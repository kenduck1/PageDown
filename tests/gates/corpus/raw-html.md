---
title: Raw HTML and Pagebreak Fidelity
---

# Raw HTML Round-Trip

A paragraph with an inline raw HTML tag: this is <span class="highlight">inline HTML</span> inside text.

<!-- pagebreak -->

## Block-Level Raw HTML

<div class="callout">
This is a raw HTML block containing a paragraph.
</div>

Regular Markdown paragraph after the block.

<!-- pagebreak -->

## HTML Comments

<!-- This is an ordinary HTML comment, not a pagebreak marker. -->

Text after an ordinary comment.

## Inline Comment

Some text with an <!-- inline comment --> in the middle of a sentence.
