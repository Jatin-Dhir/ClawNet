/**
 * The topology scene: this node at the centre, every other node on a shell whose radius is
 * its hop count from here, links drawn with their advertised cost, and packet events shown
 * on the edges they concern.
 *
 * It is imperative on purpose: React hands it a topology and packet events and never
 * re-renders per frame. Everything is batched for size: nodes are one InstancedMesh, links
 * two LineSegments, packets one Points cloud, so a hundred nodes cost a handful of draw
 * calls. The loop only runs while something moves (layout settling, damping, packets) and
 * never while the page or the canvas is hidden.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PACKET_KINDS } from './kinds.js';


const SHELL = 7;
const SELF_COLOR = new THREE.Color('#f2a65a');
const NODE_LINKED = new THREE.Color('#dfe7f0');
const NODE_REACHABLE = new THREE.Color('#8e9aa8');
const NODE_UNREACHABLE = new THREE.Color('#47505c');
const LINK_SELF = new THREE.Color('#9fb0c2');
const LINK_NEAR = new THREE.Color('#6d7d8e');
const LINK_FAR = new THREE.Color('#3a4652');
const SHELL_COLOR = new THREE.Color('#1f2833');
const MAX_PULSES = 384;
const SEGMENT_MS = 420;
const FLASH_MS = 700;
const LABEL_ALL_NODES = 40;
const LABEL_ALL_LINKS = 60;
const REST_LENGTH = 5.5;

/** True when this browser can give us a WebGL context at all. */
export function webglAvailable() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function dotTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  const gradient = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.9)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gradient;
  g.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

export class TopologyScene {
  #container;
  #hooks;
  #reduced;
  #renderer;
  #scene = new THREE.Scene();
  #camera;
  #controls;
  #overlay;
  #raf = 0;
  #disposed = false;
  #pageVisible = !document.hidden;
  #onScreen = true;
  #heat = 0;
  #fitted = false;
  #userMoved = false;
  #fitRadius = 0;
  #width = 0;
  #height = 0;
  #mid = new THREE.Vector3();
  #labelState = new WeakMap();
  #nodes = new Map();
  #order = [];
  #links = [];
  #linkByPair = new Map();
  #selfId = null;
  #maxHops = 1;
  #hasUnreachable = false;
  #shellKey = '';
  #selected = null;
  #hovered = null;
  #nodeMesh;
  #nodeCapacity = 0;
  #nodeGeometry = new THREE.SphereGeometry(0.42, 20, 14);
  #nodeMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
  #selfMesh;
  #selfHalo;
  #selectRing;
  #hoverRing;
  #shellGroup = new THREE.Group();
  #shellLabels = [];
  #linkLines;
  #halfLines;
  #linkCapacity = 0;
  #pulses = [];
  #points;
  #dot = dotTexture();
  #down = null;
  #observers = [];
  #listeners = [];
  #flashTimer = 0;
  #tmpMatrix = new THREE.Matrix4();
  #tmpVec = new THREE.Vector3();
  #tmpColor = new THREE.Color();

  /**
   * @param {{ container: HTMLElement, reducedMotion: boolean,
   *   onSelect: (id: string | null) => void, onHover: (id: string | null) => void,
   *   onContextLost: () => void }} options
   */
  constructor({ container, reducedMotion, onSelect, onHover, onContextLost }) {
    this.#container = container;
    this.#reduced = reducedMotion;
    this.#hooks = { onSelect, onHover, onContextLost };

    this.#renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
    this.#renderer.setClearColor('#080b10', 1);
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const canvas = this.#renderer.domElement;
    canvas.className = 'topo-canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Network map. Drag or use the arrow keys to rotate, plus and minus to zoom. The list view shows the same data as text.');
    container.appendChild(canvas);

    this.#overlay = document.createElement('div');
    this.#overlay.className = 'topo-overlay';
    this.#overlay.setAttribute('aria-hidden', 'true');
    container.appendChild(this.#overlay);

    this.#camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
    this.#camera.position.set(0, 14, 26);

    this.#controls = new OrbitControls(this.#camera, canvas);
    this.#controls.enableDamping = !reducedMotion;
    this.#controls.dampingFactor = 0.12;
    this.#controls.enablePan = false;
    this.#controls.minDistance = 4;
    this.#controls.maxDistance = 600;
    this.#controls.addEventListener('change', () => this.#request());
    // Once the operator has moved the camera, the map stops re-framing itself.
    this.#controls.addEventListener('start', () => {
      this.#userMoved = true;
    });

    this.#scene.add(new THREE.HemisphereLight(0xe6edf5, 0x0b0f14, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 0.8);
    key.position.set(10, 20, 14);
    this.#scene.add(key);
    this.#scene.add(this.#shellGroup);

    this.#selfMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.72, 2), new THREE.MeshLambertMaterial({ color: SELF_COLOR, emissive: SELF_COLOR, emissiveIntensity: 0.35 }));
    this.#selfMesh.visible = false;
    this.#scene.add(this.#selfMesh);
    this.#selfHalo = new THREE.Mesh(new THREE.RingGeometry(1.05, 1.17, 48), new THREE.MeshBasicMaterial({ color: SELF_COLOR, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
    this.#selfHalo.visible = false;
    this.#scene.add(this.#selfHalo);
    this.#selectRing = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.8, 40), new THREE.MeshBasicMaterial({ color: 0xe6edf5, side: THREE.DoubleSide, depthWrite: false, transparent: true }));
    this.#selectRing.visible = false;
    this.#scene.add(this.#selectRing);
    this.#hoverRing = new THREE.Mesh(new THREE.RingGeometry(0.66, 0.71, 40), new THREE.MeshBasicMaterial({ color: 0x8e9aa8, side: THREE.DoubleSide, depthWrite: false, transparent: true, opacity: 0.8 }));
    this.#hoverRing.visible = false;
    this.#scene.add(this.#hoverRing);

    this.#growNodes(64);
    this.#growLinks(128);

    const pulseGeometry = new THREE.BufferGeometry();
    pulseGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PULSES * 3), 3).setUsage(THREE.DynamicDrawUsage));
    pulseGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_PULSES * 3), 3).setUsage(THREE.DynamicDrawUsage));
    pulseGeometry.setDrawRange(0, 0);
    this.#points = new THREE.Points(pulseGeometry, new THREE.PointsMaterial({ size: 0.62, map: this.#dot, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }));
    this.#points.frustumCulled = false;
    this.#scene.add(this.#points);

    this.#listen(canvas, 'pointerdown', (e) => {
      this.#down = { x: e.clientX, y: e.clientY };
    });
    this.#listen(canvas, 'pointerup', (e) => {
      const down = this.#down;
      this.#down = null;
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      this.#hooks.onSelect(this.#pick(e));
    });
    this.#listen(canvas, 'pointermove', (e) => {
      if (this.#down) return;
      const id = this.#pick(e);
      if (id !== this.#hovered) {
        this.#hovered = id;
        canvas.style.cursor = id ? 'pointer' : '';
        this.#hooks.onHover(id);
        this.#request();
      }
    });
    this.#listen(canvas, 'pointerleave', () => {
      if (this.#hovered !== null) {
        this.#hovered = null;
        this.#hooks.onHover(null);
        this.#request();
      }
    });
    this.#listen(canvas, 'keydown', (e) => this.#onKey(e));
    this.#listen(canvas, 'webglcontextlost', (e) => {
      e.preventDefault();
      this.#hooks.onContextLost();
    });
    this.#listen(document, 'visibilitychange', () => {
      this.#pageVisible = !document.hidden;
      this.#request();
    });

    const resize = new ResizeObserver(() => this.#resize());
    resize.observe(container);
    const seen = new IntersectionObserver((entries) => {
      this.#onScreen = entries.some((entry) => entry.isIntersecting);
      this.#request();
    });
    seen.observe(container);
    this.#observers.push(resize, seen);
    this.#resize();
  }

  /** Replace the graph with GET /topology's shape (nodes, links, self). */
  setGraph(topology) {
    if (this.#disposed) return;
    const selfId = topology.self;
    this.#selfId = selfId;
    let maxHops = 1;
    for (const node of topology.nodes) if (node.reachable && typeof node.hops === 'number') maxHops = Math.max(maxHops, node.hops);
    this.#maxHops = maxHops;
    this.#hasUnreachable = topology.nodes.some((node) => node.id !== selfId && !node.reachable);

    const incoming = new Set();
    const neighbours = new Map();
    for (const link of topology.links) {
      if (!neighbours.has(link.a)) neighbours.set(link.a, []);
      if (!neighbours.has(link.b)) neighbours.set(link.b, []);
      neighbours.get(link.a).push(link.b);
      neighbours.get(link.b).push(link.a);
    }
    let changed = false;
    for (const info of topology.nodes) {
      incoming.add(info.id);
      const isSelf = info.id === selfId;
      const target = isSelf ? 0 : (info.reachable && typeof info.hops === 'number' ? info.hops : maxHops + 1) * SHELL;
      let node = this.#nodes.get(info.id);
      if (!node) {
        const anchor = (neighbours.get(info.id) ?? []).map((id) => this.#nodes.get(id)).find(Boolean);
        const pos = new THREE.Vector3();
        if (!isSelf) {
          if (anchor) pos.copy(anchor.pos).add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(3));
          if (pos.lengthSq() < 0.01) pos.set(Math.random() - 0.5, (Math.random() - 0.5) * 0.6, Math.random() - 0.5);
          pos.setLength(target);
        }
        node = { id: info.id, pos, vel: new THREE.Vector3(), label: this.#makeLabel('topo-label') };
        this.#nodes.set(info.id, node);
        changed = true;
      }
      if (node.target !== target) changed = true;
      Object.assign(node, { short: info.shortId ?? info.id.slice(0, 8), self: isSelf, linked: info.linked, reachable: info.reachable, hops: info.hops, target });
      node.label.textContent = isSelf ? `${node.short}  this node` : node.short;
      node.label.classList.toggle('is-self', isSelf);
      node.label.classList.toggle('is-dim', !info.reachable && !isSelf);
    }
    for (const [id, node] of this.#nodes) {
      if (!incoming.has(id)) {
        node.label.remove();
        this.#nodes.delete(id);
        changed = true;
      }
    }
    this.#order = [...this.#nodes.values()].filter((n) => !n.self);

    const oldLinks = this.#linkByPair;
    this.#linkByPair = new Map();
    this.#links = [];
    for (const info of topology.links) {
      if (!this.#nodes.has(info.a) || !this.#nodes.has(info.b)) continue;
      const key = pairKey(info.a, info.b);
      const previous = oldLinks.get(key);
      const link = previous ?? { key, label: this.#makeLabel('topo-cost'), flash: null };
      if (!previous) changed = true;
      Object.assign(link, { a: info.a, b: info.b, costAB: info.costAB, costBA: info.costBA, state: info.state });
      const costs = [info.costAB, info.costBA].filter((c) => typeof c === 'number');
      const text = costs.length === 2 && costs[0] !== costs[1] ? `${costs[0]}/${costs[1]}` : `${costs[0] ?? '?'}`;
      link.label.textContent = info.state === 'half' ? `${text} half` : text;
      link.cost = costs.length ? Math.min(...costs) : null;
      this.#links.push(link);
      this.#linkByPair.set(key, link);
    }
    for (const [key, link] of oldLinks) if (!this.#linkByPair.has(key)) link.label.remove();

    if (this.#nodes.size > this.#nodeCapacity) this.#growNodes(Math.max(this.#nodes.size, this.#nodeCapacity * 2));
    if (this.#links.length > this.#linkCapacity) this.#growLinks(Math.max(this.#links.length, this.#linkCapacity * 2));
    this.#buildShells();
    this.#colorNodes();
    if (changed) {
      this.#heat = 1;
      if (this.#reduced) this.#settle();
    }
    const radius = (this.#maxHops + (this.#hasUnreachable ? 1 : 0)) * SHELL;
    if (this.#nodes.size > 0 && (!this.#fitted || (!this.#userMoved && radius !== this.#fitRadius))) {
      this.resetView();
      this.#fitted = true;
    }
    this.#writeNodes();
    this.#request();
  }

  /** Move the camera so that every shell is in view. */
  resetView() {
    this.#fitRadius = (this.#maxHops + (this.#hasUnreachable ? 1 : 0)) * SHELL;
    this.#userMoved = false;
    const radius = this.#fitRadius + 3;
    const distance = radius / Math.tan(THREE.MathUtils.degToRad(this.#camera.fov / 2)) * 0.95;
    this.#camera.position.set(0, distance * 0.55, distance * 0.84);
    this.#controls.target.set(0, 0, 0);
    this.#controls.update();
    this.#request();
  }

  /** @param {string | null} id */
  select(id) {
    this.#selected = id;
    this.#request();
  }

  /**
   * Show a packet event: a dot that travels `route` (node ids, one hop per segment).
   * `hold` keeps it at the last node (queued, dropped); `dimAfter` dims it from that
   * segment on (a predicted path, not an observed one).
   */
  pulse(kind, route, { hold = 0, dimAfter = Infinity } = {}) {
    if (this.#disposed || route.length === 0) return;
    const color = new THREE.Color(PACKET_KINDS[kind] ?? '#ffffff');
    const now = performance.now();
    for (let i = 0; i + 1 < route.length && i < Math.min(route.length - 1, dimAfter); i++) {
      const link = this.#linkByPair.get(pairKey(route[i], route[i + 1]));
      // With reduced motion every edge of the route lights at once instead of in sequence.
      const start = this.#reduced ? now : now + i * SEGMENT_MS;
      if (link) link.flash = { color, start, until: start + FLASH_MS };
    }
    if (this.#reduced) {
      // No travelling dots: the edges hold their colour for a moment, then return.
      clearTimeout(this.#flashTimer);
      this.#flashTimer = setTimeout(() => this.#request(), FLASH_MS + 20);
      this.#request();
      return;
    }
    if (this.#pulses.length >= MAX_PULSES) this.#pulses.shift();
    this.#pulses.push({ route, t0: now, hold, dimAfter, color, kind });
    this.#request();
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    cancelAnimationFrame(this.#raf);
    clearTimeout(this.#flashTimer);
    for (const observer of this.#observers) observer.disconnect();
    for (const [target, type, fn] of this.#listeners) target.removeEventListener(type, fn);
    this.#controls.dispose();
    this.#scene.traverse((object) => {
      object.geometry?.dispose();
      const material = object.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
    });
    this.#nodeGeometry.dispose();
    this.#nodeMaterial.dispose();
    this.#dot.dispose();
    this.#renderer.dispose();
    this.#renderer.forceContextLoss();
    this.#renderer.domElement.remove();
    this.#overlay.remove();
    this.#nodes.clear();
    this.#links = [];
    this.#pulses = [];
  }

  // ---------------------------------------------------------------- internals

  #listen(target, type, fn) {
    target.addEventListener(type, fn);
    this.#listeners.push([target, type, fn]);
  }

  #makeLabel(className) {
    const el = document.createElement('div');
    el.className = className;
    this.#overlay.appendChild(el);
    return el;
  }

  #resize() {
    const width = this.#container.clientWidth;
    const height = this.#container.clientHeight;
    if (width === 0 || height === 0) return;
    this.#width = width;
    this.#height = height;
    this.#renderer.setSize(width, height, false);
    this.#camera.aspect = width / height;
    this.#camera.updateProjectionMatrix();
    this.#request();
  }

  #request() {
    if (this.#raf || this.#disposed || !this.#pageVisible || !this.#onScreen) return;
    this.#raf = requestAnimationFrame((t) => this.#frame(t));
  }

  #frame(now) {
    this.#raf = 0;
    if (this.#disposed || !this.#pageVisible || !this.#onScreen) return;
    let active = false;
    if (this.#heat > 0) {
      this.#tick();
      this.#tick();
      this.#writeNodes();
      active = this.#heat > 0;
    }
    if (this.#controls.update()) active = true;
    if (this.#writePulses(now)) active = true;
    if (this.#writeLinks(now)) active = true;
    this.#placeMarkers();
    this.#renderer.render(this.#scene, this.#camera);
    this.#placeLabels();
    if (active) this.#request();
  }

  /** One step of a force layout constrained to hop shells; self stays at the origin. */
  #tick() {
    const nodes = this.#order;
    const n = nodes.length;
    const heat = this.#heat;
    for (const node of nodes) node.force = node.force ?? new THREE.Vector3();
    for (const node of nodes) node.force.set(0, 0, 0);
    const d = this.#tmpVec;
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        d.subVectors(a.pos, b.pos);
        const dist2 = Math.max(d.lengthSq(), 0.04);
        d.multiplyScalar(26 / (dist2 * Math.sqrt(dist2)));
        a.force.add(d);
        b.force.sub(d);
      }
    }
    for (const link of this.#links) {
      const a = this.#nodes.get(link.a);
      const b = this.#nodes.get(link.b);
      if (!a || !b) continue;
      d.subVectors(b.pos, a.pos);
      const dist = Math.max(d.length(), 0.01);
      d.multiplyScalar(((dist - REST_LENGTH) * 0.06) / dist);
      if (!a.self) a.force.add(d);
      if (!b.self) b.force.sub(d);
    }
    for (const node of nodes) {
      node.vel.add(node.force.clampLength(0, 2)).multiplyScalar(0.55);
      node.pos.addScaledVector(node.vel, heat);
      // Keep each node near its hop ring: a little height is allowed so crossing links
      // separate, but the distance from this node stays its hop count.
      const maxY = node.target * 0.2;
      node.pos.y = Math.max(-maxY, Math.min(maxY, node.pos.y * 0.9));
      let h = Math.hypot(node.pos.x, node.pos.z);
      if (h < 0.01) {
        node.pos.x = Math.random() - 0.5;
        node.pos.z = Math.random() - 0.5;
        h = Math.hypot(node.pos.x, node.pos.z);
      }
      const want = Math.sqrt(Math.max(node.target * node.target - node.pos.y * node.pos.y, 0.01));
      const k = (h + (want - h) * 0.35) / h;
      node.pos.x *= k;
      node.pos.z *= k;
    }
    this.#heat = heat * 0.975;
    if (this.#heat < 0.03) this.#heat = 0;
  }

  #settle() {
    for (let i = 0; i < 400 && this.#heat > 0; i++) this.#tick();
    this.#heat = 0;
  }

  #growNodes(capacity) {
    if (this.#nodeMesh) {
      this.#scene.remove(this.#nodeMesh);
      this.#nodeMesh.dispose();
    }
    this.#nodeCapacity = capacity;
    this.#nodeMesh = new THREE.InstancedMesh(this.#nodeGeometry, this.#nodeMaterial, capacity);
    this.#nodeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#nodeMesh.count = 0;
    this.#nodeMesh.frustumCulled = false;
    this.#scene.add(this.#nodeMesh);
  }

  #growLinks(capacity) {
    for (const lines of [this.#linkLines, this.#halfLines]) {
      if (lines) {
        this.#scene.remove(lines);
        lines.geometry.dispose();
        lines.material.dispose();
      }
    }
    this.#linkCapacity = capacity;
    const make = (material) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 6), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(capacity * 6), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setDrawRange(0, 0);
      const lines = new THREE.LineSegments(geometry, material);
      lines.frustumCulled = false;
      this.#scene.add(lines);
      return lines;
    };
    this.#linkLines = make(new THREE.LineBasicMaterial({ vertexColors: true }));
    this.#halfLines = make(new THREE.LineDashedMaterial({ vertexColors: true, dashSize: 0.35, gapSize: 0.35 }));
  }

  #buildShells() {
    // The outer "no route" ring exists only while some known node has no route.
    const wanted = this.#maxHops + (this.#hasUnreachable ? 1 : 0);
    const key = `${this.#maxHops}:${this.#hasUnreachable}`;
    if (this.#shellKey === key) return;
    this.#shellKey = key;
    for (const child of [...this.#shellGroup.children]) {
      child.geometry.dispose();
      child.material.dispose();
      this.#shellGroup.remove(child);
    }
    for (const label of this.#shellLabels) label.el.remove();
    this.#shellLabels = [];
    for (let h = 1; h <= wanted; h++) {
      const points = [];
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * Math.PI * 2;
        points.push(new THREE.Vector3(Math.cos(a) * h * SHELL, 0, Math.sin(a) * h * SHELL));
      }
      const unreachable = this.#hasUnreachable && h === wanted;
      const material = unreachable
        ? new THREE.LineDashedMaterial({ color: SHELL_COLOR, dashSize: 0.6, gapSize: 0.6 })
        : new THREE.LineBasicMaterial({ color: SHELL_COLOR });
      const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), material);
      if (unreachable) ring.computeLineDistances();
      this.#shellGroup.add(ring);
      const el = this.#makeLabel('topo-shell');
      el.textContent = unreachable ? 'no route' : `${h} hop${h === 1 ? '' : 's'}`;
      this.#shellLabels.push({ el, pos: new THREE.Vector3(h * SHELL + 0.6, 0, 0) });
    }
  }

  #colorNodes() {
    let i = 0;
    for (const node of this.#order) {
      const color = node.linked ? NODE_LINKED : node.reachable ? NODE_REACHABLE : NODE_UNREACHABLE;
      this.#nodeMesh.setColorAt(i, color);
      node.index = i;
      i += 1;
    }
    this.#nodeMesh.count = i;
    if (this.#nodeMesh.instanceColor) this.#nodeMesh.instanceColor.needsUpdate = true;
  }

  #writeNodes() {
    for (const node of this.#order) {
      this.#tmpMatrix.makeTranslation(node.pos.x, node.pos.y, node.pos.z);
      this.#nodeMesh.setMatrixAt(node.index, this.#tmpMatrix);
    }
    this.#nodeMesh.instanceMatrix.needsUpdate = true;
    const self = this.#nodes.get(this.#selfId);
    this.#selfMesh.visible = Boolean(self);
    this.#selfHalo.visible = Boolean(self);
  }

  #writeLinks(now) {
    const solid = this.#linkLines.geometry;
    const half = this.#halfLines.geometry;
    const sp = solid.attributes.position.array;
    const sc = solid.attributes.color.array;
    const hp = half.attributes.position.array;
    const hc = half.attributes.color.array;
    let si = 0;
    let hi = 0;
    let flashing = false;
    let minCost = Infinity;
    let maxCost = -Infinity;
    for (const link of this.#links) {
      if (typeof link.cost === 'number') {
        minCost = Math.min(minCost, link.cost);
        maxCost = Math.max(maxCost, link.cost);
      }
    }
    const span = maxCost > minCost ? maxCost - minCost : 1;
    for (const link of this.#links) {
      const a = this.#nodes.get(link.a);
      const b = this.#nodes.get(link.b);
      if (!a || !b) continue;
      const touchesSelf = a.self || b.self;
      const t = typeof link.cost === 'number' ? (link.cost - minCost) / span : 1;
      const color = this.#tmpColor.copy(touchesSelf ? LINK_SELF : LINK_NEAR).lerp(LINK_FAR, touchesSelf ? t * 0.5 : t);
      if (link.flash) {
        if (now >= link.flash.until) link.flash = null;
        else if (now >= link.flash.start) {
          const k = this.#reduced ? 1 : 1 - (now - link.flash.start) / FLASH_MS;
          color.lerp(link.flash.color, Math.max(0, k));
          flashing = true;
        } else flashing = true;
      }
      const isHalf = link.state === 'half';
      const pos = isHalf ? hp : sp;
      const col = isHalf ? hc : sc;
      const o = (isHalf ? hi : si) * 6;
      pos[o] = a.pos.x; pos[o + 1] = a.pos.y; pos[o + 2] = a.pos.z;
      pos[o + 3] = b.pos.x; pos[o + 4] = b.pos.y; pos[o + 5] = b.pos.z;
      col[o] = color.r; col[o + 1] = color.g; col[o + 2] = color.b;
      col[o + 3] = color.r; col[o + 4] = color.g; col[o + 5] = color.b;
      if (isHalf) hi += 1;
      else si += 1;
    }
    solid.setDrawRange(0, si * 2);
    half.setDrawRange(0, hi * 2);
    solid.attributes.position.needsUpdate = true;
    solid.attributes.color.needsUpdate = true;
    half.attributes.position.needsUpdate = true;
    half.attributes.color.needsUpdate = true;
    if (hi > 0) this.#halfLines.computeLineDistances();
    return flashing && !this.#reduced;
  }

  #writePulses(now) {
    const geometry = this.#points.geometry;
    const pos = geometry.attributes.position.array;
    const col = geometry.attributes.color.array;
    let k = 0;
    const alive = [];
    for (const pulse of this.#pulses) {
      const hops = pulse.route.length - 1;
      const elapsed = now - pulse.t0;
      const travel = hops * SEGMENT_MS;
      if (elapsed > travel + pulse.hold) continue;
      let at;
      let dim = 1;
      if (elapsed < travel && hops > 0) {
        const seg = Math.min(hops - 1, Math.floor(elapsed / SEGMENT_MS));
        const from = this.#nodes.get(pulse.route[seg]);
        const to = this.#nodes.get(pulse.route[seg + 1]);
        if (!from || !to) continue;
        at = this.#tmpVec.lerpVectors(from.pos, to.pos, ease((elapsed - seg * SEGMENT_MS) / SEGMENT_MS));
        if (seg >= pulse.dimAfter) dim = 0.4;
      } else {
        const last = this.#nodes.get(pulse.route[hops]);
        if (!last) continue;
        at = this.#tmpVec.copy(last.pos);
        if (hops > 0 && pulse.dimAfter < hops) dim = 0.4;
        if (pulse.kind === 'dropped') dim *= 0.55 + 0.45 * Math.cos((elapsed - travel) / 90);
      }
      alive.push(pulse);
      pos[k * 3] = at.x;
      pos[k * 3 + 1] = at.y + 0.02;
      pos[k * 3 + 2] = at.z;
      col[k * 3] = pulse.color.r * dim;
      col[k * 3 + 1] = pulse.color.g * dim;
      col[k * 3 + 2] = pulse.color.b * dim;
      k += 1;
    }
    this.#pulses = alive;
    geometry.setDrawRange(0, k);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
    return k > 0;
  }

  #placeMarkers() {
    const q = this.#camera.quaternion;
    const self = this.#nodes.get(this.#selfId);
    if (self) {
      this.#selfMesh.position.copy(self.pos);
      this.#selfHalo.position.copy(self.pos);
      this.#selfHalo.quaternion.copy(q);
    }
    const place = (ring, id) => {
      const node = id ? this.#nodes.get(id) : null;
      ring.visible = Boolean(node);
      if (node) {
        ring.position.copy(node.pos);
        ring.quaternion.copy(q);
        ring.scale.setScalar(node.self ? 1.7 : 1);
      }
    };
    place(this.#selectRing, this.#selected);
    place(this.#hoverRing, this.#hovered !== this.#selected ? this.#hovered : null);
  }

  /**
   * Move one overlay label. Labels are written only when they change, and the size comes
   * from the last resize: reading layout here would force a reflow per label per frame.
   */
  #project(pos, el) {
    const v = this.#tmpVec.copy(pos).project(this.#camera);
    const visible = v.z <= 1 && v.z >= -1;
    const state = this.#labelState.get(el) ?? { visible: true, x: NaN, y: NaN };
    this.#labelState.set(el, state);
    if (state.visible !== visible) {
      state.visible = visible;
      el.style.visibility = visible ? '' : 'hidden';
    }
    if (!visible) return;
    const x = Math.round(((v.x + 1) / 2) * this.#width);
    const y = Math.round(((1 - v.y) / 2) * this.#height);
    if (x !== state.x || y !== state.y) {
      state.x = x;
      state.y = y;
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }
  }

  #setShown(el, show) {
    if (el.hidden === !show) return;
    el.hidden = !show;
  }

  #placeLabels() {
    const allNodes = this.#nodes.size <= LABEL_ALL_NODES;
    const focus = new Set([this.#selected, this.#hovered, this.#selfId].filter(Boolean));
    for (const node of this.#nodes.values()) {
      const show = allNodes || node.self || node.linked || focus.has(node.id);
      this.#setShown(node.label, show);
      const focused = node.id === this.#selected || node.id === this.#hovered;
      if (node.focused !== focused) {
        node.focused = focused;
        node.label.classList.toggle('is-focus', focused);
      }
      if (show) this.#project(node.pos, node.label);
    }
    const allLinks = this.#links.length <= LABEL_ALL_LINKS;
    for (const link of this.#links) {
      const a = this.#nodes.get(link.a);
      const b = this.#nodes.get(link.b);
      const show = Boolean(a && b) && (allLinks || focus.has(link.a) || focus.has(link.b));
      this.#setShown(link.label, show);
      if (show) this.#project(this.#mid.lerpVectors(a.pos, b.pos, 0.5), link.label);
    }
    for (const shell of this.#shellLabels) this.#project(shell.pos, shell.el);
  }

  /** The node nearest the pointer on screen, within a finger-sized radius; spheres alone are too small to hit. */
  #pick(e) {
    const rect = this.#renderer.domElement.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    let best = null;
    let bestDistance = Infinity;
    for (const node of this.#nodes.values()) {
      const v = this.#tmpVec.copy(node.pos).project(this.#camera);
      if (v.z > 1 || v.z < -1) continue;
      const d = Math.hypot(((v.x + 1) / 2) * rect.width - px, ((1 - v.y) / 2) * rect.height - py);
      if (d < (node.self ? 22 : 16) && d < bestDistance) {
        best = node.id;
        bestDistance = d;
      }
    }
    return best;
  }

  #onKey(e) {
    const step = Math.PI / 24;
    const offset = this.#tmpVec.copy(this.#camera.position).sub(this.#controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    if (e.key === 'ArrowLeft') spherical.theta -= step;
    else if (e.key === 'ArrowRight') spherical.theta += step;
    else if (e.key === 'ArrowUp') spherical.phi = Math.max(0.1, spherical.phi - step);
    else if (e.key === 'ArrowDown') spherical.phi = Math.min(Math.PI - 0.1, spherical.phi + step);
    else if (e.key === '+' || e.key === '=') spherical.radius = Math.max(this.#controls.minDistance, spherical.radius * 0.85);
    else if (e.key === '-' || e.key === '_') spherical.radius = Math.min(this.#controls.maxDistance, spherical.radius / 0.85);
    else if (e.key === 'Escape') {
      this.#hooks.onSelect(null);
      return;
    } else return;
    e.preventDefault();
    this.#userMoved = true;
    offset.setFromSpherical(spherical);
    this.#camera.position.copy(this.#controls.target).add(offset);
    this.#controls.update();
    this.#request();
  }
}
