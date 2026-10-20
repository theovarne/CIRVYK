// Minimal DOM surface for source-workspace interaction tests, with no browser,
// network, HTML parser or script execution.
export function sourceDocument(clipboard) {
  const doc = {baseURI: 'https://circuit.test/', defaultView: {navigator: {clipboard}}, activeElement: null};
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.parentElement = null; this.dataset = {}; this.attributes = new Map(); this.listeners = new Map(); this.className = ''; this._text = ''; this.value = ''; }
    get classList() { const node = this; return {add(...names) { node.className = [...new Set([...node.className.split(/\s+/).filter(Boolean), ...names])].join(' '); }, remove(...names) { node.className = node.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); }, toggle(name, force) { const has = node.className.split(/\s+/).includes(name); const on = force ?? !has; if (on) this.add(name); else this.remove(name); return on; }}; }
    get firstElementChild() { return this.children[0] ?? null; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
    replaceChildren(...nodes) { for (const child of this.children) child.parentElement = null; this.children = []; this._text = ''; this.append(...nodes); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    async dispatch(type, event = {}) { for (const listener of this.listeners.get(type) ?? []) await listener({target: this, ...event}); }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    focus() { doc.activeElement = this; }
    querySelectorAll(selector) {
      const match = (node, query) => query.startsWith('.') ? node.className.split(/\s+/).includes(query.slice(1)) : query === 'button[data-source-path]' ? node.tagName === 'BUTTON' && !!node.dataset.sourcePath : node.tagName === query.toUpperCase();
      const matches = []; const visit = node => { for (const child of node.children) { if (selector.split(',').some(query => match(child, query))) matches.push(child); visit(child); } }; visit(this); return matches;
    }
  }
  doc.createElement = tag => new Element(tag);
  return doc;
}
