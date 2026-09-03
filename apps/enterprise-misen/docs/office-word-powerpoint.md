# Word and PowerPoint capability decision

Enterprise Misen exposes Word and PowerPoint through the same pinned
`iOfficeAI/OfficeCLI` v1.0.147 runtime used for Excel. The model does not receive
a shell, OfficeCLI syntax, a generic Office DOM, MCP, or arbitrary file paths.

## Typed Tool surface

Word:

- `document_read`: read at most 100 ordered text elements and their stable paths.
- `document_create_output`: create a blank `.docx` or copy a workspace template,
  then optionally add bounded paragraphs.
- `document_update`: apply bounded literal find/replace operations and/or append
  paragraphs to an existing output document.

PowerPoint:

- `presentation_read`: read text from at most 100 ordered slides.
- `presentation_create_output`: create a blank `.pptx` or copy a workspace
  template, then optionally add bounded slides using an allowlisted layout.
- `presentation_update`: apply bounded literal find/replace operations and/or
  append slides to an existing output presentation.

Find/replace is deliberately literal: regex and raw path-scoped mutation are not
model-facing. Every requested replacement must match at least once; a silent
zero-match receipt fails before publication. Rich shapes, charts, media, comments, tracked changes, speaker
notes, animation, and render output remain possible in OfficeCLI but are not in
this first Misen capability slice.

## Lifecycle and independent checks

Create and update run on a private temporary file. OfficeCLI batches are atomic,
OfficeCLI validation must report zero errors, and a separate bounded ZIP/OpenXML
inspection confirms the package type before same-directory atomic publication.
The independent check rejects active content, embedded packages, non-hyperlink
external relationships, malformed parts, ZIP traversal names, oversized package
expansion, and format/extension mismatches. External hyperlink relationships are
preserved as inert document content; Misen never follows them.

Template source bytes are never modified. Word style/settings/theme parts and
PowerPoint slide-master/layout/theme parts are independently fingerprinted in
tests to catch preservation regressions. Output discovery, opaque artifact IDs,
session history, and RFC 5987 downloads now accept `.xlsx`, `.docx`, and `.pptx`.

## Agent boundary

```text
Portable Skill -> Pi Agent -> typed document/presentation Tool
               -> OfficeCLI adapter -> pinned OfficeCLI -> Word/PowerPoint
```

The existing five Excel Tool contracts, Finance Skill boundary, July/August
fixtures, and Decision 441 Acceptance remain unchanged.
