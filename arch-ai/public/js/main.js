import { Viewer } from "./scene.js";
import { normalize, EXAMPLE, FLOORS, newId, snap, round, wallLength, wallFrame } from "./design.js";
import { planDxf, modelDxf } from "./dxf.js";

const $ = (s) => document.querySelector(s);
const STORE_KEY = "arch-ai-design";
const SNAP_RADIUS = 0.3;

const viewer = new Viewer($("#viewport"));
const canvas = viewer.renderer.domElement;

const state = {
  design: null,
  undo: [],
  redo: [],
  level: 0,
  tool: "select",
  selection: null,
  ghostLower: true,
  showRoof: false,
  ortho: true,
  render: false,
  drawStart: null, // wall / room tools
  drag: null,
};

const HINTS = {
  select: "Click to select · drag to move · drag a wall's yellow handles to move its ends · drag empty space to orbit, right-drag to pan, scroll to zoom",
  wall: "Click to start a wall, click again to finish it (walls chain). Esc or right-click to stop. Snaps to wall ends.",
  door: "Click on a wall to place a door.",
  window: "Click on a wall to place a window.",
  room: "Drag on the floor to draw a room.",
};

// ---------------------------------------------------------------------------
// State changes

function load(design, { keepView = false } = {}) {
  state.design = normalize(design);
  state.level = Math.min(state.level, state.design.levels.length - 1);
  state.selection = null;
  refresh();
  if (!keepView) viewer.frame("3d");
}

function snapshot() {
  return JSON.stringify(state.design);
}

function commit(mutate) {
  const before = snapshot();
  mutate(state.design);
  state.design = normalize(state.design);
  if (snapshot() !== before) {
    state.undo.push(before);
    if (state.undo.length > 200) state.undo.shift();
    state.redo = [];
  }
  validateSelection();
  refresh();
}

function undo() {
  if (!state.undo.length) return;
  state.redo.push(snapshot());
  state.design = JSON.parse(state.undo.pop());
  state.level = Math.min(state.level, state.design.levels.length - 1);
  validateSelection();
  refresh();
}

function redo() {
  if (!state.redo.length) return;
  state.undo.push(snapshot());
  state.design = JSON.parse(state.redo.pop());
  validateSelection();
  refresh();
}

function find(kind, id, d = state.design) {
  const list = kind === "wall" ? d.walls : kind === "opening" ? d.openings : kind === "room" ? d.rooms : [];
  return list.find((o) => o.id === id);
}

function validateSelection() {
  if (state.selection && !find(state.selection.kind, state.selection.id)) state.selection = null;
}

function select(sel) {
  state.selection = sel;
  refresh();
}

function refresh() {
  const d = state.design;
  viewer.build(d, { activeLevel: state.level, ghostLower: state.ghostLower, showRoof: state.showRoof, selection: state.selection });
  viewer.setGridLevel(d.levels[state.level].elevation);
  $("#projectName").value = d.name;
  $("#notes").textContent = d.notes || "No notes yet.";
  $("#btnUndo").disabled = !state.undo.length;
  $("#btnRedo").disabled = !state.redo.length;
  $("#btnDelete").disabled = !state.selection;
  renderLevels();
  renderProps();
  try {
    localStorage.setItem(STORE_KEY, snapshot());
  } catch {}
}

function setTool(tool) {
  state.tool = tool;
  state.drawStart = null;
  viewer.setPreview(null);
  document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
  $("#viewport").className = `viewport tool-${tool}`;
  $("#hint").textContent = HINTS[tool];
}

// ---------------------------------------------------------------------------
// Geometry helpers for editing

const elevation = () => state.design.levels[state.level].elevation;
const levelWalls = () => state.design.walls.filter((w) => w.level === state.level);

// Snap a plan point to a nearby wall end on the active level, else to the grid.
function snapPoint(p, excludeWallId) {
  let best = null, bestD = SNAP_RADIUS;
  for (const w of levelWalls()) {
    if (w.id === excludeWallId) continue;
    for (const [x, y] of [[w.x1, w.y1], [w.x2, w.y2]]) {
      const dist = Math.hypot(p.x - x, p.y - y);
      if (dist < bestD) (bestD = dist), (best = { x, y });
    }
  }
  return best ?? { x: round(snap(p.x)), y: round(snap(p.y)) };
}

function orthoFrom(start, p) {
  if (!state.ortho || !start) return p;
  return Math.abs(p.x - start.x) >= Math.abs(p.y - start.y) ? { x: p.x, y: start.y } : { x: start.x, y: p.y };
}

// Other wall ends on the same level that touch this point (so corners stay joined while dragging).
function jointsAt(design, level, x, y, excludeId) {
  const out = [];
  for (const w of design.walls) {
    if (w.level !== level || w.id === excludeId) continue;
    if (Math.hypot(w.x1 - x, w.y1 - y) < 0.02) out.push({ id: w.id, end: 1 });
    if (Math.hypot(w.x2 - x, w.y2 - y) < 0.02) out.push({ id: w.id, end: 2 });
  }
  return out;
}

function offsetOnWall(wall, p) {
  const { ux, uy } = wallFrame(wall);
  return (p.x - wall.x1) * ux + (p.y - wall.y1) * uy;
}

function addOpening(design, wall, type, offset) {
  const width = type === "door" ? (wall.exterior ? 1.0 : 0.9) : 1.2;
  const id = newId(design, type === "door" ? "d" : "win");
  design.openings.push({
    id,
    wallId: wall.id,
    type,
    offset: round(snap(offset)),
    width,
    height: type === "door" ? 2.1 : 1.4,
    sill: type === "door" ? 0 : 0.9,
  });
  return id;
}

// ---------------------------------------------------------------------------
// Pointer interaction

canvas.addEventListener("contextmenu", (e) => {
  if (state.tool === "wall" && state.drawStart) e.preventDefault();
  state.drawStart = null;
  viewer.setPreview(null);
});

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || state.render) return;
  const ground = viewer.groundPoint(e, elevation());

  if (state.tool === "select") {
    const hit = viewer.pick(e);
    if (!hit) {
      if (state.selection) select(null);
      return;
    }
    if (hit.kind === "handle") {
      startDrag(e, { type: "handle", id: hit.id, end: hit.end });
      return;
    }
    if (!state.selection || state.selection.kind !== hit.kind || state.selection.id !== hit.id) select({ kind: hit.kind, id: hit.id });
    if (ground) startDrag(e, { type: "move", kind: hit.kind, id: hit.id, start: ground });
    return;
  }

  if (state.tool === "door" || state.tool === "window") {
    const hit = viewer.pick(e, ["wall", "opening"]);
    if (!hit) return;
    const wallId = hit.kind === "wall" ? hit.id : find("opening", hit.id).wallId;
    let newSel;
    commit((d) => {
      const wall = d.walls.find((w) => w.id === wallId);
      newSel = addOpening(d, wall, state.tool, offsetOnWall(wall, hit.point));
    });
    select({ kind: "opening", id: newSel });
    return;
  }

  if (!ground) return;
  if (state.tool === "wall") {
    const p = state.drawStart ? snapPoint(orthoFrom(state.drawStart, ground)) : snapPoint(ground);
    if (!state.drawStart) {
      state.drawStart = p;
      return;
    }
    const a = state.drawStart;
    if (Math.hypot(p.x - a.x, p.y - a.y) > 0.05) {
      const lvl = state.design.levels[state.level];
      commit((d) => {
        d.walls.push({ id: newId(d, "w"), level: state.level, x1: a.x, y1: a.y, x2: p.x, y2: p.y, thickness: 0.12, height: lvl.height, exterior: false });
      });
      state.drawStart = p;
    }
    return;
  }

  if (state.tool === "room") {
    state.drawStart = { x: round(snap(ground.x)), y: round(snap(ground.y)) };
    canvas.setPointerCapture(e.pointerId);
    viewer.controls.enabled = false;
  }
});

function startDrag(e, drag) {
  drag.before = snapshot();
  drag.orig = structuredClone(state.design);
  state.drag = drag;
  viewer.controls.enabled = false;
  canvas.setPointerCapture(e.pointerId);
}

canvas.addEventListener("pointermove", (e) => {
  const ground = viewer.groundPoint(e, elevation());
  if (ground) $("#coords").textContent = `x ${ground.x.toFixed(2)} m   y ${ground.y.toFixed(2)} m`;
  if (state.render || !ground) return;

  if (state.drag) {
    dragTo(ground, e);
    return;
  }
  if (state.tool === "wall" && state.drawStart) {
    const p = snapPoint(orthoFrom(state.drawStart, ground));
    const len = Math.hypot(p.x - state.drawStart.x, p.y - state.drawStart.y);
    viewer.setPreview("wall", { x1: state.drawStart.x, y1: state.drawStart.y, x2: p.x, y2: p.y, thickness: 0.12, height: state.design.levels[state.level].height, elevation: elevation() });
    $("#coords").textContent = `length ${len.toFixed(2)} m`;
  }
  if (state.tool === "room" && state.drawStart) {
    const r = roomRect(state.drawStart, ground);
    viewer.setPreview("room", { ...r, elevation: elevation() });
    $("#coords").textContent = `${r.width.toFixed(2)} × ${r.depth.toFixed(2)} m = ${(r.width * r.depth).toFixed(1)} m²`;
  }
});

function roomRect(a, p) {
  const b = { x: round(snap(p.x)), y: round(snap(p.y)) };
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: round(Math.abs(b.x - a.x)), depth: round(Math.abs(b.y - a.y)) };
}

function dragTo(ground, e) {
  const drag = state.drag;
  const d = structuredClone(drag.orig);

  if (drag.type === "handle") {
    const w = d.walls.find((x) => x.id === drag.id);
    const other = drag.end === 1 ? { x: w.x2, y: w.y2 } : { x: w.x1, y: w.y1 };
    const p = snapPoint(e.shiftKey ? ground : orthoFrom(other, ground), w.id);
    const ox = w[`x${drag.end}`], oy = w[`y${drag.end}`];
    for (const j of jointsAt(d, w.level, ox, oy, w.id)) {
      const jw = d.walls.find((x) => x.id === j.id);
      jw[`x${j.end}`] = p.x;
      jw[`y${j.end}`] = p.y;
    }
    w[`x${drag.end}`] = p.x;
    w[`y${drag.end}`] = p.y;
  } else if (drag.kind === "opening") {
    const o = d.openings.find((x) => x.id === drag.id);
    const wall = d.walls.find((x) => x.id === o.wallId);
    o.offset = round(snap(offsetOnWall(wall, ground)));
  } else {
    const dx = round(snap(ground.x - drag.start.x));
    const dy = round(snap(ground.y - drag.start.y));
    if (drag.kind === "room") {
      const r = d.rooms.find((x) => x.id === drag.id);
      r.x = round(r.x + dx);
      r.y = round(r.y + dy);
    } else if (drag.kind === "wall") {
      const w = d.walls.find((x) => x.id === drag.id);
      for (const end of [1, 2]) {
        const ox = w[`x${end}`], oy = w[`y${end}`];
        for (const j of jointsAt(d, w.level, ox, oy, w.id)) {
          const jw = d.walls.find((x) => x.id === j.id);
          jw[`x${j.end}`] = round(ox + dx);
          jw[`y${j.end}`] = round(oy + dy);
        }
        w[`x${end}`] = round(ox + dx);
        w[`y${end}`] = round(oy + dy);
      }
    }
  }
  state.design = normalize(d);
  validateSelection();
  viewer.build(state.design, { activeLevel: state.level, ghostLower: state.ghostLower, showRoof: state.showRoof, selection: state.selection });
}

canvas.addEventListener("pointerup", (e) => {
  viewer.controls.enabled = true;
  if (state.drag) {
    const { before } = state.drag;
    state.drag = null;
    if (snapshot() !== before) {
      state.undo.push(before);
      state.redo = [];
    }
    refresh();
    return;
  }
  if (state.tool === "room" && state.drawStart) {
    const ground = viewer.groundPoint(e, elevation());
    const r = ground ? roomRect(state.drawStart, ground) : null;
    state.drawStart = null;
    viewer.setPreview(null);
    if (r && r.width >= 0.5 && r.depth >= 0.5) {
      let id;
      commit((d) => {
        id = newId(d, "r");
        d.rooms.push({ id, level: state.level, name: "Room", ...r, floor: "wood" });
      });
      select({ kind: "room", id });
      setTool("select");
    }
  }
});

// ---------------------------------------------------------------------------
// Properties panel

function field(label, key, value, { type = "number", step = 0.05, full = false, options, readonly = false } = {}) {
  let input;
  if (options) {
    input = `<select data-key="${key}">${options.map((o) => `<option value="${o}" ${o === value ? "selected" : ""}>${o}</option>`).join("")}</select>`;
  } else if (type === "checkbox") {
    input = `<input type="checkbox" data-key="${key}" ${value ? "checked" : ""} />`;
  } else {
    input = `<input type="${type}" data-key="${key}" ${type === "number" ? `step="${step}"` : ""} ${readonly ? "readonly" : ""} />`;
  }
  return `<div class="${full ? "full" : ""}"><label>${label}</label>${input}</div>`;
}

function fillValues(root, obj) {
  root.querySelectorAll("input[data-key]").forEach((el) => {
    if (el.type === "checkbox") return;
    const v = obj[el.dataset.key];
    el.value = typeof v === "number" ? round(v) : v ?? "";
  });
}

function readValue(el) {
  if (el.type === "checkbox") return el.checked;
  if (el.type === "number") return Number(el.value);
  return el.value;
}

function renderProps() {
  const root = $("#props");
  const sel = state.selection;
  const obj = sel && find(sel.kind, sel.id);

  if (sel?.kind === "wall" && obj) {
    root.innerHTML = `
      <div class="props-title"><h2>Wall</h2><code>${obj.id}</code></div>
      <div class="fields">
        ${field("Start x", "x1", obj.x1)}${field("Start y", "y1", obj.y1)}
        ${field("End x", "x2", obj.x2)}${field("End y", "y2", obj.y2)}
        ${field("Length", "length", 0)}${field("Thickness", "thickness", obj.thickness, { step: 0.01 })}
        ${field("Height", "height", obj.height)}
        <div><label>Exterior</label><input type="checkbox" data-key="exterior" ${obj.exterior ? "checked" : ""} /></div>
      </div>
      <div class="btn-row">
        <button data-act="door">+ Door</button><button data-act="window">+ Window</button>
        <button data-act="split">Split</button><button data-act="delete" class="danger">Delete</button>
      </div>`;
    fillValues(root, { ...obj, length: wallLength(obj) });
  } else if (sel?.kind === "opening" && obj) {
    const wall = find("wall", obj.wallId);
    root.innerHTML = `
      <div class="props-title"><h2>${obj.type === "door" ? "Door" : "Window"}</h2><code>${obj.id}</code></div>
      <div class="fields">
        ${field("Type", "type", obj.type, { options: ["door", "window"] })}
        ${field("Offset from wall start", "offset", obj.offset)}
        ${field("Width", "width", obj.width)}${field("Height", "height", obj.height)}
        ${obj.type === "window" ? field("Sill height", "sill", obj.sill) : ""}
      </div>
      <p class="readout">In wall <code>${obj.wallId}</code> (${wallLength(wall).toFixed(2)} m long)</p>
      <div class="btn-row"><button data-act="delete" class="danger">Delete</button></div>`;
    fillValues(root, obj);
  } else if (sel?.kind === "room" && obj) {
    root.innerHTML = `
      <div class="props-title"><h2>Room</h2><code>${obj.id}</code></div>
      <div class="fields">
        ${field("Name", "name", obj.name, { type: "text", full: true })}
        ${field("x (south-west)", "x", obj.x)}${field("y (south-west)", "y", obj.y)}
        ${field("Width (x)", "width", obj.width)}${field("Depth (y)", "depth", obj.depth)}
        ${field("Floor finish", "floor", obj.floor, { options: FLOORS, full: true })}
      </div>
      <p class="readout">Area: ${(obj.width * obj.depth).toFixed(2)} m²</p>
      <div class="btn-row"><button data-act="walls">Add walls around</button><button data-act="delete" class="danger">Delete</button></div>`;
    fillValues(root, obj);
  } else {
    const d = state.design;
    const lvl = d.levels[state.level];
    const rows = d.levels
      .map((l, i) => {
        const area = d.rooms.filter((r) => r.level === i).reduce((s, r) => s + r.width * r.depth, 0);
        return `<tr><td>${escapeHtml(l.name)}</td><td>${area.toFixed(1)} m²</td></tr>`;
      })
      .join("");
    const total = d.rooms.reduce((s, r) => s + r.width * r.depth, 0);
    root.innerHTML = `
      <div class="props-title"><h2>Level</h2><code>${state.level}</code></div>
      <div class="fields" data-scope="level">
        ${field("Name", "name", lvl.name, { type: "text", full: true })}
        ${field("Elevation", "elevation", lvl.elevation)}${field("Floor-to-floor", "height", lvl.height)}
      </div>
      <div class="btn-row"><button data-act="addLevel">+ Level above</button><button data-act="delLevel" class="danger" ${d.levels.length < 2 ? "disabled" : ""}>Delete level</button></div>
      <h3 style="margin-top:22px">Roof</h3>
      <div class="fields" data-scope="roof">
        ${field("Type", "type", d.roof.type, { options: ["gable", "flat", "none"], full: true })}
        ${field("Pitch (°)", "pitch", d.roof.pitch, { step: 1 })}${field("Overhang", "overhang", d.roof.overhang)}
      </div>
      <h3 style="margin-top:22px">Floor areas</h3>
      <table class="summary">${rows}<tr><td><b>Total</b></td><td><b>${total.toFixed(1)} m²</b></td></tr></table>
      <h3 style="margin-top:22px">Editing</h3>
      <ul class="help">
        <li>Click a wall, door, window or room to edit it here.</li>
        <li><kbd>V</kbd> select · <kbd>W</kbd> wall · <kbd>D</kbd> door · <kbd>N</kbd> window · <kbd>R</kbd> room</li>
        <li><kbd>Del</kbd> delete · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>Esc</kbd> stop drawing</li>
        <li>Hold <kbd>Shift</kbd> while dragging a wall end to draw at any angle.</li>
      </ul>`;
    fillValues(root.querySelector('[data-scope="level"]'), lvl);
    fillValues(root.querySelector('[data-scope="roof"]'), d.roof);
  }
}

$("#props").addEventListener("change", (e) => {
  const el = e.target.closest("[data-key]");
  if (!el) return;
  const key = el.dataset.key;
  const value = readValue(el);
  if (el.type === "number" && !Number.isFinite(value)) return;
  const sel = state.selection;
  const scope = el.closest("[data-scope]")?.dataset.scope;

  commit((d) => {
    if (scope === "roof") {
      d.roof[key] = value;
    } else if (scope === "level") {
      const lvl = d.levels[state.level];
      if (key === "height") {
        for (const w of d.walls) if (w.level === state.level && Math.abs(w.height - lvl.height) < 0.01) w.height = value;
      }
      lvl[key] = value;
      // Keep the storeys stacked on top of each other.
      for (let i = 1; i < d.levels.length; i++) d.levels[i].elevation = round(d.levels[i - 1].elevation + d.levels[i - 1].height);
    } else if (sel) {
      const obj = find(sel.kind, sel.id, d);
      if (sel.kind === "wall" && key === "length") {
        const { ux, uy } = wallFrame(obj);
        obj.x2 = round(obj.x1 + ux * value);
        obj.y2 = round(obj.y1 + uy * value);
      } else if (sel.kind === "wall" && ["x1", "y1", "x2", "y2"].includes(key)) {
        const end = key.slice(1);
        for (const j of jointsAt(d, obj.level, obj[`x${end}`], obj[`y${end}`], obj.id)) {
          const jw = d.walls.find((x) => x.id === j.id);
          jw[`${key[0]}${j.end}`] = value;
        }
        obj[key] = value;
      } else {
        obj[key] = value;
        if (sel.kind === "opening" && key === "type") {
          Object.assign(obj, value === "door" ? { sill: 0, height: 2.1 } : { sill: 0.9, height: 1.4 });
        }
      }
    }
  });
});

$("#props").addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act) return;
  const sel = state.selection;
  if (act === "delete") return deleteSelection();
  if (act === "door" || act === "window") {
    let id;
    commit((d) => {
      const wall = find("wall", sel.id, d);
      id = addOpening(d, wall, act, wallLength(wall) / 2);
    });
    return select({ kind: "opening", id });
  }
  if (act === "split") {
    return commit((d) => {
      const w = find("wall", sel.id, d);
      const mx = round(snap((w.x1 + w.x2) / 2)), my = round(snap((w.y1 + w.y2) / 2));
      const half = wallLength(w) / 2;
      const id = newId(d, "w");
      d.walls.push({ ...w, id, x1: mx, y1: my });
      for (const o of d.openings) if (o.wallId === w.id && o.offset > half) (o.wallId = id), (o.offset = round(o.offset - half));
      w.x2 = mx;
      w.y2 = my;
    });
  }
  if (act === "walls") {
    return commit((d) => {
      const r = find("room", sel.id, d);
      const lvl = d.levels[r.level];
      const c = [[r.x, r.y], [r.x + r.width, r.y], [r.x + r.width, r.y + r.depth], [r.x, r.y + r.depth]];
      for (let i = 0; i < 4; i++) {
        const [x1, y1] = c[i], [x2, y2] = c[(i + 1) % 4];
        const exists = d.walls.some((w) => w.level === r.level && onSegment(w, x1, y1) && onSegment(w, x2, y2));
        if (!exists) d.walls.push({ id: newId(d, "w"), level: r.level, x1, y1, x2, y2, thickness: 0.12, height: lvl.height, exterior: false });
      }
    });
  }
  if (act === "addLevel") {
    let next;
    commit((d) => {
      const cur = d.levels[d.levels.length - 1];
      next = d.levels.length;
      d.levels.push({ name: `Level ${next}`, elevation: round(cur.elevation + cur.height), height: cur.height });
      // Start the new storey with the outer walls and stairs of the one below.
      for (const w of d.walls.filter((w) => w.level === next - 1 && w.exterior)) d.walls.push({ ...w, id: newId(d, "w"), level: next, height: cur.height });
      for (const r of d.rooms.filter((r) => r.level === next - 1 && /stair/i.test(r.name))) d.rooms.push({ ...r, id: newId(d, "r"), level: next });
    });
    state.level = next;
    return refresh();
  }
  if (act === "delLevel") {
    const li = state.level;
    if (!confirm(`Delete "${state.design.levels[li].name}" and everything on it?`)) return;
    commit((d) => {
      d.levels.splice(li, 1);
      d.walls = d.walls.filter((w) => w.level !== li).map((w) => ({ ...w, level: w.level > li ? w.level - 1 : w.level }));
      d.rooms = d.rooms.filter((r) => r.level !== li).map((r) => ({ ...r, level: r.level > li ? r.level - 1 : r.level }));
      for (let i = 1; i < d.levels.length; i++) d.levels[i].elevation = round(d.levels[i - 1].elevation + d.levels[i - 1].height);
      if (d.levels.length) d.levels[0].elevation = 0;
    });
    state.level = Math.max(0, li - 1);
    refresh();
  }
});

function onSegment(w, x, y) {
  const L = wallLength(w);
  const d1 = Math.hypot(x - w.x1, y - w.y1), d2 = Math.hypot(x - w.x2, y - w.y2);
  return Math.abs(d1 + d2 - L) < 0.02;
}

function deleteSelection() {
  const sel = state.selection;
  if (!sel) return;
  commit((d) => {
    if (sel.kind === "wall") d.walls = d.walls.filter((w) => w.id !== sel.id);
    if (sel.kind === "opening") d.openings = d.openings.filter((o) => o.id !== sel.id);
    if (sel.kind === "room") d.rooms = d.rooms.filter((r) => r.id !== sel.id);
  });
}

function renderLevels() {
  const sel = $("#levelSelect");
  sel.innerHTML = state.design.levels.map((l, i) => `<option value="${i}">${escapeHtml(l.name)}</option>`).join("");
  sel.value = String(state.level);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------------------------------------------------------------------------
// AI

async function askAI(brief, current) {
  const status = $("#aiStatus");
  const buttons = [$("#btnGenerate"), $("#btnChange")];
  buttons.forEach((b) => (b.disabled = true));
  status.className = "ai-status busy";
  const t0 = Date.now();
  const tick = () => (status.textContent = `${current ? "Updating the design" : "Designing your building"}… ${Math.round((Date.now() - t0) / 1000)}s`);
  tick();
  const timer = setInterval(tick, 1000);
  try {
    const res = await fetch("/api/design", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief, design: current }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    const before = snapshot();
    if (!current) state.level = 0;
    load(data.design, { keepView: Boolean(current) });
    state.undo.push(before);
    state.redo = [];
    refresh();
    status.className = "ai-status";
    status.textContent = current ? "Change applied. Undo with Ctrl+Z if you don't like it." : "Design ready. Edit it in 3D, then export or render.";
    return true;
  } catch (err) {
    status.className = "ai-status error";
    status.textContent = err.message === "Failed to fetch" ? "Could not reach the server." : err.message;
    return false;
  } finally {
    clearInterval(timer);
    buttons.forEach((b) => (b.disabled = false));
  }
}

$("#btnGenerate").addEventListener("click", () => {
  const brief = $("#brief").value.trim();
  if (!brief) return $("#brief").focus();
  askAI(brief, null);
});

$("#btnChange").addEventListener("click", async () => {
  const change = $("#change").value.trim();
  if (!change) return $("#change").focus();
  if (await askAI(change, state.design)) $("#change").value = "";
});

// ---------------------------------------------------------------------------
// Files, export and render

function download(name, content, type) {
  const url = content.startsWith?.("data:") ? content : URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (!url.startsWith("data:")) setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fileBase = () => state.design.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "design";

$("#btnPlanDxf").addEventListener("click", () => download(`${fileBase()}-plans.dxf`, planDxf(state.design), "application/dxf"));
$("#btnModelDxf").addEventListener("click", () => download(`${fileBase()}-3d.dxf`, modelDxf(state.design), "application/dxf"));
$("#btnSave").addEventListener("click", () => download(`${fileBase()}.json`, JSON.stringify(state.design, null, 2), "application/json"));
$("#btnOpen").addEventListener("click", () => $("#fileInput").click());
$("#fileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const before = snapshot();
    state.level = 0;
    load(JSON.parse(await file.text()));
    state.undo.push(before);
    refresh();
  } catch {
    alert("That file is not a valid design (.json saved from this app).");
  }
});
$("#btnNew").addEventListener("click", () => {
  if (!confirm("Start a new empty design? (You can undo this.)")) return;
  const before = snapshot();
  state.level = 0;
  load({ name: "New design", levels: [{ name: "Ground floor", elevation: 0, height: 3 }], walls: [], openings: [], rooms: [], roof: { type: "flat", pitch: 30, overhang: 0.3 } });
  state.undo.push(before);
  refresh();
  setTool("wall");
});
$("#btnExample").addEventListener("click", () => {
  const before = snapshot();
  state.level = 0;
  load(EXAMPLE);
  state.undo.push(before);
  refresh();
});

function setRender(on) {
  state.render = on;
  document.body.classList.toggle("rendering", on);
  $("#btnRender").textContent = on ? "Back to editing" : "Render";
  $("#btnRender").classList.toggle("primary", !on);
  viewer.setRenderMode(on);
  if (on) {
    state.selection = null;
    setTool("select");
    $("#hint").textContent = "Render view: orbit with the mouse, then Save image. Click “Back to editing” to keep designing.";
  } else {
    setTool(state.tool);
  }
  refresh();
}
$("#btnRender").addEventListener("click", () => setRender(!state.render));
$("#btnShot").addEventListener("click", () => download(`${fileBase()}-${state.render ? "render" : "view"}.png`, viewer.snapshot(2), "image/png"));

// ---------------------------------------------------------------------------
// Toolbar and keyboard

document.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
$("#btnDelete").addEventListener("click", deleteSelection);
$("#btnUndo").addEventListener("click", undo);
$("#btnRedo").addEventListener("click", redo);
$("#btnView3d").addEventListener("click", () => viewer.frame("3d"));
$("#btnViewTop").addEventListener("click", () => viewer.frame("top"));
$("#levelSelect").addEventListener("change", (e) => {
  state.level = Number(e.target.value);
  state.selection = null;
  refresh();
});
$("#chkGhost").addEventListener("change", (e) => ((state.ghostLower = e.target.checked), refresh()));
$("#chkRoof").addEventListener("change", (e) => ((state.showRoof = e.target.checked), refresh()));
$("#chkOrtho").addEventListener("change", (e) => (state.ortho = e.target.checked));
$("#projectName").addEventListener("change", (e) => commit((d) => (d.name = e.target.value.trim() || "Untitled design")));

window.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select")) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z") return e.preventDefault(), e.shiftKey ? redo() : undo();
  if ((e.ctrlKey || e.metaKey) && k === "y") return e.preventDefault(), redo();
  if (e.ctrlKey || e.metaKey || e.altKey || state.render) return;
  if (k === "escape") {
    if (state.drawStart) (state.drawStart = null), viewer.setPreview(null);
    else if (state.tool !== "select") setTool("select");
    else select(null);
  }
  if (k === "delete" || k === "backspace") return e.preventDefault(), deleteSelection();
  const tools = { v: "select", w: "wall", d: "door", n: "window", r: "room" };
  if (tools[k]) setTool(tools[k]);
});

// ---------------------------------------------------------------------------
// Start

let saved = null;
try {
  saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
} catch {}
load(saved?.walls ? saved : EXAMPLE);
setTool("select");
