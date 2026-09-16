# Report PDF fonts

Both families are **SIL Open Font License 1.1**, which permits embedding in a
generated document and redistribution. The licence text sits beside each family.

| File | Family | Why |
|---|---|---|
| `Inter-Regular/Bold/Italic/BoldItalic.ttf` | Inter 4.1 | Body and headings |
| `JetBrainsMono-Regular/Bold.ttf` | JetBrains Mono 2.304 | Raw evidence, IDs, reproduction commands |

**Why these are committed rather than left to the system.** `@react-pdf/renderer`
defaults to the base-14 fonts (Helvetica, Courier), which are *referenced* rather
than embedded — the reader's viewer has to supply them. That works in Preview and
CoreGraphics but **renders completely blank in poppler** (`pdftoppm`, and much
server-side PDF tooling). Verified with a minimal one-line document: base-14
rendered blank, the same document with an embedded font rendered correctly.

Embedding is therefore not a styling choice here, it is what makes the PDF
readable outside a desktop viewer.

Sources: <https://github.com/rsms/inter> (v4.1) and
<https://github.com/JetBrains/JetBrainsMono> (v2.304). Static instances are used
rather than the variable font: `@react-pdf/renderer` renders the default
instance, so weight selection needs real static files.
