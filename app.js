// Floorplanner — single-page interactive planner.
// All geometry stored in inches (canonical). Display unit switches imperial/metric.

const SVGNS = 'http://www.w3.org/2000/svg';
const IN_PER_CM = 1 / 2.54;
const CM_PER_IN = 2.54;

// ---------- DOM shortcuts ----------
const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const bgLayer = $('bgLayer');
const gridLayer = $('gridLayer');
const roomsLayer = $('roomsLayer');
const itemsLayer = $('itemsLayer');
const overlayLayer = $('overlayLayer');
const measureLayer = $('measureLayer');
const rulerLayer = $('rulerLayer');
const handlesLayer = $('handlesLayer');
const worldG = $('world');
const tooltip = $('tooltip');
const hintEl = $('hint');

// ---------- Presets (dimensions in inches) ----------
// shape: 'rect' (default) | 'circle' | 'door'
const PRESETS = {
  bed:        { name: 'Bed',         w: 60, h: 80, color: '#c9a97d' },   // queen
  sofa:       { name: 'Sofa',        w: 84, h: 36, color: '#7a9bc7' },
  table:      { name: 'Table',       w: 60, h: 36, color: '#a87f5b' },
  chair:      { name: 'Chair',       w: 18, h: 18, color: '#6a6a6a' },
  desk:       { name: 'Desk',        w: 60, h: 30, color: '#8f7257' },
  fridge:     { name: 'Fridge',      w: 36, h: 30, color: '#b8bec8' },
  toilet:     { name: 'Toilet',      w: 20, h: 28, color: '#d4d8de' },
  sink:       { name: 'Sink',        w: 30, h: 22, color: '#aeb5c0' },
  door:       { name: 'Door',        w: 32, h: 4,  color: '#6b7685', shape: 'door', flip: false },
  roundTable: { name: 'Round table', w: 48, h: 48, color: '#a87f5b', shape: 'circle' },
  rug:        { name: 'Round rug',   w: 72, h: 72, color: '#d4b78e', shape: 'circle' },
};

// ---------- State ----------
function defaultState() {
  return {
    version: 1,
    name: '',
    units: 'imperial',
    rooms: [],
    items: [],
    bg: null, // { url, x, y, w, h, opacity }
  };
}

let state = defaultState();
let selected = null; // {kind: 'room'|'item', id}
let tool = 'select';
let snap = true;
let camera = { scale: 4, tx: 80, ty: 80 }; // px per inch, translation in px
let undoStack = [];
let redoStack = [];
const UNDO_LIMIT = 50;

function gridInches() { return state.units === 'imperial' ? 6 : 10 * IN_PER_CM; }
function majorEveryInches() { return state.units === 'imperial' ? 12 : 100 * IN_PER_CM; }

// ---------- Unit formatting / parsing ----------
function formatLen(inches) {
  if (!isFinite(inches)) return '';
  const sign = inches < 0 ? '-' : '';
  const v = Math.abs(inches);
  if (state.units === 'imperial') {
    // round to nearest 1/8"
    const eighths = Math.round(v * 8);
    const totalIn = eighths / 8;
    const feet = Math.floor(totalIn / 12);
    const rem = totalIn - feet * 12;
    if (feet === 0) return `${sign}${formatInchesOnly(rem)}`;
    if (rem === 0) return `${sign}${feet}'`;
    return `${sign}${feet}' ${formatInchesOnly(rem)}`;
  } else {
    // cm with 1 decimal when needed
    const cm = v * CM_PER_IN;
    if (cm >= 100) {
      const m = cm / 100;
      const rounded = Math.round(m * 100) / 100;
      return `${sign}${trimNum(rounded)} m`;
    }
    return `${sign}${trimNum(Math.round(cm * 10) / 10)} cm`;
  }
}

function formatInchesOnly(inches) {
  const whole = Math.floor(inches);
  const frac = inches - whole;
  if (frac === 0) return `${whole}"`;
  const eighths = Math.round(frac * 8);
  if (eighths === 0) return `${whole}"`;
  if (eighths === 8) return `${whole + 1}"`;
  // reduce fraction
  let n = eighths, d = 8;
  while (n % 2 === 0) { n /= 2; d /= 2; }
  return whole > 0 ? `${whole} ${n}/${d}"` : `${n}/${d}"`;
}

function trimNum(n) {
  return Number(n).toFixed(2).replace(/\.?0+$/, '');
}

function parseLen(str) {
  if (typeof str === 'number') return str;
  const s = String(str).trim();
  if (!s) return 0;
  if (state.units === 'imperial') return parseImperial(s);
  return parseMetric(s);
}

function parseImperial(str) {
  // Accept forms: 12' 6", 12', 6", 12' 6 1/2", 12.5', 150, 12ft 6in
  let s = str.trim().replace(/\s+/g, ' ');
  let inches = 0;
  let consumed = false;
  // feet
  let m = s.match(/^(-?\d*\.?\d+)\s*(?:'|ft\b|feet\b)/i);
  if (m) {
    inches += parseFloat(m[1]) * 12;
    s = s.slice(m[0].length).trim();
    consumed = true;
  }
  if (s) {
    // optional whole + fraction inches: "6 1/2" or "6.5" or "6" or "6.5in"
    let m2 = s.match(/^(-?\d*\.?\d+)(?:\s+(\d+)\/(\d+))?\s*(?:"|in\b|inches\b)?$/i);
    if (m2) {
      inches += parseFloat(m2[1]);
      if (m2[2] && m2[3]) inches += parseInt(m2[2]) / parseInt(m2[3]);
      consumed = true;
    } else {
      // fraction-only like "1/2""
      let m3 = s.match(/^(\d+)\/(\d+)\s*(?:"|in\b)?$/i);
      if (m3) {
        inches += parseInt(m3[1]) / parseInt(m3[2]);
        consumed = true;
      } else {
        return NaN;
      }
    }
  }
  return consumed ? inches : NaN;
}

function parseMetric(str) {
  // Accept: "3.5 m", "380 cm", "3 m 80 cm", "380", "3.5m", "80cm"
  let s = str.trim().toLowerCase();
  let cm = 0;
  let consumed = false;
  let m = s.match(/^(-?\d*\.?\d+)\s*m(?!m|c)(\b|\s|$)/);
  if (m) { cm += parseFloat(m[1]) * 100; s = s.slice(m[0].length).trim(); consumed = true; }
  if (s) {
    let m2 = s.match(/^(-?\d*\.?\d+)\s*(?:cm)?$/);
    if (m2) { cm += parseFloat(m2[1]); consumed = true; }
    else return NaN;
  }
  return consumed ? cm * IN_PER_CM : NaN;
}

// ---------- Camera / coords ----------
function worldToScreen(x, y) {
  return { x: x * camera.scale + camera.tx, y: y * camera.scale + camera.ty };
}
function screenToWorld(sx, sy) {
  return { x: (sx - camera.tx) / camera.scale, y: (sy - camera.ty) / camera.scale };
}
function pointerWorld(e) {
  const r = canvas.getBoundingClientRect();
  return screenToWorld(e.clientX - r.left, e.clientY - r.top);
}
let lastAppliedScale = -1;
function applyCamera() {
  worldG.setAttribute('transform', `translate(${camera.tx},${camera.ty}) scale(${camera.scale})`);
  $('zoomLabel').textContent = Math.round(camera.scale / 4 * 100) + '%'; // 4 px/in = 100%
  renderGrid();
  renderRulers();
  renderHandles();
  // Labels on rooms/items set their font-size inline from camera.scale at
  // render time, so we must re-render those layers whenever the zoom changes;
  // otherwise fonts stay at the previous scale until another draw touches them.
  if (lastAppliedScale !== camera.scale) {
    lastAppliedScale = camera.scale;
    renderRooms();
    renderItems();
  }
}

function snapV(v) {
  if (!snap) return v;
  const g = gridInches();
  return Math.round(v / g) * g;
}

// ---------- Edge snapping (rooms + items) ----------
const ROOM_SNAP_PX = 8;   // screen px threshold

function itemVisualBBox(it) {
  const rot = Number(it.rotation) || 0;
  if (rot % 360 === 0) return { x: it.x, y: it.y, w: it.w, h: it.h };
  const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
  const pts = [[it.x, it.y], [it.x + it.w, it.y], [it.x, it.y + it.h], [it.x + it.w, it.y + it.h]]
    .map(([px, py]) => rotatePoint(px, py, cx, cy, rot));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Collect candidate snap edges from all rooms and items, excluding the moving object.
function snapTargets(excludeKind, excludeId) {
  const xs = [], ys = [];
  for (const r of state.rooms) {
    if (excludeKind === 'room' && r.id === excludeId) continue;
    const bbox = { x: r.x, y: r.y, w: r.w, h: r.h };
    xs.push({ v: bbox.x, bbox }, { v: bbox.x + bbox.w, bbox });
    ys.push({ v: bbox.y, bbox }, { v: bbox.y + bbox.h, bbox });
  }
  for (const it of state.items) {
    if (excludeKind === 'item' && it.id === excludeId) continue;
    const bbox = itemVisualBBox(it);
    xs.push({ v: bbox.x, bbox }, { v: bbox.x + bbox.w, bbox });
    ys.push({ v: bbox.y, bbox }, { v: bbox.y + bbox.h, bbox });
  }
  return { xs, ys };
}

function nearestEdge(value, edges, threshold) {
  let best = null;
  let minD = threshold;
  for (const e of edges) {
    const d = Math.abs(e.v - value);
    if (d < minD) { minD = d; best = e; }
  }
  return best;
}

// Returns { dx, dy, guideX, guideY } — adjustments to align a moving bbox to other rooms/items.
function computeMoveSnap(x, y, w, h, excludeKind, excludeId) {
  const th = ROOM_SNAP_PX / camera.scale;
  const { xs, ys } = snapTargets(excludeKind, excludeId);
  let dx = 0, guideX = null, bestX = Infinity;
  for (const myV of [x, x + w]) {
    const s = nearestEdge(myV, xs, th);
    if (!s) continue;
    const d = s.v - myV;
    if (Math.abs(d) < bestX) { bestX = Math.abs(d); dx = d; guideX = { v: s.v, bbox: s.bbox }; }
  }
  let dy = 0, guideY = null, bestY = Infinity;
  for (const myV of [y, y + h]) {
    const s = nearestEdge(myV, ys, th);
    if (!s) continue;
    const d = s.v - myV;
    if (Math.abs(d) < bestY) { bestY = Math.abs(d); dy = d; guideY = { v: s.v, bbox: s.bbox }; }
  }
  return { dx, dy, guideX, guideY };
}

let activeSnapGuides = []; // { axis:'x'|'y', v, bbox }

function renderSnapGuides() {
  clear(overlayLayer);
  for (const g of activeSnapGuides) {
    const line = document.createElementNS(SVGNS, 'line');
    if (g.axis === 'x') {
      line.setAttribute('x1', g.v); line.setAttribute('x2', g.v);
      line.setAttribute('y1', g.bbox.y - 1000); line.setAttribute('y2', g.bbox.y + g.bbox.h + 1000);
    } else {
      line.setAttribute('y1', g.v); line.setAttribute('y2', g.v);
      line.setAttribute('x1', g.bbox.x - 1000); line.setAttribute('x2', g.bbox.x + g.bbox.w + 1000);
    }
    line.setAttribute('stroke', '#ff3b7f');
    line.setAttribute('stroke-width', '1');
    line.setAttribute('stroke-dasharray', '5 4');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    overlayLayer.appendChild(line);
  }
}

function clearSnapGuides() { activeSnapGuides = []; clear(overlayLayer); }

// ---------- Undo / history ----------
function snapshot() {
  return JSON.stringify(state);
}
function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  state = JSON.parse(undoStack.pop());
  selected = null;
  renderAll();
  persist();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  state = JSON.parse(redoStack.pop());
  selected = null;
  renderAll();
  persist();
}

// ---------- IDs ----------
function uid() { return Math.random().toString(36).slice(2, 9); }

// ---------- Rendering ----------
function renderAll() {
  applyCamera();
  renderBackground();
  renderRooms();
  renderItems();
  renderHandles();
  renderSidebar();
  $('planName').value = state.name || '';
  $('units').value = state.units;
}

function renderBackground() {
  clear(bgLayer);
  const bg = state.bg;
  if (!bg || !bg.url) return;
  const img = document.createElementNS(SVGNS, 'image');
  img.setAttribute('href', bg.url);
  img.setAttribute('x', bg.x);
  img.setAttribute('y', bg.y);
  img.setAttribute('width', Math.max(1, bg.w));
  img.setAttribute('height', Math.max(1, bg.h));
  img.setAttribute('opacity', bg.opacity);
  img.setAttribute('preserveAspectRatio', 'none');
  img.style.pointerEvents = 'none'; // never absorbs clicks; rooms/items stay interactive
  bgLayer.appendChild(img);
}

function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

function renderGrid() {
  clear(gridLayer);
  const r = canvas.getBoundingClientRect();
  const topLeft = screenToWorld(0, 0);
  const botRight = screenToWorld(r.width, r.height);
  let g = gridInches();
  let major = majorEveryInches();
  // adaptive: ensure minor gridlines are at least ~6px apart in screen space
  while (g * camera.scale < 6) g *= 2;
  while (major * camera.scale < 24) major *= 2;
  const x0 = Math.floor(topLeft.x / g) * g;
  const x1 = Math.ceil(botRight.x / g) * g;
  const y0 = Math.floor(topLeft.y / g) * g;
  const y1 = Math.ceil(botRight.y / g) * g;
  // vertical
  for (let x = x0; x <= x1 + 1e-6; x += g) {
    const line = document.createElementNS(SVGNS, 'line');
    line.setAttribute('x1', x); line.setAttribute('x2', x);
    line.setAttribute('y1', topLeft.y); line.setAttribute('y2', botRight.y);
    let cls = 'grid-line';
    if (Math.abs(x) < 1e-6) cls += ' origin';
    else if (Math.abs(x % major) < 1e-6) cls += ' major';
    line.setAttribute('class', cls);
    // stroke width must be scaled for world-space; use vector-effect
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    gridLayer.appendChild(line);
  }
  // horizontal
  for (let y = y0; y <= y1 + 1e-6; y += g) {
    const line = document.createElementNS(SVGNS, 'line');
    line.setAttribute('y1', y); line.setAttribute('y2', y);
    line.setAttribute('x1', topLeft.x); line.setAttribute('x2', botRight.x);
    let cls = 'grid-line';
    if (Math.abs(y) < 1e-6) cls += ' origin';
    else if (Math.abs(y % major) < 1e-6) cls += ' major';
    line.setAttribute('class', cls);
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    gridLayer.appendChild(line);
  }
}

function renderRulers() {
  clear(rulerLayer);
  const r = canvas.getBoundingClientRect();
  const w = r.width, h = r.height;
  const RULER_SIZE = 22;
  // backgrounds
  const top = document.createElementNS(SVGNS, 'rect');
  top.setAttribute('x', 0); top.setAttribute('y', 0);
  top.setAttribute('width', w); top.setAttribute('height', RULER_SIZE);
  top.setAttribute('class', 'ruler-bg');
  rulerLayer.appendChild(top);
  const left = document.createElementNS(SVGNS, 'rect');
  left.setAttribute('x', 0); left.setAttribute('y', 0);
  left.setAttribute('width', RULER_SIZE); left.setAttribute('height', h);
  left.setAttribute('class', 'ruler-bg');
  rulerLayer.appendChild(left);
  // border lines
  const bl = document.createElementNS(SVGNS, 'line');
  bl.setAttribute('x1', 0); bl.setAttribute('y1', RULER_SIZE); bl.setAttribute('x2', w); bl.setAttribute('y2', RULER_SIZE);
  bl.setAttribute('stroke', '#d5dae3'); rulerLayer.appendChild(bl);
  const bl2 = document.createElementNS(SVGNS, 'line');
  bl2.setAttribute('x1', RULER_SIZE); bl2.setAttribute('y1', 0); bl2.setAttribute('x2', RULER_SIZE); bl2.setAttribute('y2', h);
  bl2.setAttribute('stroke', '#d5dae3'); rulerLayer.appendChild(bl2);

  // ticks & labels based on camera
  let major = majorEveryInches();
  let minor = gridInches();
  while (minor * camera.scale < 6) minor *= 2;
  while (major * camera.scale < 24) major *= 2;
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(w, h);

  // Determine label stride so labels don't overlap
  const labelSpacingPx = 60;
  const worldPerPx = 1 / camera.scale;
  let labelStrideWorld = major;
  while (labelStrideWorld * camera.scale < labelSpacingPx) labelStrideWorld *= 2;

  // horizontal (top)
  const xStart = Math.floor(tl.x / minor) * minor;
  const xEnd = Math.ceil(br.x / minor) * minor;
  for (let x = xStart; x <= xEnd + 1e-6; x += minor) {
    const sx = worldToScreen(x, 0).x;
    if (sx < RULER_SIZE) continue;
    const isMajor = Math.abs(x % major) < 1e-6;
    const tick = document.createElementNS(SVGNS, 'line');
    tick.setAttribute('x1', sx); tick.setAttribute('x2', sx);
    tick.setAttribute('y1', RULER_SIZE); tick.setAttribute('y2', RULER_SIZE - (isMajor ? 8 : 4));
    tick.setAttribute('class', 'ruler-tick');
    rulerLayer.appendChild(tick);
    if (isMajor && Math.abs(x % labelStrideWorld) < 1e-6) {
      const t = document.createElementNS(SVGNS, 'text');
      t.setAttribute('x', sx + 2); t.setAttribute('y', 12);
      t.setAttribute('class', 'ruler-text');
      t.textContent = formatLen(x);
      rulerLayer.appendChild(t);
    }
  }
  // vertical (left)
  const yStart = Math.floor(tl.y / minor) * minor;
  const yEnd = Math.ceil(br.y / minor) * minor;
  for (let y = yStart; y <= yEnd + 1e-6; y += minor) {
    const sy = worldToScreen(0, y).y;
    if (sy < RULER_SIZE) continue;
    const isMajor = Math.abs(y % major) < 1e-6;
    const tick = document.createElementNS(SVGNS, 'line');
    tick.setAttribute('y1', sy); tick.setAttribute('y2', sy);
    tick.setAttribute('x1', RULER_SIZE); tick.setAttribute('x2', RULER_SIZE - (isMajor ? 8 : 4));
    tick.setAttribute('class', 'ruler-tick');
    rulerLayer.appendChild(tick);
    if (isMajor && Math.abs(y % labelStrideWorld) < 1e-6) {
      const t = document.createElementNS(SVGNS, 'text');
      t.setAttribute('x', 4); t.setAttribute('y', sy - 2);
      t.setAttribute('class', 'ruler-text');
      t.textContent = formatLen(y);
      rulerLayer.appendChild(t);
    }
  }

  // corner cover
  const cc = document.createElementNS(SVGNS, 'rect');
  cc.setAttribute('x', 0); cc.setAttribute('y', 0);
  cc.setAttribute('width', RULER_SIZE); cc.setAttribute('height', RULER_SIZE);
  cc.setAttribute('class', 'ruler-bg');
  rulerLayer.appendChild(cc);
}

function renderRooms() {
  clear(roomsLayer);
  for (const room of state.rooms) {
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('data-id', room.id);
    g.setAttribute('data-kind', 'room');
    const rect = document.createElementNS(SVGNS, 'rect');
    rect.setAttribute('x', room.x); rect.setAttribute('y', room.y);
    rect.setAttribute('width', room.w); rect.setAttribute('height', room.h);
    rect.setAttribute('fill', room.color);
    rect.setAttribute('stroke', darker(room.color));
    rect.setAttribute('class', 'room-rect' + (isSelected('room', room.id) ? ' selected' : ''));
    rect.setAttribute('vector-effect', 'non-scaling-stroke');
    g.appendChild(rect);
    // room label
    const label = document.createElementNS(SVGNS, 'text');
    label.setAttribute('x', room.x + room.w / 2);
    label.setAttribute('y', room.y + 10 / camera.scale + 4 / camera.scale);
    label.setAttribute('class', 'room-label');
    label.setAttribute('style', `font-size:${11 / camera.scale}px`);
    label.textContent = room.name || 'Room';
    g.appendChild(label);
    // dimension labels when selected
    if (isSelected('room', room.id)) appendDimLabels(g, room);
    roomsLayer.appendChild(g);
  }
}

function renderItems() {
  clear(itemsLayer);
  for (const it of state.items) {
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('data-id', it.id);
    g.setAttribute('data-kind', 'item');
    const cx = it.x + it.w / 2;
    const cy = it.y + it.h / 2;
    const rot = Number.isFinite(Number(it.rotation)) ? Number(it.rotation) : 0;
    g.setAttribute('transform', `rotate(${rot} ${cx} ${cy})`);
    const shape = it.shape || 'rect';
    const sel = isSelected('item', it.id);

    if (shape === 'circle') {
      const el = document.createElementNS(SVGNS, 'ellipse');
      el.setAttribute('cx', cx); el.setAttribute('cy', cy);
      el.setAttribute('rx', it.w / 2); el.setAttribute('ry', it.h / 2);
      el.setAttribute('fill', it.color);
      el.setAttribute('stroke', darker(it.color));
      el.setAttribute('class', 'item-rect' + (sel ? ' selected' : ''));
      el.setAttribute('vector-effect', 'non-scaling-stroke');
      g.appendChild(el);
    } else if (shape === 'door') {
      // Door frame (thin wall slot) and swing: hinge at (x,y) or (x+w,y) if flipped.
      // Local door: opening along top edge from x..x+w at y..y+h; swings upward (-y) in world coords.
      // Frame line along the top (wall side)
      const wall = document.createElementNS(SVGNS, 'line');
      wall.setAttribute('x1', it.x); wall.setAttribute('y1', it.y);
      wall.setAttribute('x2', it.x + it.w); wall.setAttribute('y2', it.y);
      wall.setAttribute('stroke', darker(it.color));
      wall.setAttribute('stroke-width', '2');
      wall.setAttribute('vector-effect', 'non-scaling-stroke');
      g.appendChild(wall);
      // Opening rect (lightly filled, shows door thickness)
      const frame = document.createElementNS(SVGNS, 'rect');
      frame.setAttribute('x', it.x); frame.setAttribute('y', it.y);
      frame.setAttribute('width', it.w); frame.setAttribute('height', it.h);
      frame.setAttribute('fill', '#ffffff');
      frame.setAttribute('stroke', 'none');
      g.appendChild(frame);
      // Door leaf + swing arc
      const hingeX = it.flip ? it.x + it.w : it.x;
      const tipOpenX = hingeX;        // open position is perpendicular to wall
      const tipOpenY = it.y - it.w;
      const tipClosedX = it.flip ? it.x : it.x + it.w;
      const tipClosedY = it.y;
      // Door leaf (the swung-open position)
      const leaf = document.createElementNS(SVGNS, 'line');
      leaf.setAttribute('x1', hingeX); leaf.setAttribute('y1', it.y);
      leaf.setAttribute('x2', tipOpenX); leaf.setAttribute('y2', tipOpenY);
      leaf.setAttribute('stroke', darker(it.color));
      leaf.setAttribute('stroke-width', '2');
      leaf.setAttribute('vector-effect', 'non-scaling-stroke');
      g.appendChild(leaf);
      // Swing arc: quarter-circle from closed tip to open tip, radius = w, center at hinge
      const sweep = it.flip ? 1 : 0; // direction of arc
      const arc = document.createElementNS(SVGNS, 'path');
      arc.setAttribute('d', `M ${tipClosedX} ${tipClosedY} A ${it.w} ${it.w} 0 0 ${sweep} ${tipOpenX} ${tipOpenY}`);
      arc.setAttribute('fill', 'none');
      arc.setAttribute('stroke', darker(it.color));
      arc.setAttribute('stroke-width', '1');
      arc.setAttribute('stroke-dasharray', '4 3');
      arc.setAttribute('vector-effect', 'non-scaling-stroke');
      g.appendChild(arc);
      // Bounding box for selection outline and hit area
      const bbox = document.createElementNS(SVGNS, 'rect');
      bbox.setAttribute('x', it.x); bbox.setAttribute('y', it.y);
      bbox.setAttribute('width', it.w); bbox.setAttribute('height', it.h);
      bbox.setAttribute('fill', 'transparent');
      bbox.setAttribute('stroke', sel ? '#3d6ef5' : 'transparent');
      bbox.setAttribute('stroke-dasharray', sel ? '3 3' : 'none');
      bbox.setAttribute('vector-effect', 'non-scaling-stroke');
      bbox.setAttribute('class', 'item-rect');
      bbox.style.cursor = 'move';
      g.appendChild(bbox);
    } else {
      const rect = document.createElementNS(SVGNS, 'rect');
      rect.setAttribute('x', it.x); rect.setAttribute('y', it.y);
      rect.setAttribute('width', it.w); rect.setAttribute('height', it.h);
      rect.setAttribute('fill', it.color);
      rect.setAttribute('stroke', darker(it.color));
      rect.setAttribute('class', 'item-rect' + (sel ? ' selected' : ''));
      rect.setAttribute('vector-effect', 'non-scaling-stroke');
      g.appendChild(rect);
    }

    if (shape !== 'door') {
      const label = document.createElementNS(SVGNS, 'text');
      label.setAttribute('x', cx);
      label.setAttribute('y', cy);
      label.setAttribute('class', 'item-label');
      label.setAttribute('style', `font-size:${9 / camera.scale}px`);
      label.textContent = it.name || '';
      g.appendChild(label);
    }
    if (sel) appendDimLabels(g, it);
    itemsLayer.appendChild(g);
  }
}

function appendDimLabels(g, o) {
  const offset = 14 / camera.scale;
  const fs = 10 / camera.scale;
  const sw = 3 / camera.scale;
  const mk = (x, y, text) => {
    const bg = document.createElementNS(SVGNS, 'text');
    bg.setAttribute('x', x); bg.setAttribute('y', y);
    bg.setAttribute('class', 'dim-label bg');
    bg.setAttribute('style', `font-size:${fs}px;stroke-width:${sw}px`);
    bg.textContent = text;
    g.appendChild(bg);
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('x', x); t.setAttribute('y', y);
    t.setAttribute('class', 'dim-label');
    t.setAttribute('style', `font-size:${fs}px`);
    t.textContent = text;
    g.appendChild(t);
  };
  mk(o.x + o.w / 2, o.y - offset, formatLen(o.w));
  mk(o.x + o.w / 2, o.y + o.h + offset, formatLen(o.w));
  mk(o.x - offset * 1.6, o.y + o.h / 2, formatLen(o.h));
  mk(o.x + o.w + offset * 1.6, o.y + o.h / 2, formatLen(o.h));
}

function darker(hex) {
  // simple darken for stroke
  const c = hex.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16);
  const gg = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  const d = (n) => Math.max(0, Math.round(n * 0.65)).toString(16).padStart(2, '0');
  return `#${d(r)}${d(gg)}${d(b)}`;
}

function renderHandles() {
  clear(handlesLayer);
  if (!selected) return;
  const o = getSelected();
  if (!o) return;
  // handles in screen space, so zoom doesn't change their size
  const handleSize = matchMedia('(pointer: coarse)').matches ? 22 : 8;
  const corners = [
    { name: 'nw', x: o.x,         y: o.y },
    { name: 'n',  x: o.x + o.w/2, y: o.y },
    { name: 'ne', x: o.x + o.w,   y: o.y },
    { name: 'e',  x: o.x + o.w,   y: o.y + o.h/2 },
    { name: 'se', x: o.x + o.w,   y: o.y + o.h },
    { name: 's',  x: o.x + o.w/2, y: o.y + o.h },
    { name: 'sw', x: o.x,         y: o.y + o.h },
    { name: 'w',  x: o.x,         y: o.y + o.h/2 },
  ];
  // Apply rotation for items
  const angle = (selected.kind === 'item' && o.rotation) ? o.rotation : 0;
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  for (const c of corners) {
    const rp = rotatePoint(c.x, c.y, cx, cy, angle);
    const s = worldToScreen(rp.x, rp.y);
    const rect = document.createElementNS(SVGNS, 'rect');
    rect.setAttribute('x', s.x - handleSize / 2);
    rect.setAttribute('y', s.y - handleSize / 2);
    rect.setAttribute('width', handleSize);
    rect.setAttribute('height', handleSize);
    rect.setAttribute('class', `handle ${c.name}`);
    rect.setAttribute('data-handle', c.name);
    handlesLayer.appendChild(rect);
  }
}

function rotatePoint(x, y, cx, cy, deg) {
  if (!deg) return { x, y };
  const rad = deg * Math.PI / 180;
  const dx = x - cx, dy = y - cy;
  return { x: cx + dx * Math.cos(rad) - dy * Math.sin(rad), y: cy + dx * Math.sin(rad) + dy * Math.cos(rad) };
}

function isSelected(kind, id) { return selected && selected.kind === kind && selected.id === id; }

function getSelected() {
  if (!selected) return null;
  const arr = selected.kind === 'room' ? state.rooms : state.items;
  return arr.find(o => o.id === selected.id);
}

// ---------- Sidebar ----------
let drawerOpen = false;
function setDrawerOpen(open) {
  drawerOpen = open;
  document.body.classList.toggle('props-open', drawerOpen);
}

function renderSidebar() {
  renderingSidebar = true;
  try {
    const o = getSelected();
    const emptyPanel = $('emptyPanel');
    const propsPanel = $('propsPanel');
    const selActions = $('selectionActions');
    selActions.hidden = !o;
    if (selActions && o) {
      // rotate only makes sense for items
      $('rotateBtn').hidden = selected.kind !== 'item';
    }
    // Deselection always closes the mobile drawer.
    if (!o && drawerOpen) setDrawerOpen(false);
    if (!o) {
      emptyPanel.hidden = false;
      propsPanel.hidden = true;
      return;
    }
    emptyPanel.hidden = true;
    propsPanel.hidden = false;
    $('propsTitle').textContent = selected.kind === 'room' ? 'Room' : 'Item';
    $('fName').value = o.name || '';
    $('fX').value = formatLen(o.x);
    $('fY').value = formatLen(o.y);
    $('fW').value = formatLen(o.w);
    $('fH').value = formatLen(o.h);
    $('fColor').value = o.color;
    const rotRow = $('rotationRow');
    const shapeRow = $('shapeRow');
    const doorActions = $('doorActions');
    if (selected.kind === 'item') {
      rotRow.hidden = false;
      shapeRow.hidden = false;
      $('fRot').value = String(Number(o.rotation) || 0);
      $('fShape').value = o.shape || 'rect';
      doorActions.hidden = (o.shape !== 'door');
    } else {
      rotRow.hidden = true;
      shapeRow.hidden = true;
      doorActions.hidden = true;
    }
  } finally {
    renderingSidebar = false;
  }
}

let renderingSidebar = false;

function bindSidebar() {
  // Each field writes only its own state property, and only when the user actually
  // changed it (guarded by `renderingSidebar` so programmatic value-setting is never
  // mistaken for user intent).
  function bindField(id, apply) {
    const el = $(id);
    const handler = () => {
      if (renderingSidebar) return;
      const o = getSelected();
      if (!o) return;
      pushUndo();
      apply(o, el);
      renderAll(); persist();
    };
    el.addEventListener('change', handler);
    if (el.tagName === 'INPUT' && el.type === 'text') {
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); handler(); } });
    }
  }
  bindField('fName',  (o) => { o.name = $('fName').value; });
  bindField('fX',     (o) => { const v = parseLen($('fX').value); if (isFinite(v)) o.x = v; });
  bindField('fY',     (o) => { const v = parseLen($('fY').value); if (isFinite(v)) o.y = v; });
  bindField('fW',     (o) => { const v = parseLen($('fW').value); if (isFinite(v) && v > 0) o.w = v; });
  bindField('fH',     (o) => { const v = parseLen($('fH').value); if (isFinite(v) && v > 0) o.h = v; });
  bindField('fColor', (o) => { o.color = $('fColor').value; });
  bindField('fRot',   (o) => { if (selected.kind === 'item') o.rotation = parseInt($('fRot').value, 10) || 0; });
  bindField('fShape', (o) => {
    if (selected.kind !== 'item') return;
    const newShape = $('fShape').value || 'rect';
    if (newShape !== o.shape) {
      o.shape = newShape;
      if (newShape === 'door' && o.flip === undefined) o.flip = false;
      if (newShape !== 'door') delete o.flip;
    }
  });
  $('duplicate').addEventListener('click', () => {
    const o = getSelected();
    if (!o) return;
    pushUndo();
    const copy = { ...o, id: uid(), x: o.x + 12, y: o.y + 12 };
    if (selected.kind === 'room') state.rooms.push(copy); else state.items.push(copy);
    selected = { kind: selected.kind, id: copy.id };
    renderAll(); persist();
  });
  $('flipDoor').addEventListener('click', () => {
    const o = getSelected();
    if (!o || o.shape !== 'door') return;
    pushUndo();
    o.flip = !o.flip;
    renderAll(); persist();
  });
  $('remove').addEventListener('click', deleteSelected);
  $('sidebarClose').addEventListener('click', () => { selected = null; renderAll(); });
  // Top-bar selection actions mirror the sidebar actions so users don't need
  // to open the drawer for simple rotate/duplicate/delete edits.
  $('rotateBtn').addEventListener('click', () => {
    if (!selected || selected.kind !== 'item') return;
    pushUndo();
    const o = getSelected();
    o.rotation = ((Number(o.rotation) || 0) + 90) % 360;
    renderAll(); persist();
  });
  $('duplicateBtn').addEventListener('click', () => $('duplicate').click());
  $('deleteBtn').addEventListener('click', deleteSelected);
  $('detailsBtn').addEventListener('click', () => setDrawerOpen(true));
  $('planName').addEventListener('change', () => { state.name = $('planName').value; persist(); });
  $('units').addEventListener('change', () => {
    pushUndo();
    state.units = $('units').value;
    renderAll(); persist();
  });
  $('snap').addEventListener('change', () => { snap = $('snap').checked; });
}

function deleteSelected() {
  if (!selected) return;
  pushUndo();
  if (selected.kind === 'room') state.rooms = state.rooms.filter(r => r.id !== selected.id);
  else state.items = state.items.filter(r => r.id !== selected.id);
  selected = null;
  renderAll(); persist();
}

// ---------- Tool switching ----------
function setTool(t) {
  tool = t;
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  canvas.classList.remove('tool-room', 'tool-measure', 'tool-pan');
  if (t === 'room') canvas.classList.add('tool-room');
  if (t === 'measure') canvas.classList.add('tool-measure');
  if (t === 'pan') canvas.classList.add('tool-pan');
  showHint(t === 'room' ? 'Drag on the canvas to draw a room' :
           t === 'measure' ? 'Click two points to measure a distance' :
           t === 'pan' ? 'Drag the canvas to pan' : '');
  measureStart = null; clear(measureLayer);
}

function showHint(text) {
  if (!text) { hintEl.classList.remove('visible'); return; }
  hintEl.textContent = text;
  hintEl.classList.add('visible');
}

// ---------- Interaction ----------
let interaction = null; // { kind: 'pan'|'move'|'resize'|'draw', ... }
let measureStart = null;
let spaceDown = false;

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('pointerleave', onPointerUp);
canvas.addEventListener('wheel', onWheel, { passive: false });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// Multi-touch gestures:
//   2 fingers → pinch zoom at centroid (also pans with centroid)
//   3+ fingers → pan
// Both take over from any in-progress pointer interaction.
let touchPan = null;
let pinch = null;
function touchCentroid(touches) {
  let x = 0, y = 0;
  for (const t of touches) { x += t.clientX; y += t.clientY; }
  return { x: x / touches.length, y: y / touches.length };
}
canvas.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    const [a, b] = e.touches;
    const r = canvas.getBoundingClientRect();
    const cx = (a.clientX + b.clientX) / 2 - r.left;
    const cy = (a.clientY + b.clientY) / 2 - r.top;
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    pinch = {
      dist0: dist,
      scale0: camera.scale,
      wp: screenToWorld(cx, cy),
    };
    interaction = null;
    clearSnapGuides();
    canvas.classList.remove('panning');
    e.preventDefault();
  } else if (e.touches.length >= 3) {
    pinch = null;
    const c = touchCentroid(e.touches);
    touchPan = { cx: c.x, cy: c.y, tx0: camera.tx, ty0: camera.ty };
    interaction = null;
    canvas.classList.add('panning');
    e.preventDefault();
  }
}, { passive: false });
canvas.addEventListener('touchmove', (e) => {
  if (pinch && e.touches.length === 2) {
    const [a, b] = e.touches;
    const r = canvas.getBoundingClientRect();
    const cx = (a.clientX + b.clientX) / 2 - r.left;
    const cy = (a.clientY + b.clientY) / 2 - r.top;
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    camera.scale = Math.min(40, Math.max(0.5, pinch.scale0 * (dist / pinch.dist0)));
    // Keep the world point under the initial centroid pinned under the current centroid
    camera.tx = cx - pinch.wp.x * camera.scale;
    camera.ty = cy - pinch.wp.y * camera.scale;
    applyCamera();
    renderHandles();
    e.preventDefault();
    return;
  }
  if (touchPan && e.touches.length >= 3) {
    const c = touchCentroid(e.touches);
    camera.tx = touchPan.tx0 + (c.x - touchPan.cx);
    camera.ty = touchPan.ty0 + (c.y - touchPan.cy);
    applyCamera();
    renderHandles();
    e.preventDefault();
  }
}, { passive: false });
canvas.addEventListener('touchend', (e) => {
  if (pinch && e.touches.length < 2) pinch = null;
  if (touchPan && e.touches.length < 3) {
    touchPan = null;
    canvas.classList.remove('panning');
  }
});

function onPointerDown(e) {
  canvas.setPointerCapture(e.pointerId);
  const p = pointerWorld(e);
  // Calibrate mode swallows clicks: 1st click marks point A, 2nd click marks
  // point B and prompts for the real-world distance.
  if (calibrateState && e.button === 0) {
    if (!calibrateState.a) {
      calibrateState.a = p;
      showHint('Click the second reference point');
      renderCalibrateMarkers();
    } else {
      const a = calibrateState.a;
      const b = p;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const answer = prompt(`Selected points are currently ${formatLen(d)} apart on the background. Enter the real-world distance between them:`);
      if (answer != null) {
        const target = parseLen(answer);
        if (isFinite(target) && target > 0) applyCalibration(a, b, target);
        else alert('Could not parse that distance.');
      }
      cancelCalibrate();
    }
    e.preventDefault();
    return;
  }
  // middle mouse, space-drag, or pan tool = pan
  if (e.button === 1 || (e.button === 0 && (spaceDown || tool === 'pan'))) {
    interaction = { kind: 'pan', startX: e.clientX, startY: e.clientY, tx0: camera.tx, ty0: camera.ty };
    canvas.classList.add('panning');
    return;
  }
  if (e.button !== 0) return;

  // handle hit
  const hTarget = e.target.closest('.handle');
  if (hTarget && selected) {
    const o = getSelected();
    if (o) {
      interaction = { kind: 'resize', handle: hTarget.dataset.handle, orig: { ...o }, startWorld: p };
      pushUndo();
      return;
    }
  }

  // hit-test rooms/items (prefer items; they're on top)
  const hit = hitTest(p.x, p.y);

  if (tool === 'room') {
    pushUndo();
    const x = snapV(p.x), y = snapV(p.y);
    const room = { id: uid(), name: 'Room', x, y, w: 0, h: 0, color: '#bcd6f5' };
    state.rooms.push(room);
    selected = { kind: 'room', id: room.id };
    interaction = { kind: 'draw', kindOf: 'room', id: room.id, anchor: { x, y } };
    renderAll();
    return;
  }

  if (tool === 'measure') {
    if (!measureStart) {
      measureStart = p;
    } else {
      drawMeasure(measureStart, p, true);
      measureStart = null;
    }
    return;
  }

  // select tool — start interactions in a "pending" state so tiny finger wiggles
  // don't accidentally move the object or pan the view.
  if (hit) {
    selected = { kind: hit.kind, id: hit.obj.id };
    interaction = {
      kind: 'pending-move',
      orig: { ...hit.obj },
      startWorld: p,
      startClientX: e.clientX, startClientY: e.clientY,
    };
    renderAll();
  } else {
    selected = null;
    interaction = {
      kind: 'pending-pan',
      startX: e.clientX, startY: e.clientY,
      tx0: camera.tx, ty0: camera.ty,
    };
    renderAll();
  }
}

function moveThresholdPx() {
  return matchMedia('(pointer: coarse)').matches ? 10 : 3;
}

function onPointerMove(e) {
  const p = pointerWorld(e);
  // hover tooltip for dimensions
  if (!interaction && tool === 'select') {
    const hit = hitTest(p.x, p.y);
    if (hit) showTooltip(e, `${hit.obj.name || ''} ${formatLen(hit.obj.w)} × ${formatLen(hit.obj.h)}`.trim());
    else hideTooltip();
  } else hideTooltip();

  // live preview for measure
  if (tool === 'measure' && measureStart) {
    drawMeasure(measureStart, p, false);
  }

  if (!interaction) return;

  // Promote pending interactions to real ones only after a threshold distance.
  // Below that, the gesture is treated as a tap/click.
  if (interaction.kind === 'pending-move') {
    const dd = Math.hypot(e.clientX - interaction.startClientX, e.clientY - interaction.startClientY);
    if (dd < moveThresholdPx()) return;
    pushUndo();
    interaction = { kind: 'move', orig: interaction.orig, startWorld: interaction.startWorld };
  } else if (interaction.kind === 'pending-pan') {
    const dd = Math.hypot(e.clientX - interaction.startX, e.clientY - interaction.startY);
    if (dd < moveThresholdPx()) return;
    interaction.kind = 'pan';
    canvas.classList.add('panning');
  }

  if (interaction.kind === 'pan') {
    camera.tx = interaction.tx0 + (e.clientX - interaction.startX);
    camera.ty = interaction.ty0 + (e.clientY - interaction.startY);
    applyCamera();
    return;
  }
  if (interaction.kind === 'draw') {
    const room = state.rooms.find(r => r.id === interaction.id);
    if (!room) return;
    let x = p.x, y = p.y;
    activeSnapGuides = [];
    let snappedX = false, snappedY = false;
    // room-snap first (takes priority over grid, so off-grid walls still align)
    if (!e.shiftKey) {
      const { xs, ys } = snapTargets('room', room.id);
      const th = ROOM_SNAP_PX / camera.scale;
      const sx = nearestEdge(x, xs, th);
      if (sx) { x = sx.v; snappedX = true; activeSnapGuides.push({ axis: 'x', v: sx.v, bbox: sx.bbox }); }
      const sy = nearestEdge(y, ys, th);
      if (sy) { y = sy.v; snappedY = true; activeSnapGuides.push({ axis: 'y', v: sy.v, bbox: sy.bbox }); }
    }
    // grid-snap axes that didn't already snap to a room
    if (!e.shiftKey && snap) {
      if (!snappedX) x = snapV(x);
      if (!snappedY) y = snapV(y);
    }
    room.x = Math.min(interaction.anchor.x, x);
    room.y = Math.min(interaction.anchor.y, y);
    room.w = Math.abs(x - interaction.anchor.x);
    room.h = Math.abs(y - interaction.anchor.y);
    renderRooms(); renderHandles(); renderSnapGuides();
    return;
  }
  if (interaction.kind === 'move') {
    const o = getSelected(); if (!o) return;
    let dx = p.x - interaction.startWorld.x;
    let dy = p.y - interaction.startWorld.y;
    let nx = interaction.orig.x + dx;
    let ny = interaction.orig.y + dy;
    activeSnapGuides = [];
    let snappedX = false, snappedY = false;
    // edge snap (rooms + items) first; per-axis so a corner snaps on both walls
    if (!e.shiftKey) {
      const bbox = (selected.kind === 'room')
        ? { x: nx, y: ny, w: o.w, h: o.h }
        : itemVisualBBox({ ...o, x: nx, y: ny });
      const s = computeMoveSnap(bbox.x, bbox.y, bbox.w, bbox.h, selected.kind, o.id);
      if (s.guideX) { nx += s.dx; snappedX = true; activeSnapGuides.push({ axis: 'x', v: s.guideX.v, bbox: s.guideX.bbox }); }
      if (s.guideY) { ny += s.dy; snappedY = true; activeSnapGuides.push({ axis: 'y', v: s.guideY.v, bbox: s.guideY.bbox }); }
    }
    // grid-snap only axes that didn't already snap to a wall/edge
    if (!e.shiftKey && snap) {
      if (!snappedX) nx = snapV(nx);
      if (!snappedY) ny = snapV(ny);
    }
    o.x = nx; o.y = ny;
    renderRooms(); renderItems(); renderHandles(); renderSidebar(); renderSnapGuides();
    return;
  }
  if (interaction.kind === 'resize') {
    const o = getSelected(); if (!o) return;
    const orig = interaction.orig;
    let dx = p.x - interaction.startWorld.x;
    let dy = p.y - interaction.startWorld.y;
    let nx = orig.x, ny = orig.y, nw = orig.w, nh = orig.h;
    const h = interaction.handle;
    if (h.includes('e')) nw = Math.max(1, orig.w + dx);
    if (h.includes('s')) nh = Math.max(1, orig.h + dy);
    if (h.includes('w')) { nw = Math.max(1, orig.w - dx); nx = orig.x + (orig.w - nw); }
    if (h.includes('n')) { nh = Math.max(1, orig.h - dy); ny = orig.y + (orig.h - nh); }
    activeSnapGuides = [];
    let snappedX = false, snappedY = false;
    // Edge snap (rooms + items) on the dragging edges; corner handles get both axes
    if (!e.shiftKey) {
      const { xs, ys } = snapTargets(selected.kind, o.id);
      const th = ROOM_SNAP_PX / camera.scale;
      if (h.includes('e')) {
        const right = nx + nw;
        const s = nearestEdge(right, xs, th);
        if (s) { nw = Math.max(1, s.v - nx); snappedX = true; activeSnapGuides.push({ axis: 'x', v: s.v, bbox: s.bbox }); }
      }
      if (h.includes('w')) {
        const left = nx;
        const right = nx + nw;
        const s = nearestEdge(left, xs, th);
        if (s) { nx = s.v; nw = Math.max(1, right - nx); snappedX = true; activeSnapGuides.push({ axis: 'x', v: s.v, bbox: s.bbox }); }
      }
      if (h.includes('s')) {
        const bot = ny + nh;
        const s = nearestEdge(bot, ys, th);
        if (s) { nh = Math.max(1, s.v - ny); snappedY = true; activeSnapGuides.push({ axis: 'y', v: s.v, bbox: s.bbox }); }
      }
      if (h.includes('n')) {
        const top = ny;
        const bot = ny + nh;
        const s = nearestEdge(top, ys, th);
        if (s) { ny = s.v; nh = Math.max(1, bot - ny); snappedY = true; activeSnapGuides.push({ axis: 'y', v: s.v, bbox: s.bbox }); }
      }
    }
    // Fall back to grid-snap on axes without a room-snap
    if (!e.shiftKey && snap) {
      const g = gridInches();
      if (!snappedX) {
        if (h.includes('e')) { nw = Math.max(1, Math.round((nx + nw) / g) * g - nx); }
        if (h.includes('w')) { const right = nx + nw; nx = Math.round(nx / g) * g; nw = Math.max(1, right - nx); }
      }
      if (!snappedY) {
        if (h.includes('s')) { nh = Math.max(1, Math.round((ny + nh) / g) * g - ny); }
        if (h.includes('n')) { const bot = ny + nh; ny = Math.round(ny / g) * g; nh = Math.max(1, bot - ny); }
      }
    }
    o.x = nx; o.y = ny; o.w = nw; o.h = nh;
    renderRooms(); renderItems(); renderHandles(); renderSidebar(); renderSnapGuides();
  }
}

function onPointerUp(e) {
  if (!interaction) {
    canvas.classList.remove('panning');
    return;
  }
  if (interaction.kind === 'draw') {
    const room = state.rooms.find(r => r.id === interaction.id);
    if (room && (room.w < 1 || room.h < 1)) {
      // too small, treat as cancelled
      state.rooms = state.rooms.filter(r => r.id !== room.id);
      selected = null;
      undoStack.pop();
    }
    setTool('select');
  }
  interaction = null;
  canvas.classList.remove('panning');
  clearSnapGuides();
  renderAll();
  persist();
}

function onWheel(e) {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const mx = e.clientX - r.left;
  const my = e.clientY - r.top;
  const wp = screenToWorld(mx, my);
  const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.015 : 0.0015));
  camera.scale = Math.min(40, Math.max(0.5, camera.scale * factor));
  camera.tx = mx - wp.x * camera.scale;
  camera.ty = my - wp.y * camera.scale;
  applyCamera();
  renderHandles();
}

function hitTest(wx, wy) {
  // items last (on top)
  for (let i = state.items.length - 1; i >= 0; i--) {
    const o = state.items[i];
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    // reverse-rotate the point into item's local coords
    const lp = o.rotation ? rotatePoint(wx, wy, cx, cy, -o.rotation) : { x: wx, y: wy };
    const shape = o.shape || 'rect';
    if (shape === 'circle') {
      const rx = o.w / 2, ry = o.h / 2;
      const dx = (lp.x - cx) / rx, dy = (lp.y - cy) / ry;
      if (dx * dx + dy * dy <= 1) return { kind: 'item', obj: o };
    } else if (shape === 'door') {
      // bounding box plus the swing quadrant (above the door in local coords)
      if (lp.x >= o.x && lp.x <= o.x + o.w && lp.y >= o.y - o.w && lp.y <= o.y + o.h) return { kind: 'item', obj: o };
    } else {
      if (lp.x >= o.x && lp.x <= o.x + o.w && lp.y >= o.y && lp.y <= o.y + o.h) return { kind: 'item', obj: o };
    }
  }
  for (let i = state.rooms.length - 1; i >= 0; i--) {
    const o = state.rooms[i];
    if (wx >= o.x && wx <= o.x + o.w && wy >= o.y && wy <= o.y + o.h) return { kind: 'room', obj: o };
  }
  return null;
}

function showTooltip(e, text) {
  const r = canvas.getBoundingClientRect();
  tooltip.hidden = false;
  tooltip.textContent = text;
  tooltip.style.left = (e.clientX - r.left + 14) + 'px';
  tooltip.style.top = (e.clientY - r.top + 14) + 'px';
}
function hideTooltip() { tooltip.hidden = true; }

// ---------- Measure overlay ----------
function drawMeasure(a, b, persistIt) {
  clear(measureLayer);
  const line = document.createElementNS(SVGNS, 'line');
  line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
  line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
  line.setAttribute('class', 'measure-line');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  measureLayer.appendChild(line);
  for (const p of [a, b]) {
    const dot = document.createElementNS(SVGNS, 'circle');
    dot.setAttribute('cx', p.x); dot.setAttribute('cy', p.y);
    dot.setAttribute('r', 3 / camera.scale);
    dot.setAttribute('class', 'measure-end');
    measureLayer.appendChild(dot);
  }
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const mfs = 11 / camera.scale;
  const msw = 3 / camera.scale;
  const bg = document.createElementNS(SVGNS, 'text');
  bg.setAttribute('x', mid.x); bg.setAttribute('y', mid.y - 8 / camera.scale);
  bg.setAttribute('class', 'dim-label bg');
  bg.setAttribute('style', `font-size:${mfs}px;stroke-width:${msw}px`);
  bg.textContent = formatLen(dist);
  measureLayer.appendChild(bg);
  const t = document.createElementNS(SVGNS, 'text');
  t.setAttribute('x', mid.x); t.setAttribute('y', mid.y - 8 / camera.scale);
  t.setAttribute('class', 'dim-label');
  t.setAttribute('style', `font-size:${mfs}px`);
  t.textContent = formatLen(dist);
  measureLayer.appendChild(t);
  if (!persistIt) {
    // ephemeral preview during drag — leave it for now, cleared next click/tool change
  }
}

// ---------- Keyboard ----------
window.addEventListener('keydown', (e) => {
  // don't trigger when typing in inputs
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.key === ' ') { spaceDown = true; e.preventDefault(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); e.preventDefault(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { undo(); e.preventDefault(); return; }
  if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { redo(); e.preventDefault(); return; }
  if (e.key === '1') { setTool('select'); return; }
  if (e.key === '2') { setTool('pan'); return; }
  if (e.key === '3') { setTool('measure'); return; }
  if (e.key === '4') {
    if (selected && selected.kind === 'item') {
      pushUndo();
      const o = getSelected();
      o.rotation = ((Number(o.rotation) || 0) + 90) % 360;
      renderAll(); persist();
    }
    return;
  }
  if (e.key === 'Escape') {
    if (calibrateState) { cancelCalibrate(); return; }
    setTool('select'); selected = null; measureStart = null; clear(measureLayer); renderAll(); return;
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ') spaceDown = false;
});

// ---------- Toolbar ----------
for (const btn of document.querySelectorAll('.tool')) {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
}
$('addRoomBtn').addEventListener('click', () => setTool('room'));
$('helpBtn').addEventListener('click', () => $('helpDialog').showModal());

// ---------- Background image ----------
$('bgBtn').addEventListener('click', () => {
  $('bgError').hidden = true;
  const bg = state.bg;
  if (bg) {
    $('bgUrl').value = bg.url || '';
    $('bgX').value = formatLen(bg.x);
    $('bgY').value = formatLen(bg.y);
    $('bgW').value = formatLen(bg.w);
    $('bgH').value = formatLen(bg.h);
    $('bgOpacity').value = String(bg.opacity);
  } else {
    $('bgUrl').value = '';
    $('bgX').value = '0';
    $('bgY').value = '0';
    $('bgW').value = '';
    $('bgH').value = '';
    $('bgOpacity').value = '0.5';
  }
  $('bgDialog').showModal();
});

// When a URL is entered with empty size fields, probe the image's natural
// dimensions so we can size it at a sensible default (fits ~80% of viewport).
$('bgUrl').addEventListener('change', () => {
  const url = $('bgUrl').value.trim();
  if (!url) return;
  if ($('bgW').value.trim() && $('bgH').value.trim()) return;
  const probe = new Image();
  probe.crossOrigin = 'anonymous'; // helps some hosts; harmless for most
  probe.onload = () => {
    const r = canvas.getBoundingClientRect();
    const worldW = r.width / camera.scale;
    const w = worldW * 0.7;
    const h = w * (probe.naturalHeight / probe.naturalWidth);
    const c = screenToWorld(r.width / 2, r.height / 2);
    $('bgW').value = formatLen(w);
    $('bgH').value = formatLen(h);
    if (!$('bgX').value.trim() || $('bgX').value === '0') $('bgX').value = formatLen(c.x - w / 2);
    if (!$('bgY').value.trim() || $('bgY').value === '0') $('bgY').value = formatLen(c.y - h / 2);
  };
  probe.onerror = () => {
    $('bgError').textContent = "Couldn't load that URL — check it's a direct link to an image and the host allows hotlinking.";
    $('bgError').hidden = false;
  };
  probe.src = url;
});

$('bgDialog').addEventListener('close', () => {
  const rv = $('bgDialog').returnValue;
  if (rv === 'cancel' || rv === '') return;
  if (rv === 'calibrate') {
    // Commit any edits from the dialog fields first, then enter calibrate mode.
    commitBgFromDialog();
    startCalibrate();
    return;
  }
  pushUndo();
  if (rv === 'remove') {
    state.bg = null;
  } else if (rv === 'ok') {
    commitBgFromDialog();
  }
  renderAll(); persist();
});

function commitBgFromDialog() {
  const url = $('bgUrl').value.trim();
  if (!url) { state.bg = null; return; }
  state.bg = {
    url,
    x: parseLen($('bgX').value) || 0,
    y: parseLen($('bgY').value) || 0,
    w: Math.max(1, parseLen($('bgW').value) || 100),
    h: Math.max(1, parseLen($('bgH').value) || 100),
    opacity: Math.min(1, Math.max(0, parseFloat($('bgOpacity').value))) || 0.5,
  };
}

// ---------- Background calibrate ----------
// The user clicks two points on the background and enters the real-world
// distance between them. The image is scaled so those two points are exactly
// that distance apart, keeping the first point pinned to its original world
// position (so the feature under the user's finger/cursor stays put).
let calibrateState = null; // null | { a: null } | { a: {x,y} }

function startCalibrate() {
  if (!state.bg) return;
  calibrateState = { a: null };
  canvas.classList.add('tool-calibrate');
  showHint('Click the first reference point on the background');
  renderAll();
}

function cancelCalibrate() {
  calibrateState = null;
  canvas.classList.remove('tool-calibrate');
  clear(measureLayer);
  showHint('');
}

function renderCalibrateMarkers() {
  clear(measureLayer);
  if (!calibrateState || !calibrateState.a) return;
  const dot = document.createElementNS(SVGNS, 'circle');
  dot.setAttribute('cx', calibrateState.a.x);
  dot.setAttribute('cy', calibrateState.a.y);
  dot.setAttribute('r', 4 / camera.scale);
  dot.setAttribute('fill', '#e47b2e');
  measureLayer.appendChild(dot);
}

function applyCalibration(ptA, ptB, realDistance) {
  const bg = state.bg;
  if (!bg) return;
  const d = Math.hypot(ptB.x - ptA.x, ptB.y - ptA.y);
  if (!d) return;
  const s = realDistance / d;
  pushUndo();
  // Keep ptA fixed in world coords: new position = A - s*(A - bg.xy).
  bg.x = ptA.x - s * (ptA.x - bg.x);
  bg.y = ptA.y - s * (ptA.y - bg.y);
  bg.w *= s;
  bg.h *= s;
  renderAll();
  persist();
}
for (const btn of document.querySelectorAll('.preset')) {
  btn.addEventListener('click', () => { addItemFromPreset(btn.dataset.preset); closeAddMenu(); });
}

const addItemBtn = $('addItemBtn');
const addItemMenu = $('addItemMenu');
function openAddMenu() { addItemMenu.hidden = false; addItemBtn.setAttribute('aria-expanded', 'true'); }
function closeAddMenu() { addItemMenu.hidden = true; addItemBtn.setAttribute('aria-expanded', 'false'); }
addItemBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (addItemMenu.hidden) openAddMenu(); else closeAddMenu();
});
document.addEventListener('click', (e) => {
  if (addItemMenu.hidden) return;
  if (e.target.closest('#addItemMenu') || e.target === addItemBtn) return;
  closeAddMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAddMenu(); });

function addItemFromPreset(key) {
  if (key === 'custom') {
    $('customDialog').showModal();
    return;
  }
  const p = PRESETS[key];
  if (!p) return;
  pushUndo();
  // place at center of viewport
  const r = canvas.getBoundingClientRect();
  const center = screenToWorld(r.width / 2, r.height / 2);
  const it = {
    id: uid(),
    name: p.name,
    x: snapV(center.x - p.w / 2),
    y: snapV(center.y - p.h / 2),
    w: p.w, h: p.h,
    rotation: 0, color: p.color,
    shape: p.shape || 'rect',
  };
  if (it.shape === 'door') it.flip = !!p.flip;
  state.items.push(it);
  selected = { kind: 'item', id: it.id };
  setTool('select');
  renderAll(); persist();
}

$('customDialog').addEventListener('close', () => {
  if ($('customDialog').returnValue !== 'ok') return;
  const name = $('cName').value || 'Item';
  const w = parseLen($('cW').value);
  const h = parseLen($('cH').value);
  if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return;
  pushUndo();
  const r = canvas.getBoundingClientRect();
  const center = screenToWorld(r.width / 2, r.height / 2);
  const it = {
    id: uid(), name,
    x: snapV(center.x - w / 2), y: snapV(center.y - h / 2),
    w, h, rotation: 0, color: $('cColor').value,
    shape: $('cShape').value || 'rect',
  };
  state.items.push(it);
  selected = { kind: 'item', id: it.id };
  renderAll(); persist();
});

$('zoomIn').addEventListener('click', () => zoomAt(1.25));
$('zoomOut').addEventListener('click', () => zoomAt(0.8));
$('zoomFit').addEventListener('click', fitToContent);

function zoomAt(factor) {
  const r = canvas.getBoundingClientRect();
  const mx = r.width / 2, my = r.height / 2;
  const wp = screenToWorld(mx, my);
  camera.scale = Math.min(40, Math.max(0.5, camera.scale * factor));
  camera.tx = mx - wp.x * camera.scale;
  camera.ty = my - wp.y * camera.scale;
  applyCamera(); renderHandles();
}

function fitToContent(maxScale = Infinity) {
  const all = [...state.rooms, ...state.items];
  if (!all.length) {
    camera = { scale: 4, tx: 80, ty: 80 };
    applyCamera(); renderHandles();
    return;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const o of all) {
    minX = Math.min(minX, o.x); minY = Math.min(minY, o.y);
    maxX = Math.max(maxX, o.x + o.w); maxY = Math.max(maxY, o.y + o.h);
  }
  const r = canvas.getBoundingClientRect();
  const pad = 60;
  const availW = r.width - pad * 2;
  const availH = r.height - pad * 2;
  const bw = maxX - minX, bh = maxY - minY;
  const fitScale = Math.min(availW / Math.max(bw, 1), availH / Math.max(bh, 1));
  camera.scale = Math.min(40, Math.max(0.5, Math.min(fitScale, maxScale)));
  // Center the content within the viewport at whatever scale was chosen.
  camera.tx = r.width / 2 - ((minX + maxX) / 2) * camera.scale;
  camera.ty = r.height / 2 - ((minY + maxY) / 2) * camera.scale;
  applyCamera(); renderHandles();
}

// ---------- Share / export / import ----------
async function encodeState(s) {
  const json = JSON.stringify(s);
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function decodeState(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const json = await new Response(stream).text();
  return JSON.parse(json);
}

$('share').addEventListener('click', async () => {
  try {
    const code = await encodeState(state);
    const url = `${location.origin}${location.pathname}#${code}`;
    try {
      await navigator.clipboard.writeText(url);
      showHint('Link copied to clipboard');
      setTimeout(() => showHint(''), 2000);
    } catch {
      prompt('Copy this shareable link:', url);
    }
  } catch (err) {
    console.error(err);
    alert('Failed to generate share link: ' + err.message);
  }
});

$('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (state.name || 'floorplan') + '.floorplan.json';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(a.href);
});

$('import').addEventListener('click', () => {
  $('importText').value = '';
  $('importFile').value = '';
  $('importDialog').showModal();
});
$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    $('importText').value = await file.text();
  } catch (err) {
    alert('Could not read file: ' + err.message);
  }
});
$('importDialog').addEventListener('close', async () => {
  if ($('importDialog').returnValue !== 'ok') return;
  const txt = $('importText').value.trim();
  if (!txt) return;
  try {
    const loaded = await parseImport(txt);
    if (!loaded || !Array.isArray(loaded.rooms) || !Array.isArray(loaded.items)) throw new Error('Invalid plan shape');
    pushUndo();
    state = Object.assign(defaultState(), loaded);
    selected = null;
    renderAll(); persist();
    fitToContent();
    showHint('Plan imported');
    setTimeout(() => showHint(''), 1500);
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
});

async function parseImport(txt) {
  txt = txt.trim();
  // JSON?
  if (txt.startsWith('{')) return JSON.parse(txt);
  // URL with hash?
  let hash = txt;
  if (txt.includes('#')) hash = txt.split('#').pop();
  return await decodeState(hash);
}

function doNewPlan() {
  pushUndo();
  state = defaultState();
  selected = null;
  history.replaceState(null, '', location.pathname);
  renderAll(); persist();
}
$('newPlan').addEventListener('click', () => {
  if (state.rooms.length || state.items.length) {
    $('confirmNewDialog').showModal();
  } else {
    doNewPlan();
  }
});
$('confirmNewDialog').addEventListener('close', () => {
  if ($('confirmNewDialog').returnValue === 'ok') doNewPlan();
});

// ---------- Persistence ----------
const LS_KEY = 'floorplan.v1';
function persist() {
  try {
    normalizeState(state);
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {}
}

function normalizeState(s) {
  for (const it of (s.items || [])) {
    if (!it.shape) it.shape = 'rect';
    const r = Number(it.rotation);
    it.rotation = Number.isFinite(r) ? r : 0;
    if (it.shape === 'door' && typeof it.flip !== 'boolean') it.flip = false;
  }
  if (s.bg && typeof s.bg === 'object') {
    if (!s.bg.url) s.bg = null;
    else {
      s.bg.x = Number(s.bg.x) || 0;
      s.bg.y = Number(s.bg.y) || 0;
      s.bg.w = Number(s.bg.w) || 100;
      s.bg.h = Number(s.bg.h) || 100;
      s.bg.opacity = Number.isFinite(Number(s.bg.opacity)) ? Math.min(1, Math.max(0, Number(s.bg.opacity))) : 0.5;
    }
  }
  return s;
}

async function loadInitial() {
  if (location.hash.length > 1) {
    try {
      const loaded = await decodeState(location.hash.slice(1));
      if (loaded && Array.isArray(loaded.rooms) && Array.isArray(loaded.items)) {
        state = normalizeState(Object.assign(defaultState(), loaded));
        // Seed localStorage with the imported plan, then drop the hash so a
        // subsequent refresh reads the user's (possibly edited) localStorage
        // state instead of re-importing the original share link.
        persist();
        history.replaceState(null, '', location.pathname + location.search);
        return;
      }
    } catch (e) { console.warn('hash load failed', e); }
  }
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && Array.isArray(parsed.rooms)) { state = normalizeState(Object.assign(defaultState(), parsed)); return; }
    }
  } catch {}
}

// ---------- Init ----------
(async function init() {
  await loadInitial();
  snap = $('snap').checked;
  bindSidebar();
  window.addEventListener('resize', () => { applyCamera(); renderHandles(); });
  renderAll();
  // Initial camera: fit content, capped at 100% (scale=4). Large plans zoom out
  // to fit; small plans stay at 100% instead of being blown up.
  if (state.rooms.length || state.items.length) fitToContent(4);
})();
