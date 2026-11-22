# Arch AI Studio

An AI architect in the browser:

1. **Describe** the building ("two-storey house, 3 bedrooms, open kitchen, gable roof").
2. **The AI designs it**: Claude returns a real model with walls, doors, windows, rooms, storeys and a roof, all measured in metres.
3. **Edit it in 3D**: select, drag and resize walls, doors, windows and rooms, draw new walls and rooms, add storeys. You can also ask the AI for changes ("make the kitchen bigger").
4. **Export to AutoCAD**:
   - **Plan DXF**: 2D floor plans, one per storey, side by side, with door swings, windows, room names and areas.
   - **3D DXF**: the full 3D model (walls with openings cut out, floors, roof) as 3DFACE surfaces.

   Both files are DXF R12 in metres, using standard layers: `A-WALL`, `A-DOOR`, `A-GLAZ`, `A-AREA`, `A-AREA-IDEN`, `A-FLOR`, `A-ROOF`, `A-ANNO-TTLB`.
5. **Render**: builds the whole building with materials, sun and shadows. Use **Save image** to download a PNG.

## Run it

You need Node.js 20+ and an Anthropic API key.

```bash
cd arch-ai
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
```

Open http://localhost:3001. Without a key everything still works except the two AI buttons, and the built-in example house loads.

## Editing controls

| Action | How |
| --- | --- |
| Select / move | `V`, then click and drag a wall, door, window or room |
| Move a wall end | Select the wall, drag a yellow handle (hold `Shift` for any angle) |
| Draw walls | `W`, then click, click… `Esc` to stop |
| Door / window | `D` / `N`, then click a wall |
| Room | `R`, then drag on the floor |
| Delete / undo / redo | `Del` / `Ctrl+Z` / `Ctrl+Y` |
| Orbit / pan / zoom | Drag empty space / right-drag / scroll |

Connected wall corners stay joined when you move walls. Exact values can be typed into the panel on the right. Your work is autosaved in the browser, and **Save** / **Open** keep a `.json` copy.

## Files

- `server.js`: Express server. `POST /api/design` asks Claude (structured JSON output) for a new design or a revised one.
- `public/js/design.js`: the building model, cleanup of AI output, wall/opening geometry and the example house.
- `public/js/scene.js`: the three.js 3D view and render mode.
- `public/js/main.js`: the editor: tools, dragging, properties, undo, AI calls, export.
- `public/js/dxf.js`: the AutoCAD DXF writer.
