# PDF capability (Issue #138)

Misen reads, renders and composes PDF files with three Tools. PDF handling is
deliberately small: understanding, rendering and manipulation each use one
pinned, pure JS or WebAssembly library, and nothing in the PDF is ever executed.

| Tool | Library | Purpose |
| --- | --- | --- |
| `pdf_read` | pdfjs-dist 6.3 (legacy build, Apache-2.0) | One call returns page count, metadata, per-page text with a light layout reconstruction, and whether the file carries active content. Bounded; a truncated result names the next start page. |
| `pdf_render` | @hyzyla/pdfium 2.1 (PDFium compiled to WebAssembly, MIT wrapper, BSD-3 engine) | Renders exactly one page to PNG. Pages are never pre-rendered in bulk. |
| `pdf_create_output` | pdf-lib 1.17 (MIT) | Composes a new PDF below `output/` from page ranges of workspace PDFs: copy, merge, extract, reorder. |

PNG encoding is a 60-line pure JS encoder over the already bundled `fflate`.
No native addon, DLL, child process, canvas, OCR engine or runtime download is
involved. `prepare-runtime` installs with `--omit=optional` so pdf.js's optional
native canvas never enters the runtime, and the boundary check rejects any
`.node` or `.dll` and any `.wasm` outside the two pinned PDF packages.

## Workflow

1. `pdf_read` with the file name. Use `start` / `end` only for a continuation
   or a specific range; `maxChars` raises or lowers the default 80,000
   character budget (50 pages per call at most).
2. If `textlessPages` lists a page, or the user asks about layout, charts,
   stamps or appearance, call `pdf_render` for that page only (`scale` defaults
   to 1.5, at most 3, and is clamped to 4 megapixels).
3. To deliver a PDF, call `pdf_create_output` with `sources` (each with an
   optional `pages` selection such as `1-3,5`) and an `output/…pdf`
   destination. Replacing an existing deliverable requires `overwrite: true`,
   which is the same user-approved checkpoint as for Office outputs.

"Read this PDF and summarize it" is one `pdf_read`. "Also check the table
layout on page 3" adds one `pdf_render(page = 3)`.

## Boundary

- Reads accept only `.pdf` files inside the selected workspace (`WorkspaceBoundary`).
- Writes accept only `.pdf` names below `output/`; sources are never modified.
  The Office create Tool still refuses `.pdf` and the PDF Tool refuses Office names.
- Both PDF read Tools go through the session read cache and the audit
  `tool.completed` record like every other read Tool.
- Encrypted (password protected), damaged and non-PDF inputs fail with an
  explicit `PdfError` code (`encrypted`, `damaged`, `not-pdf`) in read, render
  and compose alike.
- `pdf_read` reports document JavaScript, OpenAction, Launch / file actions,
  links, attachments, AcroForm, XFA and signatures as counts and flags only.
  Scripts, actions and attachments are never run, opened or returned.
- `pdf_create_output` strips document-level `OpenAction`, `AA`, `AcroForm`,
  `Names/JavaScript` and `Names/EmbeddedFiles`, page-level `AA`, and every
  annotation that has an additional-actions dictionary, a file specification,
  a non `URI` / `GoTo` / `Named` action, or a `FileAttachment`, `RichMedia`,
  `3D`, `Screen`, `Movie`, `Sound` or `Widget` subtype. The sanitized pages are
  then copied into a fresh document so removed objects are not serialized.
- Every result carries the notice that PDF text is untrusted document content.

## Not in stage 1

OCR (image-only pages are reported as `textless`; look at them with
`pdf_render`), visual diff, digital signatures, AcroForm editing, annotation /
redaction / attachment editing, PDFBox or any Java runtime, and LiteParse (a
native N-API addon with a separate PDFium DLL and a first-use download of
Tesseract language data, which the runtime boundary does not admit).
