---
name: kmdrawio
description: Use when users ask to generate and insert DrawIO diagrams into 学城/KM documents, including requests like 在学城合适位置插入drawIO, 在文档某段后插入drawIO图, or 生成流程图并插入到KM文档.
---

# KM DrawIO Skill

Use this skill when the user intent is DrawIO diagram generation + insertion for 学城/KM documents.

Typical trigger scenarios:
- 在学城合适位置插入drawIO
- 在 KM 文档指定段落后插入 drawIO 图
- 生成流程图/架构图并插入到当前学城文档
- 把 Mermaid/CSV 转为 DrawIO 后插入文档

## Prerequisites

Ensure the converter command is available before using this skill:

```bash
cd scripts/drawio-converter
bun install
bun run build
bun link
```

Fallback (without global link):

```bash
cd scripts/drawio-converter
bun dist/cli.js --help
```

## Format Selection Guidance

Choose input/output format by scenario:

| Type | Format | Best For |
|------|--------|----------|
| **Source Input** | **Mermaid** | Flowcharts, sequences, ERD, Gantt, state diagrams, class diagrams |
| **Source Input** | **CSV** | Hierarchical data (org charts), bulk import from spreadsheets |
| **DrawIO Content** | **XML** | Complex layouts, precise positioning, custom styling, icons, shapes |

## Workflow

1. Choose format branch:
   - Diagram DSL -> `Mermaid`
   - Structured hierarchy data -> `CSV`
   - Prebuilt drawio content -> `XML`
2. If format is `Mermaid` or `CSV`, run SVG-first conversion command (default path):
   - `drawio-converter convert --input-format <mermaid|csv> --output-format svg --input-file <input_file> --output-file <output_file.svg>`
3. If SVG conversion fails (typically CDP/browser unavailable), downgrade to `.drawio`:
   - `drawio-converter convert --input-format <mermaid|csv> --output-format drawio --input-file <input_file> --output-file <output_file.drawio>`
4. If format is `XML`, use it as drawIO source content for drawIO insertion operation (not plain-text insertion).
   - XML must start with `mxfile` as root node, and `mxfile` must include `host="km.sankuai.com"`.
5. Insert drawIO via KM edit ops operation (`insert_drawio` path), never as raw text.
6. If format is `XML` or output is `.drawio`, remind the user:
   - `.drawio` may not preview directly in current view.
   - In KM docs, the drawIO diagram itself may appear blank (not previewable) initially.
   - In 学城, double-click the drawIO diagram to enter editor, then save once (after browser rendering), and it will display normally.

## Hard Constraints

- Never insert drawIO XML as plain text/markdown paragraph content.
- Never paste `<mxfile ...>` directly into doc body as textual content.
- DrawIO content must be inserted only through KM edit ops drawIO operation (`insert_drawio` or equivalent drawIO-specific op path).

## Format Examples

### Mermaid
```
graph TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Action]
    B -->|No| D[End]
```

### XML (drawio native)
```xml
<mxfile host="km.sankuai.com" modified="" agent="5.0" etag="abc123" version="21.0.0" type="device">
  <diagram id="flowchart-1" name="Process Flow">
    <mxGraphModel>
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="2" value="Box" style="rounded=1;fillColor=#d5e8d4;" vertex="1" parent="1">
          <mxGeometry x="100" y="100" width="120" height="60" as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

### CSV (hierarchical data)
```
# label: %name%
# style: rounded=1;whiteSpace=wrap;html=1;
# connect: {"from":"manager","to":"name","invert":true}
# layout: auto
name,manager
CEO,
CTO,CEO
CFO,CEO
```


## CLI Quick Start

Inspect full options first:

```bash
drawio-converter --help
```

Core command:

```bash
drawio-converter convert --input-format <mermaid|csv> --output-format <svg|drawio> --input-file <path> --output-file <path>
```

You can also use inline text:

```bash
drawio-converter convert --input-format mermaid --output-format svg --input-text "flowchart TD\nA-->B" --output-file ./chart.svg
```

If SVG export fails, downgrade to `.drawio`:

```bash
drawio-converter convert --input-format mermaid --output-format drawio --input-text "flowchart TD\nA-->B" --output-file ./chart.drawio
```

## Runtime Notes

- SVG export depends on CDP/browser runtime.
- If CDP is unavailable, use `.drawio` output instead.
- Avoid manually rewriting compressed payload strings in generated drawio/svgs.
