// @ts-check
/* CodeSense Project Map: a dependency-free force-directed graph in SVG. */
(function () {
  'use strict';

  // In VS Code this is provided; the stub lets the page run in a plain browser for demos.
  const vscode = typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : { postMessage: (m) => console.log('postMessage', m) };

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svg = /** @type {SVGSVGElement} */ (document.getElementById('graph'));
  const tooltip = /** @type {HTMLElement} */ (document.getElementById('tooltip'));
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

  // ---------- state ----------
  /** @type {any[]} */ let nodes = [];
  /** @type {any[]} */ let edges = [];
  /** @type {Map<string, any>} */ let byId = new Map();
  /** @type {Map<string, Set<string>>} */ let neighbors = new Map();
  /** @type {Map<string, string>} */ let folderColor = new Map();
  let view = { x: 0, y: 0, k: 1 };      // pan/zoom transform
  let alpha = 0;                        // simulation "temperature"
  let running = false;
  let showAllLabels = false;
  let focusSet = /** @type {Set<string>|null} */ (null); // highlighted subset
  let searchTerm = '';

  // ---------- SVG scaffolding ----------
  const defs = el('defs', {}, svg);
  for (const [id, cls] of [['arrow', 'arrow'], ['arrow-red', 'arrow red']]) {
    const m = el('marker', { id, viewBox: '0 -4 8 8', refX: 8, refY: 0, markerWidth: 6, markerHeight: 6, orient: 'auto' }, defs);
    el('path', { d: 'M0,-4L8,0L0,4', class: cls }, m);
  }
  const root = el('g', {}, svg);
  const edgeLayer = el('g', { class: 'edges' }, root);
  const nodeLayer = el('g', { class: 'nodes' }, root);
  const labelLayer = el('g', { class: 'labels' }, root);

  function el(tag, attrs, parent) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) { e.setAttribute(k, String(attrs[k])); }
    if (parent) { parent.appendChild(e); }
    return e;
  }

  // ---------- data in ----------
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.type === 'graph') { load(msg.payload); }
  });

  function load(payload) {
    const old = byId;
    folderColor = assignColors(payload.nodes);

    nodes = payload.nodes.map((n) => {
      const prev = old.get(n.id);
      return Object.assign({}, n, {
        x: prev ? prev.x : NaN, y: prev ? prev.y : NaN, vx: 0, vy: 0,
        r: 5 + Math.sqrt(n.inDeg) * 3.2, fixed: false,
      });
    });
    byId = new Map(nodes.map((n) => [n.id, n]));
    edges = payload.edges
      .filter((e) => byId.has(e.source) && byId.has(e.target))
      .map((e) => ({ source: byId.get(e.source), target: byId.get(e.target), inCycle: e.inCycle }));

    neighbors = new Map(nodes.map((n) => [n.id, new Set()]));
    for (const e of edges) {
      neighbors.get(e.source.id).add(e.target.id);
      neighbors.get(e.target.id).add(e.source.id);
    }

    seedPositions();
    buildDom();
    renderSidebar(payload);
    const fresh = old.size === 0;
    startSimulation(fresh ? 1 : 0.3);
    if (fresh) { setTimeout(fit, 900); }
  }

  /** Place each folder's files around its own point on a circle, so clusters form fast. */
  function seedPositions() {
    const folders = [...new Set(nodes.map((n) => n.folder))];
    const R = 60 + Math.sqrt(nodes.length) * 28;
    folders.forEach((f, i) => {
      const a = (i / folders.length) * Math.PI * 2;
      const cx = Math.cos(a) * R, cy = Math.sin(a) * R;
      for (const n of nodes) {
        if (n.folder === f && Number.isNaN(n.x)) {
          n.x = cx + (Math.random() - 0.5) * 80;
          n.y = cy + (Math.random() - 0.5) * 80;
        }
      }
    });
  }

  function assignColors(list) {
    const counts = new Map();
    for (const n of list) { counts.set(n.folder, (counts.get(n.folder) || 0) + 1); }
    const folders = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
    // Colorblind-friendly qualitative palette (red is reserved for cycles).
    const palette = ['#4e79a7', '#f28e2b', '#59a14f', '#edc948', '#b07aa1',
                     '#76b7b2', '#ff9da7', '#9c755f', '#a0cbe8', '#bab0ac'];
    const map = new Map();
    folders.forEach((f, i) => {
      map.set(f, i < palette.length ? palette[i] : `hsl(${(i * 137.508) % 360} 45% 60%)`);
    });
    return map;
  }

  // ---------- DOM ----------
  function buildDom() {
    edgeLayer.replaceChildren();
    nodeLayer.replaceChildren();
    labelLayer.replaceChildren();

    for (const e of edges) {
      e.dom = el('line', { class: e.inCycle ? 'edge cycle' : 'edge',
        'marker-end': e.inCycle ? 'url(#arrow-red)' : 'url(#arrow)' }, edgeLayer);
    }
    for (const n of nodes) {
      n.dom = el('circle', { r: n.r, class: n.inCycle ? 'node cycle' : 'node', fill: folderColor.get(n.folder) }, nodeLayer);
      n.dom.dataset.id = n.id;
      n.text = el('text', { class: 'label' }, labelLayer);
      n.text.textContent = n.name;
    }
    applyHighlight();
  }

  function draw() {
    root.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
    labelLayer.setAttribute('font-size', (11 / view.k).toFixed(2));
    for (const e of edges) {
      const dx = e.target.x - e.source.x, dy = e.target.y - e.source.y;
      const d = Math.hypot(dx, dy) || 1;
      // Stop the line at the target's edge so the arrowhead is visible.
      const tx = e.target.x - (dx / d) * (e.target.r + 2);
      const ty = e.target.y - (dy / d) * (e.target.r + 2);
      e.dom.setAttribute('x1', e.source.x.toFixed(1));
      e.dom.setAttribute('y1', e.source.y.toFixed(1));
      e.dom.setAttribute('x2', tx.toFixed(1));
      e.dom.setAttribute('y2', ty.toFixed(1));
    }
    for (const n of nodes) {
      n.dom.setAttribute('cx', n.x.toFixed(1));
      n.dom.setAttribute('cy', n.y.toFixed(1));
      n.text.setAttribute('x', n.x.toFixed(1));
      n.text.setAttribute('y', (n.y - n.r - 4 / view.k).toFixed(1));
    }
  }

  // ---------- physics ----------
  function startSimulation(heat) {
    alpha = Math.max(alpha, heat);
    if (!running) { running = true; requestAnimationFrame(tick); }
  }

  function tick() {
    const steps = nodes.length > 400 ? 1 : 2;
    for (let s = 0; s < steps; s++) { step(); }
    draw();
    alpha *= 0.985;
    if (alpha > 0.005) { requestAnimationFrame(tick); } else { running = false; }
  }

  function step() {
    const n = nodes.length;
    const REPULSE = 2600, SPRING = 0.04, LENGTH = 95, CENTER = 0.004, COHESION = 0.012, DAMP = 0.55;

    // Repulsion between all pairs (O(n²); fine for a few hundred files).
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        if (d2 > 250000) { continue; } // ignore pairs > 500px apart
        const f = (REPULSE * alpha) / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
      }
    }
    // Springs along import edges.
    for (const e of edges) {
      const dx = e.target.x - e.source.x, dy = e.target.y - e.source.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = (d - LENGTH) * SPRING * alpha;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      e.source.vx += fx; e.source.vy += fy;
      e.target.vx -= fx; e.target.vy -= fy;
    }
    // Pull each node toward its folder's centroid, and everything toward the center.
    const centroids = new Map();
    for (const node of nodes) {
      const c = centroids.get(node.folder) || { x: 0, y: 0, n: 0 };
      c.x += node.x; c.y += node.y; c.n++;
      centroids.set(node.folder, c);
    }
    for (const node of nodes) {
      const c = centroids.get(node.folder);
      node.vx += (c.x / c.n - node.x) * COHESION * alpha - node.x * CENTER * alpha;
      node.vy += (c.y / c.n - node.y) * COHESION * alpha - node.y * CENTER * alpha;
    }
    for (const node of nodes) {
      if (node.fixed) { node.vx = node.vy = 0; continue; }
      node.vx *= DAMP; node.vy *= DAMP;
      node.x += node.vx; node.y += node.vy;
    }
  }

  // ---------- highlight / search ----------
  function applyHighlight(hoverId) {
    let active = focusSet;
    if (hoverId) { active = new Set([hoverId, ...neighbors.get(hoverId)]); }
    if (!active && searchTerm) {
      active = new Set(nodes.filter(matches).map((n) => n.id));
    }
    const hubIds = new Set([...nodes].sort((a, b) => b.inDeg - a.inDeg).slice(0, 12).map((n) => n.id));
    const smallGraph = nodes.length <= 25;

    for (const n of nodes) {
      const on = !active || active.has(n.id);
      n.dom.classList.toggle('dim', !on);
      n.dom.classList.toggle('active', !!active && active.has(n.id));
      const labelVisible = (showAllLabels || smallGraph || hubIds.has(n.id) || (active && active.has(n.id))) && on;
      n.text.classList.toggle('hidden', !labelVisible);
    }
    for (const e of edges) {
      const on = !active || (active.has(e.source.id) && active.has(e.target.id));
      e.dom.classList.toggle('dim', !on);
      e.dom.classList.toggle('active', !!active && on);
    }
  }

  function matches(n) {
    return n.label.toLowerCase().includes(searchTerm);
  }

  // ---------- interaction ----------
  let drag = /** @type {null | {mode:'pan'|'node', node?:any, sx:number, sy:number, vx:number, vy:number, moved:boolean}} */ (null);

  function toWorld(clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    return { x: (clientX - rect.left - view.x) / view.k, y: (clientY - rect.top - view.y) / view.k };
  }

  svg.addEventListener('pointerdown', (ev) => {
    const target = /** @type {Element} */ (ev.target);
    const id = target instanceof SVGCircleElement ? target.dataset.id : undefined;
    svg.setPointerCapture(ev.pointerId);
    if (id) {
      const node = byId.get(id);
      node.fixed = true;
      drag = { mode: 'node', node, sx: ev.clientX, sy: ev.clientY, vx: 0, vy: 0, moved: false };
    } else {
      drag = { mode: 'pan', sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y, moved: false };
      if (focusSet) { focusSet = null; applyHighlight(); }
    }
  });

  svg.addEventListener('pointermove', (ev) => {
    if (!drag) {
      const target = /** @type {Element} */ (ev.target);
      const id = target instanceof SVGCircleElement ? target.dataset.id : undefined;
      if (id) { showTooltip(byId.get(id), ev); applyHighlight(id); }
      else { tooltip.hidden = true; applyHighlight(); }
      return;
    }
    if (Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) > 3) { drag.moved = true; }
    if (drag.mode === 'pan') {
      view.x = drag.vx + (ev.clientX - drag.sx);
      view.y = drag.vy + (ev.clientY - drag.sy);
      draw();
    } else if (drag.node) {
      const p = toWorld(ev.clientX, ev.clientY);
      drag.node.x = p.x; drag.node.y = p.y;
      tooltip.hidden = true;
      startSimulation(0.15);
    }
  });

  svg.addEventListener('pointerup', () => {
    if (drag && drag.mode === 'node' && drag.node) {
      if (!drag.moved) { vscode.postMessage({ type: 'open', id: drag.node.id }); }
      drag.node.fixed = drag.moved; // keep dragged nodes pinned where you put them
    }
    drag = null;
  });

  svg.addEventListener('pointerleave', () => {
    if (drag) { return; }
    tooltip.hidden = true;
    applyHighlight();
  });

  svg.addEventListener('dblclick', (ev) => {
    // Double-click a node to unpin it.
    const target = /** @type {Element} */ (ev.target);
    const id = target instanceof SVGCircleElement ? target.dataset.id : undefined;
    if (id) { byId.get(id).fixed = false; startSimulation(0.2); }
  });

  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    const k = Math.min(6, Math.max(0.1, view.k * Math.exp(-ev.deltaY * 0.0015)));
    // Zoom around the cursor.
    view.x = mx - ((mx - view.x) * k) / view.k;
    view.y = my - ((my - view.y) * k) / view.k;
    view.k = k;
    draw();
  }, { passive: false });

  function showTooltip(n, ev) {
    const rect = svg.getBoundingClientRect();
    tooltip.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = n.label;
    tooltip.appendChild(title);
    const lines = [
      `${n.lines} lines`,
      `imported by ${n.inDeg} file${n.inDeg === 1 ? '' : 's'}`,
      `imports ${n.outDeg} local file${n.outDeg === 1 ? '' : 's'}`,
    ];
    if (n.roles.length) { lines.push(n.roles.join(', ')); }
    if (n.inCycle) { lines.push('⚠ part of a circular dependency'); }
    for (const l of lines) {
      const div = document.createElement('div');
      div.textContent = l;
      tooltip.appendChild(div);
    }
    tooltip.style.left = `${ev.clientX - rect.left + 14}px`;
    tooltip.style.top = `${ev.clientY - rect.top + 14}px`;
    tooltip.hidden = false;
  }

  function fit() {
    if (!nodes.length) { return; }
    const rect = svg.getBoundingClientRect();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x - n.r); maxX = Math.max(maxX, n.x + n.r);
      minY = Math.min(minY, n.y - n.r); maxY = Math.max(maxY, n.y + n.r);
    }
    const pad = 40;
    const k = Math.min(2, Math.min((rect.width - pad * 2) / (maxX - minX || 1), (rect.height - pad * 2) / (maxY - minY || 1)));
    view.k = k;
    view.x = rect.width / 2 - ((minX + maxX) / 2) * k;
    view.y = rect.height / 2 - ((minY + maxY) / 2) * k;
    draw();
  }

  function focusOn(ids) {
    focusSet = new Set(ids);
    applyHighlight();
    const pts = ids.map((id) => byId.get(id)).filter(Boolean);
    if (!pts.length) { return; }
    const rect = svg.getBoundingClientRect();
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    view.k = Math.max(view.k, 1.2);
    view.x = rect.width / 2 - cx * view.k;
    view.y = rect.height / 2 - cy * view.k;
    draw();
  }

  // ---------- sidebar ----------
  function renderSidebar(p) {
    const cycleText = p.cycles.length ? ` · <span class="bad">${p.cycles.length} cycle${p.cycles.length > 1 ? 's' : ''}</span>` : '';
    $('stats').innerHTML = `${p.nodes.length} files · ${p.edges.length} imports${cycleText}`;

    const legend = $('legend');
    legend.replaceChildren();
    const counts = new Map();
    for (const n of p.nodes) { counts.set(n.folder, (counts.get(n.folder) || 0) + 1); }
    for (const [folder, color] of folderColor) {
      const li = item(legend, `${folder}`, () => focusOn(nodes.filter((n) => n.folder === folder).map((n) => n.id)));
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = color;
      li.prepend(sw);
      const c = document.createElement('span');
      c.className = 'count';
      c.textContent = String(counts.get(folder));
      li.appendChild(c);
    }

    fillList('entries', p.entryPoints.slice(0, 12), (id) => byId.get(id)?.label ?? id, (id) => focusOn([id]), 'None found');
    fillList('hubs', p.hubs, (h) => `${byId.get(h.id)?.label ?? h.id}  (${h.importers})`, (h) => focusOn([h.id, ...neighbors.get(h.id)]), 'None');
    fillList('cycles', p.cycles, (c) => {
      const names = c.map((id) => byId.get(id)?.name ?? id);
      return names.join(' → ') + ' → ' + names[0];
    }, (c) => focusOn(c), '✓ None. Nice!');
    fillList('orphans', p.orphans.slice(0, 15), (id) => byId.get(id)?.label ?? id, (id) => focusOn([id]), 'None');
  }

  function fillList(id, items, text, onClick, empty) {
    const ul = $(id);
    ul.replaceChildren();
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = empty;
      ul.appendChild(li);
      return;
    }
    for (const it of items) { item(ul, text(it), () => onClick(it)); }
  }

  function item(ul, text, onClick) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 'text';
    span.textContent = text;
    span.title = text;
    li.appendChild(span);
    li.addEventListener('click', onClick);
    ul.appendChild(li);
    return li;
  }

  $('fit').addEventListener('click', fit);
  $('labels').addEventListener('click', () => {
    showAllLabels = !showAllLabels;
    $('labels').classList.toggle('on', showAllLabels);
    applyHighlight();
  });
  $('rescan').addEventListener('click', () => vscode.postMessage({ type: 'rescan' }));
  $('search').addEventListener('input', (ev) => {
    searchTerm = /** @type {HTMLInputElement} */ (ev.target).value.trim().toLowerCase();
    focusSet = null;
    applyHighlight();
  });
  window.addEventListener('resize', () => draw());

  vscode.postMessage({ type: 'ready' });
})();
