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

writeFileSync(new URL('./long.md', import.meta.url), generate(120, 'Long Reference Report'))
writeFileSync(new URL('./very-long.md', import.meta.url), generate(300, 'Very Long Reference Report'))
console.log('Wrote phase0/corpus/long.md and phase0/corpus/very-long.md')
