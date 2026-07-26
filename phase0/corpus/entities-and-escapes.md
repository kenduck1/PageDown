---
title: Entities and Escapes
page: Letter
margins: 1in
---

# Terms &amp; Conditions

Rights &copy; 2026 PageDown. Use of the ampersand character (\&) and other
reserved symbols such as &lt;tag&gt; must be escaped in source form.

This is \*not emphasis\*, and this is a literal backslash: \\ followed by
more plain text so the run continues well past the escape.

Smart quotes are not auto-converted, but a named entity like &mdash; still
needs correct source accounting, as does a numeric reference like &#65; and
a hexadecimal one like &#x42;.

Common abbreviations like Q&A; and R&D; look exactly like character
references to a naive scanner but are not real ones — "A" and "D" are not
recognized entity names, so this text renders unchanged and must stay
identity-mapped character for character, not collapsed like a real entity.

Rights &copy; owned jointly by the Q&A; team must still be tracked
accurately: this sentence deliberately mixes a real, genuinely-collapsing
reference (`&copy;`) with a fake, reference-shaped-but-not-real one (`&A;`)
in the _same_ text run. A per-run aggregate length comparison alone cannot
catch a bug that wrongly collapses `&A;` here, because the real `&copy;`
collapse already changes this run's rendered length — the fake collapse's
own zero net length change (a non-decoding match always has the same
length before and after) is invisible against that backdrop. This
adversarial arrangement is required, not incidental: if this sentence were
ever split so the real and fake references landed in separate runs, this
specific regression coverage would silently disappear. See
`phase0/gate1-source-offset.spec.ts`'s per-match independent check, which
verifies each match's own byte range regardless of what else shares its
run, and does not depend on this specific sentence structure to work.
