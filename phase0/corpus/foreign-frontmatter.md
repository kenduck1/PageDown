---
title: Document With Foreign Frontmatter Keys
page: Letter
margins: 1in
tags:
  - obsidian-style-tag
  - another-tag
draft: true
bibliography: references.bib
custom_pandoc_field: some-value
---

# Body

This document's frontmatter intentionally includes keys PageDown doesn't own (`tags`, `draft`, `bibliography`, `custom_pandoc_field`) alongside the ones it does (`title`, `page`, `margins`). A round-trip through PageDown must preserve every one of them unchanged.
