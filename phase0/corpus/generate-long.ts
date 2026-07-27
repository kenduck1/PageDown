import { writeFileSync } from 'node:fs'

const paragraphs = [
  'The committee reviewed the quarterly submission and found the methodology sound, though several reviewers noted that the sampling window could be extended in future cycles to capture seasonal variation.',
  'Subsequent analysis revealed a consistent pattern across all four regions, with the northern district showing the most pronounced deviation from the projected baseline established in the prior fiscal year.',
  'It is recommended that the working group reconvene no later than the end of next month to finalize the revised timeline and communicate any changes to the affected stakeholders in writing.'
]

function generate(sections: number, title: string): string {
  let out = `---\ntitle: ${title}\npage: A4\nmargins: 1in\n---\n\n`
  for (let section = 1; section <= sections; section++) {
    out += `## Section ${section}\n\n`
    out += `${paragraphs[section % paragraphs.length]}\n\n`
    out += `${paragraphs[(section + 1) % paragraphs.length]}\n\n`
  }
  return out
}

// Section counts calibrated (not guessed) against the real render pipeline
// to actually paginate to ~100 / ~300 pages under Paged.js's current default
// page box (no @page CSS is wired in yet -- see Task 6's Gate 2 findings),
// not just named as if they did. The original counts (120 / 300) were a
// Task 2 naming assumption that never got verified against a real
// Previewer run; Task 6's Gate 2 measured the true ratio at exactly
// 4.2857 sections/page for this paragraph pool (120 sections -> 28 pages,
// 300 sections -> 70 pages, identical ratio both times), and these counts
// are that ratio times 100 and 300 respectively, then confirmed empirically
// (see docs/superpowers/plans/2026-07-25-phase0-findings.md's Gate 2
// section) to land within a page or two of the intended target.
writeFileSync(new URL('./long.md', import.meta.url), generate(429, 'Long Reference Report'))
writeFileSync(
  new URL('./very-long.md', import.meta.url),
  generate(1286, 'Very Long Reference Report')
)
console.log('Wrote phase0/corpus/long.md and phase0/corpus/very-long.md')
