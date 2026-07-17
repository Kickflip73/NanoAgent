# KM Media Path Template

Use this file to verify supported local media path styles in markdown create flow.

## DrawIO / SVG

Relative path:

![DrawIO Relative](./assets/diagram.drawio)
![SVG Relative](./assets/diagram.svg)

Absolute path:

![DrawIO Absolute](/tmp/diagram.drawio)
![SVG Absolute](/tmp/diagram.svg)

Home path:

![DrawIO Home](~/km-assets/diagram.drawio)
![SVG Home](~/km-assets/diagram.svg)

file URI:

![DrawIO File URI](file:///tmp/diagram.drawio)
![SVG File URI](file:///tmp/diagram.svg)

## Images

Relative path:

![PNG Relative](./assets/demo.png)
![JPEG Relative](./assets/demo.jpeg)

Absolute path:

![WEBP Absolute](/tmp/demo.webp)

file URI:

![GIF File URI](file:///tmp/demo.gif)

## Notes

- Remote URL images are not uploaded by markdown converter.
- Use local files only for drawIO/image references in `km create --file`.
