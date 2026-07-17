# KM Extended Markdown Formats

Extended formats supported by `km create --file`, beyond standard Markdown.

## Todo List

- `- [ ]` unchecked, `- [x]` checked

- [ ] Confirm target space/parent
- [x] Create backup strategy
- [ ] Add owner and update cadence

## LaTeX Formula

- Inline: `$formula$`
- Block: `$$formula$$`

Inline: $E = mc^2$

$$
\frac{\partial f}{\partial x} = \lim_{h \to 0}\frac{f(x+h)-f(x)}{h}
$$

## PlantUML

- Fenced code block with language `plantuml`

```plantuml
@startuml
actor User
participant KM
User -> KM: create doc
KM --> User: done
@enduml
```

## DrawIO / SVG (Local File Reference)

- Generate with `kmdrawio` skill first, then reference the local file

![Architecture DrawIO](./diagram.drawio)
![Architecture SVG](./diagram.svg)

## Image (Local File Reference)

- Supported: `.png` `.jpg` `.jpeg` `.gif` `.webp`

![System Overview](./images/overview.png)
![Flow Snapshot](./images/flow.jpg)

## Constraints

- **Local paths only** (relative, absolute, `~/`, `file://`). Remote `http(s)://` URLs are **not** uploaded — they render as an error placeholder.
- **Inline HTML**: only `<u>`, `<sup>`, `<sub>` tags are rendered; all other HTML is escaped.
