import { protocol } from 'electron'

// The pagedown-render:// scheme hosts the sandboxed pagination render
// context (see pagination-window.ts). It must be registered as privileged
// (standard + secure) before Electron's `ready` event fires — Electron
// enforces this at the protocol.registerSchemesAsPrivileged call site itself
// (it throws/no-ops if called after app.whenReady()), which is why this is
// invoked at module scope in src/main/index.ts before app.whenReady() is
// awaited anywhere.
//
// `standard: true` gives the scheme a real, distinct origin (relative URL
// resolution, same-origin checks, `'self'` CSP) instead of falling back to
// an opaque/non-standard origin. `secure: true` marks it a secure context
// (no mixed-content warnings, Web APIs that require secure contexts work).
// `corsEnabled` + `supportFetchAPI` + `stream` let the context behave like a
// normal https-ish origin for fetch/streaming if later tasks need it.
export function registerPaginationScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'pagedown-render',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}
