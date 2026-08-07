// Builds the pagedown-render:// sandbox context as a fully self-contained
// static bundle: out/pagination-render/{index.html,index.js}.
//
// This intentionally does NOT go through electron-vite's `renderer` config.
// electron-vite pins that config's Vite `root` to `src/renderer` (see
// `electronRendererConfigPresetPlugin` in electron-vite's source), which is
// the right place for the main app UI but wrong for this context: an
// `index.html` outside that root fails the build (Rollup rejects emitted
// chunk/asset filenames that resolve outside the output dir, e.g.
// `../../resources/pagination-render/index.html`), and even if it didn't,
// the render context would end up coupled to the main renderer's Vite
// pipeline (React plugin, shared chunk graph) — the opposite of the
// "self-contained bundle, no dependency on the main app's renderer bundle"
// requirement this context has (no Node/Electron API access, no preload,
// no IPC; it must not accidentally inherit anything from the app shell).
//
// A small dedicated esbuild step (this file, run via `tsx`), executed as
// its own build phase, keeps this output genuinely independent and lets us
// pin the output path exactly to what src/main/pagination-window.ts expects
// (out/pagination-render/).
import { build } from 'esbuild'
import { cp, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const projectRoot = path.resolve(fileURLToPath(import.meta.url), '../..')
const srcDir = path.join(projectRoot, 'resources', 'pagination-render')
const outDir = path.join(projectRoot, 'out', 'pagination-render')

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true })

  await build({
    entryPoints: [path.join(srcDir, 'index.ts')],
    outfile: path.join(outDir, 'index.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome142', // matches Electron 39's bundled Chromium
    sourcemap: false, // avoid any data: sourceMappingURL interaction with this context's strict CSP
    minify: false,
    logLevel: 'info',
    // Document Typography sub-project: the render context needs the shared
    // typography stylesheet's raw TEXT (to hand to previewer.preview() as a
    // real stylesheet, see index.ts) and the Source Serif 4 font's raw
    // BYTES as a self-contained base64 string (this sandboxed context has
    // no reachable font asset of its own and a strict CSP that disallows
    // fetching one from elsewhere -- see the design doc's "Delivering a
    // real stylesheet" section for why a data: URI, not a served static
    // file, was chosen).
    loader: {
      '.css': 'text',
      '.woff2': 'base64'
    }
  })

  await cp(path.join(srcDir, 'index.html'), path.join(outDir, 'index.html'))

  console.log(`Built pagination render context -> ${path.relative(projectRoot, outDir)}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
