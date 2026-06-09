import type { VisualizationData } from "./types.js";

/**
 * Generate a self-contained HTML file with a module-first architecture map.
 *
 * Interaction model:
 * - Overview mode: modules/directories as the primary graph
 * - Focus mode: selected module centered, callers on the left, callees on the right
 * - Symbol detail appears only inside the focused module
 */
export function generateVisualizationHtml(data: VisualizationData): string {
  const jsonData = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Call Graph Visualization</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #0d0f1a;
  color: #e6e8ef;
  overflow: hidden;
}
#container { width: 100vw; height: 100vh; position: relative; }
canvas { display: block; }
.interaction-hint {
  position: absolute;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
  z-index: 20;
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(23,27,45,0.92);
  border: 1px solid #2a3050;
  color: #aeb7d4;
  font-size: 11px;
  display: none;
  pointer-events: none;
}

#controls {
  position: absolute;
  top: 12px;
  left: 12px;
  display: flex;
  gap: 8px;
  align-items: center;
  z-index: 20;
  flex-wrap: wrap;
  max-width: 620px;
}
#search {
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid #2a3050;
  background: #171b2d;
  color: #e6e8ef;
  font-size: 13px;
  width: 220px;
  outline: none;
}
#search:focus {
  border-color: #5574ff;
  box-shadow: 0 0 0 2px rgba(85,116,255,0.22);
}
.button {
  padding: 8px 11px;
  border-radius: 8px;
  border: 1px solid #2a3050;
  background: #171b2d;
  color: #c4c9da;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.button:hover {
  background: #202744;
  color: #fff;
}
.button.active {
  background: #26305c;
  border-color: #5a74ff;
  color: #fff;
}
.button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

#stats {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 20;
  background: rgba(23,27,45,0.92);
  border: 1px solid #2a3050;
  border-radius: 10px;
  padding: 12px 14px;
  font-size: 11px;
  line-height: 1.65;
  min-width: 120px;
}
#stats .label { color: #7f88a8; }

#legend {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 20;
  background: rgba(23,27,45,0.94);
  border: 1px solid #2a3050;
  border-radius: 10px;
  padding: 12px 14px;
  width: 260px;
  max-height: 260px;
  overflow-y: auto;
}
#legend h4 {
  font-size: 11px;
  color: #8f97b3;
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 6px;
  cursor: pointer;
}
.legend-item:hover { background: #202744; }
.legend-swatch {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex: 0 0 auto;
}
.legend-text {
  color: #c6cce0;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

#detail {
  position: absolute;
  left: 12px;
  bottom: 12px;
  z-index: 20;
  max-width: 520px;
  background: rgba(23,27,45,0.94);
  border: 1px solid #2a3050;
  border-radius: 10px;
  padding: 14px 16px;
  display: none;
  box-shadow: 0 8px 28px rgba(0,0,0,0.35);
}
#detail h3 {
  font-size: 14px;
  margin-bottom: 10px;
  color: #ffffff;
}
#detail .row {
  display: flex;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 12px;
}
#detail .k {
  min-width: 92px;
  color: #7f88a8;
}
#detail .v {
  color: #dbe1f1;
  word-break: break-word;
}
#detail .section {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(255,255,255,0.08);
}

#mode-badge {
  position: absolute;
  top: 58px;
  left: 12px;
  z-index: 20;
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(34,41,70,0.92);
  border: 1px solid #36406a;
  color: #dbe1f1;
  font-size: 11px;
  display: none;
}

#truncation-warning {
  position: absolute;
  top: 58px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(70,50,10,0.94);
  border: 1px solid #8a6d15;
  color: #ffd86a;
  font-size: 11px;
  display: none;
}
</style>
</head>
<body>
<div id="container">
  <canvas id="graph"></canvas>
  <div id="controls">
    <input id="search" type="text" placeholder="Search symbols or modules..." autocomplete="off">
    <button class="button" id="btn-overview">Overview</button>
    <button class="button active" id="btn-labels">Labels</button>
    <button class="button active" id="btn-weights">Weights</button>
    <button class="button" id="btn-blast">Blast Radius</button>
    <button class="button" id="btn-fit" title="Recompute the overview layout for the current window size">Reset Overview Layout</button>
  </div>
  <div id="mode-badge"></div>
  <div id="truncation-warning"></div>
  <div id="interaction-hint" class="interaction-hint"></div>
  <div id="stats"></div>
  <div id="detail">
    <h3 id="detail-title"></h3>
    <div class="row"><div class="k">Type</div><div class="v" id="detail-type"></div></div>
    <div class="row"><div class="k">Location</div><div class="v" id="detail-location"></div></div>
    <div class="row"><div class="k">Connections</div><div class="v" id="detail-connections"></div></div>
    <div class="row"><div class="k">Notes</div><div class="v" id="detail-notes"></div></div>
    <div class="section">
      <div class="row"><div class="k">Callers</div><div class="v" id="detail-callers"></div></div>
      <div class="row"><div class="k">Callees</div><div class="v" id="detail-callees"></div></div>
      <div class="row"><div class="k">Edge types</div><div class="v" id="detail-edge-types"></div></div>
      <div class="row"><div class="k">Blast radius</div><div class="v" id="detail-blast"></div></div>
    </div>
  </div>
  <div id="legend"><h4>Modules</h4><div id="legend-items"></div></div>
</div>
<script>
(function () {
"use strict";

const DATA = ${jsonData};
const allNodes = DATA.nodes;
const allEdges = DATA.edges;
const allModules = DATA.modules || [];
const allModuleEdges = DATA.moduleEdges || [];
const meta = DATA.metadata;

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────
function shortPath(path) {
  return path.length > 36 ? "..." + path.slice(-33) : path;
}

function hashColor(index) {
  const palette = [
    "#5c7cfa", "#20c997", "#ff6b6b", "#fcc419", "#cc5de8", "#51cf66",
    "#339af0", "#f06595", "#ff922b", "#66d9e8", "#845ef7", "#94d82d",
    "#748ffc", "#3bc9db", "#ffa94d", "#69db7c", "#e64980", "#f76707"
  ];
  return palette[index % palette.length];
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function kindColor(kind, moduleColor) {
  if (!kind) return moduleColor;
  const k = kind.toLowerCase();
  if (k.includes("class") || k.includes("struct")) return "#ffd166";
  if (k.includes("interface") || k.includes("type")) return "#7bdff2";
  if (k.includes("const") || k.includes("variable") || k.includes("let")) return "#ff99c8";
  if (k.includes("enum")) return "#cdb4db";
  return moduleColor;
}

function drawSymbolGlyph(ctx, node, x, y, size, color) {
  const kind = (node.kind || "").toLowerCase();
  ctx.beginPath();
  if (kind.includes("class") || kind.includes("struct")) {
    ctx.rect(x - size, y - size, size * 2, size * 2);
  } else if (kind.includes("interface") || kind.includes("type")) {
    ctx.moveTo(x, y - size - 1);
    ctx.lineTo(x + size + 1, y);
    ctx.lineTo(x, y + size + 1);
    ctx.lineTo(x - size - 1, y);
    ctx.closePath();
  } else if (kind.includes("const") || kind.includes("variable") || kind.includes("let")) {
    ctx.moveTo(x, y - size - 1);
    ctx.lineTo(x + size + 1, y + size + 1);
    ctx.lineTo(x - size - 1, y + size + 1);
    ctx.closePath();
  } else {
    ctx.arc(x, y, size, 0, Math.PI * 2);
  }
  ctx.fillStyle = color;
  ctx.fill();
}

function shortNodeLabel(name) {
  return name.length > 18 ? name.slice(0, 15) + "…" : name;
}

// ────────────────────────────────────────────────────────────
// Build graph models
// ────────────────────────────────────────────────────────────
const nodeById = new Map(allNodes.map((n) => [n.id, n]));
allNodes.forEach((n) => { n.module = n.moduleId; });

const resolvedEdges = allEdges
  .filter((e) => nodeById.has(e.source) && nodeById.has(e.target))
  .map((e) => ({ ...e, sourceNode: nodeById.get(e.source), targetNode: nodeById.get(e.target) }));

const modules = new Map((DATA.modules || []).map((module) => [module.id, {
  ...module,
  color: null,
  nodes: [],
  files: new Set(),
  incoming: new Map(),
  outgoing: new Map(),
  internalEdgeCount: 0,
  totalWeight: 0,
}]));

for (const node of allNodes) {
  const mod = modules.get(node.moduleId);
  if (!mod) continue;
  mod.nodes.push(node);
  mod.files.add(node.filePath);
}

const moduleList = [...modules.values()].sort((a, b) => b.symbolCount - a.symbolCount || a.label.localeCompare(b.label));
moduleList.forEach((m, i) => { m.color = hashColor(i); });

for (const edge of resolvedEdges) {
  const src = edge.sourceNode.moduleId;
  const tgt = edge.targetNode.moduleId;
  if (src && tgt && src === tgt && modules.has(src)) {
    modules.get(src).internalEdgeCount += 1;
  }
}

const moduleEdges = (DATA.moduleEdges || []).map((edge) => ({
  ...edge,
  callTypes: edge.callTypes || {},
}));

for (const edge of moduleEdges) {
  if (modules.has(edge.source) && modules.has(edge.target)) {
    modules.get(edge.source).outgoing.set(edge.target, edge.weight);
    modules.get(edge.target).incoming.set(edge.source, edge.weight);
  }
}

for (const mod of moduleList) {
  mod.totalWeight = [...mod.incoming.values(), ...mod.outgoing.values()].reduce((a, b) => a + b, 0) + mod.internalEdgeCount;
}

// ────────────────────────────────────────────────────────────
// Overview layout: module dependency map
// ────────────────────────────────────────────────────────────
const moduleBounds = new Map();

function computeModuleDepths() {
  const indegree = new Map(moduleList.map((m) => [m.id, 0]));
  const outgoing = new Map(moduleList.map((m) => [m.id, []]));
  for (const e of moduleEdges) {
    indegree.set(e.target, (indegree.get(e.target) || 0) + 1);
    outgoing.get(e.source).push(e.target);
  }

  const queue = [];
  indegree.forEach((v, k) => { if (v === 0) queue.push(k); });
  const depth = new Map(moduleList.map((m) => [m.id, 0]));
  const seen = new Set();

  while (queue.length) {
    const current = queue.shift();
    seen.add(current);
    for (const next of outgoing.get(current) || []) {
      depth.set(next, Math.max(depth.get(next) || 0, (depth.get(current) || 0) + 1));
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }

  // cycles / disconnected: fallback by fan-out - fan-in bias
  for (const mod of moduleList) {
    if (!seen.has(mod.id)) {
      const out = mod.outgoing.size;
      const inc = mod.incoming.size;
      depth.set(mod.id, Math.max(0, 2 + out - inc));
    }
  }
  return depth;
}

const moduleDepth = computeModuleDepths();

function layoutOverview() {
  moduleBounds.clear();
  const sparseModuleGraph = moduleEdges.length < Math.max(2, Math.floor(moduleList.length / 3));

  if (sparseModuleGraph) {
    const cols = Math.max(2, Math.min(4, Math.ceil(Math.sqrt(moduleList.length))));
    const cardW = 240;
    const cardHBase = 92;
    const gapX = 28;
    const gapY = 26;
    const totalWidth = cols * cardW + (cols - 1) * gapX;
    const startX = Math.max(48, (window.innerWidth - totalWidth) / 2);
    let currentX = startX;
    let currentY = 120;
    let rowMaxHeight = cardHBase;

    moduleList.forEach((mod, index) => {
      const cardH = Math.max(cardHBase, 58 + Math.ceil(mod.nodes.length / 8) * 14);
      moduleBounds.set(mod.id, { x: currentX, y: currentY, w: cardW, h: cardH });
      rowMaxHeight = Math.max(rowMaxHeight, cardH);
      if ((index + 1) % cols === 0) {
        currentX = startX;
        currentY += rowMaxHeight + gapY + 24;
        rowMaxHeight = cardHBase;
      } else {
        currentX += cardW + gapX;
      }
    });

    return { maxDepth: 0, sortedDepths: [0], sparse: true };
  }

  const levels = new Map();
  let maxDepth = 0;
  for (const mod of moduleList) {
    const d = moduleDepth.get(mod.id) || 0;
    maxDepth = Math.max(maxDepth, d);
    if (!levels.has(d)) levels.set(d, []);
    levels.get(d).push(mod);
  }

  // barycenter-like ordering by average target/source level positions
  const sortedDepths = [...levels.keys()].sort((a, b) => a - b);
  for (const depth of sortedDepths) {
    const row = levels.get(depth);
    row.sort((a, b) => {
      const aScore = [...a.incoming.entries(), ...a.outgoing.entries()].reduce((sum, [k, w]) => sum + (moduleDepth.get(k) || 0) * w, 0) / Math.max(1, a.totalWeight);
      const bScore = [...b.incoming.entries(), ...b.outgoing.entries()].reduce((sum, [k, w]) => sum + (moduleDepth.get(k) || 0) * w, 0) / Math.max(1, b.totalWeight);
      return aScore - bScore || b.totalWeight - a.totalWeight;
    });
  }

  const leftPad = 70;
  const rightPad = 90;
  const topPad = 120;
  const laneGap = 170;
  const rowGap = 70;
  const baseW = 150;
  const baseH = 76;

  for (const depth of sortedDepths) {
    const row = levels.get(depth);
    const x = leftPad + depth * laneGap;
    const totalHeight = row.reduce((sum, mod) => {
      const h = Math.max(baseH, 42 + Math.ceil(mod.nodes.length / 6) * 11);
      return sum + h;
    }, 0) + Math.max(0, row.length - 1) * rowGap;

    let y = Math.max(topPad, (window.innerHeight - totalHeight) / 2);
    for (const mod of row) {
      const h = Math.max(baseH, 42 + Math.ceil(mod.nodes.length / 6) * 11);
      const w = Math.min(240, Math.max(baseW, 120 + Math.min(mod.totalWeight, 20) * 4));
      moduleBounds.set(mod.id, { x, y, w, h });
      y += h + rowGap;
    }
  }

  return { maxDepth, sortedDepths, sparse: false };
}

let overviewLayout = layoutOverview();

// ────────────────────────────────────────────────────────────
// Focus layout: selected module centered, callers left, callees right
// ────────────────────────────────────────────────────────────
function buildFocusState(moduleId) {
  const center = modules.get(moduleId);
  if (!center) return null;

  function traverse(direction) {
    const queue = [...(direction === "incoming" ? center.incoming.entries() : center.outgoing.entries())]
      .map(([id, weight]) => ({ id, weight, hop: 1 }));
    const visited = new Set();
    const results = [];

    while (queue.length) {
      const current = queue.shift();
      if (visited.has(current.id) || current.hop > 3) continue;
      visited.add(current.id);
      const mod = modules.get(current.id);
      if (!mod) continue;
      results.push({ mod, weight: current.weight, hop: current.hop });
      if (blastRadiusMode) {
        const nextEntries = direction === "incoming" ? mod.incoming.entries() : mod.outgoing.entries();
        for (const [nextId, nextWeight] of nextEntries) {
          if (!visited.has(nextId)) queue.push({ id: nextId, weight: nextWeight, hop: current.hop + 1 });
        }
      }
    }

    return results.sort((a, b) => a.hop - b.hop || b.weight - a.weight);
  }

  const callers = traverse("incoming");
  const callees = traverse("outgoing");

  return { center, callers, callees };
}

function layoutFocus(moduleId) {
  const focus = buildFocusState(moduleId);
  if (!focus) return null;

  const centerBox = {
    x: window.innerWidth * 0.28,
    y: 120,
    w: window.innerWidth * 0.44,
    h: Math.max(280, 140 + Math.ceil(focus.center.nodes.length / 5) * 26),
  };

  const leftBoxes = [];
  const rightBoxes = [];

  function stackSide(items, side) {
    const startX = side === "left" ? 36 : window.innerWidth - 36 - 190;
    let y = 150;
    return items.map(({ mod, weight, hop }) => {
      const h = Math.max(64, 46 + Math.ceil(mod.nodes.length / 10) * 10);
      const box = { x: startX, y, w: 190, h, weight, hop, mod };
      y += h + 24;
      return box;
    });
  }

  leftBoxes.push(...stackSide(focus.callers, "left"));
  rightBoxes.push(...stackSide(focus.callees, "right"));

  const symbolPositions = new Map();
  const fileBoxes = [];
  const fileGroups = new Map();
  for (const node of focus.center.nodes) {
    if (!fileGroups.has(node.filePath)) fileGroups.set(node.filePath, []);
    fileGroups.get(node.filePath).push(node);
  }

  const files = [...fileGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const laneGap = 12;
  const innerX = centerBox.x + 16;
  const innerY = centerBox.y + 58;
  const laneW = centerBox.w - 32;
  let laneY = innerY;

  files.forEach(([filePath, nodesInFile]) => {
    const sortedNodes = [...nodesInFile].sort((a, b) => a.name.localeCompare(b.name));
    const estimatedChipWidth = Math.max(
      90,
      ...sortedNodes.map((node) => shortNodeLabel(node.name).length * 7 + 18),
    );
    const maxPerRow = Math.max(1, Math.min(3, Math.floor((laneW - 145) / Math.min(180, estimatedChipWidth))));
    const rows = Math.max(1, Math.ceil(sortedNodes.length / maxPerRow));
    const laneH = Math.max(68, 36 + rows * 34);
    fileBoxes.push({ filePath, x: innerX, y: laneY, w: laneW, h: laneH, nodes: sortedNodes });

    const contentStartX = innerX + 130;
    const contentW = laneW - 145;
    const cols = Math.max(1, Math.min(maxPerRow, Math.ceil(sortedNodes.length / rows)));
    const stepX = contentW / Math.max(cols, 1);
    const stepY = rows > 1 ? 30 : 0;

    sortedNodes.forEach((node, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      symbolPositions.set(node.id, {
        x: contentStartX + col * stepX + stepX / 2,
        y: laneY + 20 + row * stepY + 12,
      });
    });

    laneY += laneH + laneGap;
  });

  centerBox.h = Math.max(centerBox.h, laneY - centerBox.y + 12);

  return { focus, centerBox, leftBoxes, rightBoxes, symbolPositions, fileBoxes };
}

// ────────────────────────────────────────────────────────────
// Canvas / interaction state
// ────────────────────────────────────────────────────────────
const canvas = document.getElementById("graph");
const ctx = canvas.getContext("2d");
let width = window.innerWidth;
let height = window.innerHeight;
function resizeCanvas() {
  width = window.innerWidth;
  height = window.innerHeight;
  canvas.width = width * devicePixelRatio;
  canvas.height = height * devicePixelRatio;
  canvas.style.width = width + "px";
  canvas.style.height = height + "px";
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}
resizeCanvas();

let mode = "overview";
let focusedModuleId = null;
let focusedSymbolId = null;
let blastRadiusMode = false;
let searchValue = "";
let showLabels = true;
let showWeights = true;
let hoverTarget = null;
let focusPanY = 0;

const legendItemsEl = document.getElementById("legend-items");
const statsEl = document.getElementById("stats");
const detailEl = document.getElementById("detail");
const modeBadgeEl = document.getElementById("mode-badge");
const overviewButton = document.getElementById("btn-overview");
const fitButton = document.getElementById("btn-fit");
const interactionHintEl = document.getElementById("interaction-hint");

if (meta.truncated) {
  const warning = document.getElementById("truncation-warning");
  warning.style.display = "block";
  warning.textContent = "⚠ Graph truncated to " + allNodes.length + " nodes (source total: " + meta.totalSymbols + ")";
}

for (const mod of moduleList) {
  const item = document.createElement("div");
  item.className = "legend-item";
  item.innerHTML = '<div class="legend-swatch" style="background:' + mod.color + '"></div>' +
    '<div class="legend-text" title="' + mod.pathPrefix + '">' + mod.label + ' (' + mod.nodes.length + ')</div>';
  item.addEventListener("click", () => enterFocus(mod.id));
  legendItemsEl.appendChild(item);
}

function updateStats() {
  if (mode === "overview") {
    statsEl.innerHTML =
      '<span class="label">Mode</span> overview' +
      '<br><span class="label">Modules</span> ' + moduleList.length +
      '<br><span class="label">Module edges</span> ' + moduleEdges.length +
      '<br><span class="label">Symbols</span> ' + allNodes.length +
      '<br><span class="label">Files</span> ' + new Set(allNodes.map((n) => n.filePath)).size;
      modeBadgeEl.style.display = "none";
  } else {
    const focus = modules.get(focusedModuleId);
    statsEl.innerHTML =
      '<span class="label">Mode</span> focus' +
      '<br><span class="label">Module</span> ' + focus.label +
      '<br><span class="label">Symbols</span> ' + focus.nodes.length +
      '<br><span class="label">Incoming</span> ' + [...focus.incoming.values()].reduce((a, b) => a + b, 0) +
      '<br><span class="label">Outgoing</span> ' + [...focus.outgoing.values()].reduce((a, b) => a + b, 0);
    modeBadgeEl.style.display = "block";
    modeBadgeEl.textContent = "Focus mode: " + focus.label;
  }
}

function updateControls() {
  overviewButton.textContent = mode === "overview" ? "Overview Map" : "Back to Overview";
  overviewButton.title = mode === "overview"
    ? "You are viewing the top-level architecture map"
    : "Return to the top-level architecture map";
  overviewButton.classList.toggle("active", mode === "overview");
  overviewButton.disabled = mode === "overview";

  fitButton.textContent = mode === "overview" ? "Reset Overview Layout" : "Overview Layout Only";
  fitButton.title = mode === "overview"
    ? "Recompute the overview layout for the current window size"
    : "This control only affects the overview map. Click Overview to return there first.";
  fitButton.disabled = mode !== "overview";

  interactionHintEl.style.display = mode === "focus" ? "block" : "none";
  interactionHintEl.textContent = mode === "focus"
    ? "Scroll to pan vertically inside focus mode"
    : "";
}

function getFocusPanBounds() {
  if (mode !== "focus" || !focusedModuleId) return { min: 0, max: 0 };
  const state = layoutFocus(focusedModuleId);
  if (!state) return { min: 0, max: 0 };
  const contentBottom = Math.max(
    state.centerBox.y + state.centerBox.h,
    ...state.leftBoxes.map((box) => box.y + box.h),
    ...state.rightBoxes.map((box) => box.y + box.h),
  );
  const overflow = Math.max(0, contentBottom - (height - 32));
  return { min: -overflow, max: 0 };
}

function clampFocusPan() {
  const bounds = getFocusPanBounds();
  focusPanY = Math.min(bounds.max, Math.max(bounds.min, focusPanY));
}

function setDetailForModule(mod, note) {
  detailEl.style.display = "block";
  document.getElementById("detail-title").textContent = mod.label;
  document.getElementById("detail-type").textContent = "Module";
  document.getElementById("detail-location").textContent = mod.pathPrefix + (mod.files.size ? " • " + [...mod.files].slice(0, 2).map(shortPath).join(", ") + ([...mod.files].length > 2 ? " …" : "") : "");
  document.getElementById("detail-connections").textContent =
    "incoming " + [...mod.incoming.values()].reduce((a, b) => a + b, 0) +
    ", outgoing " + [...mod.outgoing.values()].reduce((a, b) => a + b, 0) +
    ", internal " + mod.internalEdgeCount;
  document.getElementById("detail-notes").textContent = note;
  document.getElementById("detail-callers").textContent = [...mod.incoming.keys()].map((id) => modules.get(id)?.label).filter(Boolean).join(", ") || "none";
  document.getElementById("detail-callees").textContent = [...mod.outgoing.keys()].map((id) => modules.get(id)?.label).filter(Boolean).join(", ") || "none";
  document.getElementById("detail-edge-types").textContent = mod.internalEdgeCount > 0 ? ("internal " + mod.internalEdgeCount) : "n/a";
  document.getElementById("detail-blast").textContent = blastRadiusMode ? "blast mode active" : "toggle Blast Radius to inspect affected neighbors";
}

function setDetailForSymbol(node) {
  const incoming = resolvedEdges.filter((e) => e.target === node.id).length;
  const outgoing = resolvedEdges.filter((e) => e.source === node.id).length;
  const callers = resolvedEdges.filter((e) => e.target === node.id).map((e) => nodeById.get(e.source)?.name).filter(Boolean);
  const callees = resolvedEdges.filter((e) => e.source === node.id).map((e) => nodeById.get(e.target)?.name).filter(Boolean);
  const edgeTypes = new Map();
  for (const edge of resolvedEdges) {
    if (edge.source === node.id || edge.target === node.id) {
      edgeTypes.set(edge.callType, (edgeTypes.get(edge.callType) || 0) + 1);
    }
  }
  const visited = new Set([node.id]);
  const queue = [{ id: node.id, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    if (current.depth >= 2) continue;
    for (const edge of resolvedEdges) {
      if (edge.source === current.id && !visited.has(edge.target)) {
        visited.add(edge.target);
        queue.push({ id: edge.target, depth: current.depth + 1 });
      }
      if (edge.target === current.id && !visited.has(edge.source)) {
        visited.add(edge.source);
        queue.push({ id: edge.source, depth: current.depth + 1 });
      }
    }
  }
  const blastModules = new Set([...visited].map((id) => nodeById.get(id)?.moduleLabel).filter(Boolean));
  detailEl.style.display = "block";
  document.getElementById("detail-title").textContent = node.name;
  document.getElementById("detail-type").textContent = node.kind;
  document.getElementById("detail-location").textContent = shortPath(node.filePath) + ':' + node.line;
  document.getElementById("detail-connections").textContent = "incoming " + incoming + ", outgoing " + outgoing;
  document.getElementById("detail-notes").textContent = "Module: " + node.moduleLabel;
  document.getElementById("detail-callers").textContent = callers.length ? callers.slice(0, 6).join(", ") + (callers.length > 6 ? " …" : "") : "none";
  document.getElementById("detail-callees").textContent = callees.length ? callees.slice(0, 6).join(", ") + (callees.length > 6 ? " …" : "") : "none";
  document.getElementById("detail-edge-types").textContent = [...edgeTypes.entries()].map(([type, count]) => type + "×" + count).join(", ") || "none";
  document.getElementById("detail-blast").textContent = (visited.size - 1) + " symbols, " + Math.max(0, blastModules.size - 1) + " modules within 2 hops";
}

function clearDetail() {
  detailEl.style.display = "none";
}

function enterFocus(moduleId) {
  mode = "focus";
  focusedModuleId = moduleId;
  focusedSymbolId = null;
  focusPanY = 0;
  updateStats();
  updateControls();
  draw();
}

function backToOverview() {
  mode = "overview";
  focusedModuleId = null;
  focusedSymbolId = null;
  focusPanY = 0;
  clearDetail();
  updateStats();
  updateControls();
  draw();
}

function getSearchMatches() {
  const q = searchValue.trim().toLowerCase();
  if (!q) return { modules: new Set(), nodes: new Set() };
  const modulesSet = new Set();
  const nodesSet = new Set();
  for (const mod of moduleList) {
    if (mod.label.toLowerCase().includes(q) || mod.pathPrefix.toLowerCase().includes(q)) modulesSet.add(mod.id);
    for (const node of mod.nodes) {
      if (node.name.toLowerCase().includes(q) || node.filePath.toLowerCase().includes(q)) {
        modulesSet.add(mod.id);
        nodesSet.add(node.id);
      }
    }
  }
  return { modules: modulesSet, nodes: nodesSet };
}

function computeBlastRadius() {
  if (!blastRadiusMode) return { modules: new Set(), nodes: new Set() };

  if (focusedSymbolId) {
    const visited = new Set([focusedSymbolId]);
    const queue = [{ id: focusedSymbolId, depth: 0 }];
    while (queue.length) {
      const current = queue.shift();
      if (current.depth >= 2) continue;
      for (const edge of resolvedEdges) {
        if (edge.source === current.id && !visited.has(edge.target)) {
          visited.add(edge.target);
          queue.push({ id: edge.target, depth: current.depth + 1 });
        }
        if (edge.target === current.id && !visited.has(edge.source)) {
          visited.add(edge.source);
          queue.push({ id: edge.source, depth: current.depth + 1 });
        }
      }
    }
    const moduleIds = new Set([...visited].map((id) => nodeById.get(id)?.moduleId).filter(Boolean));
    return { nodes: visited, modules: moduleIds };
  }

  if (focusedModuleId) {
    const moduleIds = new Set([focusedModuleId]);
    const nodeIds = new Set((modules.get(focusedModuleId)?.nodes || []).map((node) => node.id));
    const queue = [{ id: focusedModuleId, depth: 0 }];
    while (queue.length) {
      const current = queue.shift();
      if (current.depth >= 3) continue;
      for (const edge of moduleEdges) {
        if (edge.source === current.id && !moduleIds.has(edge.target)) {
          moduleIds.add(edge.target);
          queue.push({ id: edge.target, depth: current.depth + 1 });
        }
        if (edge.target === current.id && !moduleIds.has(edge.source)) {
          moduleIds.add(edge.source);
          queue.push({ id: edge.source, depth: current.depth + 1 });
        }
      }
    }
    for (const modId of moduleIds) {
      for (const node of modules.get(modId)?.nodes || []) nodeIds.add(node.id);
    }
    return { modules: moduleIds, nodes: nodeIds };
  }

  return { modules: new Set(), nodes: new Set() };
}

// ────────────────────────────────────────────────────────────
// Drawing
// ────────────────────────────────────────────────────────────
function drawOverview() {
  const matches = getSearchMatches();
  const blast = computeBlastRadius();

  if (!overviewLayout.sparse) {
    // background flow lanes
    for (let d = 0; d <= overviewLayout.maxDepth; d++) {
      const x = 52 + d * 170;
      ctx.fillStyle = "rgba(255,255,255,0.02)";
      roundRect(ctx, x - 18, 94, 130, height - 170, 12);
      ctx.fill();
      if (showLabels) {
        ctx.fillStyle = "#647095";
        ctx.font = "11px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(d === 0 ? "entry" : "layer " + d, x + 47, 82);
      }
    }
  } else if (showLabels) {
    ctx.fillStyle = "#647095";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("module atlas", 48, 82);
  }

  const drawOverviewEdges = () => {
  const atlasBusY = Math.max(40, Math.min(...moduleList.map((mod) => (moduleBounds.get(mod.id)?.y ?? 120) - 18)));
  for (const edge of moduleEdges) {
    const s = moduleBounds.get(edge.source);
    const t = moduleBounds.get(edge.target);
    if (!s || !t) continue;
    const sMid = { x: s.x + s.w, y: s.y + s.h / 2 };
    const tMid = { x: t.x, y: t.y + t.h / 2 };
    const searched = !matches.modules.size || matches.modules.has(edge.source) || matches.modules.has(edge.target);
    const inBlast = !blast.modules.size || blast.modules.has(edge.source) || blast.modules.has(edge.target);
    ctx.strokeStyle = searched && inBlast ? "rgba(123,145,255," + Math.min(0.82, 0.18 + edge.weight * 0.06) + ")" : "rgba(70,78,110,0.12)";
    ctx.lineWidth = Math.max(1, Math.min(8, edge.weight * 0.85));
    ctx.beginPath();
    if (overviewLayout.sparse) {
      const sourcePoint = s.x < t.x
        ? { x: s.x + s.w, y: s.y + s.h / 2 }
        : { x: s.x, y: s.y + s.h / 2 };
      const targetPoint = s.x < t.x
        ? { x: t.x, y: t.y + t.h / 2 }
        : { x: t.x + t.w, y: t.y + t.h / 2 };
      const corridorX = (sourcePoint.x + targetPoint.x) / 2;
      ctx.moveTo(sourcePoint.x, sourcePoint.y);
      ctx.lineTo(corridorX, sourcePoint.y);
      ctx.lineTo(corridorX, targetPoint.y);
      ctx.lineTo(targetPoint.x, targetPoint.y);
    } else {
      const dx = Math.max(50, (tMid.x - sMid.x) * 0.45);
      ctx.moveTo(sMid.x, sMid.y);
      ctx.bezierCurveTo(sMid.x + dx, sMid.y, tMid.x - dx, tMid.y, tMid.x, tMid.y);
    }
    ctx.stroke();

    if (showWeights) {
      const mx = (sMid.x + tMid.x) / 2;
      const my = (sMid.y + tMid.y) / 2;
      ctx.fillStyle = "rgba(13,15,26,0.95)";
      roundRect(ctx, mx - 10, my - 8, 20, 16, 5);
      ctx.fill();
      ctx.fillStyle = "#cfd6ef";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(String(edge.weight), mx, my + 3);
    }
  }
  };

  if (!overviewLayout.sparse) drawOverviewEdges();

  for (const mod of moduleList) {
    const b = moduleBounds.get(mod.id);
    const searched = !matches.modules.size || matches.modules.has(mod.id);
    const inBlast = !blast.modules.size || blast.modules.has(mod.id);
    const fill = searched && inBlast ? mod.color + "18" : "rgba(24,28,44,0.46)";
    const stroke = searched && inBlast ? mod.color : "#2f3659";

    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = searched && inBlast ? mod.color + "33" : "rgba(0,0,0,0)";
    ctx.shadowBlur = searched && inBlast ? 18 : 0;
    ctx.shadowOffsetY = 6;
    roundRect(ctx, b.x, b.y, b.w, b.h, 14);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.stroke();

    // header glow / accent
    ctx.fillStyle = mod.color + "22";
    roundRect(ctx, b.x + 10, b.y + 10, b.w - 20, 16, 8);
    ctx.fill();

    // module title
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 14px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(mod.label, b.x + 14, b.y + 23);

    // summary
    ctx.fillStyle = "#b0b8d4";
    ctx.font = "12px sans-serif";
    ctx.fillText(mod.nodes.length + " symbols", b.x + 14, b.y + 46);
    ctx.fillText(mod.files.size + " files", b.x + 14, b.y + 63);

    // density bars
    const barY = b.y + b.h - 18;
    const outgoing = [...mod.outgoing.values()].reduce((a, c) => a + c, 0);
    const incoming = [...mod.incoming.values()].reduce((a, c) => a + c, 0);
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    roundRect(ctx, b.x + 14, barY, b.w - 28, 7, 3);
    ctx.fill();
    const total = Math.max(1, outgoing + incoming + mod.internalEdgeCount);
    const outW = (b.w - 28) * (outgoing / total);
    const intW = (b.w - 28) * (mod.internalEdgeCount / total);
    ctx.fillStyle = "#7b91ff";
    roundRect(ctx, b.x + 14, barY, outW, 7, 3);
    ctx.fill();
    ctx.fillStyle = "#4ad7a6";
    roundRect(ctx, b.x + 14 + outW, barY, intW, 7, 3);
    ctx.fill();
  }

  if (overviewLayout.sparse) drawOverviewEdges();
}

function drawFocus() {
  const state = layoutFocus(focusedModuleId);
  if (!state) return;
  clampFocusPan();
  const matches = getSearchMatches();
  const blast = computeBlastRadius();
  ctx.save();
  ctx.translate(0, focusPanY);

  // left callers
  for (const box of state.leftBoxes) {
    drawSideModuleBox(box, "caller", (!matches.modules.size || matches.modules.has(box.mod.id)) && (!blast.modules.size || blast.modules.has(box.mod.id)));
  }
  // right callees
  for (const box of state.rightBoxes) {
    drawSideModuleBox(box, "callee", (!matches.modules.size || matches.modules.has(box.mod.id)) && (!blast.modules.size || blast.modules.has(box.mod.id)));
  }

  // center panel
  ctx.fillStyle = state.focus.center.color + "18";
  ctx.strokeStyle = state.focus.center.color;
  ctx.lineWidth = 2;
  roundRect(ctx, state.centerBox.x, state.centerBox.y, state.centerBox.w, state.centerBox.h, 16);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#ffffff";
  ctx.font = "700 16px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(state.focus.center.label, state.centerBox.x + 16, state.centerBox.y + 24);
  ctx.fillStyle = "#9aa6cb";
  ctx.font = "12px sans-serif";
  ctx.fillText(
    state.focus.center.nodes.length + " symbols • " + state.focus.center.files.size + " files • internal edges " + state.focus.center.internalEdgeCount,
    state.centerBox.x + 16,
    state.centerBox.y + 44,
  );

  for (const fileBox of state.fileBoxes) {
    ctx.fillStyle = "rgba(255,255,255,0.03)";
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    roundRect(ctx, fileBox.x, fileBox.y, fileBox.w, fileBox.h, 10);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "rgba(255,255,255,0.06)";
    roundRect(ctx, fileBox.x + 6, fileBox.y + 6, 112, fileBox.h - 12, 8);
    ctx.fill();

    ctx.fillStyle = "#bfc8e8";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "left";
    const shortFile = fileBox.filePath.split("/").pop();
    ctx.fillText(shortFile, fileBox.x + 14, fileBox.y + 20);
    ctx.fillStyle = "#8290b8";
    ctx.font = "9px sans-serif";
    ctx.fillText(fileBox.nodes.length + " symbols", fileBox.x + 14, fileBox.y + 34);
  }

  // internal symbol edges
  const centerIds = new Set(state.focus.center.nodes.map((n) => n.id));
  const internalEdges = resolvedEdges.filter((e) => centerIds.has(e.source) && centerIds.has(e.target));
  for (const edge of internalEdges) {
    const s = state.symbolPositions.get(edge.source);
    const t = state.symbolPositions.get(edge.target);
    const searched = !matches.nodes.size || matches.nodes.has(edge.source) || matches.nodes.has(edge.target);
    ctx.strokeStyle = searched ? "rgba(123,145,255,0.5)" : "rgba(74,82,118,0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(t.x, t.y);
    ctx.stroke();
  }

  // symbol nodes
  for (const node of state.focus.center.nodes) {
    const pos = state.symbolPositions.get(node.id);
    const match = (!matches.nodes.size || matches.nodes.has(node.id)) && (!blast.nodes.size || blast.nodes.has(node.id));
    const selected = focusedSymbolId === node.id;
    const degree = resolvedEdges.filter((e) => e.source === node.id || e.target === node.id).length;
    const radius = selected ? 8 : Math.min(7, 4 + degree * 0.45);
    const color = match ? kindColor(node.kind, state.focus.center.color) : "#525a7e";
    drawSymbolGlyph(ctx, node, pos.x, pos.y, radius, color);
    if (selected) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
    } else if (hoverTarget && hoverTarget.type === "symbol" && hoverTarget.node.id === node.id) {
      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (showLabels) {
      const label = shortNodeLabel(node.name);
      ctx.font = selected ? "600 10px sans-serif" : "9px sans-serif";
      ctx.textAlign = "center";
      const textWidth = ctx.measureText(label).width;
      const chipW = textWidth + 10;
      const chipH = 16;
      const chipX = pos.x - chipW / 2;
      const chipY = pos.y - (radius + 20);
      const hovered = hoverTarget && hoverTarget.type === "symbol" && hoverTarget.node.id === node.id;
      ctx.fillStyle = selected ? "rgba(255,255,255,0.16)" : (hovered ? "rgba(33,38,60,0.96)" : "rgba(18,22,36,0.88)");
      roundRect(ctx, chipX, chipY, chipW, chipH, 6);
      ctx.fill();
      ctx.strokeStyle = selected ? "rgba(255,255,255,0.28)" : (hovered ? "rgba(123,145,255,0.35)" : "rgba(255,255,255,0.08)");
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = selected ? "#fff" : (hovered ? "#eef3ff" : "#dce2f4");
      ctx.fillText(label, pos.x, chipY + 11);
    }
  }

  // aggregated side edges
  for (const box of state.leftBoxes) {
    const targetY = box.y + box.h / 2;
    const sourceY = state.centerBox.y + state.centerBox.h / 2;
    const weight = box.weight;
    drawAggregateConnector(box.x + box.w, targetY, state.centerBox.x, sourceY, weight, box.mod.color, true);
  }
  for (const box of state.rightBoxes) {
    const sourceY = state.centerBox.y + state.centerBox.h / 2;
    const targetY = box.y + box.h / 2;
    const weight = box.weight;
    drawAggregateConnector(state.centerBox.x + state.centerBox.w, sourceY, box.x, targetY, weight, box.mod.color, false);
  }
  ctx.restore();
}

function drawSideModuleBox(box, kind, searched) {
  ctx.fillStyle = searched ? box.mod.color + "20" : "rgba(28,31,49,0.76)";
  ctx.strokeStyle = searched ? box.mod.color : "#2f3659";
  ctx.lineWidth = 1.4;
  ctx.shadowColor = searched ? box.mod.color + "22" : "rgba(0,0,0,0)";
  ctx.shadowBlur = searched ? 10 : 0;
  ctx.shadowOffsetY = 4;
  roundRect(ctx, box.x, box.y, box.w, box.h, 12);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.stroke();

  ctx.fillStyle = "#ffffff";
  ctx.font = "600 12px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(box.mod.label, box.x + 12, box.y + 20);
  ctx.fillStyle = "#95a0c5";
  ctx.font = "11px sans-serif";
  ctx.fillText((box.hop > 1 ? String(box.hop) + " hops away" : (kind === "caller" ? "calls selected module" : "called by selected module")), box.x + 12, box.y + 38);
  ctx.fillText(box.weight + " cross-module calls", box.x + 12, box.y + 54);
}

function drawAggregateConnector(x1, y1, x2, y2, weight, color, leftToCenter) {
  const dx = Math.abs(x2 - x1) * 0.45;
  ctx.strokeStyle = color + (showWeights ? "cc" : "88");
  ctx.lineWidth = Math.max(2, Math.min(10, weight * 0.8));
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  if (leftToCenter) {
    ctx.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2);
  } else {
    ctx.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2);
  }
  ctx.stroke();

  if (showWeights) {
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    ctx.fillStyle = "rgba(13,15,26,0.96)";
    roundRect(ctx, mx - 12, my - 9, 24, 18, 6);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(String(weight), mx, my + 3);
  }
}

function draw() {
  ctx.clearRect(0, 0, width, height);
  if (mode === "overview") drawOverview();
  else drawFocus();
}

// ────────────────────────────────────────────────────────────
// Hit testing
// ────────────────────────────────────────────────────────────
function hitTestOverview(x, y) {
  for (const mod of moduleList) {
    const b = moduleBounds.get(mod.id);
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return { type: "module", moduleId: mod.id };
  }
  return null;
}

function hitTestFocus(x, y) {
  const state = layoutFocus(focusedModuleId);
  if (!state) return null;
  const adjustedY = y - focusPanY;

  if (x >= state.centerBox.x && x <= state.centerBox.x + state.centerBox.w && adjustedY >= state.centerBox.y && adjustedY <= state.centerBox.y + state.centerBox.h) {
    for (const node of state.focus.center.nodes) {
      const pos = state.symbolPositions.get(node.id);
      const dx = x - pos.x;
      const dy = adjustedY - pos.y;
      if (dx * dx + dy * dy <= 64) return { type: "symbol", node };
    }
    return { type: "module", moduleId: focusedModuleId };
  }

  for (const box of [...state.leftBoxes, ...state.rightBoxes]) {
    if (x >= box.x && x <= box.x + box.w && adjustedY >= box.y && adjustedY <= box.y + box.h) {
      return { type: "module", moduleId: box.mod.id };
    }
  }
  return null;
}

canvas.addEventListener("wheel", (event) => {
  if (mode !== "focus") return;
  const bounds = getFocusPanBounds();
  if (bounds.min === 0 && bounds.max === 0) return;
  event.preventDefault();
  focusPanY -= event.deltaY;
  clampFocusPan();
  draw();
}, { passive: false });

canvas.addEventListener("mousemove", (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const previousHover = hoverTarget;
  hoverTarget = mode === "overview" ? hitTestOverview(x, y) : hitTestFocus(x, y);
  canvas.style.cursor = hoverTarget ? "pointer" : "default";
  if ((previousHover?.type || null) !== (hoverTarget?.type || null)
    || (previousHover?.node?.id || null) !== (hoverTarget?.node?.id || null)
    || (previousHover?.moduleId || null) !== (hoverTarget?.moduleId || null)) {
    draw();
  }
});

canvas.addEventListener("click", (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const hit = mode === "overview" ? hitTestOverview(x, y) : hitTestFocus(x, y);
  if (!hit) return;

  if (hit.type === "module") {
    if (mode === "focus" && hit.moduleId === focusedModuleId) {
      setDetailForModule(modules.get(hit.moduleId), "Selected module overview");
      draw();
      return;
    }
    if (mode === "focus" && hit.moduleId !== focusedModuleId) {
      enterFocus(hit.moduleId);
      setDetailForModule(modules.get(hit.moduleId), "Drilled into connected module");
      return;
    }
    enterFocus(hit.moduleId);
    setDetailForModule(modules.get(hit.moduleId), "Click Overview to return to the architecture map");
    return;
  }

  if (hit.type === "symbol") {
    focusedSymbolId = hit.node.id;
    setDetailForSymbol(hit.node);
    draw();
  }
});

// controls
const searchInput = document.getElementById("search");
searchInput.addEventListener("input", () => {
  searchValue = searchInput.value;
  draw();
});

document.getElementById("btn-overview").addEventListener("click", () => {
  backToOverview();
});

document.getElementById("btn-labels").addEventListener("click", function () {
  showLabels = !showLabels;
  this.classList.toggle("active", showLabels);
  draw();
});

document.getElementById("btn-weights").addEventListener("click", function () {
  showWeights = !showWeights;
  this.classList.toggle("active", showWeights);
  draw();
});

document.getElementById("btn-blast").addEventListener("click", function () {
  blastRadiusMode = !blastRadiusMode;
  this.classList.toggle("active", blastRadiusMode);
  draw();
});

document.getElementById("btn-fit").addEventListener("click", () => {
  if (mode !== "overview") return;
  overviewLayout = layoutOverview();
  clearDetail();
  draw();
});

window.addEventListener("resize", () => {
  resizeCanvas();
  overviewLayout = layoutOverview();
  draw();
});

updateStats();
updateControls();
draw();
})();
</script>
</body>
</html>`;
}
