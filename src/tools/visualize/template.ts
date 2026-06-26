import type { VisualizationData } from "./types.js";

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
*{box-sizing:border-box}body{margin:0;background:#0d1118;color:#c4cfe6;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;overflow:hidden}
#app{height:100vh;display:grid;grid-template-columns:300px minmax(0,1fr) 320px;grid-template-rows:auto 1fr;gap:12px;padding:14px}
.top{grid-column:1/-1;display:flex;align-items:center;gap:10px;min-width:0}.search{width:300px;max-width:40vw;padding:8px 11px;border:1px solid #203149;border-radius:6px;background:#141e2e;color:#c4cfe6;outline:none}.search:focus{border-color:#5577d8}
.tabs{display:flex;gap:6px;min-width:0;overflow:auto}.tab{border:1px solid #203149;background:#141e2e;color:#6f83a4;border-radius:6px;padding:7px 10px;cursor:pointer;white-space:nowrap}.tab.active{border-color:#5577d8;color:#fff;background:#111c30}
.stats{margin-left:auto;color:#334966;font-size:12px;white-space:nowrap;border:1px solid #203149;background:#141e2e;border-radius:6px;padding:7px 11px}.stats b{color:#7f94b8}
.panel{background:rgba(13,17,24,.86);border:1px solid #203149;border-radius:8px;min-height:0}.left,.right{padding:14px;overflow:auto;overflow-x:hidden}.title{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#334966;margin:0 0 10px}
.results,.list{display:grid;gap:7px;min-width:0}.result,.row,.node,.change{min-width:0;border:1px solid #203149;background:#101722;border-radius:7px;padding:9px 10px;cursor:pointer;overflow:hidden}.result:hover,.row:hover,.node:hover,.change:hover{border-color:#375171;background:#121c2a}.result.active,.node.active,.change.active{border-color:#8b6cf6;background:#15172a}
.name{font-family:"SF Mono","Cascadia Code",Consolas,monospace;font-size:12px;color:#e0e6f7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta{min-width:0;max-width:100%;font-size:11px;color:#6f83a4;margin-top:4px;display:flex;gap:8px;align-items:center;overflow:hidden}.meta span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.badge{font-family:"SF Mono",Consolas,monospace;font-size:10px;border-radius:4px;padding:2px 5px;background:#1b2940;color:#7890ac;flex:0 0 auto}.badge.function,.badge.fn{background:#18264a;color:#7896ff}.badge.class{background:#271f4b;color:#a48cff}.badge.type,.badge.interface{background:#172d36;color:#5fc4d4}.badge.enum{background:#382812;color:#e3a348}
.main{position:relative;overflow:hidden;padding:14px}.flow{position:relative;height:100%;display:grid;grid-template-columns:minmax(220px,1fr) minmax(300px,1.15fr) minmax(220px,1fr);gap:24px;align-items:center}.lane{height:min(640px,calc(100vh - 150px));min-height:360px;border:1px solid #203149;border-radius:8px;padding:14px;display:flex;flex-direction:column;gap:10px;overflow:auto;background:rgba(16,23,34,.5)}.lane .node,.lane .row{flex:0 0 auto}.lane h3,.module-symbols h3{margin:0 0 4px;font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#334966;text-align:center}.center{align-self:center;min-width:0}.center .node{cursor:default;border-color:#8b6cf6;background:#15172a;box-shadow:0 0 0 1px rgba(139,108,246,.2)}.module-board{height:100%;display:grid;grid-template-rows:auto 260px minmax(260px,1fr);gap:12px;overflow:hidden}.module-summary .node{cursor:default;border-color:#8b6cf6;background:#15172a}.module-lanes{min-height:0;display:grid;grid-template-columns:1fr 1fr;gap:12px}.module-board .lane{height:auto;min-height:0}.module-symbols{min-height:0;border:1px solid #203149;border-radius:8px;padding:14px;background:rgba(16,23,34,.5);display:flex;flex-direction:column;gap:10px;overflow:hidden}.module-symbols .list{display:block;overflow:auto;min-height:0}.module-symbols .row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;margin:0 0 6px;padding:8px 10px}.module-symbols .row .meta{margin-top:0;justify-content:flex-end}.weight{margin-left:auto;color:#334966;font-variant-numeric:tabular-nums}.edges{position:absolute;inset:0;pointer-events:none;z-index:1}.node{position:relative;z-index:2}
.details{display:grid;gap:8px}.kv{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid #17243a;padding-bottom:7px;color:#6f83a4;font-size:12px}.kv span:first-child{color:#334966;text-transform:uppercase;font-size:10px;letter-spacing:.08em}.mini{display:flex;align-items:center;gap:8px;color:#6f83a4;font-size:12px}.dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}.empty{height:100%;display:grid;place-items:center;color:#334966;font-size:12px;text-align:center;line-height:1.5}.guide{border:1px solid #203149;border-radius:7px;background:#101722;padding:10px;color:#6f83a4;font-size:12px;line-height:1.45}.guide b{display:block;color:#e0e6f7;margin-bottom:4px}.guide span{display:block}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:10px;align-content:start}.rank{font-size:20px;color:#8b6cf6;font-variant-numeric:tabular-nums}.change-grid{display:grid;grid-template-columns:minmax(280px,.95fr) minmax(320px,1.2fr);gap:12px;height:100%;min-height:0}.change-list,.why{display:flex;flex-direction:column;gap:9px;min-height:0;overflow:auto;overflow-x:hidden}.change-top{display:flex;align-items:center;gap:8px;margin-bottom:7px;min-width:0}.pill{font-size:10px;text-transform:uppercase;letter-spacing:.08em;border:1px solid #203149;border-radius:999px;padding:3px 7px;color:#6f83a4;flex:0 0 auto}.pill.hot{color:#d5c9ff;border-color:#634bc2}.pill.risk{color:#ffbab7;border-color:#8d3d3a}.pill.legacy{color:#c5d1df;border-color:#41536c}.why-card{min-width:0;border:1px solid #203149;background:rgba(16,23,34,.65);border-radius:8px;padding:14px;overflow:hidden}.why-card h3{margin:0 0 8px;font-size:13px}.why-card p{margin:0;color:#6f83a4;font-size:13px;line-height:1.55}.impact{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px}.impact div{border:1px solid #17243a;border-radius:7px;padding:8px}.impact b{display:block;font-size:16px;color:#e0e6f7}.impact span{font-size:10px;color:#334966;text-transform:uppercase;letter-spacing:.08em}
.hint{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);font-size:11px;color:#334966;border:1px solid #203149;background:rgba(13,17,24,.9);border-radius:6px;padding:6px 12px;white-space:nowrap}
@media(max-width:1500px){body{overflow:auto}#app{height:auto;min-height:100vh;grid-template-columns:1fr;grid-template-rows:auto auto auto auto}.top{flex-wrap:wrap}.tabs{flex-wrap:wrap;overflow:visible}.search{width:100%;max-width:none}.stats{margin-left:0;width:100%}.main{order:1;min-height:820px}.right{order:2}.left{order:3}.flow{grid-template-columns:minmax(220px,1fr) minmax(300px,1.15fr) minmax(220px,1fr);gap:16px;align-items:center}.change-grid{grid-template-columns:1fr;gap:12px;align-items:stretch}.why{order:1}.change-list{order:2}.lane{height:min(560px,calc(100vh - 180px));min-height:260px}.impact{grid-template-columns:1fr}.edges{display:none}.hint{position:static;transform:none;margin-top:10px;text-align:center}}
@media(max-width:900px){.flow,.module-lanes{grid-template-columns:1fr;gap:12px;align-items:stretch}.lane{height:auto;max-height:360px;min-height:160px}.module-board{grid-template-rows:auto auto minmax(260px,1fr);overflow:visible}.module-symbols{max-height:420px}.module-symbols .row{grid-template-columns:1fr}.module-symbols .row .meta{justify-content:flex-start;margin-top:4px}}
</style>
</head>
<body>
<div id="app">
  <div class="top">
    <input id="search" class="search" placeholder="Search changes, symbols, modules, files..." autocomplete="off">
    <div class="tabs" id="tabs"></div>
    <div class="stats"><b id="modeName">Changes</b> | <b id="nodeCount">0</b> nodes | <b id="edgeCount">0</b> edges | <b id="changeCount">0</b> change lenses</div>
  </div>
  <aside class="panel left"><h2 class="title">Search / jump</h2><div id="results" class="results"></div></aside>
  <main class="panel main"><svg id="edges" class="edges"></svg><div id="stage" class="flow"></div><div class="hint" id="hint">Scroll to pan vertically inside focus mode</div></main>
  <aside class="panel right"><h2 class="title">Details</h2><div id="details" class="details"></div></aside>
</div>
<script>
const graphData = ${jsonData};
const nodes = graphData.nodes || [];
const edges = graphData.edges || [];
const modules = graphData.modules || [];
const moduleEdges = graphData.moduleEdges || [];
const changes = graphData.changes || [];
const modes = ["Changes", "Module Overview", "Explore Symbols", "Hotspots", "Cycles"];
let mode = changes.length > 0 ? "Changes" : "Module Overview";
let selected = nodes[0] ? { type: "symbol", id: nodes[0].id } : { type: "module", id: modules[0] && modules[0].id };
let selectedChange = changes[0] && changes[0].id;
let query = "";

function esc(value){return String(value == null ? "" : value).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c];});}
function nodeById(id){return nodes.find(function(node){return node.id === id;});}
function moduleById(id){return modules.find(function(item){return item.id === id;});}
function colorFor(id){const moduleId = nodeById(id) ? nodeById(id).moduleId : id; const index = Math.max(0, modules.findIndex(function(item){return item.id === moduleId;})); return ["#8b6cf6","#5577d8","#4aa46c","#ce6764","#d0933a","#41a6bd","#c667a4","#7890ac"][index % 8];}
function shortPath(filePath){const parts = String(filePath || "").split(/[\\\\/]/).filter(Boolean); if(parts.length <= 3)return String(filePath || ""); return ".../" + parts.slice(-3).join("/");}
function badge(kind){return '<span class="badge ' + esc(kind) + '">' + esc(kind) + '</span>';}
function edgeWeight(edge){return edge.weight || 1;}
function incomingSymbol(id){return edges.filter(function(edge){return edge.target === id;}).sort(function(a,b){return edgeWeight(b)-edgeWeight(a);});}
function outgoingSymbol(id){return edges.filter(function(edge){return edge.source === id;}).sort(function(a,b){return edgeWeight(b)-edgeWeight(a);});}
function incomingModule(id){return moduleEdges.filter(function(edge){return edge.target === id;}).sort(function(a,b){return b.weight-a.weight;});}
function outgoingModule(id){return moduleEdges.filter(function(edge){return edge.source === id;}).sort(function(a,b){return b.weight-a.weight;});}
function labelOf(id){const node = nodeById(id); if(node)return node.name; const mod = moduleById(id); return mod ? mod.label : id;}
function nodeCard(title, meta, id, type, color, active){return '<div class="node ' + (active ? 'active' : '') + '" data-id="' + esc(id || '') + '" data-type="' + esc(type || 'symbol') + '" style="border-color:' + esc(color || "#203149") + '"><div class="name">' + esc(title) + '</div><div class="meta">' + meta + '</div></div>';}
function symbolCard(id, weight){const node = nodeById(id); if(!node)return ""; return nodeCard(node.name, badge(node.kind) + '<span>' + esc(shortPath(node.filePath)) + '</span><span class="weight">' + weight + '</span>', node.id, "symbol", colorFor(node.id), false);}
function moduleCard(id, weight){const item = moduleById(id); if(!item)return ""; return nodeCard(item.label, '<span>' + item.symbolCount + ' symbols</span><span class="weight">' + weight + '</span>', item.id, "module", colorFor(item.id), false);}
function empty(a,b){return '<div class="empty"><div>' + esc(a) + '<br>' + esc(b) + '</div></div>';}
function emptyCycleState(){return '<div class="empty"><div><b>No cycles found</b><br>This graph slice has no resolved module loops or symbol recursion.<br><br>A cycle means A calls B, B calls C, and C calls A.</div></div>';}
function guideForMode(){
  if(mode === "Module Overview")return '<div class="guide"><b>How to read</b><span>Module = code area. Symbol = named code item. Counts on caller/callee cards are call edges. Grouped symbol rows collapse repeated indexed ranges.</span></div>';
  if(mode === "Explore Symbols")return '<div class="guide"><b>How to read</b><span>Focused symbol is in the middle. Left calls it. Right is what it calls.</span></div>';
  if(mode === "Hotspots")return '<div class="guide"><b>How to read</b><span>Higher score means more incoming plus outgoing call edges, often more load-bearing.</span></div>';
  if(mode === "Cycles")return '<div class="guide"><b>How to read</b><span>Cycles include module dependency loops and direct or short symbol recursion.</span></div>';
  return '<div class="guide"><b>How to read</b><span>Recent Git movement is shown first; open a change to see affected module, churn, and call context.</span></div>';
}
function groupedSymbolCards(edgeList, pickId, limit){
  const groups = new Map();
  edgeList.forEach(function(edge){const id = pickId(edge); const node = nodeById(id); if(!node)return; const key = node.name + "|" + node.kind + "|" + node.filePath; const group = groups.get(key) || { id:id, count:0 }; group.count += edgeWeight(edge); groups.set(key, group);});
  return [...groups.values()].sort(function(a,b){return b.count-a.count;}).slice(0, limit || groups.size).map(function(group){return symbolCard(group.id, group.count);}).join("");
}
function groupedModuleSymbolRows(symbols){
  const groups = new Map();
  symbols.forEach(function(node){
    const key = node.name + "|" + node.kind + "|" + node.filePath;
    const group = groups.get(key) || { id:node.id, node:node, count:0, minLine:node.line, maxLine:node.line };
    group.count += 1;
    group.minLine = Math.min(group.minLine, node.line);
    group.maxLine = Math.max(group.maxLine, node.line);
    groups.set(key, group);
  });
  return [...groups.values()].map(function(group){
    const lineText = group.minLine === group.maxLine ? "line " + group.minLine : "lines " + group.minLine + "-" + group.maxLine;
    const countText = group.count > 1 ? '<span>x' + group.count + '</span>' : "";
    return '<div class="row" data-id="' + esc(group.id) + '" data-type="symbol"><div class="name">' + esc(group.node.name) + '</div><div class="meta">' + badge(group.node.kind) + '<span>' + esc(shortPath(group.node.filePath)) + '</span><span>' + esc(lineText) + '</span>' + countText + '</div></div>';
  }).join("");
}
function findSymbolCycles(limit){
  const outgoing = new Map();
  edges.forEach(function(edge){if(edge.source === edge.target)return; const list = outgoing.get(edge.source) || []; list.push(edge.target); outgoing.set(edge.source, list);});
  const cycles = [];
  const seen = new Set();
  edges.filter(function(edge){return edge.source === edge.target;}).forEach(function(edge){
    if(!nodeById(edge.source))return;
    seen.add(edge.source + ">" + edge.source);
    cycles.push({ ids:[edge.source], kind:"direct recursion" });
  });
  nodes.some(function(start){
    const stack = [{ id:start.id, path:[start.id] }];
    while(stack.length > 0 && cycles.length < limit){
      const current = stack.pop();
      (outgoing.get(current.id) || []).forEach(function(next){
        if(cycles.length >= limit)return;
        if(next === start.id && current.path.length > 1){
          const key = current.path.slice().sort().join(">");
          if(!seen.has(key)){seen.add(key); cycles.push({ ids:current.path.slice(), kind:"symbol loop" });}
        } else if(current.path.length < 5 && current.path.indexOf(next) === -1) {
          stack.push({ id:next, path:current.path.concat(next) });
        }
      });
    }
    return cycles.length >= limit;
  });
  return cycles.slice(0, limit);
}

function renderTabs(){
  document.getElementById("tabs").innerHTML = modes.map(function(item){return '<button class="tab ' + (item === mode ? 'active' : '') + '" data-mode="' + esc(item) + '">' + esc(item) + '</button>';}).join("");
  document.querySelectorAll("[data-mode]").forEach(function(button){button.onclick = function(){mode = button.dataset.mode || "Changes"; render();};});
  document.getElementById("modeName").textContent = mode;
  document.getElementById("nodeCount").textContent = String(nodes.length);
  document.getElementById("edgeCount").textContent = String(edges.length);
  document.getElementById("changeCount").textContent = String(changes.length);
}
function renderResults(){
  const q = query.toLowerCase();
  const items = changes.map(function(change){return {type:"change",id:change.id,title:change.title,meta:change.source + " | " + change.when + " | " + change.intent,color:change.kind === "risk" ? "#ce6764" : "#8b6cf6"};})
    .concat(modules.map(function(item){return {type:"module",id:item.id,title:item.label,meta:item.symbolCount + " symbols | " + item.category,color:colorFor(item.id)};}))
    .concat(nodes.map(function(node){return {type:"symbol",id:node.id,title:node.name,meta:node.kind + " | " + shortPath(node.filePath),color:colorFor(node.id)};}))
    .filter(function(item){return !q || (item.title + " " + item.meta + " " + item.id).toLowerCase().includes(q);})
    .slice(0, 24);
  document.getElementById("results").innerHTML = items.map(function(item){return '<div class="result" data-id="' + esc(item.id) + '" data-type="' + esc(item.type) + '" style="border-color:' + esc(item.color) + '"><div class="name">' + esc(item.title) + '</div><div class="meta">' + esc(item.meta) + '</div></div>';}).join("") || empty("No matching changes, symbols, or modules", "Try a file, symbol, intent, or risk term");
}
function renderChanges(){
  const active = changes.find(function(change){return change.id === selectedChange;}) || changes[0];
  if(!active){renderHotspots(); return;}
  selectedChange = active.id;
  const focus = active.focusNodeId ? nodeById(active.focusNodeId) : undefined;
  document.getElementById("stage").className = "change-grid";
  document.getElementById("stage").innerHTML = '<section class="change-list"><h2 class="title">Moving lately</h2>' + changes.map(function(change){
    return '<div class="change ' + (change.id === active.id ? 'active' : '') + '" data-change="' + esc(change.id) + '"><div class="change-top"><span class="pill ' + esc(change.kind) + '">' + esc(change.kind) + '</span><span class="meta">' + esc(change.source) + ' | ' + esc(change.when) + '</span></div><div class="name">' + esc(change.title) + '</div><div class="meta">' + esc(change.summary) + '</div></div>';
  }).join("") + '</section><section class="why"><div class="why-card"><div class="change-top"><span class="pill ' + esc(active.kind) + '">' + esc(active.intent) + '</span><span class="meta">' + esc(active.source) + ' | ' + esc(active.when) + '</span></div><h3>' + esc(active.title) + '</h3><p>' + esc(active.why) + '</p><div class="impact"><div><b>' + active.calls + '</b><span>call edges</span></div><div><b>' + active.churn + '</b><span>churn</span></div><div><b>' + esc(active.risk) + '</b><span>risk</span></div></div></div><div class="why-card"><h3>Current touchpoint</h3>' + (focus ? nodeCard(focus.name, badge(focus.kind) + '<span>' + esc(shortPath(focus.filePath)) + '</span>', focus.id, "symbol", colorFor(focus.id), false) : moduleCard(active.moduleId, active.calls)) + '</div><div class="why-card"><h3>Nearest call context</h3><div class="list">' + (focus ? (groupedSymbolCards(incomingSymbol(focus.id), function(edge){return edge.source;}, 3) + groupedSymbolCards(outgoingSymbol(focus.id), function(edge){return edge.target;}, 3)) : empty("No focused symbol", "Open Module Overview")) + '</div></div></section>';
  document.getElementById("hint").textContent = "Temporal default: what changed, why, and which call path it affects.";
  document.getElementById("edges").innerHTML = "";
  document.querySelectorAll("[data-change]").forEach(function(el){el.onclick = function(){selectedChange = el.dataset.change; render();};});
}
function renderSymbol(){
  const symbol = selected.type === "symbol" ? nodeById(selected.id) : nodes.find(function(node){return node.moduleId === selected.id;}) || nodes[0];
  if(!symbol){document.getElementById("stage").innerHTML = empty("No symbols", "Run index_codebase first"); return;}
  selected = {type:"symbol", id:symbol.id};
  const callers = incomingSymbol(symbol.id);
  const callees = outgoingSymbol(symbol.id);
  document.getElementById("stage").className = "flow";
  document.getElementById("stage").innerHTML = '<section class="lane" id="callers"><h3>Callers</h3>' + (groupedSymbolCards(callers, function(edge){return edge.source;}) || empty("No callers", "Entry-level symbol")) + '</section><section class="center">' + nodeCard(symbol.name, badge(symbol.kind) + '<span>' + esc(shortPath(symbol.filePath)) + '</span>', symbol.id, "symbol", colorFor(symbol.id), true) + '</section><section class="lane" id="callees"><h3>Callees</h3>' + (groupedSymbolCards(callees, function(edge){return edge.target;}) || empty("No callees", "Leaf-level symbol")) + '</section>';
  document.getElementById("hint").textContent = "Explore mode: clustered symbol relationships. Focused module view uses the same one-hop navigation.";
  requestAnimationFrame(drawEdges);
}
function renderModule(){
  const item = selected.type === "module" ? moduleById(selected.id) : moduleById((nodeById(selected.id) || {}).moduleId) || modules[0];
  if(!item){document.getElementById("stage").innerHTML = empty("No modules", "Run index_codebase first"); return;}
  selected = {type:"module", id:item.id};
  const callers = incomingModule(item.id);
  const callees = outgoingModule(item.id);
  const internalEdges = edges.filter(function(edge){return nodeById(edge.source)?.moduleId === item.id && nodeById(edge.target)?.moduleId === item.id;});
  const moduleSymbols = nodes.filter(function(node){return node.moduleId === item.id;});
  const leftTitle = callers.length > 0 ? "Incoming modules" : "Internal callers";
  const rightTitle = callees.length > 0 ? "Outgoing modules" : "Internal callees";
  const groupedModuleSymbols = groupedModuleSymbolRows(moduleSymbols);
  const uniqueModuleSymbolCount = (groupedModuleSymbols.match(/class="row"/g) || []).length;
  const leftCards = callers.length > 0 ? callers.map(function(edge){return moduleCard(edge.source, edge.weight);}).join("") : groupedSymbolCards(internalEdges, function(edge){return edge.source;}, 12);
  const rightCards = callees.length > 0 ? callees.map(function(edge){return moduleCard(edge.target, edge.weight);}).join("") : groupedSymbolCards(internalEdges, function(edge){return edge.target;}, 12);
  document.getElementById("stage").className = "module-board";
  document.getElementById("stage").innerHTML = '<section class="module-summary">' + nodeCard(item.label, '<span>' + item.symbolCount + ' indexed symbols</span><span>' + uniqueModuleSymbolCount + ' unique rows</span><span>' + esc(item.category) + '</span>', item.id, "module", colorFor(item.id), true) + '</section><section class="module-lanes"><div class="lane" id="callers"><h3>' + leftTitle + '</h3>' + (leftCards || empty("This slice only has intra-module calls.", "Selected from module list")) + '</div><div class="lane" id="callees"><h3>' + rightTitle + '</h3>' + (rightCards || empty("No calls in this module.", "Selected from module list")) + '</div></section><section class="module-symbols"><h3>Symbols in module (' + uniqueModuleSymbolCount + ' unique, ' + moduleSymbols.length + ' indexed)</h3><div class="list">' + groupedModuleSymbols + '</div></section>';
  document.getElementById("hint").textContent = callers.length + callees.length > 0 ? "Module Overview. Focused module view shows strongest incoming and outgoing module edges." : "Module Overview. This repo slice has no resolved cross-module edges, so this view shows intra-module hotspots.";
  requestAnimationFrame(drawEdges);
}
function renderHotspots(){
  const ranked = nodes.map(function(node){return {node:node, score:incomingSymbol(node.id).length + outgoingSymbol(node.id).length};}).sort(function(a,b){return b.score-a.score;}).slice(0, 20);
  document.getElementById("stage").className = "grid";
  document.getElementById("stage").innerHTML = ranked.map(function(item,index){return '<div class="row" data-id="' + esc(item.node.id) + '" data-type="symbol"><div class="meta"><span class="rank">' + (index + 1) + '</span><span class="weight">' + item.score + ' call edges</span></div><div class="name">' + esc(item.node.name) + '</div><div class="meta">' + badge(item.node.kind) + '<span>' + esc(shortPath(item.node.filePath)) + '</span></div></div>';}).join("") || empty("No hotspots", "No call edges in this slice");
  document.getElementById("hint").textContent = "Hotspots rank symbols by incoming plus outgoing call edges.";
  document.getElementById("edges").innerHTML = "";
}
function renderCycles(){
  const cycles = moduleEdges.filter(function(edge){return moduleEdges.some(function(other){return other.source === edge.target && other.target === edge.source;});});
  const symbolCycles = findSymbolCycles(20);
  document.getElementById("stage").className = "grid";
  const moduleHtml = cycles.map(function(edge){return '<div class="row" data-id="' + esc(edge.source) + '" data-type="module"><div class="name">' + esc(labelOf(edge.source)) + ' -> ' + esc(labelOf(edge.target)) + '</div><div class="meta"><span>module dependency loop candidate</span><span class="weight">' + edge.weight + ' calls</span></div></div>';}).join("");
  const symbolHtml = symbolCycles.map(function(cycle){const start = cycle.ids[0]; const node = nodeById(start); const path = cycle.ids.map(function(id){return labelOf(id);}).join(" -> ") + " -> " + labelOf(start); const countLabel = cycle.ids.length === 1 ? "1 symbol" : cycle.ids.length + " symbols"; return '<div class="row" data-id="' + esc(start) + '" data-type="symbol"><div class="name">' + esc(path) + '</div><div class="meta"><span>' + esc(cycle.kind) + '</span>' + (node ? '<span>' + esc(shortPath(node.filePath)) + '</span>' : '') + '<span class="weight">' + countLabel + '</span></div></div>';}).join("");
  document.getElementById("stage").innerHTML = moduleHtml + symbolHtml || emptyCycleState();
  document.getElementById("hint").textContent = "Cycle mode surfaces module loops plus direct or short symbol recursion.";
  document.getElementById("edges").innerHTML = "";
}
function renderDetails(){
  if(mode === "Changes"){
    const active = changes.find(function(change){return change.id === selectedChange;});
    if(active){document.getElementById("details").innerHTML = guideForMode() + '<div class="name">' + esc(active.title) + '</div><div class="kv"><span>Source</span><b>' + esc(active.source) + '</b></div><div class="kv"><span>Changed</span><b>' + esc(active.when) + '</b></div><div class="kv"><span>Intent</span><b>' + esc(active.intent) + '</b></div><div class="kv"><span>Risk</span><b>' + esc(active.risk) + '</b></div><h2 class="title">Onboarding read</h2><p style="margin:0;color:#6f83a4;font-size:13px;line-height:1.6">' + esc(active.summary) + '</p>'; return;}
  }
  const isSymbol = selected.type === "symbol";
  const item = isSymbol ? nodeById(selected.id) : moduleById(selected.id);
  if(!item){document.getElementById("details").innerHTML = guideForMode(); return;}
  const incoming = isSymbol ? incomingSymbol(selected.id) : incomingModule(selected.id);
  const outgoing = isSymbol ? outgoingSymbol(selected.id) : outgoingModule(selected.id);
  if(!isSymbol){
    const internal = edges.filter(function(edge){const source = nodeById(edge.source); const target = nodeById(edge.target); return source && target && source.moduleId === selected.id && target.moduleId === selected.id;});
    const hasCrossModuleEdges = incoming.length + outgoing.length > 0;
    const edgeCards = hasCrossModuleEdges ? incoming.concat(outgoing).map(function(edge){return moduleCard(edge.source === selected.id ? edge.target : edge.source, edge.weight);}).join("") : groupedSymbolCards(internal, function(edge){return edge.source;}, 4) + groupedSymbolCards(internal, function(edge){return edge.target;}, 4);
    document.getElementById("details").innerHTML = guideForMode() + '<div class="name">' + esc(item.label) + '</div><div class="kv"><span>Kind</span><b>' + esc(item.category) + '</b></div><div class="kv"><span>File/module</span><b>' + esc(item.label) + '</b></div><div class="kv"><span>Symbols</span><b>' + item.symbolCount + '</b></div><div class="kv"><span>' + (hasCrossModuleEdges ? 'Cross-module edges' : 'Internal call edges') + '</span><b>' + (incoming.length + outgoing.length || internal.length) + '</b></div><h2 class="title">Strongest edges</h2><div class="list">' + (edgeCards || empty("No calls in this module.", "Selected from module list")) + '</div>';
    return;
  }
  document.getElementById("details").innerHTML = guideForMode() + '<div class="name">' + esc(item.name) + '</div><div class="kv"><span>Kind</span><b>' + esc(item.kind) + '</b></div><div class="kv"><span>File/module</span><b>' + esc(shortPath(item.filePath)) + '</b></div><div class="kv"><span>Callers</span><b>' + incoming.length + '</b></div><div class="kv"><span>Callees</span><b>' + outgoing.length + '</b></div><h2 class="title">Strongest edges</h2><div class="list">' + groupedSymbolCards(incoming.concat(outgoing), function(edge){return edge.source === selected.id ? edge.target : edge.source;}, 8) + '</div>';
}
function drawEdges(){
  const svg = document.getElementById("edges");
  const stage = document.getElementById("stage");
  const left = document.getElementById("callers");
  const right = document.getElementById("callees");
  const center = document.querySelector(".center .node");
  svg.innerHTML = "";
  if(!left || !right || !center || innerWidth < 901)return;
  const box = stage.getBoundingClientRect();
  svg.setAttribute("viewBox", "0 0 " + box.width + " " + box.height);
  function line(from,to){const a=from.getBoundingClientRect();const b=to.getBoundingClientRect();const x1=a.right-box.left;const y1=a.top+a.height/2-box.top;const x2=b.left-box.left;const y2=b.top+b.height/2-box.top;const mid=(x1+x2)/2;const path=document.createElementNS("http://www.w3.org/2000/svg","path");path.setAttribute("d","M"+x1+","+y1+" C"+mid+","+y1+" "+mid+","+y2+" "+x2+","+y2);path.setAttribute("fill","none");path.setAttribute("stroke","#334966");path.setAttribute("stroke-width","1.5");path.setAttribute("opacity",".65");svg.appendChild(path);}
  left.querySelectorAll(".node").forEach(function(node){line(node, center);});
  right.querySelectorAll(".node").forEach(function(node){line(center, node);});
}
function wireClicks(){
  document.querySelectorAll("[data-id]").forEach(function(el){el.onclick = function(){selected = {type:el.dataset.type, id:el.dataset.id}; if(selected.type === "change"){selectedChange = selected.id; mode = "Changes";} else {mode = selected.type === "module" ? "Module Overview" : "Explore Symbols";} render();};});
}
function render(){
  renderTabs();
  renderResults();
  if(mode === "Changes")renderChanges(); else if(mode === "Module Overview")renderModule(); else if(mode === "Hotspots")renderHotspots(); else if(mode === "Cycles")renderCycles(); else renderSymbol();
  renderDetails();
  wireClicks();
}
document.getElementById("search").addEventListener("input", function(event){query = event.target.value; renderResults(); wireClicks();});
addEventListener("resize", function(){requestAnimationFrame(drawEdges);});
render();
</script>
</body>
</html>`;
}
