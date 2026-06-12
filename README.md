# Owen Mermaid

Owen Mermaid is an Obsidian plugin for viewing and editing Mermaid SVG images inside your notes.

- Detects Mermaid SVG diagrams and adds an inline glass toolbar.
- Adds a Mermaid SVG right-click menu for zoom view, editing, PNG download, and JPG download.
- Provides a full-screen pan and zoom viewer.
- Includes a flowchart-focused visual editor for creating shapes, dragging nodes, editing text, creating/editing/deleting connectors, and writing changes back to the original Mermaid code block.
- Supports PNG/JPG download settings for save location, output folder, filename template, quality, background, and scale.
- Provides a settings screen with section headers like the screenshot design.
- Supports mouse drag-and-drop Mermaid editing directly on the canvas, similar to working in Visio.
- Applies a liquid glass design tone inspired by Owen Graphite and Owen Editor.

## Screenshots

![Owen Mermaid menu](screenshot/menu.png)

![Owen Mermaid zoom viewer](screenshot/zoom.png)

![Owen Mermaid visual editor](screenshot/editor.png)

![Owen Mermaid visual editor 1](screenshot/editor-1.png)

![Owen Mermaid visual editor 2](screenshot/editor-2.png)

![Owen Mermaid visual editor 3](screenshot/editor-3.png)

![Owen Mermaid visual editor 4](screenshot/editor-4.png)

![Owen Mermaid visual editor 5](screenshot/editor-5.png)

![Owen Mermaid visual editor 6](screenshot/editor-6.png)

## Features

- Zoom rendered Mermaid SVG diagrams with a full-screen pan and zoom viewer.
- Open a visual Mermaid editor from the SVG right-click menu.
- Create, edit, drag, connect, and delete common flowchart nodes.
- Save visual editor changes back to the original Mermaid code block.
- Download rendered Mermaid SVGs as PNG or JPG.
- Use an Owen Graphite inspired liquid glass UI for settings, diagram controls, and editor panels.

## Similar Plugin Notes

The implementation was shaped by current community plugin patterns:

- `mermaid-zoom` focuses on wheel zoom, drag panning, and full-screen diagram viewing.
- `obsidian-mermaid-exporter` focuses on rendered SVG to PNG export and highlights why scoped processing is better than a long-lived global document observer.
- `mermaid-copy` shows the familiar pattern of adding actions near Obsidian's rendered Mermaid controls.

Owen Mermaid combines those surfaces and adds a visual editor path for flowchart-style diagrams.

## Usage

1. Create a Mermaid code block in an Obsidian note.
2. View the note in Reading view or Live Preview.
3. Hover a rendered Mermaid diagram to use the inline buttons.
4. Right-click the Mermaid SVG to open zoom, edit, or download actions.

The visual editor currently targets common `flowchart`/`graph` Mermaid syntax: nodes, basic shapes, labels, and connectors. Unsupported lines are preserved in the generated output section when possible.

## Development

```bash
npm install
npm run dev
npm run build
```

Manual install for testing:

```text
<vault>/.obsidian/plugins/owen-mermaid/
```

Copy `main.js`, `manifest.json`, and `styles.css` into that folder, reload Obsidian, and enable **Owen Mermaid** from Community plugins.

## Release Files

Community release assets should include:

- `manifest.json`
- `main.js`
- `styles.css`
