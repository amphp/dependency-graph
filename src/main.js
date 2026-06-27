import * as d3 from 'd3';
import edgesData from '../data/dependencies.json';
import packageMap from '../data/classes.json';

const nodePackage = (id) => packageMap[id] ?? 'unknown';
const nodeIds = [...new Set(edgesData.flatMap((e) => [e.from, e.to]))];

const packages = [...new Set(nodeIds.map(nodePackage))].sort();
const color = d3.scaleOrdinal(d3.schemeTableau10).domain(packages);

const inDegree = new Map(nodeIds.map((id) => [id, 0]));
for (const { to } of edgesData) inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
const maxIn = Math.max(...inDegree.values());
const radius = (id) => 6 + (inDegree.get(id) / maxIn) * 20;

const nodes = nodeIds.map((id) => ({ id }));

const neighbors = new Map(nodes.map((n) => [n.id, new Set()]));
for (const { from, to } of edgesData) {
  neighbors.get(from)?.add(to);
  neighbors.get(to)?.add(from);
}

// Canvas
const canvas = document.getElementById('graph');
const width = window.innerWidth;
const height = window.innerHeight;
const dpr = window.devicePixelRatio || 1;
canvas.width = width * dpr;
canvas.height = height * dpr;
canvas.style.width = `${width}px`;
canvas.style.height = `${height}px`;
const ctx = canvas.getContext('2d');

// State
let transform = d3.zoomIdentity;
let hoveredNode = null;
let selectedNode = null;
let hoveredPackage = null;
const disabledPackages = new Set();

// Active graph (set by computeLayout)
let activeNodes = [];
let activeLinks = [];       // within-package class edges
let activeCrossEdges = [];  // deduplicated cross-package edges {from: pkg, to: pkg}
let activePkgClasses = new Map(); // pkg -> node[]
let activePkgInfo = new Map();    // pkg -> {cx, cy, r}


function computeLayout() {
  const activeSet = new Set(
    nodes.filter((n) => !disabledPackages.has(nodePackage(n.id))).map((n) => n.id),
  );
  activeNodes = nodes.filter((n) => activeSet.has(n.id));

  // Group classes by package
  activePkgClasses = new Map();
  for (const n of activeNodes) {
    const pkg = nodePackage(n.id);
    if (!activePkgClasses.has(pkg)) activePkgClasses.set(pkg, []);
    activePkgClasses.get(pkg).push(n);
  }

  // --- Level 1: build cross-package edges, reduce transitively, then simulate ---

  // Collect deduplicated cross-package edges
  const seenPkgEdges = new Set();
  for (const { from, to } of edgesData) {
    if (!activeSet.has(from) || !activeSet.has(to)) continue;
    const fp = nodePackage(from), tp = nodePackage(to);
    if (fp !== tp) seenPkgEdges.add(`${fp}\0${tp}`);
  }

  const allCrossEdges = [...seenPkgEdges].map((key) => {
    const i = key.indexOf('\0');
    return { from: key.slice(0, i), to: key.slice(i + 1) };
  });

  // Transitive reduction
  const pkgAdj = new Map([...activePkgClasses.keys()].map((p) => [p, new Set()]));
  for (const { from, to } of allCrossEdges) pkgAdj.get(from)?.add(to);

  activeCrossEdges = allCrossEdges.filter(({ from, to }) => {
    const visited = new Set();
    const stack = [...pkgAdj.get(from)].filter((n) => n !== to);
    while (stack.length) {
      const curr = stack.pop();
      if (curr === to) return false;
      if (!visited.has(curr)) {
        visited.add(curr);
        for (const next of pkgAdj.get(curr) ?? []) stack.push(next);
      }
    }
    return true;
  });

  // --- Level 2 first: run local sims at origin to get true cluster sizes ---
  for (const [pkg, classes] of activePkgClasses) {
    for (const n of classes) { delete n.x; delete n.y; delete n.vx; delete n.vy; }

    const pkgNodeMap = new Map(classes.map((n) => [n.id, n]));
    const localLinks = edgesData
      .filter((e) => pkgNodeMap.has(e.from) && pkgNodeMap.has(e.to))
      .map((e) => ({ source: e.from, target: e.to }));

    const sim = d3.forceSimulation(classes)
      .force('link', d3.forceLink(localLinks).id((d) => d.id).distance(40).strength(0.4))
      .force('charge', d3.forceManyBody().strength(-120))
      .force('x', d3.forceX(0).strength(0.08))
      .force('y', d3.forceY(0).strength(0.08))
      .force('collision', d3.forceCollide().radius((d) => radius(d.id) + 8))
      .stop();

    const ticks = Math.ceil(Math.log(sim.alphaMin()) / Math.log(1 - sim.alphaDecay()));
    for (let i = 0; i < ticks; i++) sim.tick();
  }

  // Measure actual cluster radii and centroids from simulation results
  const trueR = new Map();
  const localCentroid = new Map();
  for (const [pkg, classes] of activePkgClasses) {
    const cx = classes.reduce((s, n) => s + n.x, 0) / classes.length;
    const cy = classes.reduce((s, n) => s + n.y, 0) / classes.length;
    const r = Math.max(...classes.map((n) => Math.hypot(n.x - cx, n.y - cy) + radius(n.id))) + 28;
    trueR.set(pkg, r);
    localCentroid.set(pkg, { cx, cy });
  }

  // --- Level 1: package sim using true cluster radii ---
  const pkgNodeList = [...activePkgClasses.keys()].map((pkg) => ({ id: pkg }));
  const pkgNodeIndex = new Map(pkgNodeList.map((n, i) => [n.id, i]));
  for (const n of pkgNodeList) { delete n.x; delete n.y; delete n.vx; delete n.vy; }

  const pkgLinkList = activeCrossEdges.map(({ from, to }) => ({
    source: pkgNodeIndex.get(from),
    target: pkgNodeIndex.get(to),
  }));

  const pkgSim = d3.forceSimulation(pkgNodeList)
    .force('link', d3.forceLink(pkgLinkList)
      .id((d) => d.index)
      .distance((l) => trueR.get(l.source.id) + trueR.get(l.target.id) + 200))
    .force('charge', d3.forceManyBody()
      .strength((d) => -(trueR.get(d.id) ?? 30) * 14))
    .force('center', d3.forceCenter(0, 0))
    .force('collision', d3.forceCollide()
      .radius((d) => (trueR.get(d.id) ?? 30) + 100))
    .stop();

  const pkgTicks = Math.ceil(Math.log(pkgSim.alphaMin()) / Math.log(1 - pkgSim.alphaDecay()));
  for (let i = 0; i < pkgTicks; i++) pkgSim.tick();

  // Translate local node positions from origin to final package positions
  for (const [pkg, classes] of activePkgClasses) {
    const { cx, cy } = localCentroid.get(pkg);
    const { x: px, y: py } = pkgNodeList[pkgNodeIndex.get(pkg)];
    for (const n of classes) { n.x = n.x - cx + px; n.y = n.y - cy + py; }
  }

  // Within-package class edges only
  const activeNodeMap = new Map(activeNodes.map((n) => [n.id, n]));
  activeLinks = edgesData
    .filter((e) => activeSet.has(e.from) && activeSet.has(e.to)
      && nodePackage(e.from) === nodePackage(e.to))
    .map((e) => ({ source: activeNodeMap.get(e.from), target: activeNodeMap.get(e.to) }));

  // Package centroids and radii from final translated positions
  activePkgInfo = new Map();
  for (const [pkg, classes] of activePkgClasses) {
    const cx = classes.reduce((s, n) => s + n.x, 0) / classes.length;
    const cy = classes.reduce((s, n) => s + n.y, 0) / classes.length;
    const r = Math.max(...classes.map((n) => Math.hypot(n.x - cx, n.y - cy) + radius(n.id))) + 28;
    activePkgInfo.set(pkg, { cx, cy, r });
  }

  fitViewport();
}

function fitViewport() {
  if (activeNodes.length === 0) return;
  const pad = 60;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const d of activeNodes) {
    x0 = Math.min(x0, d.x); y0 = Math.min(y0, d.y);
    x1 = Math.max(x1, d.x); y1 = Math.max(y1, d.y);
  }
  const fitScale = Math.min((width - pad * 2) / (x1 - x0), (height - pad * 2) / (y1 - y0));
  const fitX = (width - (x0 + x1) * fitScale) / 2;
  const fitY = (height - (y0 + y1) * fitScale) / 2;
  sel.call(zoom.transform, d3.zoomIdentity.translate(fitX, fitY).scale(fitScale));
}

function drawHull(pkg, pkgNodes, depthMap, upstreamPkgs) {
  if (pkgNodes.length === 0) return;
  const info = activePkgInfo.get(pkg);
  if (!info) return;

  const isHovered = hoveredPackage === pkg;
  const depth = depthMap.get(pkg);
  const isDep = depth !== undefined;
  const isUpstream = upstreamPkgs.has(pkg);
  const isDimmed = selectedNode ? true
    : hoveredPackage ? (!isHovered && !isDep && !isUpstream) : false;

  ctx.fillStyle = color(pkg);
  ctx.strokeStyle = color(pkg);
  ctx.globalAlpha = isDimmed ? 0.03 : 0.1;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(info.cx, info.cy, info.r, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = isDimmed ? 0.06 : 0.25;
  ctx.stroke();

  if (isHovered || isDep) {
    ctx.globalAlpha = isHovered ? 0.8 : 0.8 * (0.75 ** depth);
    ctx.strokeStyle = color(pkg);
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(info.cx, info.cy, info.r + 6, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  if (isUpstream) {
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = color(pkg);
    ctx.lineWidth = 5;
    ctx.setLineDash([8, 5]);
    ctx.beginPath(); ctx.arc(info.cx, info.cy, info.r + 6, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
}

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.translate(transform.x, transform.y);
  ctx.scale(transform.k, transform.k);

  // BFS from hoveredPackage along outgoing edges to get transitive dep depths
  const depthMap = new Map();   // dep pkg → BFS depth
  const upstreamPkgs = new Set(); // packages that directly depend on hoveredPackage
  if (hoveredPackage) {
    const adj = new Map([...activePkgClasses.keys()].map((p) => [p, []]));
    for (const { from, to } of activeCrossEdges) adj.get(from)?.push(to);
    const queue = [[hoveredPackage, 0]];
    const visited = new Set([hoveredPackage]);
    while (queue.length) {
      const [pkg, depth] = queue.shift();
      for (const next of adj.get(pkg) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          depthMap.set(next, depth + 1);
          queue.push([next, depth + 1]);
        }
      }
    }
    for (const { from, to } of activeCrossEdges) {
      if (to === hoveredPackage) upstreamPkgs.add(from);
    }
  }

  // Package hulls (drawn first, behind everything)
  for (const [pkg, pkgNodes] of activePkgClasses) drawHull(pkg, pkgNodes, depthMap, upstreamPkgs);

  // Cross-package edges (package → package, drawn between cluster boundaries)
  for (const { from, to } of activeCrossEdges) {
    const src = activePkgInfo.get(from), tgt = activePkgInfo.get(to);
    if (!src || !tgt) continue;

    const srcDepth = from === hoveredPackage ? 0 : (depthMap.get(from) ?? -1);
    const tgtDepth = to === hoveredPackage ? 0 : (depthMap.get(to) ?? -1);
    const isDepEdge = srcDepth >= 0 && tgtDepth >= 0;
    const isUpstreamEdge = upstreamPkgs.has(from) && to === hoveredPackage;
    const alpha = selectedNode ? 0.1
      : hoveredPackage
        ? (isDepEdge ? Math.max(0.2, 0.9 * (0.6 ** srcDepth))
          : isUpstreamEdge ? 0.55 : 0.05)
        : 0.45;

    const dx = tgt.cx - src.cx, dy = tgt.cy - src.cy;
    const len = Math.hypot(dx, dy);
    if (len < 1 || len < src.r + tgt.r) continue;

    // Offset connection points around each circle so the bezier handles
    // point outward along the radius — curve exits/enters at 90° to the border
    const baseAngle = Math.atan2(dy, dx);
    const δ = 0.4; // radians offset (~23°)

    const srcAngle = baseAngle - δ;
    const sx = src.cx + Math.cos(srcAngle) * src.r;
    const sy = src.cy + Math.sin(srcAngle) * src.r;

    const tgtAngle = baseAngle + Math.PI + δ;
    const ex = tgt.cx + Math.cos(tgtAngle) * tgt.r;
    const ey = tgt.cy + Math.sin(tgtAngle) * tgt.r;

    // h must be based on the gap between connection points (not len) to prevent
    // the handles from crossing each other and causing loops on short edges.
    const dist = Math.hypot(ex - sx, ey - sy);
    if (dist < 5) continue;
    const h = Math.min(dist * 0.45, 200);
    const cp1x = sx + Math.cos(srcAngle) * h;
    const cp1y = sy + Math.sin(srcAngle) * h;
    const cp2x = ex + Math.cos(tgtAngle) * h;
    const cp2y = ey + Math.sin(tgtAngle) * h;

    // Arrowhead along inward radial at target connection point
    const tax = -Math.cos(tgtAngle), tay = -Math.sin(tgtAngle);
    const arrowLen = 36, arrowHalf = 18;
    const bx = ex - tax * arrowLen, by = ey - tay * arrowLen;

    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color(from);
    ctx.fillStyle = color(from);
    ctx.lineWidth = (isDepEdge || isUpstreamEdge) ? 7 : 5;

    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, bx, by);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(bx - tay * arrowHalf, by + tax * arrowHalf);
    ctx.lineTo(bx + tay * arrowHalf, by - tax * arrowHalf);
    ctx.closePath(); ctx.fill();
  }

  // Within-package class edges
  const activeNode = selectedNode ?? hoveredNode?.id ?? null;
  for (const l of activeLinks) {
    const srcPkg = nodePackage(l.source.id);
    const connected = activeNode &&
      (l.source.id === activeNode || l.target.id === activeNode);
    const alpha = activeNode
      ? (connected ? 0.9 : 0.04)
      : hoveredPackage ? 0.04 : 0.25;

    const sx = l.source.x, sy = l.source.y;
    const tx = l.target.x, ty = l.target.y;
    const dx = tx - sx, dy = ty - sy;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) continue;
    const ux = dx / len, uy = dy / len;
    const tr = radius(l.target.id);
    if (len < tr) continue;

    const ex = tx - ux * tr, ey = ty - uy * tr;
    const arrowLen = 7, arrowHalf = 3.5;
    const bx = ex - ux * arrowLen, by = ey - uy * arrowLen;

    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color(srcPkg);
    ctx.fillStyle = color(srcPkg);
    ctx.lineWidth = connected ? 1.5 : 1;

    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(bx - uy * arrowHalf, by + ux * arrowHalf);
    ctx.lineTo(bx + uy * arrowHalf, by - ux * arrowHalf);
    ctx.closePath(); ctx.fill();
  }

  // Nodes
  for (const n of activeNodes) {
    const pkg = nodePackage(n.id);
    const r = radius(n.id);
    const isHovered = hoveredNode === n;
    const isDimmed = activeNode
      ? (n.id !== activeNode && !neighbors.get(activeNode)?.has(n.id))
      : hoveredPackage ? pkg !== hoveredPackage : false;

    ctx.globalAlpha = isDimmed ? 0.15 : 1;

    if (isHovered) {
      ctx.beginPath(); ctx.arc(n.x, n.y, r + 5, 0, Math.PI * 2);
      ctx.strokeStyle = color(pkg); ctx.lineWidth = 4;
      ctx.globalAlpha = 0.8; ctx.stroke();
      ctx.globalAlpha = isDimmed ? 0.15 : 1;
    }

    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color(pkg); ctx.fill();
    ctx.strokeStyle = '#0f1117'; ctx.lineWidth = 1.5; ctx.stroke();
  }

  ctx.globalAlpha = 1;

  // Package name labels in screen space for hovered + next-hop packages
  if (hoveredPackage) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    const toScreen = (wx, wy) => [
      wx * transform.k + transform.x,
      wy * transform.k + transform.y,
    ];

    const pad = 5;
    for (const pkg of [...depthMap.keys(), ...upstreamPkgs]) {
      const info = activePkgInfo.get(pkg);
      if (!info) continue;
      const depth = depthMap.get(pkg) ?? 0;
      const isUpstream = upstreamPkgs.has(pkg);
      // Minimum 0.65 so contrast never falls below readable regardless of decay
      const textAlpha = Math.max(0.65, isUpstream ? 0.7 : 0.9 * (0.75 ** depth));
      const [sx, sy] = toScreen(info.cx, info.cy - info.r - 32);
      const label = pkg.replace('amphp/', '');
      const w = ctx.measureText(label).width;

      // Dark background pill for guaranteed contrast surface
      ctx.globalAlpha = textAlpha * 0.85;
      ctx.fillStyle = '#0f1117';
      ctx.beginPath();
      ctx.roundRect(sx - w / 2 - pad, sy - 13 - pad, w + pad * 2, 13 + pad * 2, 4);
      ctx.fill();

      ctx.globalAlpha = textAlpha;
      ctx.fillStyle = color(pkg);
      ctx.fillText(label, sx, sy);
    }
    ctx.globalAlpha = 1;
  }
}

// Zoom
const zoom = d3.zoom()
  .scaleExtent([0.1, 8])
  .on('zoom', (event) => { transform = event.transform; draw(); });

const sel = d3.select(canvas);
sel.call(zoom);

function hitTest(event) {
  const [mx, my] = d3.pointer(event);
  const sx = (mx - transform.x) / transform.k;
  const sy = (my - transform.y) / transform.k;
  for (let i = activeNodes.length - 1; i >= 0; i--) {
    const n = activeNodes[i];
    if ((sx - n.x) ** 2 + (sy - n.y) ** 2 <= radius(n.id) ** 2) return n;
  }
  return null;
}

function hitTestPackage(event) {
  const [mx, my] = d3.pointer(event);
  const sx = (mx - transform.x) / transform.k;
  const sy = (my - transform.y) / transform.k;
  for (const [pkg, info] of activePkgInfo) {
    if ((sx - info.cx) ** 2 + (sy - info.cy) ** 2 <= info.r ** 2) return pkg;
  }
  return null;
}

const tooltip = document.getElementById('tooltip');

sel.on('mousemove', (event) => {
  const hit = hitTest(event);
  const hitPkg = hit ? null : hitTestPackage(event);

  if (hit !== hoveredNode) { hoveredNode = hit; draw(); }

  const newHoveredPackage = hit ? nodePackage(hit.id) : (hitPkg ?? null);
  if (newHoveredPackage !== hoveredPackage) {
    hoveredPackage = newHoveredPackage;
    draw();
  }

  if (hit) {
    tooltip.style.opacity = 1;
    tooltip.textContent = hit.id;
    tooltip.style.left = `${event.clientX + 12}px`;
    tooltip.style.top = `${event.clientY - 8}px`;
  } else if (hitPkg) {
    tooltip.style.opacity = 1;
    tooltip.textContent = hitPkg;
    tooltip.style.left = `${event.clientX + 12}px`;
    tooltip.style.top = `${event.clientY - 8}px`;
  } else {
    tooltip.style.opacity = 0;
  }
  canvas.style.cursor = (hit || hitPkg) ? 'pointer' : 'default';
});

sel.on('mouseleave', () => {
  hoveredNode = null;
  hoveredPackage = null;
  tooltip.style.opacity = 0;
  draw();
});

sel.on('click', (event) => {
  const hit = hitTest(event);
  selectedNode = hit?.id !== selectedNode ? hit?.id ?? null : null;
  draw();
});

// Initial layout
computeLayout();

// Legend
const legend = d3.select('#legend');
legend.append('h3').text('Package');
packages.forEach((pkg) => {
  const item = legend.append('div').attr('class', 'legend-item');
  item.append('div').attr('class', 'legend-swatch').style('background', color(pkg));
  const label = item.append('span').text(pkg);

  const syncStyle = () => {
    const off = disabledPackages.has(pkg);
    item.style('opacity', off ? 0.35 : 1);
    label.style('text-decoration', off ? 'line-through' : 'none');
  };
  syncStyle();

  item.style('cursor', 'pointer')
    .on('mouseover', () => {
      if (disabledPackages.has(pkg)) return;
      hoveredPackage = pkg; draw();
    })
    .on('mouseout', () => {
      if (hoveredPackage === pkg) { hoveredPackage = null; draw(); }
    })
    .on('click', () => {
      if (disabledPackages.has(pkg)) {
        disabledPackages.delete(pkg);
      } else {
        disabledPackages.add(pkg);
        if (hoveredPackage === pkg) hoveredPackage = null;
        if (selectedNode && nodePackage(selectedNode) === pkg) selectedNode = null;
      }
      syncStyle();
      computeLayout();
      draw();
    });
});
