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
