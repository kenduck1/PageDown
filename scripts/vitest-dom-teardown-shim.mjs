// Neutralises a stray DOM call that `@milkdown/ctx` makes after Vitest has
// already torn down a test file's jsdom environment.
//
// THE UPSTREAM BUG (read from the installed @milkdown/ctx@7.21.3 source, not
// inferred): its `Timer` schedules
//
//     setTimeout(() => { ...; this.#removeListener(); reject(...) }, 3000)
//
// and NEVER cancels it -- `clearTimeout` does not appear anywhere in that
// package. The callback fires even when the timer already resolved, because
// `#listener` is assigned once and never nulled, so `#removeListener()` always
// reaches the bare global `removeEventListener`.
//
// Any test file that constructs a Milkdown editor therefore leaves a 3-second
// timer armed. Vitest tears the jsdom environment down as soon as that file's
// tests finish -- deleting `removeEventListener` from `globalThis` -- so if the
// file completes within those 3 seconds the callback lands in a torn-down
// environment and throws `ReferenceError: removeEventListener is not defined`.
// Every test still PASSES; the run fails on the unhandled error alone.
//
// It is timing-dependent, which is why it is intermittent: observed on CI while
// the same commit was green locally.
//
// WHY THIS FIXES IT, AND WHY IT HIDES NOTHING
//
// Vitest's `populateGlobal` records a pre-existing global before overwriting it
// (`if (overriddenKeys.has(key) && key in global) originals.set(key, global[key])`)
// and its jsdom teardown restores exactly those:
//
//     keys.forEach((key) => delete global[key])
//     originals.forEach((v, k) => global[k] = v)
//
// `removeEventListener` is in that key set. So defining a no-op here -- BEFORE
// the environment exists, which is why this runs via `--import` rather than a
// setup file -- means teardown restores the no-op instead of leaving the global
// undefined. The stray callback becomes a call to a function that does nothing,
// which is precisely what cancelling the timer would have achieved.
//
// This is deliberately NOT `dangerouslyIgnoreUnhandledErrors`. That would
// suppress every unhandled rejection in the suite, including real ones in
// product code. This changes nothing except the behaviour of a listener call
// made against an environment that no longer exists -- where the only
// alternative to a no-op is a crash.
//
// During a test, jsdom's real implementations are installed over these and are
// what any test actually observes. These are only ever reachable in the window
// between one file's teardown and the next file's setup.
//
// Remove this once @milkdown/ctx cancels its timer (or nulls `#listener` after
// removing it). A quick check on upgrade:
//     grep -c clearTimeout node_modules/.pnpm/@milkdown+ctx@*/node_modules/@milkdown/ctx/lib/index.js
// Anything other than 0 means it may have been fixed upstream.

/** @returns {void} */
function noop() {}

/** @returns {boolean} */
function alwaysDispatched() {
  return true
}

for (const name of ['addEventListener', 'removeEventListener', 'dispatchEvent']) {
  if (typeof globalThis[name] === 'undefined') {
    Object.defineProperty(globalThis, name, {
      value: name === 'dispatchEvent' ? alwaysDispatched : noop,
      writable: true,
      configurable: true,
      enumerable: false
    })
  }
}
