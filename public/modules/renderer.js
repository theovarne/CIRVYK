const NS = 'http://www.w3.org/2000/svg';
export const CIRCUIT_STAGES = Object.freeze(['sensor', 'resistor', 'capacitor', 'comparator', 'switch', 'memory']);
const LABELS = Object.freeze({sensor: 'Sensor', resistor: 'Resistor', capacitor: 'Capacitor', comparator: 'Comparator', switch: 'Switch', memory: 'Memory'});
const ASSETS = Object.freeze({
  floorplan: new URL('../assets/circuit-board.svg', import.meta.url),
  backplane: new URL('../assets/circuit-backplane.svg', import.meta.url),
});
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const countOf = trace => Number.isFinite(trace?.count) ? Math.max(0, trace.count) : (Array.isArray(trace?.validInputs) ? trace.validInputs.length : 0);

// Only the shipped local geometry is parsed. Imports and user data never enter this path.
function parseLocalSvg(source) {
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  const svg = doc.documentElement;
  if (doc.querySelector('parsererror') || svg.localName !== 'svg' || svg.namespaceURI !== NS) throw new Error('Invalid circuit asset.');
  const tags = new Set(['svg', 'g', 'path', 'circle', 'text', 'title', 'desc', 'style']);
  const attrs = new Set(['aria-label', 'class', 'cx', 'cy', 'd', 'data-component', 'data-output', 'data-figure', 'data-free', 'data-lit', 'data-route', 'data-shade', 'data-tone', 'r', 'role', 'tabindex', 'text-anchor', 'viewBox', 'x', 'y', 'xmlns']);
  for (const node of [svg, ...svg.querySelectorAll('*')]) {
    if (!tags.has(node.localName) || node.namespaceURI !== NS) throw new Error('Unsupported circuit geometry.');
    for (const attr of [...node.attributes]) if (!attrs.has(attr.name)) node.removeAttribute(attr.name);
    if (node.localName === 'style' && /@import|url\s*\(|expression\s*\(|javascript:/i.test(node.textContent)) throw new Error('Unsafe circuit styling.');
  }
  return document.importNode(svg, true);
}

export class CircuitRenderer {
  constructor(mount, options = {}) {
    if (!(mount instanceof Element)) throw new TypeError('A circuit mount element is required.');
    this.mount = mount;
    this.options = options;
    this.selected = null;
    this.hovered = null;
    this.result = null;
    this.replayStep = null;
    this.view = {zoom: 1, x: 0, y: 0};
    this.bounds = {x: 0, y: 0, width: 720, height: 510};
    this.assetViews = new Map();
    this.asset = null;
    this.pendingAsset = null;
    this.loadId = 0;
    this.cleanups = [];
    this.destroyed = false;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.abort = new AbortController();
    mount.classList.add('circuit-renderer');
    mount.setAttribute('aria-label', 'Interactive circuit. Select a component to inspect it. Drag to pan, use plus and minus to zoom, or zero to reset.');
    if (!mount.hasAttribute('tabindex')) mount.tabIndex = 0;
    this.ready = this.setAsset(options.asset || 'floorplan');
  }

  /** Switch only between shipped, reviewed local assets; selection and Trace persist. */
  setAsset(name) {
    if (!Object.hasOwn(ASSETS, name)) throw new TypeError('Choose the floorplan or backplane circuit asset.');
    if (this.destroyed) return Promise.resolve(null);
    if (this.pendingAsset === name) return this.ready;
    if (!this.pendingAsset && this.asset === name && this.svg) return Promise.resolve(this);
    if (this.asset) this.assetViews.set(this.asset, {...this.view});
    this.pendingAsset = name;
    const loadId = ++this.loadId;
    this.abort.abort();
    this.abort = new AbortController();
    this.stopParticles();
    clearTimeout(this.recordTimer);
    this.ready = this.load(name, loadId).catch(error => {
      if (this.destroyed || error.name === 'AbortError') return null;
      if (loadId !== this.loadId) return null;
      this.pendingAsset = null;
      this.error = error;
      if (!this.svg) {
        const message = document.createElement('p');
        message.className = 'circuit-load-error';
        message.setAttribute('role', 'status');
        message.textContent = 'Circuit graphic could not be loaded. Refresh the page to try again.';
        this.mount.replaceChildren(message);
      }
      this.options.onError?.(error);
      return null;
    });
    return this.ready;
  }

  listen(target, type, handler, options) {
    if (!target) return;
    target.addEventListener(type, handler, options);
    this.cleanups.push(() => target.removeEventListener(type, handler, options));
  }

  async load(name, loadId) {
    const assetUrl = ASSETS[name];
    if (assetUrl.origin !== location.origin) throw new Error('Circuit asset must be local.');
    const response = await fetch(assetUrl, {signal: this.abort.signal, credentials: 'same-origin', cache: 'no-cache'});
    if (!response.ok) throw new Error(`Circuit asset returned ${response.status}.`);
    const source = await response.text();
    if (this.destroyed || loadId !== this.loadId) return null;
    const svg = parseLocalSvg(source);
    const [x, y, width, height] = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error('Invalid circuit view bounds.');
    this.cleanups.forEach(cleanup => cleanup());
    this.cleanups.length = 0;
    this.drag = null;
    this.dragged = false;
    this.hovered = null;
    this.error = null;
    this.bounds = {x, y, width, height};
    this.asset = name;
    this.pendingAsset = null;
    this.view = this.assetViews.get(name) || {zoom: 1, x: 0, y: 0};
    this.svg = svg;
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    this.viewport = document.createElementNS(NS, 'g');
    this.viewport.classList.add('circuit-viewport');
    for (const child of [...this.svg.children]) if (child.localName !== 'style') this.viewport.append(child);
    this.svg.append(this.viewport);
    this.mount.replaceChildren(this.svg);
    this.components = new Map(CIRCUIT_STAGES.map(id => [id, this.svg.querySelector(`[data-component="${id}"]`)]));
    this.routes = new Map(CIRCUIT_STAGES.map(id => [id, this.svg.querySelector(`[data-route="${id}"]`)]));
    this.capacitorCells = [...(this.components.get('capacitor')?.querySelectorAll('.memory-cell') || [])];
    this.capacitorReadout = document.createElementNS(NS, 'text');
    this.capacitorReadout.setAttribute('class', 'capacitor-readout');
    this.capacitorReadout.setAttribute('x', name === 'backplane' ? '850' : '545');
    this.capacitorReadout.setAttribute('y', name === 'backplane' ? '80' : '318');
    this.capacitorReadout.setAttribute('text-anchor', 'end');
    this.viewport.append(this.capacitorReadout);
    this.particles = document.createElementNS(NS, 'g');
    this.particles.setAttribute('aria-hidden', 'true');
    this.viewport.append(this.particles);
    this.bindInteractions();
    this.applyView();
    this.select(this.selected);
    this.setResult(this.result);
    this.setReplayStep(this.replayStep);
    this.syncVisibility();
    this.options.onAssetChange?.(name);
    return this;
  }

  bindInteractions() {
    for (const [id, node] of this.components) {
      if (!node) continue;
      this.listen(node, 'pointerenter', () => this.hover(id));
      this.listen(node, 'pointerleave', () => this.hover(null));
      this.listen(node, 'focus', () => this.hover(id));
      this.listen(node, 'blur', () => this.hover(null));
      this.listen(node, 'click', event => {
        if (this.dragged) return;
        event.stopPropagation();
        this.select(id);
        this.options.onSelect?.(id);
      });
      this.listen(node, 'keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); event.stopPropagation();
          this.select(id); this.options.onSelect?.(id);
        }
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault(); event.stopPropagation();
          const next = CIRCUIT_STAGES[(CIRCUIT_STAGES.indexOf(id) + (event.key === 'ArrowRight' ? 1 : 5)) % 6];
          this.components.get(next)?.focus();
        }
      });
    }
    this.listen(this.svg, 'pointerdown', event => {
      if (event.button !== 0 || this.drag && event.pointerId !== this.drag.pointer) return;
      this.dragged = false;
      this.drag = {pointer: event.pointerId, originX: event.clientX, originY: event.clientY, ...this.view};
    });
    this.listen(this.svg, 'pointermove', event => {
      if (!this.drag || event.pointerId !== this.drag.pointer) return;
      const dx = event.clientX - this.drag.originX, dy = event.clientY - this.drag.originY;
      if (Math.hypot(dx, dy) > 4) {
        this.dragged = true;
        this.svg.setPointerCapture(event.pointerId);
        this.svg.style.cursor = 'grabbing';
      }
      if (!this.dragged) return;
      const rect = this.svg.getBoundingClientRect();
      const units = Math.min(rect.width / this.bounds.width, rect.height / this.bounds.height);
      if (!(units > 0)) return;
      this.view.x = clamp(this.drag.x + dx / units, -this.bounds.width, this.bounds.width);
      this.view.y = clamp(this.drag.y + dy / units, -this.bounds.height, this.bounds.height);
      this.applyView();
    });
    const finishDrag = event => {
      if (!this.drag || event.pointerId !== this.drag.pointer) return;
      if (this.svg.hasPointerCapture?.(event.pointerId)) this.svg.releasePointerCapture(event.pointerId);
      this.drag = null;
      this.svg.style.cursor = '';
    };
    this.listen(this.svg, 'pointerup', finishDrag);
    this.listen(this.svg, 'pointercancel', finishDrag);
    this.listen(this.svg, 'wheel', event => {
      event.preventDefault();
      const matrix = this.svg.getScreenCTM();
      if (!matrix) return;
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      this.zoom(this.view.zoom * (Math.exp(-event.deltaY * .0013) - 1), point);
    }, {passive: false});
    this.listen(this.mount, 'keydown', event => {
      if (['+', '=', '-', '0', 'Home'].includes(event.key)) {
        event.preventDefault();
        if (event.key === '0' || event.key === 'Home') this.resetView();
        else this.zoom(event.key === '-' ? -.16 : .16);
      } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault();
        this.view.x += event.key === 'ArrowLeft' ? 16 : event.key === 'ArrowRight' ? -16 : 0;
        this.view.y += event.key === 'ArrowUp' ? 16 : event.key === 'ArrowDown' ? -16 : 0;
        this.applyView();
      }
    });
    this.listen(document, 'visibilitychange', () => this.syncVisibility());
    this.listen(this.reducedMotion, 'change', () => this.syncVisibility());
  }

  hover(id) {
    this.hovered = CIRCUIT_STAGES.includes(id) ? id : null;
    this.updateClasses();
    this.options.onHover?.(this.hovered);
  }

  select(id) {
    this.selected = CIRCUIT_STAGES.includes(id) ? id : null;
    this.updateClasses();
    return this;
  }

  setResult(trace) {
    const previousId = this.result?.id;
    this.result = trace || null;
    if (!this.svg) return this;
    const count = countOf(this.result);
    this.capacitorCells.forEach((cell, index) => cell.classList.toggle('is-charged', index < Math.min(count, this.capacitorCells.length)));
    this.components.get('capacitor')?.setAttribute('aria-label', this.result
      ? `Inspect Capacitor. ${count} valid input${count === 1 ? '' : 's'} accumulated.`
      : 'Inspect Capacitor. No verified window loaded.');
    this.capacitorReadout.textContent = this.result ? `${count} VALID · ${Math.round(clamp(Number(this.result.progress) || 0, 0, 1) * 100)}% WINDOW` : '';
    const resolvedPath = trace?.status === 'final' && ['QUIET', 'FLOW', 'SURGE'].includes(trace.path) ? trace.path : null;
    this.svg.dataset.path = resolvedPath || 'UNRESOLVED';
    for (const rail of this.svg.querySelectorAll('[data-output]')) {
      const active = rail.dataset.output === resolvedPath;
      rail.classList.toggle('is-current', active);
      rail.setAttribute('aria-label', `${rail.dataset.output} display path; ${active ? 'selected by completed window' : 'inactive'}.`);
    }
    this.svg.querySelector('.output-rails')?.setAttribute('aria-label', resolvedPath
      ? `Predefined switch output rails. Completed window selected ${resolvedPath}.`
      : 'Predefined switch output rails. No complete path selected.');
    if (trace?.status === 'final' && trace.id && trace.id !== previousId && !document.hidden && !this.reducedMotion.matches) {
      const memory = this.components.get('memory');
      memory?.classList.remove('is-recorded');
      clearTimeout(this.recordTimer);
      // A short completed-record feedback, independent of all displayed counts.
      this.recordTimer = setTimeout(() => {
        if (!this.destroyed) memory?.classList.add('is-recorded');
      }, 0);
    }
    this.updateClasses();
    return this;
  }

  setReplayStep(step) {
    const index = typeof step === 'string' ? CIRCUIT_STAGES.indexOf(step.toLowerCase()) : step;
    this.replayStep = Number.isInteger(index) && index >= 0 && index < 6 ? index : null;
    this.updateClasses();
    this.stopParticles();
    if (this.svg && this.replayStep !== null && countOf(this.result) > 0) this.animateRoute(CIRCUIT_STAGES[this.replayStep]);
    return this;
  }

  updateClasses() {
    if (!this.components) return;
    const active = this.replayStep === null ? null : CIRCUIT_STAGES[this.replayStep];
    for (const [id, node] of this.components) {
      if (!node) continue;
      node.classList.toggle('is-selected', id === this.selected);
      node.classList.toggle('is-hovered', id === this.hovered);
      node.classList.toggle('is-replaying', id === active);
      node.setAttribute('aria-pressed', String(id === this.selected));
      const route = this.routes.get(id);
      if (!route) continue;
      route.classList.toggle('is-related', id === this.selected || id === this.hovered);
      route.classList.toggle('is-replaying', id === active);
      route.classList.toggle('is-traversed', this.replayStep !== null && CIRCUIT_STAGES.indexOf(id) < this.replayStep);
    }
  }

  animateRoute(id) {
    if (document.hidden || this.reducedMotion.matches) return;
    const path = this.routes.get(id)?.querySelector('.route-forward');
    if (!path) return;
    // At most four visible particles, no playback queue; underlying input counts are untouched.
    const total = path.getTotalLength();
    const particleCount = Math.min(4, countOf(this.result));
    const dots = Array.from({length: particleCount}, () => {
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('class', 'signal-particle'); dot.setAttribute('r', '1.65');
      this.particles.append(dot); return dot;
    });
    const start = performance.now();
    const frame = now => {
      if (this.destroyed || document.hidden || this.reducedMotion.matches) return this.stopParticles();
      const elapsed = now - start;
      dots.forEach((dot, index) => {
        const t = (elapsed - index * 105) / 760;
        dot.setAttribute('opacity', t < 0 || t > 1 ? '0' : '1');
        const point = path.getPointAtLength(clamp(t, 0, 1) * total);
        dot.setAttribute('cx', point.x); dot.setAttribute('cy', point.y);
      });
      if (elapsed < 760 + (dots.length - 1) * 105) this.animationFrame = requestAnimationFrame(frame);
      else this.stopParticles();
    };
    this.animationFrame = requestAnimationFrame(frame);
  }

  stopParticles() {
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    this.particles?.replaceChildren();
  }

  syncVisibility() {
    this.svg?.classList.toggle('circuit-paused', document.hidden || this.reducedMotion.matches);
    if (document.hidden || this.reducedMotion.matches) this.stopParticles();
  }

  zoom(delta, anchor = {x: this.bounds.x + this.bounds.width / 2, y: this.bounds.y + this.bounds.height / 2}) {
    const before = this.view.zoom;
    const after = clamp(before + Number(delta || 0), .65, 2.7);
    const scale = after / before;
    this.view.x = anchor.x - (anchor.x - this.view.x) * scale;
    this.view.y = anchor.y - (anchor.y - this.view.y) * scale;
    this.view.zoom = after;
    this.applyView();
    return this;
  }

  resetView() {
    this.view = {zoom: 1, x: 0, y: 0};
    this.applyView();
    return this;
  }

  applyView() {
    this.viewport?.setAttribute('transform', `translate(${this.view.x} ${this.view.y}) scale(${this.view.zoom})`);
    this.options.onViewChange?.({...this.view});
  }

  snapshotSvg() {
    if (!this.svg) return null;
    const clone = this.svg.cloneNode(true);
    clone.setAttribute('xmlns', NS);
    clone.setAttribute('width', '1440');
    clone.setAttribute('height', String(Math.round(1440 * this.bounds.height / this.bounds.width)));
    const style = document.createElementNS(NS, 'style');
    style.textContent = '*{animation:none!important;transition:none!important}';
    clone.append(style);
    return new XMLSerializer().serializeToString(clone);
  }

  destroy() {
    this.destroyed = true;
    this.abort.abort();
    this.stopParticles();
    clearTimeout(this.recordTimer);
    this.cleanups.forEach(cleanup => cleanup());
    this.cleanups.length = 0;
    this.mount.replaceChildren();
  }
}

export function createRenderer(mount, options) { return new CircuitRenderer(mount, options); }
