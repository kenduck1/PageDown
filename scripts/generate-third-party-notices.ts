/**
 * Regenerates docs/THIRD-PARTY-NOTICES.md from the installed dependency tree.
 *
 *   pnpm exec tsx scripts/generate-third-party-notices.ts
 *
 * WHY THIS FILE HAS TO EXIST AT ALL. PageDown ships as a packaged desktop
 * app, so every release redistributes its dependencies as binaries: the
 * bundlers inline most of the tree into `out/`, and electron-builder packs
 * the rest into the asar. MIT, ISC and the BSD licences all permit that and
 * all attach the same condition -- the copyright notice and permission
 * notice have to travel with the redistribution. The root LICENSE covers
 * PageDown's own source and the three bundled fonts; this file covers
 * everything else.
 *
 * WHY IT IS GENERATED RATHER THAN HAND-WRITTEN. A hand-maintained notices
 * file is wrong the first time a dependency is added and nobody notices,
 * which is the same "documentation that is a claim about the past" failure
 * this repo has been bitten by elsewhere. Regenerating is one command.
 *
 * DELIBERATELY OVER-INCLUSIVE. This walks the whole resolved tree rather
 * than trying to compute exactly which packages survive tree-shaking into a
 * shipped artifact. Some entries here are therefore build- or test-time only
 * and are not actually redistributed. That is the safe direction to be wrong
 * in: attributing a package that did not ship costs a line of text, while
 * missing one that did ship is a licence violation. Working out the true
 * shipped set would mean parsing three separate bundler outputs and would go
 * stale on any config change.
 *
 * HOW THE LICENCE TEXTS ARE CHOSEN. Rather than hardcoding canonical texts
 * (which drift, and which are not necessarily the text a given package
 * actually shipped), one representative package per licence identifier is
 * picked and ITS real licence file is inlined. Packages sharing a licence
 * differ only in the copyright line, and every copyright line is listed
 * individually above the text.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface PnpmLicensePackage {
  name: string
  versions: string[]
  paths: string[]
  license: string
  author?: string
  homepage?: string
}

const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i

/** The first real copyright line in a licence file, if it has one. */
function findCopyright(packageDir: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(packageDir)
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!LICENSE_FILE_PATTERN.test(entry)) continue
    let text: string
    try {
      text = readFileSync(join(packageDir, entry), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim().replace(/\s+/g, ' ')
      // A real notice names a year or carries (c)/©. Requiring that skips
      // the definitions paragraph in Apache-2.0 and MPL-2.0, whose wording
      // ("'Licensor' shall mean the copyright owner…") contains the word but
      // attributes nobody -- which is how dompurify first came out credited
      // to "Licensor shall mean the copyright owner".
      if (!/copyright/i.test(trimmed)) continue
      if (!/copyright\s*(\(c\)|©|\d{4})/i.test(trimmed)) continue
      if (/shall mean|\bmeans\b|as defined in|notwithstanding/i.test(trimmed)) continue
      if (/^all rights reserved/i.test(trimmed)) continue
      return trimmed
    }
  }
  return null
}

function findLicenseText(packageDir: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(packageDir)
  } catch {
    return null
  }
  // Prefer a file actually named for the licence over NOTICE, which is
  // usually an addendum rather than the terms themselves.
  const ranked = entries
    .filter((entry) => LICENSE_FILE_PATTERN.test(entry))
    .sort((a, b) => Number(/^notice/i.test(a)) - Number(/^notice/i.test(b)))
  for (const entry of ranked) {
    try {
      const text = readFileSync(join(packageDir, entry), 'utf8').trim()
      if (text.length > 200) return text
    } catch {
      continue
    }
  }
  return null
}

const raw = execFileSync('pnpm', ['licenses', 'list', '--json'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024
})
const byLicense = JSON.parse(raw) as Record<string, PnpmLicensePackage[]>

const licenseIds = Object.keys(byLicense).sort((a, b) => {
  const sizeDelta = byLicense[b].length - byLicense[a].length
  return sizeDelta !== 0 ? sizeDelta : a.localeCompare(b)
})

const totalPackages = Object.values(byLicense).reduce((sum, list) => sum + list.length, 0)

const out: string[] = []
out.push('# Third-party notices')
out.push('')
out.push(
  'PageDown is distributed as a packaged desktop application, so a release',
  'redistributes the third-party software listed here in binary form. Each',
  'component remains under its own licence and its own copyright.',
  ''
)
out.push(
  'PageDown itself is MIT-licensed — see [LICENSE](../LICENSE). That file is',
  'kept',
  "as the bare MIT text and nothing else, because GitHub's licence detection",
  'reports `NOASSERTION` for a LICENSE with extra sections appended, which',
  'costs the repository its licence badge and its place in licence searches.',
  'Everything third-party therefore lives here instead.',
  '',
  '## Bundled fonts',
  '',
  'Three typefaces are vendored into the application and embedded in rendered',
  'output, all under the SIL Open Font License 1.1:',
  '',
  '- **Source Serif 4** — `src/renderer/src/assets/fonts/OFL.txt`',
  '- **Inter** — `src/renderer/src/assets/fonts/OFL-Inter.txt`',
  '- **Source Code Pro** — `src/renderer/src/assets/fonts/OFL-Source-Code-Pro.txt`',
  '',
  "KaTeX's own maths fonts are embedded as `data:` URIs when a document",
  'contains maths; they are covered by the KaTeX entry in the MIT section',
  'below.',
  ''
)
out.push(
  '> Generated by `scripts/generate-third-party-notices.ts` from the installed',
  '> dependency tree. Do not edit by hand — run',
  '> `pnpm exec tsx scripts/generate-third-party-notices.ts` instead.',
  '',
  '> This list is deliberately over-inclusive: it covers the whole resolved',
  '> dependency tree, so some entries are build- or test-time only and are not',
  '> actually redistributed. Attributing too much is the safe direction.',
  ''
)
out.push(
  'One component is worth calling out because it is copied rather than merely',
  'depended on: the syntax-highlighting colours in',
  '`src/typography/document-typography.css` are taken verbatim from',
  "highlight.js's own `styles/github.css`, and so carry highlight.js's",
  'BSD-3-Clause notice directly in that file.',
  ''
)
out.push(`Components: **${totalPackages}** packages across **${licenseIds.length}** licences.`)
out.push('')
out.push('## Contents')
out.push('')
for (const id of licenseIds) {
  const anchor = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  out.push(`- [${id}](#${anchor}) — ${byLicense[id].length} packages`)
}
out.push('')

for (const id of licenseIds) {
  const packages = [...byLicense[id]].sort((a, b) => a.name.localeCompare(b.name))
  out.push(`## ${id}`)
  out.push('')

  let representativeText: string | null = null
  for (const pkg of packages) {
    const copyright = findCopyright(pkg.paths[0] ?? '')
    const versions = pkg.versions.join(', ')
    out.push(`- **${pkg.name}** ${versions}${copyright ? ` — ${copyright}` : ''}`)
    if (!representativeText) representativeText = findLicenseText(pkg.paths[0] ?? '')
  }
  out.push('')

  if (representativeText) {
    out.push(`<details><summary>Full ${id} licence text</summary>`)
    out.push('')
    out.push('```')
    out.push(representativeText)
    out.push('```')
    out.push('')
    out.push('</details>')
    out.push('')
  }
}

writeFileSync('docs/THIRD-PARTY-NOTICES.md', out.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8')
console.log(
  `Wrote docs/THIRD-PARTY-NOTICES.md (${totalPackages} packages, ${licenseIds.length} licences)`
)
