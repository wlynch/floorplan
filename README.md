# Floorplanner

A single-page, client-side floorplanner. Draw rooms, drop furniture (rectangles, circles/ellipses, doors with swing arcs), set exact measurements on a grid, and share a plan as a base64-encoded URL.

No server, no build step, no dependencies.

## Usage

Serve the directory over HTTP and open `index.html`:

```
python3 -m http.server 8765
open http://localhost:8765/
```

Or open `index.html` directly — most things work from `file://`, but the clipboard copy for share links falls back to a prompt.

## Features

- **Rooms** — click **Add Room**, drag on the canvas to draw.
- **Items** — **+ Add item ▾** opens a preset menu: Bed, Sofa, Table, Chair, Desk, Fridge, Toilet, Sink, Door, Round table, Round rug, or Custom…
- **Shapes** — rectangles, circles/ellipses, and doors (with swing arc + flip-hinge).
- **Precise dimensions** — sidebar inputs accept `12' 6"`, `12.5'`, `150"`, `6 1/2"`, `12ft 6in`, or `3.5m`, `380cm`, `3m 80cm` in metric.
- **Grid snap** — toggleable; `Shift` while dragging disables snap.
- **Measure tool** — click two points to show a distance.
- **Rulers** — top and left edges, adaptive to zoom.
- **Share link** — state → `deflate-raw` → base64url → copied to clipboard.
- **Export / Import** — JSON file, or paste a shared URL / base64 / raw JSON.
- **Autosave** — to `localStorage`.

## Shortcuts

| Key | Action |
| --- | --- |
| `1` | Select tool |
| `2` | Pan (move canvas) tool |
| `3` | Measure tool |
| `4` | Rotate selected item 90° |
| `Delete` / `Backspace` | Remove selection |
| `⌘/Ctrl+Z` | Undo |
| `⌘/Ctrl+Shift+Z` or `⌘/Ctrl+Y` | Redo |
| `Shift` | Disable snap while dragging |
| `Esc` | Cancel current tool / close dropdowns |
| Mouse wheel / trackpad 2-finger scroll | Zoom at cursor |
| Trackpad pinch / `Ctrl+Wheel` | Zoom at cursor |
| Drag empty canvas area | Pan |
| 3-finger drag (macOS Accessibility) / 3-finger touch | Pan |
| Middle-drag or `Space`+drag | Pan |

## Files

- `index.html` — toolbar, sidebar, SVG canvas, dialogs.
- `app.js` — state, rendering, interaction, URL encode/decode.
- `styles.css` — layout + visual styling.

## License

[Apache License 2.0](./LICENSE)
