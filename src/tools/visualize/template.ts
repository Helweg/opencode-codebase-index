import type { VisualizationData } from "./types.js";

/**
 * Generate a self-contained HTML file with an interactive force-directed graph visualization.
 * Uses inline D3.js (force + zoom + drag modules) with Canvas rendering for performance.
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
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #e0e0e0; overflow: hidden; }
#container { width: 100vw; height: 100vh; position: relative; }
canvas { display: block; }
#controls { position: absolute; top: 12px; left: 12px; display: flex; gap: 8px; align-items: center; z-index: 10; }
#search { padding: 8px 12px; border-radius: 6px; border: 1px solid #333; background: #16213e; color: #e0e0e0; font-size: 14px; width: 260px; outline: none; }
#search:focus { border-color: #0f3460; box-shadow: 0 0 0 2px rgba(15,52,96,0.3); }
#stats { position: absolute; top: 12px; right: 12px; background: #16213e; border: 1px solid #333; border-radius: 6px; padding: 10px 14px; font-size: 12px; z-index: 10; }
#stats span { display: block; margin-bottom: 4px; }
#detail { position: absolute; bottom: 12px; left: 12px; background: #16213e; border: 1px solid #333; border-radius: 6px; padding: 14px; font-size: 13px; z-index: 10; max-width: 400px; display: none; }
#detail h3 { margin-bottom: 8px; color: #4fc3f7; font-size: 15px; }
#detail .field { margin-bottom: 4px; }
#detail .field .label { color: #888; margin-right: 6px; }
#legend { position: absolute; bottom: 12px; right: 12px; background: #16213e; border: 1px solid #333; border-radius: 6px; padding: 10px 14px; font-size: 11px; z-index: 10; max-height: 200px; overflow-y: auto; }
#legend h4 { margin-bottom: 6px; color: #aaa; }
.legend-item { display: flex; align-items: center; margin-bottom: 3px; }
.legend-swatch { width: 12px; height: 12px; border-radius: 50%; margin-right: 6px; flex-shrink: 0; }
.filter-btn { padding: 6px 10px; border-radius: 6px; border: 1px solid #333; background: #16213e; color: #e0e0e0; font-size: 12px; cursor: pointer; }
.filter-btn:hover { background: #0f3460; }
.filter-btn.active { background: #0f3460; border-color: #4fc3f7; }
#truncation-warning { position: absolute; top: 50px; left: 12px; background: #4a3000; border: 1px solid #f5a623; border-radius: 6px; padding: 8px 12px; font-size: 12px; color: #ffd700; z-index: 10; display: none; }
</style>
</head>
<body>
<div id="container">
  <canvas id="graph"></canvas>
  <div id="controls">
    <input type="text" id="search" placeholder="Search symbols..." autocomplete="off">
    <button class="filter-btn" id="btn-reset" title="Reset view">Reset</button>
  </div>
  <div id="stats">
    <span id="stat-nodes"></span>
    <span id="stat-edges"></span>
    <span id="stat-files"></span>
  </div>
  <div id="detail">
    <h3 id="detail-name"></h3>
    <div class="field"><span class="label">File:</span><span id="detail-file"></span></div>
    <div class="field"><span class="label">Kind:</span><span id="detail-kind"></span></div>
    <div class="field"><span class="label">Line:</span><span id="detail-line"></span></div>
    <div class="field"><span class="label">Connections:</span><span id="detail-connections"></span></div>
  </div>
  <div id="legend"><h4>Directories</h4><div id="legend-items"></div></div>
  <div id="truncation-warning"></div>
</div>
<script>
(function() {
"use strict";

const DATA = ${jsonData};

const nodes = DATA.nodes;
const edges = DATA.edges;
const meta = DATA.metadata;

// --- Stats ---
document.getElementById("stat-nodes").textContent = "Nodes: " + nodes.length;
document.getElementById("stat-edges").textContent = "Edges: " + edges.length;
const fileCount = new Set(nodes.map(n => n.filePath)).size;
document.getElementById("stat-files").textContent = "Files: " + fileCount;

if (meta.truncated) {
  const w = document.getElementById("truncation-warning");
  w.style.display = "block";
  w.textContent = "\\u26a0\\ufe0f Graph truncated. Showing top " + nodes.length + " most-connected nodes out of " + meta.totalSymbols + " total.";
}

// --- Color by directory ---
const directories = [...new Set(nodes.map(n => n.directory))].sort();
const dirColorMap = new Map();
const hueStep = 360 / Math.max(directories.length, 1);
directories.forEach((dir, i) => {
  const hue = (i * hueStep + 200) % 360;
  dirColorMap.set(dir, "hsl(" + hue + ", 65%, 55%)");
});

// Legend
const legendEl = document.getElementById("legend-items");
const maxLegendItems = 20;
const dirs = directories.slice(0, maxLegendItems);
dirs.forEach(dir => {
  const item = document.createElement("div");
  item.className = "legend-item";
  const swatch = document.createElement("div");
  swatch.className = "legend-swatch";
  swatch.style.background = dirColorMap.get(dir);
  const label = document.createElement("span");
  label.textContent = dir.length > 35 ? "..." + dir.slice(-32) : dir;
  item.appendChild(swatch);
  item.appendChild(label);
  legendEl.appendChild(item);
});
if (directories.length > maxLegendItems) {
  const more = document.createElement("div");
  more.className = "legend-item";
  more.textContent = "... and " + (directories.length - maxLegendItems) + " more";
  legendEl.appendChild(more);
}

// --- Canvas setup ---
const canvas = document.getElementById("graph");
const ctx = canvas.getContext("2d");
let width = window.innerWidth;
let height = window.innerHeight;
canvas.width = width * devicePixelRatio;
canvas.height = height * devicePixelRatio;
canvas.style.width = width + "px";
canvas.style.height = height + "px";
ctx.scale(devicePixelRatio, devicePixelRatio);

// --- Force simulation (custom, no D3 dependency) ---
const nodeMap = new Map();
nodes.forEach((n, i) => {
  n._x = width / 2 + (Math.random() - 0.5) * Math.min(width, 800);
  n._y = height / 2 + (Math.random() - 0.5) * Math.min(height, 600);
  n._vx = 0;
  n._vy = 0;
  n._idx = i;
  nodeMap.set(n.id, n);
});

// Resolve edge references
const resolvedEdges = [];
for (const e of edges) {
  const src = nodeMap.get(e.source);
  const tgt = nodeMap.get(e.target);
  if (src && tgt) resolvedEdges.push({ source: src, target: tgt, callType: e.callType, confidence: e.confidence });
}

// Build adjacency for neighbor highlighting
const adjacency = new Map();
nodes.forEach(n => adjacency.set(n.id, new Set()));
resolvedEdges.forEach(e => {
  adjacency.get(e.source.id).add(e.target.id);
  adjacency.get(e.target.id).add(e.source.id);
});

// --- Simulation parameters ---
const ALPHA_DECAY = 0.0228;
const VELOCITY_DECAY = 0.4;
const REPULSION = -120;
const LINK_DISTANCE = 80;
const LINK_STRENGTH = 0.3;
const CENTER_STRENGTH = 0.03;
let alpha = 1.0;
let alphaMin = 0.001;

function simulate() {
  if (alpha < alphaMin) return;
  alpha *= (1 - ALPHA_DECAY);

  // Center gravity
  nodes.forEach(n => {
    n._vx += (width / 2 - n._x) * CENTER_STRENGTH * alpha;
    n._vy += (height / 2 - n._y) * CENTER_STRENGTH * alpha;
  });

  // Repulsion (Barnes-Hut approximation for perf)
  const nodeCount = nodes.length;
  if (nodeCount < 500) {
    // Direct O(n^2) for small graphs
    for (let i = 0; i < nodeCount; i++) {
      for (let j = i + 1; j < nodeCount; j++) {
        let dx = nodes[j]._x - nodes[i]._x;
        let dy = nodes[j]._y - nodes[i]._y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        let force = REPULSION * alpha / (dist * dist);
        let fx = dx / dist * force;
        let fy = dy / dist * force;
        nodes[i]._vx -= fx;
        nodes[i]._vy -= fy;
        nodes[j]._vx += fx;
        nodes[j]._vy += fy;
      }
    }
  } else {
    // Grid-based approximation for large graphs
    const cellSize = 100;
    const grid = new Map();
    nodes.forEach(n => {
      const key = Math.floor(n._x / cellSize) + "," + Math.floor(n._y / cellSize);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(n);
    });
    nodes.forEach(n => {
      const cx = Math.floor(n._x / cellSize);
      const cy = Math.floor(n._y / cellSize);
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          const cell = grid.get((cx + dx) + "," + (cy + dy));
          if (!cell) continue;
          for (const other of cell) {
            if (other === n) continue;
            let ddx = other._x - n._x;
            let ddy = other._y - n._y;
            let dist = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
            if (dist > cellSize * 3) continue;
            let force = REPULSION * alpha / (dist * dist);
            n._vx -= ddx / dist * force;
            n._vy -= ddy / dist * force;
          }
        }
      }
    });
  }

  // Link forces
  resolvedEdges.forEach(e => {
    let dx = e.target._x - e.source._x;
    let dy = e.target._y - e.source._y;
    let dist = Math.sqrt(dx * dx + dy * dy) || 1;
    let force = (dist - LINK_DISTANCE) * LINK_STRENGTH * alpha;
    let fx = dx / dist * force;
    let fy = dy / dist * force;
    e.source._vx += fx;
    e.source._vy += fy;
    e.target._vx -= fx;
    e.target._vy -= fy;
  });

  // Integrate
  nodes.forEach(n => {
    if (n._fixed) return;
    n._vx *= VELOCITY_DECAY;
    n._vy *= VELOCITY_DECAY;
    n._x += n._vx;
    n._y += n._vy;
  });
}

// --- Zoom & Pan ---
let transform = { x: 0, y: 0, k: 1 };

function screenToWorld(sx, sy) {
  return { x: (sx - transform.x) / transform.k, y: (sy - transform.y) / transform.k };
}

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const scale = e.deltaY > 0 ? 0.9 : 1.1;
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

  // Check if clicking a node
  const hitNode = findNodeAt(world.x, world.y);
  if (hitNode) {
    isDragging = true;
    dragNode = hitNode;
    dragNode._fixed = true;
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
    alpha = Math.max(alpha, 0.3);
    draw();
  } else {
    // Hover cursor
    const world = screenToWorld(mx, my);
    const hover = findNodeAt(world.x, world.y);
    canvas.style.cursor = hover ? "pointer" : "grab";
  }
});

canvas.addEventListener("mouseup", () => {
  if (isDragging && dragNode) {
    dragNode._fixed = false;
    dragNode = null;
  }
  isPanning = false;
  isDragging = false;
});

function findNodeAt(wx, wy) {
  const radius = 8 / transform.k;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    const dx = n._x - wx;
    const dy = n._y - wy;
    if (dx * dx + dy * dy < radius * radius) return n;
  }
  return null;
}

// --- Selection ---
let selectedNode = null;
let highlightedIds = new Set();

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

  const neighbors = adjacency.get(node.id);
  document.getElementById("detail-connections").textContent = String(neighbors ? neighbors.size : 0);

  highlightedIds = new Set([node.id, ...(neighbors || [])]);
  draw();
}

// --- Search ---
const searchInput = document.getElementById("search");
let searchMatches = new Set();

searchInput.addEventListener("input", () => {
  const q = searchInput.value.toLowerCase().trim();
  if (!q) {
    searchMatches.clear();
  } else {
    searchMatches = new Set(nodes.filter(n => n.name.toLowerCase().includes(q)).map(n => n.id));
  }
  draw();
});

// --- Reset ---
document.getElementById("btn-reset").addEventListener("click", () => {
  transform = { x: 0, y: 0, k: 1 };
  selectedNode = null;
  highlightedIds.clear();
  searchMatches.clear();
  searchInput.value = "";
  document.getElementById("detail").style.display = "none";
  alpha = 1.0;
  draw();
});

// --- Drawing ---
const EDGE_COLORS = {
  Call: "#5c6bc0",
  MethodCall: "#26a69a",
  Constructor: "#ef5350",
  Import: "#ffa726",
  Inherits: "#ab47bc",
  Implements: "#66bb6a",
};

function draw() {
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.translate(transform.x, transform.y);
  ctx.scale(transform.k, transform.k);

  const hasHighlight = highlightedIds.size > 0;
  const hasSearch = searchMatches.size > 0;

  // Draw edges
  resolvedEdges.forEach(e => {
    const dimmed = (hasHighlight && !highlightedIds.has(e.source.id) && !highlightedIds.has(e.target.id))
      || (hasSearch && !searchMatches.has(e.source.id) && !searchMatches.has(e.target.id));

    ctx.beginPath();
    ctx.moveTo(e.source._x, e.source._y);
    ctx.lineTo(e.target._x, e.target._y);
    ctx.strokeStyle = dimmed ? "rgba(60,60,80,0.3)" : (EDGE_COLORS[e.callType] || "#5c6bc0");
    ctx.lineWidth = dimmed ? 0.5 : 1;
    ctx.globalAlpha = dimmed ? 0.3 : 0.7;
    ctx.stroke();

    // Arrow
    if (!dimmed) {
      const angle = Math.atan2(e.target._y - e.source._y, e.target._x - e.source._x);
      const arrowLen = 6;
      const mx = e.target._x - Math.cos(angle) * 8;
      const my = e.target._y - Math.sin(angle) * 8;
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.lineTo(mx - arrowLen * Math.cos(angle - 0.4), my - arrowLen * Math.sin(angle - 0.4));
      ctx.lineTo(mx - arrowLen * Math.cos(angle + 0.4), my - arrowLen * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fillStyle = EDGE_COLORS[e.callType] || "#5c6bc0";
      ctx.fill();
    }
  });

  ctx.globalAlpha = 1;

  // Draw nodes
  const nodeRadius = Math.max(3, Math.min(6, 800 / Math.sqrt(nodes.length)));
  nodes.forEach(n => {
    const dimmed = (hasHighlight && !highlightedIds.has(n.id))
      || (hasSearch && !searchMatches.has(n.id));

    const isSelected = selectedNode && n.id === selectedNode.id;
    const isSearchMatch = searchMatches.has(n.id);

    ctx.beginPath();
    const r = isSelected ? nodeRadius * 1.8 : (isSearchMatch ? nodeRadius * 1.4 : nodeRadius);
    ctx.arc(n._x, n._y, r, 0, Math.PI * 2);

    ctx.fillStyle = dimmed ? "rgba(60,60,80,0.4)" : dirColorMap.get(n.directory) || "#888";
    ctx.fill();

    if (isSelected) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();
    } else if (isSearchMatch) {
      ctx.strokeStyle = "#ffd700";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Label for selected/search nodes or when zoomed in
    if ((isSelected || isSearchMatch || transform.k > 2) && !dimmed) {
      ctx.font = (11 / transform.k) + "px sans-serif";
      ctx.fillStyle = "#e0e0e0";
      ctx.textAlign = "center";
      ctx.fillText(n.name, n._x, n._y - r - 4);
    }
  });

  ctx.restore();
}

// --- Animation loop ---
let running = true;
function tick() {
  if (!running) return;
  simulate();
  draw();
  if (alpha >= alphaMin) {
    requestAnimationFrame(tick);
  } else {
    draw(); // Final frame
  }
}
tick();

// Keep simulation accessible for interactions
setInterval(() => {
  if (alpha >= alphaMin) {
    if (!running) { running = true; tick(); }
  } else {
    running = false;
  }
}, 100);

// --- Resize ---
window.addEventListener("resize", () => {
  width = window.innerWidth;
  height = window.innerHeight;
  canvas.width = width * devicePixelRatio;
  canvas.height = height * devicePixelRatio;
  canvas.style.width = width + "px";
  canvas.style.height = height + "px";
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  draw();
});

})();
</script>
</body>
</html>`;
}
