// 3D view of the design. Plan (x, y, z) maps to three.js (x, z, -y).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { wallFrame, wallPieces, levelBounds, designBounds, roofFaces } from "./design.js";

const v3 = (x, y, z = 0) => new THREE.Vector3(x, z, -y);

const FLOOR_COLORS = { wood: 0xb88a5a, tile: 0xd9d4cc, concrete: 0x9c9c98, carpet: 0x8d8f9e, stone: 0xbfb6a6 };
const ROOM_TINTS = [0x8ecae6, 0xffb703, 0x90be6d, 0xf28482, 0xcdb4db, 0x84a59d, 0xf6bd60, 0x80ed99];

function tintFor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ROOM_TINTS[h % ROOM_TINTS.length];
}

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = "labels";
    container.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    this.camera.position.set(-12, 16, 18);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.2);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.hemi, this.sun, this.sun.target);

    this.grid = new THREE.GridHelper(80, 80, 0x5b6474, 0x3a414d);
    this.scene.add(this.grid);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x7f9c62, roughness: 1 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.31;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.building = new THREE.Group();
    this.helpers = new THREE.Group();
    this.scene.add(this.building, this.helpers);

    this.raycaster = new THREE.Raycaster();
    this.mats = this.makeMaterials();
    this.renderMode = false;
    this.setRenderMode(false);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.labels.render(this.scene, this.camera);
    });
  }

  makeMaterials() {
    const std = (o) => new THREE.MeshStandardMaterial({ roughness: 0.85, ...o });
    const floors = {};
    for (const [k, c] of Object.entries(FLOOR_COLORS)) floors[k] = std({ color: c, roughness: k === "tile" ? 0.35 : 0.8 });
    return {
      wall: std({ color: 0xeeeae4 }),
      wallExt: std({ color: 0xf4efe7 }),
      ghost: std({ color: 0xbfc5cf, transparent: true, opacity: 0.18, depthWrite: false }),
      selected: std({ color: 0x4f9dff, emissive: 0x1d4f99, emissiveIntensity: 0.6 }),
      door: std({ color: 0x8a5a33, roughness: 0.6 }),
      frame: std({ color: 0x3b3f46, roughness: 0.5 }),
      glass: new THREE.MeshPhysicalMaterial({ color: 0xa9cde8, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.35, depthWrite: false }),
      slab: std({ color: 0xd6d2cb }),
      roof: std({ color: 0x5e2c22, roughness: 0.7, side: THREE.DoubleSide }),
      roofFlat: std({ color: 0x9b9a96, side: THREE.DoubleSide }),
      handle: new THREE.MeshBasicMaterial({ color: 0xffcc33, depthTest: false }),
      preview: new THREE.MeshBasicMaterial({ color: 0x4f9dff, transparent: true, opacity: 0.45, depthWrite: false }),
      floors,
      tints: new Map(),
    };
  }

  tint(color) {
    if (!this.mats.tints.has(color)) {
      this.mats.tints.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.9, transparent: true, opacity: 0.55 }));
    }
    return this.mats.tints.get(color);
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setRenderMode(on) {
    this.renderMode = on;
    this.renderer.shadowMap.enabled = on;
    this.scene.environment = on ? this.envMap : null;
    this.scene.background = new THREE.Color(on ? 0xb9d3ea : 0x262b33);
    this.scene.fog = on ? new THREE.Fog(0xb9d3ea, 60, 220) : null;
    this.renderer.toneMappingExposure = on ? 1.0 : 1.1;
    this.hemi.intensity = on ? 0.6 : 1.3;
    this.sun.intensity = on ? 2.6 : 1.6;
    this.sun.castShadow = on;
    this.grid.visible = !on;
    this.ground.visible = on;
    this.labels.domElement.style.display = on ? "none" : "";
    this.renderer.shadowMap.needsUpdate = true;
    for (const m of Object.values(this.mats)) if (m?.isMaterial) m.needsUpdate = true;
  }

  clear(group) {
    group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    group.clear();
  }

  // opts: { activeLevel, ghostLower, showRoof, selection: {kind,id} }
  build(design, opts) {
    this.design = design;
    this.opts = opts;
    this.clear(this.building);
    const render = this.renderMode;
    const active = opts.activeLevel;
    const visible = (lvl) => render || lvl === active || (opts.ghostLower && lvl < active);
    const ghosted = (lvl) => !render && lvl !== active;
    const isSel = (kind, id) => opts.selection && opts.selection.kind === kind && opts.selection.id === id;

    const add = (mesh, data) => {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (data) Object.assign(mesh.userData, data);
      this.building.add(mesh);
      return mesh;
    };

    // Floor slabs under upper storeys and a plinth under the ground floor.
    design.levels.forEach((lvl, i) => {
      if (!visible(i)) return;
      const b = levelBounds(design, i);
      const t = i === 0 ? 0.3 : 0.25;
      const geo = new THREE.BoxGeometry(b.maxX - b.minX, t, b.maxY - b.minY);
      const mesh = new THREE.Mesh(geo, ghosted(i) ? this.mats.ghost : this.mats.slab);
      mesh.position.copy(v3((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, lvl.elevation - t / 2 - 0.005));
      add(mesh);
    });

    for (const r of design.rooms) {
      if (!visible(r.level)) continue;
      const lvl = design.levels[r.level];
      const mat = ghosted(r.level) ? this.mats.ghost : isSel("room", r.id) ? this.mats.selected : render ? this.mats.floors[r.floor] : this.tint(tintFor(r.name));
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(r.width - 0.02, 0.02, r.depth - 0.02), mat);
      mesh.position.copy(v3(r.x + r.width / 2, r.y + r.depth / 2, lvl.elevation + 0.01));
      add(mesh, { kind: "room", id: r.id, level: r.level, pickable: r.level === active });

      if (!render && !opts.showRoof && r.level === active) {
        const el = document.createElement("div");
        el.className = "room-label" + (isSel("room", r.id) ? " selected" : "");
        el.innerHTML = `<b></b><span>${(r.width * r.depth).toFixed(1)} m²</span>`;
        el.querySelector("b").textContent = r.name;
        const label = new CSS2DObject(el);
        label.position.copy(v3(r.x + r.width / 2, r.y + r.depth / 2, lvl.elevation + 0.05));
        this.building.add(label);
      }
    }

    for (const w of design.walls) {
      if (!visible(w.level)) continue;
      const z = design.levels[w.level].elevation;
      const { ux, uy } = wallFrame(w);
      const angle = Math.atan2(uy, ux);
      const openings = design.openings.filter((o) => o.wallId === w.id);
      const wallMat = ghosted(w.level) ? this.mats.ghost : isSel("wall", w.id) ? this.mats.selected : w.exterior ? this.mats.wallExt : this.mats.wall;

      for (const p of wallPieces(w, openings)) {
        const len = p.s1 - p.s0;
        const geo = new THREE.BoxGeometry(len, p.z1 - p.z0, w.thickness);
        const mesh = new THREE.Mesh(geo, wallMat);
        const s = (p.s0 + p.s1) / 2;
        mesh.position.copy(v3(w.x1 + ux * s, w.y1 + uy * s, z + (p.z0 + p.z1) / 2));
        mesh.rotation.y = angle;
        add(mesh, { kind: "wall", id: w.id, level: w.level, pickable: w.level === active });
      }

      if (ghosted(w.level)) continue;
      for (const o of openings) {
        const sel = isSel("opening", o.id);
        const group = new THREE.Group();
        group.position.copy(v3(w.x1 + ux * o.offset, w.y1 + uy * o.offset, z + o.sill + o.height / 2));
        group.rotation.y = angle;
        const data = { kind: "opening", id: o.id, level: w.level, pickable: w.level === active };
        if (o.type === "door") {
          const leaf = new THREE.Mesh(new THREE.BoxGeometry(o.width - 0.04, o.height - 0.02, 0.045), sel ? this.mats.selected : this.mats.door);
          Object.assign(leaf.userData, data);
          leaf.castShadow = leaf.receiveShadow = true;
          group.add(leaf);
        } else {
          const glass = new THREE.Mesh(new THREE.BoxGeometry(o.width, o.height, 0.02), sel ? this.mats.selected : this.mats.glass);
          Object.assign(glass.userData, data);
          group.add(glass);
          const fw = 0.05;
          const frameMat = sel ? this.mats.selected : this.mats.frame;
          for (const [sx, sy, px, py] of [
            [o.width, fw, 0, o.height / 2 - fw / 2],
            [o.width, fw, 0, -o.height / 2 + fw / 2],
            [fw, o.height, o.width / 2 - fw / 2, 0],
            [fw, o.height, -o.width / 2 + fw / 2, 0],
            [fw, o.height, 0, 0],
          ]) {
            const bar = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, 0.07), frameMat);
            bar.position.set(px, py, 0);
            Object.assign(bar.userData, data);
            bar.castShadow = true;
            group.add(bar);
          }
        }
        this.building.add(group);
      }
    }

    if (render || opts.showRoof) {
      for (const face of roofFaces(design)) {
        const pts = face.pts.map(([x, y, zz]) => v3(x, y, zz));
        const geo = new THREE.BufferGeometry().setFromPoints(pts.length === 4 ? [pts[0], pts[1], pts[2], pts[0], pts[2], pts[3]] : pts);
        geo.computeVertexNormals();
        const mat = face.part === "gable" ? this.mats.wallExt : design.roof.type === "flat" ? this.mats.roofFlat : this.mats.roof;
        const mesh = new THREE.Mesh(geo, face.part === "gable" ? mat.clone() : mat);
        if (face.part === "gable") mesh.material.side = THREE.DoubleSide;
        add(mesh);
      }
    }

    this.buildHandles();
    this.fitSun();
  }

  buildHandles() {
    this.clear(this.helpers);
    const sel = this.opts?.selection;
    if (this.renderMode || !sel || sel.kind !== "wall") return;
    const w = this.design.walls.find((x) => x.id === sel.id);
    if (!w) return;
    const z = this.design.levels[w.level].elevation + w.height + 0.25;
    for (const end of [1, 2]) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.22, 20, 14), this.mats.handle);
      m.position.copy(v3(w[`x${end}`], w[`y${end}`], z));
      m.renderOrder = 10;
      m.userData = { kind: "handle", id: w.id, end, pickable: true };
      this.helpers.add(m);
    }
  }

  fitSun() {
    const b = designBounds(this.design);
    const c = v3((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, 0);
    const r = Math.max(b.maxX - b.minX, b.maxY - b.minY, 8);
    this.sun.position.copy(c).add(new THREE.Vector3(-r * 0.9, r * 1.4, r * 1.1));
    this.sun.target.position.copy(c);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -r * 1.3;
    cam.right = cam.top = r * 1.3;
    cam.near = 0.5;
    cam.far = r * 5;
    cam.updateProjectionMatrix();
  }

  // Preview box while drawing (plan coordinates), or null to remove.
  setPreview(kind, data) {
    if (this.preview) {
      this.preview.geometry.dispose();
      this.scene.remove(this.preview);
      this.preview = null;
    }
    if (!kind) return;
    let geo, pos, rot = 0;
    if (kind === "wall") {
      const { x1, y1, x2, y2, thickness, height, elevation } = data;
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 0.01) return;
      geo = new THREE.BoxGeometry(len + thickness, height, thickness);
      pos = v3((x1 + x2) / 2, (y1 + y2) / 2, elevation + height / 2);
      rot = Math.atan2(y2 - y1, x2 - x1);
    } else {
      const { x, y, width, depth, elevation } = data;
      if (width < 0.01 || depth < 0.01) return;
      geo = new THREE.BoxGeometry(width, 0.05, depth);
      pos = v3(x + width / 2, y + depth / 2, elevation + 0.03);
    }
    this.preview = new THREE.Mesh(geo, this.mats.preview);
    this.preview.position.copy(pos);
    this.preview.rotation.y = rot;
    this.scene.add(this.preview);
  }

  setGridLevel(elevation) {
    this.grid.position.y = elevation + 0.002;
  }

  ndc(event) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((event.clientX - r.left) / r.width) * 2 - 1, -((event.clientY - r.top) / r.height) * 2 + 1);
  }

  // Returns { kind, id, end?, point: {x, y, z} } for the nearest pickable object.
  pick(event, kinds) {
    this.raycaster.setFromCamera(this.ndc(event), this.camera);
    const handles = this.raycaster.intersectObjects(this.helpers.children, false);
    if (handles.length && (!kinds || kinds.includes("handle"))) return this.hit(handles[0]);
    const hits = this.raycaster.intersectObjects(this.building.children, true);
    for (const h of hits) {
      const d = h.object.userData;
      if (!d.pickable) continue;
      if (kinds && !kinds.includes(d.kind)) continue;
      return this.hit(h);
    }
    return null;
  }

  hit(h) {
    const d = h.object.userData;
    return { kind: d.kind, id: d.id, end: d.end, point: { x: h.point.x, y: -h.point.z, z: h.point.y } };
  }

  // Where the pointer meets the horizontal plane at this elevation, in plan coordinates.
  groundPoint(event, elevation) {
    this.raycaster.setFromCamera(this.ndc(event), this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -elevation);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, p)) return null;
    return { x: p.x, y: -p.z };
  }

  frame(view = "3d") {
    const b = designBounds(this.design);
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const r = Math.max(b.maxX - b.minX, b.maxY - b.minY, 8);
    const target = v3(cx, cy, view === "top" ? 0 : 2);
    this.controls.target.copy(target);
    if (view === "top") this.camera.position.copy(target).add(new THREE.Vector3(0, r * 1.9, 0.01));
    else this.camera.position.copy(target).add(new THREE.Vector3(-r * 0.75, r * 0.85, r * 1.15));
    this.camera.lookAt(target);
    this.controls.update();
  }

  snapshot(scale = 2) {
    const { clientWidth: w, clientHeight: h } = this.container;
    this.renderer.setPixelRatio(scale);
    this.renderer.setSize(w, h);
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL("image/png");
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.resize();
    return url;
  }
}
