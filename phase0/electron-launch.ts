import { _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
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
  close: () => Promise<void>
}

export async function launchIsolatedApp(args: string[]): Promise<IsolatedApp> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'pagedown-gate-userdata-'))
  const app = await electron.launch({ args: [...args, `--user-data-dir=${userDataDir}`] })
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
      await app.close()
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
}
