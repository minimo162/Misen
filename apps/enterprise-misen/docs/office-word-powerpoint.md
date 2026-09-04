# Word and PowerPoint capability decision

Enterprise Misen exposes Word and PowerPoint through the same pinned
`iOfficeAI/OfficeCLI` v1.0.147 runtime used for Excel. The model does not receive
a shell, OfficeCLI syntax, a generic Office DOM, MCP, or arbitrary file paths.

## Typed Tool surface

The compatibility readers `document_read` and `presentation_read` remain
available. Creation and mutation use the common typed Office verbs:
`office_create_output`, `office_get`, `office_query`, `office_inspect`,
`office_set`, `office_add`, `office_remove`, `office_move`, `office_swap`,
`office_batch`, and `office_import`.

Word headings and tables are added with `office_add`; PowerPoint slides use the
same verb with an allowlisted layout. Literal whole-package find/replace is
expressed through `office_set` at `/`.

Find/replace is deliberately literal: regex and raw commands are not
model-facing. Every requested replacement must match at least once; a silent
zero-match receipt fails before publication. Media, embedded objects, fields,
external data sources, and external references are rejected by the shared
Office deny-list.

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

The Finance Skill boundary, July/August fixtures, and Decision 441 Acceptance
remain unchanged.
