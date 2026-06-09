import type { VisualizationData } from "./types.js";

/**
 * Generate a self-contained HTML file with an interactive stratified cluster graph visualization.
 * Layout algorithm:
 * 1. Compute topological depth via DAG traversal (cycle-breaking with DFS)
 * 2. Group nodes into directory clusters
 * 3. Position clusters vertically by median node depth (orchestrators top, utilities bottom)
 * 4. Position clusters horizontally using barycenter ordering to minimize edge crossings
 * 5. Intra-cluster layout: compact grid
 * 6. Edge rendering with directional arrows
 */
export function generateVisualizationHtml(data: VisualizationData): string {
  // Escape < and > in JSON to prevent script injection in HTML context
  const jsonData = JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Call Graph Visualization</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f1a; color: #e0e0e0; overflow: hidden; }
#container { width: 100vw; height: 100vh; position: relative; }
canvas { display: block; }

#controls { position: absolute; top: 12px; left: 12px; display: flex; gap: 8px; align-items: center; z-index: 10; flex-wrap: wrap; max-width: 500px; }
#search { padding: 8px 12px; border-radius: 6px; border: 1px solid #2a2a4a; background: #1a1a2e; color: #e0e0e0; font-size: 13px; width: 220px; outline: none; }
#search:focus { border-color: #4a4a8a; box-shadow: 0 0 0 2px rgba(74,74,138,0.3); }
.ctrl-btn { padding: 6px 10px; border-radius: 6px; border: 1px solid #2a2a4a; background: #1a1a2e; color: #b0b0c0; font-size: 11px; cursor: pointer; transition: all 0.15s; }
.ctrl-btn:hover { background: #252545; border-color: #4a4a8a; color: #e0e0e0; }
.ctrl-btn.active { background: #2a2a5a; border-color: #6a6aaa; color: #fff; }

#stats { position: absolute; top: 12px; right: 12px; background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 8px; padding: 12px 16px; font-size: 11px; z-index: 10; line-height: 1.7; }
#stats .stat-label { color: #666; }

#detail { position: absolute; bottom: 12px; left: 12px; background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 8px; padding: 16px; font-size: 12px; z-index: 10; max-width: 380px; display: none; box-shadow: 0 4px 20px rgba(0,0,0,0.4); }
#detail h3 { margin-bottom: 10px; color: #7eb8ff; font-size: 14px; font-weight: 600; letter-spacing: -0.3px; }
#detail .field { margin-bottom: 5px; display: flex; gap: 6px; }
#detail .label { color: #666; min-width: 80px; }
#detail .value { color: #ccc; word-break: break-all; }

#legend { position: absolute; bottom: 12px; right: 12px; background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 8px; padding: 12px 16px; font-size: 10px; z-index: 10; max-height: 240px; overflow-y: auto; min-width: 160px; }
#legend h4 { margin-bottom: 8px; color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
.legend-item { display: flex; align-items: center; margin-bottom: 4px; cursor: pointer; padding: 2px 4px; border-radius: 3px; }
.legend-item:hover { background: #252545; }
.legend-swatch { width: 10px; height: 10px; border-radius: 3px; margin-right: 8px; flex-shrink: 0; }
.legend-label { color: #aaa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

#edge-legend { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 8px; padding: 8px 16px; font-size: 10px; z-index: 10; display: flex; gap: 14px; align-items: center; }
.edge-type { display: flex; align-items: center; gap: 4px; }
.edge-line { width: 16px; height: 2px; border-radius: 1px; }

#truncation-warning { position: absolute; top: 50px; left: 12px; background: #2a2000; border: 1px solid #8a6800; border-radius: 6px; padding: 8px 12px; font-size: 11px; color: #ffd700; z-index: 10; display: none; }

#minimap { position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 8px; width: 180px; height: 100px; z-index: 9; overflow: hidden; display: none; }
</style>
</head>
<body>
<div id="container">
  <canvas id="graph"></canvas>
  <div id="controls">
    <input type="text" id="search" placeholder="Search symbols..." autocomplete="off">
    <button class="ctrl-btn" id="btn-reset" title="Reset view">Reset</button>
    <button class="ctrl-btn" id="btn-labels" title="Toggle labels">Labels</button>
    <button class="ctrl-btn" id="btn-edges" title="Toggle edge type colors">Edges</button>
  </div>
  <div id="edge-legend">
    <div class="edge-type"><div class="edge-line" style="background:#5c7cfa"></div><span>Call</span></div>
    <div class="edge-type"><div class="edge-line" style="background:#20c997"></div><span>Method</span></div>
    <div class="edge-type"><div class="edge-line" style="background:#ff6b6b"></div><span>Constructor</span></div>
    <div class="edge-type"><div class="edge-line" style="background:#fcc419"></div><span>Import</span></div>
    <div class="edge-type"><div class="edge-line" style="background:#cc5de8"></div><span>Inherits</span></div>
    <div class="edge-type"><div class="edge-line" style="background:#51cf66"></div><span>Implements</span></div>
  </div>
  <div id="stats"></div>
  <div id="detail">
    <h3 id="detail-name"></h3>
    <div class="field"><span class="label">File</span><span class="value" id="detail-file"></span></div>
    <div class="field"><span class="label">Kind</span><span class="value" id="detail-kind"></span></div>
    <div class="field"><span class="label">Line</span><span class="value" id="detail-line"></span></div>
    <div class="field"><span class="label">Connections</span><span class="value" id="detail-connections"></span></div>
    <div class="field"><span class="label">Callers</span><span class="value" id="detail-callers"></span></div>
    <div class="field"><span class="label">Callees</span><span class="value" id="detail-callees"></span></div>
  </div>
  <div id="legend"><h4>Modules</h4><div id="legend-items"></div></div>
  <div id="truncation-warning"></div>
</div>
<script>
(function() {
"use strict";

const DATA = ${jsonData};
const nodes = DATA.nodes;
const edges = DATA.edges;
const meta = DATA.metadata;

// ═══════════════════════════════════════════════════
// GRAPH ANALYSIS
// ═══════════════════════════════════════════════════

const nodeMap = new Map();
nodes.forEach(n => nodeMap.set(n.id, n));

// Build adjacency lists
const outEdges = new Map(); // id -> [{target, edge}]
const inEdges = new Map();  // id -> [{source, edge}]
nodes.forEach(n => { outEdges.set(n.id, []); inEdges.set(n.id, []); });

const resolvedEdges = [];
for (const e of edges) {
  const src = nodeMap.get(e.source);
  const tgt = nodeMap.get(e.target);
  if (src && tgt) {
    resolvedEdges.push({ source: src, target: tgt, callType: e.callType, confidence: e.confidence });
    outEdges.get(e.source).push({ node: tgt, edge: e });
    inEdges.get(e.target).push({ node: src, edge: e });
  }
}

// ═══════════════════════════════════════════════════
// LAYER ASSIGNMENT (Topological depth with cycle breaking)
// ═══════════════════════════════════════════════════

function computeDepths() {
  const depth = new Map();
  const visited = new Set();
  const inStack = new Set();

  function dfs(id, d) {
    if (inStack.has(id)) return; // cycle - skip
    if (visited.has(id) && depth.get(id) >= d) return;
    visited.add(id);
    inStack.add(id);
    depth.set(id, Math.max(depth.get(id) || 0, d));
    for (const { node } of outEdges.get(id) || []) {
      dfs(node.id, d + 1);
    }
    inStack.delete(id);
  }

  // Start from roots (nodes with no incoming edges)
  const roots = nodes.filter(n => (inEdges.get(n.id) || []).length === 0);
  if (roots.length === 0) {
    // All nodes in cycles - pick highest out-degree nodes as roots
    const sorted = [...nodes].sort((a, b) => (outEdges.get(b.id) || []).length - (outEdges.get(a.id) || []).length);
    sorted.slice(0, Math.max(3, Math.floor(nodes.length * 0.1))).forEach(n => dfs(n.id, 0));
  } else {
    roots.forEach(n => dfs(n.id, 0));
  }

  // Handle disconnected nodes
  nodes.forEach(n => { if (!depth.has(n.id)) depth.set(n.id, 0); });

  return depth;
}

const nodeDepth = computeDepths();

// ═══════════════════════════════════════════════════
// DIRECTORY CLUSTERING
// ═══════════════════════════════════════════════════

const clusters = new Map(); // directory -> [nodes]
nodes.forEach(n => {
  if (!clusters.has(n.directory)) clusters.set(n.directory, []);
  clusters.get(n.directory).push(n);
});

// Compute cluster median depth for vertical ordering
const clusterDepth = new Map();
for (const [dir, members] of clusters) {
  const depths = members.map(n => nodeDepth.get(n.id) || 0).sort((a, b) => a - b);
  clusterDepth.set(dir, depths[Math.floor(depths.length / 2)]);
}

// Sort clusters into layers
const maxDepth = Math.max(...nodeDepth.values(), 0);
const layerCount = Math.min(maxDepth + 1, 8); // Cap at 8 layers for readability
const layerSize = (maxDepth + 1) / layerCount;

const clusterLayer = new Map();
for (const [dir, depth] of clusterDepth) {
  clusterLayer.set(dir, Math.min(Math.floor(depth / layerSize), layerCount - 1));
}

// Group clusters by layer
const layers = Array.from({ length: layerCount }, () => []);
for (const [dir] of clusters) {
  layers[clusterLayer.get(dir)].push(dir);
}

// Order clusters within each layer by barycenter (average position of connected clusters in adjacent layers)
function orderByBarycenter() {
  // Build inter-cluster edges
  const interCluster = new Map(); // dir -> Set of connected dirs
  for (const e of resolvedEdges) {
    const srcDir = e.source.directory;
    const tgtDir = e.target.directory;
    if (srcDir !== tgtDir) {
      if (!interCluster.has(srcDir)) interCluster.set(srcDir, new Map());
      const m = interCluster.get(srcDir);
      m.set(tgtDir, (m.get(tgtDir) || 0) + 1);
    }
  }

  // Multiple sweep passes
  for (let pass = 0; pass < 4; pass++) {
    for (let l = 1; l < layerCount; l++) {
      const layer = layers[l];
      const prevLayer = layers[l - 1];
      const prevPos = new Map();
      prevLayer.forEach((d, i) => prevPos.set(d, i));

      layer.sort((a, b) => {
        const aConns = interCluster.get(a);
        const bConns = interCluster.get(b);
        let aSum = 0, aCount = 0, bSum = 0, bCount = 0;
        if (aConns) for (const [d, w] of aConns) { if (prevPos.has(d)) { aSum += prevPos.get(d) * w; aCount += w; } }
        if (bConns) for (const [d, w] of bConns) { if (prevPos.has(d)) { bSum += prevPos.get(d) * w; bCount += w; } }
        const aBar = aCount ? aSum / aCount : Infinity;
        const bBar = bCount ? bSum / bCount : Infinity;
        return aBar - bBar;
      });
    }
  }
}
orderByBarycenter();

// ═══════════════════════════════════════════════════
// LAYOUT COMPUTATION
// ═══════════════════════════════════════════════════

const CLUSTER_PAD_X = 30;
const CLUSTER_PAD_Y = 28;
const NODE_SPACING = 28;
const CLUSTER_GAP_X = 50;
const CLUSTER_GAP_Y = 70;
const LAYER_GAP = 100;

const clusterBounds = new Map(); // dir -> {x, y, w, h}
const nodePositions = new Map(); // id -> {x, y}

function computeLayout() {
  let currentY = 60;

  for (let l = 0; l < layerCount; l++) {
    const layerDirs = layers[l];
    if (layerDirs.length === 0) continue;

    // Compute cluster sizes
    const clusterSizes = layerDirs.map(dir => {
      const members = clusters.get(dir);
      const cols = Math.ceil(Math.sqrt(members.length * 1.5));
      const rows = Math.ceil(members.length / cols);
      const w = cols * NODE_SPACING + CLUSTER_PAD_X * 2;
      const h = rows * NODE_SPACING + CLUSTER_PAD_Y * 2;
      return { dir, members, cols, rows, w, h };
    });

    const maxH = Math.max(...clusterSizes.map(c => c.h));
    let currentX = 40;

    for (const cs of clusterSizes) {
      const cx = currentX;
      const cy = currentY;

      clusterBounds.set(cs.dir, { x: cx, y: cy, w: cs.w, h: cs.h });

      // Position nodes in grid within cluster
      cs.members.forEach((node, i) => {
        const col = i % cs.cols;
        const row = Math.floor(i / cs.cols);
        const nx = cx + CLUSTER_PAD_X + col * NODE_SPACING + NODE_SPACING / 2;
        const ny = cy + CLUSTER_PAD_Y + row * NODE_SPACING + NODE_SPACING / 2;
        nodePositions.set(node.id, { x: nx, y: ny });
        node._x = nx;
        node._y = ny;
      });

      currentX += cs.w + CLUSTER_GAP_X;
    }

    currentY += maxH + LAYER_GAP;
  }
}
computeLayout();

// ═══════════════════════════════════════════════════
// COLOR SCHEME
// ═══════════════════════════════════════════════════

const directories = [...clusters.keys()].sort();
const dirColorMap = new Map();
// Use a perceptually uniform palette
const PALETTE = [
  "#5c7cfa", "#20c997", "#ff6b6b", "#fcc419", "#cc5de8",
  "#51cf66", "#339af0", "#f06595", "#ff922b", "#66d9e8",
  "#845ef7", "#94d82d", "#e599f7", "#3bc9db", "#ffa94d",
  "#69db7c", "#748ffc", "#e64980", "#f76707", "#22b8cf",
];
directories.forEach((dir, i) => {
  dirColorMap.set(dir, PALETTE[i % PALETTE.length]);
});

const EDGE_COLORS = {
  Call: "#5c7cfa",
  MethodCall: "#20c997",
  Constructor: "#ff6b6b",
  Import: "#fcc419",
  Inherits: "#cc5de8",
  Implements: "#51cf66",
};

// ═══════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════

const fileCount = new Set(nodes.map(n => n.filePath)).size;
document.getElementById("stats").innerHTML =
  '<span class="stat-label">Nodes</span> ' + nodes.length +
  '<br><span class="stat-label">Edges</span> ' + resolvedEdges.length +
  '<br><span class="stat-label">Files</span> ' + fileCount +
  '<br><span class="stat-label">Modules</span> ' + clusters.size +
  '<br><span class="stat-label">Layers</span> ' + layerCount;

if (meta.truncated) {
  const w = document.getElementById("truncation-warning");
  w.style.display = "block";
  w.textContent = "\\u26a0\\ufe0f Graph truncated to " + nodes.length + " most-connected nodes (total: " + meta.totalSymbols + ")";
}

// Legend
const legendEl = document.getElementById("legend-items");
directories.forEach(dir => {
  const item = document.createElement("div");
  item.className = "legend-item";
  item.dataset.dir = dir;
  const swatch = document.createElement("div");
  swatch.className = "legend-swatch";
  swatch.style.background = dirColorMap.get(dir);
  const label = document.createElement("span");
  label.className = "legend-label";
  const shortDir = dir.length > 28 ? "..." + dir.slice(-25) : dir;
  label.textContent = shortDir + " (" + clusters.get(dir).length + ")";
  label.title = dir;
  item.appendChild(swatch);
  item.appendChild(label);
  item.addEventListener("click", () => focusCluster(dir));
  legendEl.appendChild(item);
});

// ═══════════════════════════════════════════════════
// CANVAS SETUP
// ═══════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════
// ZOOM & PAN
// ═══════════════════════════════════════════════════

let transform = { x: 40, y: 40, k: 1 };

// Auto-fit on load
function fitView() {
  if (nodes.length === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [, b] of clusterBounds) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  const graphW = maxX - minX;
  const graphH = maxY - minY;
  const padW = width * 0.08;
  const padH = height * 0.08;
  const scaleX = (width - padW * 2) / graphW;
  const scaleY = (height - padH * 2) / graphH;
  transform.k = Math.min(scaleX, scaleY, 2.5);
  transform.x = (width - graphW * transform.k) / 2 - minX * transform.k;
  transform.y = (height - graphH * transform.k) / 2 - minY * transform.k;
}
fitView();

function screenToWorld(sx, sy) {
  return { x: (sx - transform.x) / transform.k, y: (sy - transform.y) / transform.k };
}

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const scale = e.deltaY > 0 ? 0.92 : 1.08;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  transform.x = mx - (mx - transform.x) * scale;
  transform.y = my - (my - transform.y) * scale;
  transform.k *= scale;
  draw();
}, { passive: false });

let isPanning = false;
let isDragging = false;
let dragNode = null;
let lastMouse = { x: 0, y: 0 };

canvas.addEventListener("mousedown", (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const world = screenToWorld(mx, my);

  const hitNode = findNodeAt(world.x, world.y);
  if (hitNode) {
    isDragging = true;
    dragNode = hitNode;
    selectNode(hitNode);
  } else {
    isPanning = true;
    selectNode(null);
  }
  lastMouse = { x: mx, y: my };
});

canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  if (isPanning) {
    transform.x += mx - lastMouse.x;
    transform.y += my - lastMouse.y;
    lastMouse = { x: mx, y: my };
    draw();
  } else if (isDragging && dragNode) {
    const world = screenToWorld(mx, my);
    dragNode._x = world.x;
    dragNode._y = world.y;
    nodePositions.set(dragNode.id, { x: world.x, y: world.y });
    draw();
  } else {
    const world = screenToWorld(mx, my);
    const hover = findNodeAt(world.x, world.y);
    canvas.style.cursor = hover ? "pointer" : "grab";
  }
});

canvas.addEventListener("mouseup", () => {
  isPanning = false;
  isDragging = false;
  dragNode = null;
});

function findNodeAt(wx, wy) {
  const radius = Math.max(6, 10 / transform.k);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    const dx = n._x - wx;
    const dy = n._y - wy;
    if (dx * dx + dy * dy < radius * radius) return n;
  }
  return null;
}

// ═══════════════════════════════════════════════════
// SELECTION & INTERACTION
// ═══════════════════════════════════════════════════

let selectedNode = null;
let highlightedIds = new Set();
let focusedDir = null;

function selectNode(node) {
  selectedNode = node;
  const detail = document.getElementById("detail");
  if (!node) {
    detail.style.display = "none";
    highlightedIds.clear();
    draw();
    return;
  }

  detail.style.display = "block";
  document.getElementById("detail-name").textContent = node.name;
  document.getElementById("detail-file").textContent = node.filePath;
  document.getElementById("detail-kind").textContent = node.kind;
  document.getElementById("detail-line").textContent = String(node.line);

  const callerList = (inEdges.get(node.id) || []).map(e => e.node.name);
  const calleeList = (outEdges.get(node.id) || []).map(e => e.node.name);
  document.getElementById("detail-connections").textContent = String(callerList.length + calleeList.length);
  document.getElementById("detail-callers").textContent = callerList.length ? callerList.join(", ") : "none";
  document.getElementById("detail-callees").textContent = calleeList.length ? calleeList.join(", ") : "none";

  highlightedIds = new Set([node.id]);
  for (const e of inEdges.get(node.id) || []) highlightedIds.add(e.node.id);
  for (const e of outEdges.get(node.id) || []) highlightedIds.add(e.node.id);
  draw();
}

function focusCluster(dir) {
  if (focusedDir === dir) { focusedDir = null; draw(); return; }
  focusedDir = dir;

  // Pan to cluster
  const bounds = clusterBounds.get(dir);
  if (bounds) {
    const cx = bounds.x + bounds.w / 2;
    const cy = bounds.y + bounds.h / 2;
    transform.x = width / 2 - cx * transform.k;
    transform.y = height / 2 - cy * transform.k;
  }
  draw();
}

// Search
const searchInput = document.getElementById("search");
let searchMatches = new Set();

searchInput.addEventListener("input", () => {
  const q = searchInput.value.toLowerCase().trim();
  if (!q) {
    searchMatches.clear();
  } else {
    searchMatches = new Set(nodes.filter(n => n.name.toLowerCase().includes(q) || n.filePath.toLowerCase().includes(q)).map(n => n.id));
  }
  draw();
});

// Controls
let showLabels = true;
let showEdgeColors = true;

document.getElementById("btn-reset").addEventListener("click", () => {
  selectedNode = null;
  highlightedIds.clear();
  searchMatches.clear();
  focusedDir = null;
  searchInput.value = "";
  document.getElementById("detail").style.display = "none";
  fitView();
  draw();
});

document.getElementById("btn-labels").addEventListener("click", function() {
  showLabels = !showLabels;
  this.classList.toggle("active", showLabels);
  draw();
});
document.getElementById("btn-labels").classList.add("active");

document.getElementById("btn-edges").addEventListener("click", function() {
  showEdgeColors = !showEdgeColors;
  this.classList.toggle("active", showEdgeColors);
  draw();
});
document.getElementById("btn-edges").classList.add("active");

// ═══════════════════════════════════════════════════
// DRAWING
// ═══════════════════════════════════════════════════

function draw() {
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.translate(transform.x, transform.y);
  ctx.scale(transform.k, transform.k);

  const hasHighlight = highlightedIds.size > 0;
  const hasSearch = searchMatches.size > 0;
  const hasFocus = focusedDir !== null;

  // Draw cluster backgrounds
  for (const [dir, bounds] of clusterBounds) {
    const dimmed = hasFocus && dir !== focusedDir;
    ctx.fillStyle = dimmed ? "rgba(20,20,40,0.3)" : "rgba(30,30,55,0.6)";
    ctx.strokeStyle = dimmed ? "rgba(40,40,70,0.3)" : dirColorMap.get(dir) + "44";
    ctx.lineWidth = 1;
    ctx.beginPath();
    roundRect(ctx, bounds.x, bounds.y, bounds.w, bounds.h, 8);
    ctx.fill();
    ctx.stroke();

    // Cluster label
    if (transform.k > 0.4) {
      ctx.font = "bold " + (10 / Math.max(transform.k, 0.8)) + "px sans-serif";
      ctx.fillStyle = dimmed ? "rgba(100,100,130,0.3)" : dirColorMap.get(dir) + "aa";
      ctx.textAlign = "left";
      const shortLabel = dir.split("/").pop() || dir;
      ctx.fillText(shortLabel, bounds.x + 8, bounds.y + 14);
    }
  }

  // Draw edges
  for (const e of resolvedEdges) {
    const srcDimmed = hasFocus && e.source.directory !== focusedDir && e.target.directory !== focusedDir;
    const highlighted = hasHighlight && (highlightedIds.has(e.source.id) && highlightedIds.has(e.target.id));
    const searched = hasSearch && (searchMatches.has(e.source.id) || searchMatches.has(e.target.id));
    const dimmed = srcDimmed || (hasHighlight && !highlighted) || (hasSearch && !searched);

    ctx.beginPath();
    // Curved edges for inter-cluster, straight for intra-cluster
    if (e.source.directory !== e.target.directory) {
      const mx = (e.source._x + e.target._x) / 2;
      const my = (e.source._y + e.target._y) / 2;
      const dx = e.target._x - e.source._x;
      const dy = e.target._y - e.source._y;
      const offsetX = -dy * 0.1;
      const offsetY = dx * 0.1;
      ctx.moveTo(e.source._x, e.source._y);
      ctx.quadraticCurveTo(mx + offsetX, my + offsetY, e.target._x, e.target._y);
    } else {
      ctx.moveTo(e.source._x, e.source._y);
      ctx.lineTo(e.target._x, e.target._y);
    }

    const baseColor = showEdgeColors ? (EDGE_COLORS[e.callType] || "#5c7cfa") : "#4a4a7a";
    ctx.strokeStyle = dimmed ? "rgba(50,50,70,0.2)" : baseColor;
    ctx.lineWidth = highlighted ? 1.8 : (dimmed ? 0.3 : 0.8);
    ctx.globalAlpha = dimmed ? 0.2 : (highlighted ? 0.9 : 0.5);
    ctx.stroke();

    // Arrow
    if (!dimmed && transform.k > 0.5) {
      const angle = Math.atan2(e.target._y - e.source._y, e.target._x - e.source._x);
      const arrowLen = 5;
      const ax = e.target._x - Math.cos(angle) * 7;
      const ay = e.target._y - Math.sin(angle) * 7;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - arrowLen * Math.cos(angle - 0.4), ay - arrowLen * Math.sin(angle - 0.4));
      ctx.lineTo(ax - arrowLen * Math.cos(angle + 0.4), ay - arrowLen * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.globalAlpha = highlighted ? 0.9 : 0.6;
      ctx.fillStyle = baseColor;
      ctx.fill();
    }
  }

  ctx.globalAlpha = 1;

  // Draw nodes
  const baseRadius = Math.max(3, Math.min(5, 600 / Math.sqrt(nodes.length)));
  for (const n of nodes) {
    const inFocus = !hasFocus || n.directory === focusedDir;
    const dimmed = (hasFocus && !inFocus) ||
      (hasHighlight && !highlightedIds.has(n.id)) ||
      (hasSearch && !searchMatches.has(n.id));

    const isSelected = selectedNode && n.id === selectedNode.id;
    const isSearchMatch = searchMatches.has(n.id);
    const isHighlighted = highlightedIds.has(n.id);

    let r = baseRadius;
    if (isSelected) r *= 2;
    else if (isSearchMatch || isHighlighted) r *= 1.4;

    ctx.beginPath();
    ctx.arc(n._x, n._y, r, 0, Math.PI * 2);
    ctx.fillStyle = dimmed ? "rgba(50,50,70,0.3)" : dirColorMap.get(n.directory) || "#888";
    ctx.fill();

    if (isSelected) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();
    } else if (isSearchMatch) {
      ctx.strokeStyle = "#ffd700";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else if (isHighlighted) {
      ctx.strokeStyle = "#7eb8ff";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Labels
    if (!dimmed && showLabels && (isSelected || isSearchMatch || isHighlighted || transform.k > 1.8)) {
      ctx.font = Math.max(8, 10 / Math.max(transform.k, 1)) + "px sans-serif";
      ctx.fillStyle = isSelected ? "#fff" : (dimmed ? "rgba(100,100,130,0.3)" : "#c8c8d8");
      ctx.textAlign = "center";
      ctx.fillText(n.name, n._x, n._y - r - 3);
    }
  }

  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
}

// Initial draw
draw();

// Resize handler
window.addEventListener("resize", () => { resizeCanvas(); draw(); });

})();
</script>
</body>
</html>`;
}
