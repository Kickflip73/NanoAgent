# morandi-journal

Hand-drawn infographic illustration with warm Morandi color tones. This style family has two preserved variants:

- `cozy-journal`: the original decorative bullet-journal feel.
- `plain-sketch`: the restrained technical sketch feel for architecture and business diagrams.

## Color Palette

- Background: Warm cream/beige with subtle paper texture (#F5F0E6)
- Primary: Muted teal/sage green (#7BA3A8) for headers and frames
- Secondary: Warm terracotta/orange (#D4956A) for highlights and numbers
- Line art: Dark charcoal brown (#4A4540)
- Soft highlights: Pale yellow (#F5E6C8)

## Visual Elements

- Hand-drawn line work with organic, slightly imperfect ink lines
- Rounded card containers for grouped concepts, modules, or option items
- Hand-drawn rulers, scales, progress bars, and timelines when they explain the content
- Hand-drawn smiley/frowny face symbols as quality markers; draw them as ink icons, not system emoji glyphs
- Dotted line frames around sections
- Connecting arrows and dotted lines between modules
- Wavy line dividers or thin dotted separators between sections
- Small line icons that clarify the meaning of a section

## Variants

| Variant | Focus | Visual Emphasis |
|---------|-------|-----------------|
| **cozy-journal** | Maximum warmth | Washi tape, stickers, decorative doodles, callout bubbles, playful journal density |
| **plain-sketch** | Readability and structure | Cleaner lines, plain cards, restrained accents, no decorative-only elements |

## Selection Rule

- Use `plain-sketch` by default for technical architecture, agent systems, data flows, governance, security, internal review, business process, and system diagrams.
- Use `cozy-journal` by default for warm knowledge cards, consumer-facing education, lifestyle content, social posts, and decorative explainers.
- If the user names a variant, follow the user.

## Variant Prompt Block: cozy-journal

Use this block when the selected variant is `cozy-journal`.

- Warm and cozy bullet journal feel with rich but still organized hand-drawn decoration.
- Hand-drawn doodle illustration, organic imperfect ink lines, dotted frames, wavy dividers, washi tape strips, rounded cards, callout bubbles, and tiny stars/clouds/sparkles as small decorations.
- Washi tape strip decorations may use diagonal beige/brown patterns.
- Corner decorations may include tiny houses, stars, sparkles, and clouds if they do not block content.
- Main title: bold hand-lettered style with mild decorative flourishes.
- Module headers: neat handwritten white text on dark teal rounded badges.
- Body labels: clear handwritten print style.
- Icons may include hand-drawn magnifying glass, thumbs up/down, small tool icons, and quality markers.
- Keep all decoration secondary to the explanation; labels must remain readable.

## Variant Prompt Block: plain-sketch

Use this block when the selected variant is `plain-sketch`.

- Quiet, utilitarian, work-focused technical sketch.
- Warm cream background should be nearly flat; paper texture must be very subtle.
- Use muted teal/sage green for section headers and card borders.
- Use terracotta/orange only for key highlights, important numbers, deadlines, or safety boundaries.
- Use dark charcoal brown for hand-drawn lines and text.
- Plain rounded cards, thin dotted separators, clean arrows, and moderate whitespace.
- Simple hand-printed title and labels; avoid brush calligraphy and decorative title banners.
- Use at most one small line icon per section.
- No decorative-only elements: no stars, sparkles, clouds, hearts, trophies, laurels, stickers, cute mascot faces, tape corners, washi tape, decorative flourishes, oversized props, busy background, large banners, system emoji glyphs, watermark, logo, or QR code.
- Preserve the Morandi hand-drawn warmth through line texture and palette, not through decoration.

## Typography

- Main title: Hand-lettered and readable; use decorative flourishes only for `cozy-journal`
- Module headers: Clean handwritten text in white on dark teal rounded badge (#6B9080)
- Body text: Neat handwritten print style, easy to read
- Numbers: Highlighted in terracotta (#D4956A), slightly larger than body

## Style Enforcement

- All imagery must maintain hand-drawn/sketch aesthetic—no digital precision
- Organic, slightly imperfect shapes throughout
- Sketch-like quality with visible line weight variations
- Warm Morandi feel, not clinical or corporate
- In `plain-sketch`, keep the page restrained and work-focused while still visibly hand-drawn

## Avoid

- Flat vector icons or system emoji glyphs
- Overly clean geometric shapes
- Stock illustration style
- Strict grid layout with no hand-drawn texture
- Pure white background
- Digital/corporate look
- Mixing `cozy-journal` decorations into a `plain-sketch` request

## Best For

- `cozy-journal`: product selection guides, lifestyle content, educational overviews, consumer-facing comparison content, Xiaohongshu-style posts
- `plain-sketch`: architecture diagrams, agent workflows, internal business diagrams, data-governance boundaries, system/process explanations
