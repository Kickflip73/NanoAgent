---
name: kmedit
description: Use when editing 学城/KM documents, such as rewriting content, checking/correcting text, continuing drafts, generating diagrams for docs, inserting images/attachments, and making structured updates at specific positions.
---

# KM Edit Skill

Use this skill for KM document editing scenarios:
- rewrite existing sections
- check and correct grammar/style/typos
- translate sections between languages
- continue writing at target positions
- generate and insert diagrams for docs
- insert images/attachments
- perform structured updates with stable anchors

Non-edit operations (`km search/get/create/copy/move/delete/restore`) belong to `meituan-km` skill.

Do not use this skill when creating a brand-new document from scratch; use `meituan-km` skill instead.

## Preconditions and URL Constraints

- `kmedit` only supports collaborative KM documents whose final page URL is:
  - `https://km.sankuai.com/collabpage/<docId>`
- Do not decide support only from user-provided URL text.
  - `https://km.sankuai.com/page/<docId>` may 302 redirect.
  - You must follow redirects / check the final landing URL first.
- Support decision rule:
  - Final landing URL is `.../collabpage/<docId>`: supported by this skill.
  - Final landing URL is `.../page/<docId>`: not supported for editing by this skill.
- If unsupported, stop edit workflow and route to `meituan-km` (read/search/management only).

## KM Edit CLI Discovery

- Runtime stack: use `kmedit` directly. It is the KM edit CLI and delegates to `scripts/meituan-local-km-js`.
- Use `kmedit --help` to view all subcommands.
- Use `kmedit <subcommand> --help` to inspect required options and defaults.
- Common entry points:
  - `kmedit login --help`
  - `kmedit inspect --help`
  - `kmedit schema --help`
  - `kmedit apply --help`
  - `kmedit browser-start --help`

## Workflow

1. Open target document URL, ensure login, and verify final landing URL:
   - `kmedit login --doc-id <docId>`
   - Follow redirect result and confirm final page type before editing.
   - Continue only when final URL matches `https://km.sankuai.com/collabpage/<docId>`.
2. Read full document in markdown first (LLM-context-safe):
   - `km get <docId> > km_<docId>.md`
   - Because full JSON is often very large, prefer markdown for full-content understanding and edit planning.
   - Only fetch JSON node tree after edit target is narrowed down by markdown content.
3. Export document node tree only when needed:
   - `km get <docId> --json > /tmp/km_doc.json`
4. Locate edit anchor (`nodeId`) using `jq` or code:
   - `jq '.. | objects | select(.attrs?.nodeId? != null) | {nodeId: .attrs.nodeId, type: .type, text: (.content // [] | map(select(.type=="text") | .text) | join(""))}' /tmp/km_doc.json`
   - If a target node has no `nodeId`, locate the nearest parent node that has `nodeId`, edit that subtree locally, then apply full-node `replace`.
5. Determine edit intent and position:
   - For partial edits inside a node, read current node content first, then apply full-node `replace` (avoid incorrect node-internal step math).
6. Build edit content tree:
   - For `replace`/`insert`, confirm target node schema first (especially `attrs`).
7. Resolve schema source:
   - Fast local static lookup (may be stale): `asset/SCHEMA_SNAPSHOT.json`
   - Runtime authoritative lookup (preferred for accuracy): `kmedit schema --doc-id <docId> --node paragraph`
   - `schema` also supports `--url <url>`, `--nodes <a,b,c>`, `--cdp-url`, and `--force-refresh`.
8. Select special operation path by content type:
   - markdown/html to nodes: use `paste`
   - image/attachment files (`jpg/png/pdf/...`): use `paste`
   - diagram insertion:
     - drawio: `insert_drawio` (diagram production rules from `kmdrawio` skill)
     - mermaid: `insert_mermaid`
     - plantuml: insert `type="plantuml"` node with `attrs.content`
9. Build `ops.json` and execute:
   - `kmedit apply --doc-id <docId> --ops-file ./ops.json`

## Ops Format (Concise)

`op`:
- `replace`
- `insert`
- `delete`
- `paste`
- `insert_drawio`
- `insert_mermaid`

`target`:
- `nodeId` (preferred exact anchor)
- `fallback`:
  - `type`
  - `textContains`
  - `nth` (0-based)

`position` for insert-like operations:
- `before`
- `after` (default)
- `inside_start`
- `inside_end`

## Insert Order and Footnote Rules

- When multiple operations use `insert + after` on the same `nodeId`, result order is reversed (last inserted appears first).
- For stable sequential insertion:
  - prefer `position="before"` on the same anchor; or
  - insert multiple nodes in one operation; or
  - after each insert, query new nodeId and use it as next anchor.
- Tail insertion must not happen after `footnote_list`; insert before footnote section.

## Minimal `ops.json` Template

```json
{
  "operations": [
    {
      "op": "replace",
      "target": { "nodeId": "node_to_replace" },
      "content": {
        "type": "paragraph",
        "content": [{ "type": "text", "text": "rewritten content" }]
      }
    },
    {
      "op": "insert",
      "position": "before",
      "target": { "nodeId": "anchor_node" },
      "content": {
        "type": "paragraph",
        "content": [{ "type": "text", "text": "inserted content" }]
      }
    },
    {
      "op": "paste",
      "position": "after",
      "target": { "nodeId": "anchor_node" },
      "clipboard": {
        "textMarkdown": "## markdown block\\n\\n- item A\\n- item B"
      }
    }
  ]
}
```

## Diagram Insert Notes

- DrawIO insertion uses `op="insert_drawio"` with `drawio.path`.
- Use `kmdrawio` skill to define DrawIO diagram generation and format strategy
- Mermaid insertion uses `op="insert_mermaid"` with attachment id/url or auto-create.
- PlantUML insertion uses `type="plantuml"` node with `attrs.content`.

PlantUML node example:

```json
{
  "op": "insert",
  "position": "after",
  "target": { "nodeId": "anchor_node" },
  "content": {
    "type": "plantuml",
    "attrs": {
      "content": "@startuml\\nAlice -> Bob: hello\\n@enduml",
      "width": 600,
      "height": 600
    }
  }
}
```
