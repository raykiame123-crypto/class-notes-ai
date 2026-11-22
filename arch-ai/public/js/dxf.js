// AutoCAD export. Writes ASCII DXF R12 (AC1009), which every AutoCAD version opens.
// Drawing units are metres ($INSUNITS = 6).
import { wallFrame, wallPieces, levelBounds, roofFaces } from "./design.js";

const LAYERS = [
  ["A-WALL", 7],
  ["A-DOOR", 3],
  ["A-GLAZ", 4],
  ["A-AREA", 8],
  ["A-AREA-IDEN", 2],
  ["A-ANNO-TTLB", 1],
  ["A-FLOR", 9],
  ["A-ROOF", 30],
];

const f = (n) => (Math.abs(n) < 1e-9 ? 0 : Math.round(n * 10000) / 10000).toString();
const ascii = (s) => String(s).normalize("NFKD").replace(/[^\x20-\x7e]/g, "");

class DxfWriter {
  constructor() {
    this.out = [];
  }
  pair(code, value) {
    this.out.push(String(code), String(value));
  }
  line(layer, x1, y1, x2, y2, z1 = 0, z2 = z1) {
    this.pair(0, "LINE");
    this.pair(8, layer);
    this.pair(10, f(x1)); this.pair(20, f(y1)); this.pair(30, f(z1));
    this.pair(11, f(x2)); this.pair(21, f(y2)); this.pair(31, f(z2));
  }
  arc(layer, cx, cy, r, startDeg, endDeg) {
    this.pair(0, "ARC");
    this.pair(8, layer);
    this.pair(10, f(cx)); this.pair(20, f(cy)); this.pair(30, 0);
    this.pair(40, f(r));
    this.pair(50, f(((startDeg % 360) + 360) % 360));
    this.pair(51, f(((endDeg % 360) + 360) % 360));
  }
  text(layer, x, y, height, value) {
    this.pair(0, "TEXT");
    this.pair(8, layer);
    this.pair(10, f(x)); this.pair(20, f(y)); this.pair(30, 0);
    this.pair(40, f(height));
    this.pair(1, ascii(value));
    this.pair(72, 4); // "Middle": centred on the alignment point
    this.pair(11, f(x)); this.pair(21, f(y)); this.pair(31, 0);
  }
  face(layer, pts) {
    const p = pts.length === 3 ? [...pts, pts[2]] : pts;
    this.pair(0, "3DFACE");
    this.pair(8, layer);
    p.forEach(([x, y, z], i) => {
      this.pair(10 + i, f(x)); this.pair(20 + i, f(y)); this.pair(30 + i, f(z));
    });
  }
  rect(layer, x, y, w, h) {
    this.line(layer, x, y, x + w, y);
    this.line(layer, x + w, y, x + w, y + h);
    this.line(layer, x + w, y + h, x, y + h);
    this.line(layer, x, y + h, x, y);
  }
  toString() {
    const head = [];
    const p = (c, v) => head.push(String(c), String(v));
    p(0, "SECTION"); p(2, "HEADER");
    p(9, "$ACADVER"); p(1, "AC1009");
    p(9, "$INSUNITS"); p(70, 6);
    p(0, "ENDSEC");
    p(0, "SECTION"); p(2, "TABLES");
    p(0, "TABLE"); p(2, "LTYPE"); p(70, 1);
    p(0, "LTYPE"); p(2, "CONTINUOUS"); p(70, 0); p(3, "Solid line"); p(72, 65); p(73, 0); p(40, 0);
    p(0, "ENDTAB");
    p(0, "TABLE"); p(2, "LAYER"); p(70, LAYERS.length);
    for (const [name, color] of LAYERS) {
      p(0, "LAYER"); p(2, name); p(70, 0); p(62, color); p(6, "CONTINUOUS");
    }
    p(0, "ENDTAB");
    p(0, "ENDSEC");
    p(0, "SECTION"); p(2, "ENTITIES");
    const tail = ["0", "ENDSEC", "0", "EOF"];
    return [...head, ...this.out, ...tail].join("\r\n") + "\r\n";
  }
}

// 2D floor plans, one per level, laid out side by side from west to east.
export function planDxf(design) {
  const dxf = new DxfWriter();
  let ox = 0;
  design.levels.forEach((level, li) => {
    const b = levelBounds(design, li);
    const dx = ox - b.minX;
    const walls = design.walls.filter((w) => w.level === li);

    for (const w of walls) {
      const { ux, uy, nx, ny } = wallFrame(w);
      const t = w.thickness / 2;
      const at = (s, side) => [w.x1 + ux * s + nx * side + dx, w.y1 + uy * s + ny * side];
      const openings = design.openings.filter((o) => o.wallId === w.id);

      // Solid wall where a full-height piece exists; gaps are the openings.
      for (const piece of wallPieces(w, openings)) {
        if (piece.z0 > 1e-6 || piece.z1 < w.height - 1e-6) continue;
        const a = at(piece.s0, t), bb = at(piece.s1, t), c = at(piece.s1, -t), d = at(piece.s0, -t);
        dxf.line("A-WALL", ...a, ...bb);
        dxf.line("A-WALL", ...bb, ...c);
        dxf.line("A-WALL", ...c, ...d);
        dxf.line("A-WALL", ...d, ...a);
      }

      for (const o of openings) {
        const s0 = o.offset - o.width / 2;
        const s1 = o.offset + o.width / 2;
        if (o.type === "door") {
          const [hx, hy] = at(s0, t);
          dxf.line("A-DOOR", hx, hy, hx + nx * o.width, hy + ny * o.width);
          const start = (Math.atan2(uy, ux) * 180) / Math.PI;
          dxf.arc("A-DOOR", hx, hy, o.width, start, start + 90);
        } else {
          for (const side of [t, t / 4, -t / 4, -t]) dxf.line("A-GLAZ", ...at(s0, side), ...at(s1, side));
        }
      }
    }

    for (const r of design.rooms.filter((r) => r.level === li)) {
      dxf.rect("A-AREA", r.x + dx, r.y, r.width, r.depth);
      const cx = r.x + r.width / 2 + dx;
      const cy = r.y + r.depth / 2;
      const size = Math.min(0.3, Math.max(0.12, Math.min(r.width, r.depth) / 8));
      dxf.text("A-AREA-IDEN", cx, cy + size * 0.8, size, r.name);
      dxf.text("A-AREA-IDEN", cx, cy - size * 0.8, size * 0.75, `${(r.width * r.depth).toFixed(1)} m2`);
    }

    dxf.text("A-ANNO-TTLB", (b.minX + b.maxX) / 2 + dx, b.maxY + 1.2, 0.5, `${design.name} - ${level.name}`);
    ox += b.maxX - b.minX + 6;
  });
  return dxf.toString();
}

// Full 3D model as 3DFACE surfaces: walls (with openings cut), floors and roof.
export function modelDxf(design) {
  const dxf = new DxfWriter();
  const box = (layer, corners) => {
    const [a, b, c, d, e, g, h, k] = corners; // bottom a b c d, top e g h k
    dxf.face(layer, [a, b, c, d]);
    dxf.face(layer, [e, g, h, k]);
    dxf.face(layer, [a, b, g, e]);
    dxf.face(layer, [b, c, h, g]);
    dxf.face(layer, [c, d, k, h]);
    dxf.face(layer, [d, a, e, k]);
  };

  for (const w of design.walls) {
    const z = design.levels[w.level].elevation;
    const { ux, uy, nx, ny } = wallFrame(w);
    const t = w.thickness / 2;
    const at = (s, side, zz) => [w.x1 + ux * s + nx * side, w.y1 + uy * s + ny * side, z + zz];
    const openings = design.openings.filter((o) => o.wallId === w.id);
    for (const p of wallPieces(w, openings)) {
      box("A-WALL", [
        at(p.s0, t, p.z0), at(p.s1, t, p.z0), at(p.s1, -t, p.z0), at(p.s0, -t, p.z0),
        at(p.s0, t, p.z1), at(p.s1, t, p.z1), at(p.s1, -t, p.z1), at(p.s0, -t, p.z1),
      ]);
    }
    for (const o of openings.filter((o) => o.type === "window")) {
      const s0 = o.offset - o.width / 2, s1 = o.offset + o.width / 2;
      dxf.face("A-GLAZ", [at(s0, 0, o.sill), at(s1, 0, o.sill), at(s1, 0, o.sill + o.height), at(s0, 0, o.sill + o.height)]);
    }
  }

  for (const r of design.rooms) {
    const z = design.levels[r.level].elevation;
    dxf.face("A-FLOR", [[r.x, r.y, z], [r.x + r.width, r.y, z], [r.x + r.width, r.y + r.depth, z], [r.x, r.y + r.depth, z]]);
  }

  for (const face of roofFaces(design)) dxf.face(face.part === "gable" ? "A-WALL" : "A-ROOF", face.pts);
  return dxf.toString();
}
