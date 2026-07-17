# Document Management Workflows

Operational guide for KM directory governance and document creation.

## Workflow 1: Manage Directory Structure

Use this workflow for large-scale space cleanup and taxonomy governance.

### Step 1: Build directory context

```bash
# Inspect a space tree
km hierarchy-info --space-id <SPACE_ID>

# Inspect neighborhood of a specific document
km hierarchy-info --doc-id <DOC_ID>
```

### Step 2: Identify candidates for reorganization

```bash
# Search by title/content keyword
km search "keyword" --space-id <SPACE_ID> --limit 100

# Read lightweight markdown for quick review
km get <DOC_ID>
```

Sort and decide by:
- Time (recent vs stale docs)
- Title naming consistency
- Author/ownership
- Content relevance and duplication

### Step 3: Execute management operations

```bash
# Copy before risky operations
km copy <DOC_ID> --title "Backup - <DOC_ID>"

# Move under another parent doc
km move <DOC_ID> --parent <NEW_PARENT_ID>

# Or move to a space root
km move <DOC_ID> --space <TARGET_SPACE_ID>

# Delete and restore
km delete <DOC_ID>
km restore <DOC_ID>
```

### Step 4: Validate final structure

```bash
km hierarchy-info --doc-id <DOC_ID>
km hierarchy-info --space-id <SPACE_ID>
```

## Workflow 2: Create Documents

Use this workflow when creating new docs or seed documents under a target directory.

### Step 1: Locate create target

- Create under a specific space root: use `--space <SPACE_ID>`.
- Create under a specific parent document: use `--parent <PARENT_DOC_ID>`.
- If neither `--space` nor `--parent` is provided, document is created in personal space (我的空间).

Examples:

```bash
km create --title "Project Home" --space 98076
km create --title "Runbook" --parent 2708424384
km create --title "Scratch Notes"
```

### Step 2: Decide content input mode

- Preferred: `--file` for most cases (reduces model context load and improves stability).
- Only use `--content` for very small markdown snippets.

```bash
# small inline markdown only
km create --title "Quick Note" --content "# TL;DR\n\n- item"

# preferred mode
km create --title "Release Plan" --file ./docs/release-plan.md --parent 2708424384
```

### Step 3: Use supported markdown features

Markdown creation supports:
- Todo list: `- [ ]` / `- [x]`
- Formula: inline `$...$` and block `$$...$$`
- PlantUML code block: fenced block with language `plantuml`
- DrawIO local file image references: `![name](./diagram.drawio)` or `![name](./diagram.svg)`
- Image local file references: `![name](./image.png)` (`.png/.jpg/.jpeg/.gif/.webp`)

Important constraints:
- DrawIO and image references must use **local files** (relative path, absolute path, `~`, or `file://` URI).
- Remote `http(s)://` image URLs are **not** uploaded — they render as an error placeholder in the doc.
- Inline HTML: only `<u>`, `<sup>`, `<sub>` tags are rendered; all other HTML is escaped.

See templates:
- `../assets/km_extended_markdown.md`
- `../assets/create_media_paths_template.md`

## Capability Matrix

| Goal | Command | Notes |
|---|---|---|
| Inspect space tree | `km hierarchy-info --space-id <spaceId>` | Build directory map before reorg |
| Inspect doc neighborhood | `km hierarchy-info --doc-id <docId>` | Confirm parent/children/siblings |
| Search docs | `km search "keyword" --space-id <spaceId>` | Find candidate docs by title/content |
| Create empty doc | `km create --title "Doc"` | Primarily used as directory/container node |
| Create from markdown text | `km create --title "Doc" --content "# Title"` | Use only for very small snippets |
| Create from markdown file | `km create --title "Doc" --file ./doc.md` | Preferred for stable, larger content creation |
| Copy doc | `km copy <docId> --title "Backup"` | Backup before move/delete |
| Move doc | `km move <docId> --parent <parentId>` | Reorganize structure |
| Delete doc | `km delete <docId>` | Move to recycle bin |
| Restore doc | `km restore <docId>` | Recover deleted doc |

## Guardrails

- For bulk cleanup, always run `copy -> move/delete` to preserve rollback.
- Verify target parent/space before move.
- Keep operation logs (docId/action/time) for batch jobs.
- Use JSON output (`km -f json ...`) for automation.

## Boundary

This reference focuses on directory/document management and markdown-based creation.

For node-level editing and diagram editing in existing docs, use:
- `kmedit` skill
- `kmdrawio` skill
