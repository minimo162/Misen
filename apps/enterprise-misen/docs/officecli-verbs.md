# OfficeCLI verb tools

Issue #122 exposes OfficeCLI's element model without exposing a shell or raw XML.

## Workflow

1. Discover files with `workspace_list_files`.
2. Inspect the relevant Office structure with `office_get` and `office_query`.
   Use `depth` to expand children; do not guess a path or property name.
3. Create a new `.xlsx`, `.docx`, or `.pptx` below `output/` with
   `office_create_output`. A workspace template may be copied as the source.
4. Modify only that output with `office_set`, `office_add`, `office_remove`,
   `office_move`, `office_swap`, `office_batch`, or `office_import`.
5. Read the changed path back and run `office_inspect` with `mode=validate`.

`office_batch` is atomic and accepts at most 200 items. Each item passes the
same verb, element, formula, URL, UNC, external-workbook, and external-data
checks as the corresponding single-operation tool.

The compatibility tools `spreadsheet_read`, `document_read`, and
`presentation_read` remain available to existing approved Skills. The old
format-specific create/update tools are retired.

## Boundary

Read tools accept only files inside the selected workspace. Mutation tools
accept only existing Office files below `output/`; `office_create_output` is
the only creation path. `office_import` also reads its CSV/TSV source through
the workspace boundary. Every edit happens on a private temporary copy, then
passes OfficeCLI `validate` and Misen's independent OOXML validation before an
atomic output replacement. Source files are never passed to a mutating
OfficeCLI invocation.

The complete deny list is defined only in
`src/capabilities/office-denylist.ts`.
