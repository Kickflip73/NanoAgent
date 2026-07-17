---
name: meituan-km
description: Meituan Knowledge Management (学城) document read, create, and management operations (search/get/create/delete/move/copy/restore), including doc search by space IDs and space search by keyword. Trigger this skill when user input contains KM links under km.sankuai.com (e.g., /collabpage/<docId> or /page/<docId>) or pasted KM content.
---

# Meituan Knowledge Management (学城) Skill

Use this skill for KM document reading, navigation, and lifecycle management.

## Trigger Scenarios

Use this skill when user intent is about:
- searching KM docs or spaces
- reading KM doc content (markdown or full JSON)
- inspecting directory tree under doc/space
- creating docs or organizing doc directories (copy/move/delete/restore)

## Trigger Timing

Trigger this skill immediately when either of the following appears in user input:
- the user pastes a KM link whose domain is `km.sankuai.com` (for example `https://km.sankuai.com/collabpage/<docId>` or `https://km.sankuai.com/page/<docId>`)
- the user pastes KM document content, KM search results, or KM hierarchy output and asks to read/summarize/analyze/manage it

Do not wait for explicit mention of "use meituan-km"; KM URL/content is sufficient trigger evidence.

**Do NOT trigger** if:
- The user wants to edit or update the content of an existing KM doc (use `kmedit` skill instead)

**Use together with other skills:**
- Creating a doc that includes drawIO diagrams: use `kmdrawio` first to generate the `.drawio`/`.svg` file, then use this skill to create the doc with a local file reference.

## Boundaries

- Editing content of existing docs → `kmedit`.
- Standalone drawIO diagram generation/conversion → `kmdrawio`.
- This skill focuses on search/read/lifecycle management; use `kmdrawio` as a prerequisite when doc creation requires diagrams.

## Quick Start

> **Prerequisite**: Ensure your browser is logged into 学城 before running any command.
> First-time setup: https://km.sankuai.com/collabpage/2708424384

> **Always run `km --help` first** to discover the full command set and options, then use `km <subcommand> --help` for details.

1. Discover command usage:
   - `km --help`
2. Locate target docs/spaces:
   - `km search "keyword" --limit 10`
   - `km search-space "keyword" --limit 10`
3. Read or manage:
   - `km get <docId>`
   - `km hierarchy-info --doc-id <docId>`
   - `km create --title "New Doc"`

## Workflow 1: Search Documents

Use this workflow for global search and space-scoped search.

Global search (minimal):

```bash
km search "API documentation" --limit 10
```

Search within specific 学城 spaces:

```bash
km search "mcp" --space-id 98076 --space-id 38556
```

Search spaces by keyword:

```bash
km search-space "基础技术部文档" --limit 5
```

## Workflow 2: Read Document Content

Use this workflow when deciding between markdown output and full ProseMirror JSON.

Read markdown (default, lightweight):

```bash
km get 1234567
```

Read full ProseMirror JSON (complete structure, heavy payload):

```bash
km get 1234567 --json > /tmp/km_doc.json
```

Markdown mode notes:
- Lightweight; suitable for most reading and summarization tasks.
- Conversion may be incomplete for complex structures (e.g. nested tables, custom blocks).

JSON mode notes:
- Output is complete but often very large; do **not** load the full file directly into context.
- Use `jq` or scripts to extract only the needed nodes/fields.
- For inline file URLs found in JSON content, fetch with `mtcurl "<url>"`.

Read embedded file content by URL:

```bash
km read-file "https://km.sankuai.com/api/file/12345/diagram.png" --compression 3
```

## Workflow 3: Find Document Directory Tree

Use this workflow to inspect parent/child/sibling relationships or browse a space tree.

By document id:

```bash
km hierarchy-info --doc-id=2708424384
```

By space id (for full space tree):

```bash
km hierarchy-info --space-id=98076
```

## Read Capability Matrix

| Goal | Command | Notes |
|---|---|---|
| Search docs | `km search "keyword" --limit 20 --page 1` | Full-text search in KM |
| Search docs by spaces | `km search "keyword" --space-id 98076 --space-id 38556` | Filter document search to specific KM spaces |
| Search spaces | `km search-space "keyword" --limit 20 --page 1` | Search KM spaces and return `spaceId` + `spaceName` |
| Get markdown | `km get <docId>` | Lightweight output, suitable for most reading tasks |
| Get full JSON tree | `km get <docId> --json` | Complete structure; use `jq`/scripts for targeted queries |
| Inspect hierarchy | `km hierarchy-info --doc-id=<docId>` | Parent/children/sibling structure |
| Read embedded file | `km read-file "<url>" --compression 3` | Image/SVG/file content |

## Management Capability Matrix

For detailed directory governance and creation workflows, see [MANAGEMENT.md](references/MANAGEMENT.md).

| Goal | Command | Notes |
|---|---|---|
| Create empty doc | `km create --title "New Doc"` | No `--content/--file` = empty doc; mainly used as directory/container node |
| Create from markdown text | `km create --title "Doc" --content "# Title"` | Use only for very small snippets; large inline content reduces stability |
| Create from markdown file | `km create --title "Doc" --file ./doc.md` | **Preferred**; keeps context lean and stable |
| Copy doc | `km copy <docId> --title "Copy"` | Duplicate existing doc |
| Move doc | `km move <docId> --parent <parentId>` | Reorganize hierarchy |
| Delete doc | `km delete <docId>` | Move to recycle bin |
| Restore doc | `km restore <docId>` | Recover from recycle bin |

> **DrawIO in docs**: If the document content requires drawIO diagrams, use the `kmdrawio` skill first to generate the `.drawio`/`.svg` file, then reference it via local path in the markdown before running `km create`.

> **Markdown format support**: `km create --file` supports extended markdown features (todo lists, LaTeX formulas, PlantUML, local drawIO/image references). See: [km_extended_markdown.md](assets/km_extended_markdown.md)

## Troubleshooting

If you encounter issues, check the FAQ or leave a message at the [meituan-km setup page](https://km.sankuai.com/collabpage/2708424384).

## Advanced References

- **[Document Management](references/MANAGEMENT.md)**
