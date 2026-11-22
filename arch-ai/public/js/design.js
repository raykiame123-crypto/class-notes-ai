// The building model shared by the editor, the 3D view and the DXF export.
// Units: metres. Plan x = east, plan y = north.

export const FLOORS = ["wood", "tile", "concrete", "carpet", "stone"];
export const GRID = 0.05;

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
export const snap = (v, step = GRID) => Math.round(v / step) * step;
export const round = (v) => Math.round(v * 1000) / 1000;

export function wallLength(w) {
  return Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
}

// Unit direction along the wall and the left-hand normal.
export function wallFrame(w) {
  const L = wallLength(w) || 1;
  const ux = (w.x2 - w.x1) / L;
  const uy = (w.y2 - w.y1) / L;
  return { L, ux, uy, nx: -uy, ny: ux };
}

export function newId(design, prefix) {
  const used = new Set([...design.walls, ...design.openings, ...design.rooms].map((o) => o.id));
  let i = 1;
  while (used.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

// Clean up anything the AI (or an edit) produced so the rest of the app can trust it.
export function normalize(input) {
  const d = structuredClone(input ?? {});
  d.name = String(d.name || "Untitled design");
  d.notes = String(d.notes || "");

  d.levels = Array.isArray(d.levels) && d.levels.length ? d.levels : [{ name: "Ground floor", elevation: 0, height: 3 }];
  d.levels = d.levels.map((l, i) => ({
    name: String(l.name || `Level ${i}`),
    elevation: num(l.elevation, i * 3),
    height: Math.max(2, num(l.height, 3)),
  }));
  const maxLevel = d.levels.length - 1;
  const clampLevel = (v) => Math.min(maxLevel, Math.max(0, Math.round(num(v, 0))));

  const seen = new Set();
  const uniq = (id, prefix) => {
    let s = String(id || "");
    if (!s || seen.has(s)) {
      let i = 1;
      while (seen.has(`${prefix}${i}`)) i++;
      s = `${prefix}${i}`;
    }
    seen.add(s);
    return s;
  };

  d.walls = (Array.isArray(d.walls) ? d.walls : [])
    .map((w) => {
      const level = clampLevel(w.level);
      return {
        id: w.id,
        level,
        x1: round(num(w.x1, 0)),
        y1: round(num(w.y1, 0)),
        x2: round(num(w.x2, 0)),
        y2: round(num(w.y2, 0)),
        thickness: Math.min(1, Math.max(0.05, num(w.thickness, w.exterior ? 0.3 : 0.12))),
        height: Math.max(0.3, num(w.height, d.levels[level].height)),
        exterior: Boolean(w.exterior),
      };
    })
    .filter((w) => wallLength(w) > 0.05)
    .map((w) => ({ ...w, id: uniq(w.id, "w") }));

  const wallsById = new Map(d.walls.map((w) => [w.id, w]));
  d.openings = (Array.isArray(d.openings) ? d.openings : [])
    .filter((o) => wallsById.has(String(o.wallId)))
    .map((o) => {
      const wall = wallsById.get(String(o.wallId));
      const L = wallLength(wall);
      const type = o.type === "window" ? "window" : "door";
      const width = Math.min(Math.max(0.3, num(o.width, type === "door" ? 0.9 : 1.2)), Math.max(0.3, L - 0.1));
      const sill = type === "door" ? 0 : Math.max(0, num(o.sill, 0.9));
      const height = Math.min(Math.max(0.3, num(o.height, type === "door" ? 2.1 : 1.2)), wall.height - sill - 0.05);
      const offset = Math.min(Math.max(width / 2, num(o.offset, L / 2)), L - width / 2);
      return { id: o.id, wallId: wall.id, type, offset: round(offset), width: round(width), height: round(height), sill: round(sill) };
    })
    .map((o) => ({ ...o, id: uniq(o.id, o.type === "door" ? "d" : "win") }));

  d.rooms = (Array.isArray(d.rooms) ? d.rooms : [])
    .map((r) => {
      let { x, y, width, depth } = { x: num(r.x, 0), y: num(r.y, 0), width: num(r.width, 3), depth: num(r.depth, 3) };
      if (width < 0) (x += width), (width = -width);
      if (depth < 0) (y += depth), (depth = -depth);
      return {
        id: r.id,
        level: clampLevel(r.level),
        name: String(r.name || "Room"),
        x: round(x),
        y: round(y),
        width: round(Math.max(0.3, width)),
        depth: round(Math.max(0.3, depth)),
        floor: FLOORS.includes(r.floor) ? r.floor : "wood",
      };
    })
    .map((r) => ({ ...r, id: uniq(r.id, "r") }));

  const roof = d.roof ?? {};
  d.roof = {
    type: ["flat", "gable", "none"].includes(roof.type) ? roof.type : "flat",
    pitch: Math.min(60, Math.max(5, num(roof.pitch, 30))),
    overhang: Math.min(2, Math.max(0, num(roof.overhang, 0.4))),
  };
  return d;
}

// Split a wall into solid boxes around its openings.
// Each piece: { s0, s1 } along the wall (metres from x1,y1) and { z0, z1 } heights above its floor.
// Wall ends are extended by half the thickness so corners close.
export function wallPieces(wall, openings) {
  const L = wallLength(wall);
  const H = wall.height;
  const ext = wall.thickness / 2;
  const spans = openings
    .filter((o) => o.wallId === wall.id)
    .map((o) => ({ a: o.offset - o.width / 2, b: o.offset + o.width / 2, o }))
    .sort((p, q) => p.a - q.a);

  const pieces = [];
  let cursor = -ext;
  for (const { a: a0, b, o } of spans) {
    const a = Math.max(a0, cursor);
    if (b <= a) continue;
    if (a > cursor + 1e-6) pieces.push({ s0: cursor, s1: a, z0: 0, z1: H });
    if (o.sill > 1e-6) pieces.push({ s0: a, s1: b, z0: 0, z1: o.sill });
    const top = o.sill + o.height;
    if (top < H - 1e-6) pieces.push({ s0: a, s1: b, z0: top, z1: H });
    cursor = b;
  }
  if (L + ext > cursor + 1e-6) pieces.push({ s0: cursor, s1: L + ext, z0: 0, z1: H });
  return pieces;
}

export function levelBounds(design, level) {
  const walls = design.walls.filter((w) => w.level === level);
  const src = walls.length ? walls : design.walls;
  if (!src.length) return { minX: 0, minY: 0, maxX: 10, maxY: 8 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const w of src) {
    const t = w.thickness / 2;
    minX = Math.min(minX, w.x1 - t, w.x2 - t);
    maxX = Math.max(maxX, w.x1 + t, w.x2 + t);
    minY = Math.min(minY, w.y1 - t, w.y2 - t);
    maxY = Math.max(maxY, w.y1 + t, w.y2 + t);
  }
  return { minX, minY, maxX, maxY };
}

export function designBounds(design) {
  const all = design.levels.map((_, i) => levelBounds(design, i));
  return {
    minX: Math.min(...all.map((b) => b.minX)),
    minY: Math.min(...all.map((b) => b.minY)),
    maxX: Math.max(...all.map((b) => b.maxX)),
    maxY: Math.max(...all.map((b) => b.maxY)),
  };
}

// Roof surfaces as 3D polygons in plan coordinates [x, y, z], shared by the 3D view and the 3D DXF.
export function roofFaces(design) {
  const { roof } = design;
  if (roof.type === "none" || !design.walls.length) return [];
  const top = design.levels.length - 1;
  const lvl = design.levels[top];
  const b = levelBounds(design, top);
  const z = lvl.elevation + lvl.height;
  const ov = roof.overhang;
  const x0 = b.minX - ov, x1 = b.maxX + ov, y0 = b.minY - ov, y1 = b.maxY + ov;

  if (roof.type === "flat") {
    const zt = z + 0.25;
    return [
      { part: "roof", pts: [[x0, y0, zt], [x1, y0, zt], [x1, y1, zt], [x0, y1, zt]] },
      { part: "roof", pts: [[x0, y0, z], [x1, y0, z], [x1, y0, zt], [x0, y0, zt]] },
      { part: "roof", pts: [[x1, y0, z], [x1, y1, z], [x1, y1, zt], [x1, y0, zt]] },
      { part: "roof", pts: [[x1, y1, z], [x0, y1, z], [x0, y1, zt], [x1, y1, zt]] },
      { part: "roof", pts: [[x0, y1, z], [x0, y0, z], [x0, y0, zt], [x0, y1, zt]] },
      { part: "roof", pts: [[x0, y0, z], [x0, y1, z], [x1, y1, z], [x1, y0, z]] },
    ];
  }

  const tan = Math.tan((roof.pitch * Math.PI) / 180);
  if (b.maxX - b.minX >= b.maxY - b.minY) {
    // Ridge runs east-west.
    const ym = (b.minY + b.maxY) / 2;
    const ridge = z + (ym - b.minY) * tan;
    const eave = z - ov * tan;
    return [
      { part: "roof", pts: [[x0, y0, eave], [x1, y0, eave], [x1, ym, ridge], [x0, ym, ridge]] },
      { part: "roof", pts: [[x1, y1, eave], [x0, y1, eave], [x0, ym, ridge], [x1, ym, ridge]] },
      { part: "gable", pts: [[b.minX, b.minY, z], [b.minX, b.maxY, z], [b.minX, ym, ridge]] },
      { part: "gable", pts: [[b.maxX, b.maxY, z], [b.maxX, b.minY, z], [b.maxX, ym, ridge]] },
    ];
  }
  // Ridge runs north-south.
  const xm = (b.minX + b.maxX) / 2;
  const ridge = z + (xm - b.minX) * tan;
  const eave = z - ov * tan;
  return [
    { part: "roof", pts: [[x0, y1, eave], [x0, y0, eave], [xm, y0, ridge], [xm, y1, ridge]] },
    { part: "roof", pts: [[x1, y0, eave], [x1, y1, eave], [xm, y1, ridge], [xm, y0, ridge]] },
    { part: "gable", pts: [[b.maxX, b.minY, z], [b.minX, b.minY, z], [xm, b.minY, ridge]] },
    { part: "gable", pts: [[b.minX, b.maxY, z], [b.maxX, b.maxY, z], [xm, b.maxY, ridge]] },
  ];
}

// ---------------------------------------------------------------------------
// Example: two-storey family house, 12 x 9 m, so the app is usable without an API key.

const ext = (id, level, x1, y1, x2, y2, h) => ({ id, level, x1, y1, x2, y2, thickness: 0.3, height: h, exterior: true });
const int = (id, level, x1, y1, x2, y2, h) => ({ id, level, x1, y1, x2, y2, thickness: 0.12, height: h, exterior: false });
const door = (id, wallId, offset, width = 0.9, height = 2.1) => ({ id, wallId, type: "door", offset, width, height, sill: 0 });
const win = (id, wallId, offset, width, height = 1.4, sill = 0.9) => ({ id, wallId, type: "window", offset, width, height, sill });
const room = (id, level, name, x, y, width, depth, floor = "wood") => ({ id, level, name, x, y, width, depth, floor });

export const EXAMPLE = normalize({
  name: "Family house (example)",
  notes:
    "Two-storey 12 x 9 m house. Open living and kitchen on the west side of the ground floor, entrance hall, WC, storage and study on the east. Four rooms upstairs around a landing at the top of the stairs. Check stair geometry and structure before detailing.",
  levels: [
    { name: "Ground floor", elevation: 0, height: 3 },
    { name: "First floor", elevation: 3, height: 2.8 },
  ],
  walls: [
    ext("w1", 0, 0, 0, 12, 0, 3), ext("w2", 0, 12, 0, 12, 9, 3), ext("w3", 0, 12, 9, 0, 9, 3), ext("w4", 0, 0, 9, 0, 0, 3),
    int("w5", 0, 7, 0, 7, 9, 3), int("w6", 0, 7, 4, 12, 4, 3), int("w7", 0, 9, 4, 9, 6, 3), int("w8", 0, 7, 6, 12, 6, 3),
    ext("w9", 1, 0, 0, 12, 0, 2.8), ext("w10", 1, 12, 0, 12, 9, 2.8), ext("w11", 1, 12, 9, 0, 9, 2.8), ext("w12", 1, 0, 9, 0, 0, 2.8),
    int("w13", 1, 4.5, 0, 4.5, 9, 2.8), int("w14", 1, 5.9, 0, 5.9, 4, 2.8), int("w15", 1, 5.9, 5.4, 5.9, 9, 2.8),
    int("w16", 1, 5.9, 4, 10.8, 4, 2.8), int("w17", 1, 5.9, 5.4, 12, 5.4, 2.8), int("w18", 1, 9, 5.4, 9, 9, 2.8),
    int("w19", 1, 10.8, 0, 10.8, 4, 2.8),
  ],
  openings: [
    door("d1", "w1", 8.9, 1.0, 2.2), win("win1", "w1", 2, 2.4), win("win2", "w1", 5.3, 1.6),
    win("win3", "w4", 2, 1.8), win("win4", "w4", 6.5, 2.0),
    win("win5", "w3", 2.5, 2.0), win("win6", "w3", 8.5, 2.4),
    win("win7", "w2", 2, 1.0, 1.0, 1.2), win("win8", "w2", 7.5, 1.5),
    door("d2", "w5", 2), door("d3", "w5", 7.5), door("d4", "w6", 1, 0.8), door("d5", "w6", 3, 0.8),
    win("win9", "w9", 2.25, 1.8), win("win10", "w9", 8.35, 1.8),
    win("win11", "w12", 2.25, 1.8), win("win12", "w12", 6.75, 1.2),
    win("win13", "w11", 1.5, 1.4), win("win14", "w11", 4.5, 1.0, 0.8, 1.4), win("win15", "w11", 9.75, 2.0),
    win("win16", "w10", 2, 1.0, 1.0, 1.2), win("win17", "w10", 7.2, 1.2),
    door("d6", "w13", 3.5), door("d7", "w13", 6), door("d8", "w14", 2), door("d9", "w15", 1.5, 0.8), door("d10", "w17", 4.5),
  ],
  rooms: [
    room("r1", 0, "Living", 0, 0, 7, 5), room("r2", 0, "Kitchen / Dining", 0, 5, 7, 4, "tile"),
    room("r3", 0, "Hall", 7, 0, 3.8, 4, "stone"), room("r4", 0, "Stairs", 10.8, 0, 1.2, 4, "stone"),
    room("r5", 0, "WC", 7, 4, 2, 2, "tile"), room("r6", 0, "Storage", 9, 4, 3, 2, "concrete"),
    room("r7", 0, "Study", 7, 6, 5, 3),
    room("r8", 1, "Bedroom 2", 0, 0, 4.5, 4.5, "carpet"), room("r9", 1, "Master bedroom", 0, 4.5, 4.5, 4.5, "carpet"),
    room("r10", 1, "Corridor", 4.5, 0, 1.4, 9), room("r11", 1, "Bedroom 3", 5.9, 0, 4.9, 4, "carpet"),
    room("r12", 1, "Stairs", 10.8, 0, 1.2, 4, "stone"), room("r13", 1, "Landing", 5.9, 4, 6.1, 1.4),
    room("r14", 1, "Bathroom", 5.9, 5.4, 3.1, 3.6, "tile"), room("r15", 1, "Bedroom 4", 9, 5.4, 3, 3.6, "carpet"),
  ],
  roof: { type: "gable", pitch: 30, overhang: 0.4 },
});
