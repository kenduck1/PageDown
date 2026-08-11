import { _electron as electron, type ElectronApplication } from '@playwright/test'
import { rmSync } from 'node:fs'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Every phase0/phase1 gate that drives the real built app via
// _electron.launch() must go through this helper instead of calling
// electron.launch() directly. Electron's default userData path
// (app.getPath('userData'), left unset by a bare electron.launch() call)
// resolves to the SAME directory a developer's own real, interactively-run
// app instance uses (~/Library/Application Support/<productName> on
// macOS) -- launching the packaged app for a gate run with no
// --user-data-dir override silently reads and writes the developer's real
// recent-files.json, thumbnail cache, and other persisted app state, not a
// sandboxed copy. Confirmed as a real, live bug, not a theoretical risk: a
// night of gate/verification runs left 8 dead file-path entries in a real
// recent-files.json, which then made the real app's Home screen throw
// ENOENT trying to generate thumbnails for files that no longer existed.
export interface IsolatedApp {
  app: ElectronApplication
  userDataDir: string
  /**
   * Tears the launched app down and removes its isolated userData directory.
   *
   * BOUNDED and best-effort by construction -- see CLOSE_TIMEOUT_MS below.
   * Never rejects, so it is always safe to call from a `finally` block
   * without masking the real failure that got you there.
   */
  close: () => Promise<void>
}

// Upper bound on how long a single app.close() gets before the process tree
// is killed outright. Under real host load on this development machine,
// `_electron`'s app.close() can hang indefinitely (CLAUDE.md's Testing
// section documents the measured 60s+ hangs, reproduced on gate11/gate13/
// gate14 alike) -- an unbounded await there wedges the Playwright worker
// until ITS teardown timeout, and leaves both the process tree and this
// launch's temp directory behind.
//
// 15s is deliberately generous relative to a healthy close (sub-second) and
// still well inside Playwright's own worker-teardown budget.
const CLOSE_TIMEOUT_MS = 15_000

// Upper bound on the pre-close "destroy every window" step (see close()
// below). Short on purpose: destroying windows is a synchronous main-process
// operation, so anything slower than this means the app is already wedged and
// the SIGKILL path is the right answer.
const DESTROY_WINDOWS_TIMEOUT_MS = 5_000

// Every launch that has not yet been closed, so the worker-exit sweep below
// can find it. Entries are added BEFORE electron.launch() is awaited (the
// temp directory already exists by then) and removed by close().
interface LiveLaunch {
  userDataDir: string
  app?: ElectronApplication
  // False when the CALLER supplied the directory (see LaunchOptions below) --
  // this launch may then kill the process but must never delete the
  // directory, because the caller is relaunching against it.
  ownsUserDataDir: boolean
}

export interface LaunchOptions {
  /**
   * Reuse a caller-owned userData directory instead of creating (and later
   * removing) a fresh one.
   *
   * Exists for exactly one thing that is otherwise inexpressible: proving
   * something PERSISTED across a real process death. The default behaviour
   * mkdtemps a directory and removes it in close(), so two launches can never
   * share state -- which is right for every gate that measures one running
   * app, and fatal for one that has to kill the app and relaunch on the same
   * profile (gate36's crash simulation).
   *
   * The caller takes on both halves of the contract: create the directory,
   * and remove it in its own `finally`. Create it with the
   * `pagedown-gate-userdata-` prefix so the stale-directory janitor above
   * still covers it if the worker is force-killed.
   *
   * Deliberately an OPTION on this helper rather than a bare
   * `electron.launch()` at the call site: the userData isolation this module
   * exists to enforce (CLAUDE.md makes it a hard rule) is preserved -- the
   * directory is still an isolated temp one, never the developer's real
   * profile -- and so are the whenReady() await and the bounded, SIGKILLing
   * close() that every gate depends on.
   */
  userDataDir?: string
}
const liveLaunches = new Set<LiveLaunch>()

// LAST-RESORT sweep, and the one that covers the case try/finally provably
// cannot: a Playwright TEST TIMEOUT.
//
// Measured, not assumed (throwaway probe spec, a test that awaits a
// never-settling promise with a 2s timeout): on timeout Playwright abandons
// the still-suspended test function rather than throwing into it, so a
// `finally` in the test body NEVER RUNS -- only hooks do. try/finally at the
// call sites therefore covers thrown assertions, and nothing else. That
// distinction matters here because the measured leak this whole fix targets
// -- 328 stale pagedown-gate-userdata-* directories (~353MB) plus orphaned
// 6+-process Electron trees -- came from gates hitting 60-90s LAUNCH
// timeouts, i.e. exactly the path try/finally misses.
//
// A process 'exit' handler is used rather than a per-file test.afterEach /
// test.afterAll registration because it needs no change in (and no import
// by) any of the 27 gate files, and cannot perturb hook ordering in the
// gates that deliberately share one app across a whole describe block. It
// must be fully synchronous, hence rmSync/kill rather than the async
// close() path. Residual gap, stated rather than papered over: if the
// Playwright worker is itself force-killed (its own teardown timeout), no
// exit handler runs and that launch still leaks -- reproduced live while
// verifying this fix. That last hole is what sweepStaleUserDataDirs below
// exists for.
process.once('exit', () => {
  for (const live of liveLaunches) {
    try {
      live.app?.process().kill('SIGKILL')
    } catch {
      // Already gone.
    }
    // Killing the process is always right; deleting the directory is not.
    // A caller-supplied directory belongs to the caller (it is mid-relaunch,
    // by definition) and is removed by that caller's own finally.
    if (!live.ownsUserDataDir) continue
    try {
      rmSync(live.userDataDir, { recursive: true, force: true })
    } catch {
      // Best-effort.
    }
  }
})

// How old a stray pagedown-gate-userdata-* directory must be before the
// janitor below will delete it. Deliberately far longer than any real gate
// run (the whole phase0 suite is minutes, not hours), so this can never race
// a directory another worker is actively using -- the point is to bound
// accumulation to a single session's worth of leaks, not to collect promptly.
const STALE_USERDATA_AGE_MS = 6 * 60 * 60 * 1000

let sweptThisProcess = false

// Janitor for leaks NEITHER try/finally NOR the exit hook above can catch:
// when a worker exceeds its own teardown timeout, Playwright kills it
// outright and no exit handler runs at all. That is not hypothetical -- it
// is precisely how the measured 328-directory / ~353MB pile-up happened
// (gates hitting 60-90s launch timeouts), and it was reproduced again while
// verifying this very fix. Sweeping on launch makes the leak self-healing
// across runs instead of permanent.
async function sweepStaleUserDataDirs(): Promise<void> {
  const parent = tmpdir()
  const entries = await readdir(parent).catch(() => [] as string[])
  const cutoff = Date.now() - STALE_USERDATA_AGE_MS
  for (const name of entries) {
    if (!name.startsWith('pagedown-gate-userdata-')) continue
    const full = join(parent, name)
    const info = await stat(full).catch(() => null)
    if (!info || info.mtimeMs > cutoff) continue
    await rm(full, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function launchIsolatedApp(
  args: string[],
  options: LaunchOptions = {}
): Promise<IsolatedApp> {
  if (!sweptThisProcess) {
    sweptThisProcess = true
    // Fire-and-forget: a gate must never be delayed or failed by janitorial
    // work on unrelated directories.
    void sweepStaleUserDataDirs()
  }
  const ownsUserDataDir = options.userDataDir === undefined
  const userDataDir =
    options.userDataDir ?? (await mkdtemp(join(tmpdir(), 'pagedown-gate-userdata-')))
  const live: LiveLaunch = { userDataDir, ownsUserDataDir }
  liveLaunches.add(live)
  let app: ElectronApplication
  try {
    app = await electron.launch({ args: [...args, `--user-data-dir=${userDataDir}`] })
    live.app = app
  } catch (err) {
    // The temp directory exists but no close() will ever be handed to a
    // caller, so this is the only chance to clean it up promptly -- unless
    // the CALLER owns it, in which case removing it here would destroy state
    // that caller is still using.
    liveLaunches.delete(live)
    if (ownsUserDataDir) {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
    throw err
  }
  // SECOND, independent reason every gate must go through this helper (the
  // first is the userData isolation above): Playwright's _electron.launch()
  // resolves as soon as it can talk to the main process, which is BEFORE
  // Electron's own `app.whenReady()` has fired. A gate that immediately calls
  // app.evaluate() into main-process code can race that readiness. The one
  // this suite hit constantly is session.fromPartition() inside
  // ensureRenderInfraRegistered() (src/main/pagination-window.ts), which
  // throws `TypeError: Session can only be received when app is ready` --
  // the stack points into src/main so it reads like a product regression,
  // but it is only a launch race (reliable under concurrent machine load,
  // rare on a quiet machine). Gates that don't evaluate immediately instead
  // show the downstream symptom "Timed out locating the main app-shell
  // window". Awaiting readiness once, here, before returning, closes the
  // race for every caller instead of relying on each gate to work around it.
  await app.evaluate(async ({ app: a }) => {
    await a.whenReady()
  })
  return {
    app,
    userDataDir,
    close: async () => {
      try {
        // Destroy every window BEFORE app.close(), which is implemented as
        // `app.quit()` (read from playwright-core's own bundled electron
        // driver: its custom close handler evaluates `app.quit()` in the node
        // context). The app now guards quitting: `before-quit` cancels the
        // quit and asks each window's renderer to confirm any unsaved work,
        // which for a dirty document opens a genuine native
        // dialog.showMessageBox that NOTHING in Playwright can dismiss. Many
        // gates legitimately end with a dirty document on screen, so without
        // this every one of them would burn the full CLOSE_TIMEOUT_MS below
        // and end in a SIGKILL.
        //
        // `destroy()` rather than `close()` is what makes this work: it is
        // documented to skip the `close` event entirely, so it bypasses the
        // guard by construction rather than racing it. That is exactly right
        // for a test harness -- the assertions have already run, and a gate
        // deliberately discards its throwaway fixture documents. It is also
        // honest about what it gives up: this path no longer exercises the
        // quit guard, which is instead covered by unit tests against the real
        // decision function (src/renderer/src/lib/close-guard.test.ts), for
        // the same reason Print and the mtime-conflict feature have no gate.
        //
        // BOUNDED, for the same reason app.close() below is: an app that is
        // already wedged would never service this evaluate either, and an
        // unbounded await here would reintroduce exactly the "close() never
        // returns, worker teardown times out, temp directory leaks" failure
        // the rest of this function exists to prevent. On expiry it simply
        // falls through to the SIGKILL path.
        await Promise.race([
          app
            .evaluate(({ BrowserWindow }) => {
              for (const win of BrowserWindow.getAllWindows()) win.destroy()
            })
            .catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, DESTROY_WINDOWS_TIMEOUT_MS))
        ])
        // Attach the settle handlers immediately, regardless of which side of
        // the race wins, so a close() that rejects LATER (after the timeout
        // already resolved) can never surface as an unhandled rejection.
        const closeOutcome = app.close().then(
          () => 'closed' as const,
          () => 'closed' as const
        )
        let timer: ReturnType<typeof setTimeout> | undefined
        const timedOut = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), CLOSE_TIMEOUT_MS)
        })
        const outcome = await Promise.race([closeOutcome, timedOut])
        clearTimeout(timer)
        if (outcome === 'timeout') {
          try {
            // SIGKILL, not the default SIGTERM: a hung app.close() means the
            // main process's own graceful-shutdown path is itself what isn't
            // completing, so a signal it could catch or defer is the wrong
            // tool.
            app.process().kill('SIGKILL')
          } catch {
            // Best-effort -- if the process is already gone there is nothing
            // more to do.
          }
        }
      } finally {
        // ALWAYS remove the temp directory, including on the timeout/SIGKILL
        // path. This `finally` is part of the fix for a measured,
        // non-theoretical leak: 328 stale pagedown-gate-userdata-*
        // directories (~353MB) had accumulated in $TMPDIR, because the old
        // body did `await app.close()` FIRST and only then rm()'d -- so any
        // hung or throwing close skipped the cleanup entirely.
        //
        // Skipped entirely for a caller-supplied directory: that caller is
        // relaunching against it, and it removes it in its own finally.
        liveLaunches.delete(live)
        if (ownsUserDataDir) {
          await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
        }
      }
    }
  }
}
