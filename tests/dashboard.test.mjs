import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExample, finalizeWindow } from '../public/modules/engine.js';
import { CircuitDashboard } from '../public/modules/dashboard.js';

class Mount extends EventTarget {
  innerHTML = '';
  querySelectorAll() { return []; }
}

// Model the browser's blur when innerHTML removes the active control. Layout
// and visual focus styling are verified separately in the real browser.
class FocusMount extends EventTarget {
  constructor(document) { super(); this.ownerDocument=document; this.nodes=[]; this.visible=true; this.isConnected=true; }
  get innerHTML() { return this.markup; }
  set innerHTML(markup) {
    const document=this.ownerDocument;
    if(this.contains(document.activeElement))document.activeElement=document.body;
    this.markup=markup;
    this.nodes=[...markup.matchAll(/<(?:g|button)\b[^>]*\b(data-instrument-component|data-time-bin|data-dashboard-event|data-reset-range|data-load-example)(?:="([^"]*)")?[^>]*>/g)].map(match=>{
      const attributes={[match[1]]:match[2]??''},node={attributes,dataset:{},isConnected:true};
      const key=match[1].slice(5).replace(/-([a-z])/g,(_all,char)=>char.toUpperCase());node.dataset[key]=attributes[match[1]];
      node.hasAttribute=name=>Object.hasOwn(attributes,name);node.getAttribute=name=>attributes[name]??null;
      node.closest=selector=>selector.split(',').some(part=>node.hasAttribute(part.trim().slice(1,-1)))?node:null;
      node.focus=options=>{document.activeElement=node;node.focusOptions=options;};return node;
    });
    this.afterReplace?.();
  }
  contains(node) { return this.nodes.includes(node); }
  closest() { return this.visible?null:{hidden:true}; }
  getClientRects() { return this.visible?[{}]:[]; }
  querySelectorAll(selector) { return this.nodes.filter(node=>node.closest(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0]??null; }
  click(node) { const event=new Event('click');Object.defineProperty(event,'target',{value:node});this.dispatchEvent(event); }
}
function focusFixture() {
  const document={body:{name:'body'}};document.activeElement=document.body;
  return {document,mount:new FocusMount(document),trace:finalizeWindow(buildExample('burst'))};
}

test('keyboard component selection retains focus on its replacement without scrolling',()=>{
  const {document,mount,trace}=focusFixture();let dashboard;
  dashboard=new CircuitDashboard([mount],{onComponent:componentId=>dashboard.update(trace,{componentId})});
  dashboard.update(trace);
  const component=mount.querySelectorAll('[data-instrument-component]')[2];component.focus();
  component.onkeydown({key:'Enter',preventDefault(){}});
  assert.notEqual(document.activeElement,component);
  assert.equal(document.activeElement.dataset.instrumentComponent,'capacitor');
  assert.deepEqual(document.activeElement.focusOptions,{preventScroll:true});
  assert.equal(dashboard.model.selection.componentId,'capacitor');dashboard.destroy();
});

test('time-grid activation and incoming updates preserve the same focused bin',()=>{
  const {document,mount,trace}=focusFixture();let dashboard;
  dashboard=new CircuitDashboard([mount],{onRange:(rangeStart,rangeEnd)=>dashboard.update(trace,{rangeStart,rangeEnd})});
  dashboard.update(trace);const bin=mount.querySelectorAll('[data-time-bin]')[4];bin.focus();mount.click(bin);
  assert.equal(document.activeElement.dataset.timeBin,'4');assert.equal(dashboard.model.selection.rangeActive,true);
  const selected=document.activeElement;dashboard.update(trace);
  assert.notEqual(document.activeElement,selected);assert.equal(document.activeElement.dataset.timeBin,'4');dashboard.destroy();
});

test('dashboard updates never take focus from another panel or restore into a hidden page',()=>{
  const {document,mount,trace}=focusFixture(),other=new FocusMount(document);
  const dashboard=new CircuitDashboard([mount,other]);dashboard.update(trace);
  const outside={name:'wallet address'};document.activeElement=outside;dashboard.update(trace);
  assert.equal(document.activeElement,outside);
  mount.querySelector('[data-instrument-component]').focus();mount.visible=false;dashboard.update(trace);
  assert.equal(document.activeElement,document.body);
  mount.visible=true;dashboard.update(trace);mount.querySelector('[data-time-bin]').focus();
  mount.afterReplace=()=>{document.activeElement=outside;};dashboard.update(trace);
  assert.equal(document.activeElement,outside);dashboard.destroy();
});

test('an unavailable Trace moves a removed focused bin to the same panel full-window control',()=>{
  const {document,mount,trace}=focusFixture(),dashboard=new CircuitDashboard([mount]);dashboard.update(trace);
  mount.querySelector('[data-time-bin]').focus();dashboard.update(null);
  assert.equal(document.activeElement,mount.querySelector('[data-reset-range]'));dashboard.destroy();
});

test('dashboard reports exact subrange totals even when its curve retains a larger plotting bucket', () => {
  const mount = new Mount(), dashboard = new CircuitDashboard([mount]);
  const trace = finalizeWindow(buildExample('burst'));
  dashboard.update(trace, { rangeStart: trace.window.start + 1100, rangeEnd: trace.window.start + 1600, bucketMs: 5000 });
  assert.equal((mount.innerHTML.match(/<strong>1 <small>Pulse \/ selection<\/small>/g) || []).length, 2);
  assert.doesNotMatch(mount.innerHTML, /NaN|undefined/);
  dashboard.destroy();
});

test('incomplete waveform readouts and grid tooltips explicitly identify observed lower bounds', () => {
  const mount = new Mount(), dashboard = new CircuitDashboard([mount]);
  const trace = finalizeWindow({ ...buildExample('single'), coverage: 'partial' });
  dashboard.update(trace);
  assert.equal((mount.innerHTML.match(/<strong>1 <small>observed \/ window<\/small>/g) || []).length, 2);
  assert.match(mount.innerHTML, /OBSERVED LOWER BOUND/);
  assert.match(mount.innerHTML, /incomplete coverage · 1 valid Pulses observed \(lower bound\)/);
  assert.match(mount.innerHTML, /stroke-dasharray="3 3"/);
  dashboard.destroy();
});

test('clearing a Trace removes its waveform and prior event numbers', () => {
  const mount = new Mount(), dashboard = new CircuitDashboard([mount]);
  dashboard.update(finalizeWindow(buildExample('burst')));
  dashboard.update(null);
  assert.match(mount.innerHTML, /No selected window/);
  assert.match(mount.innerHTML, /No synthetic waveform is shown/);
  assert.doesNotMatch(mount.innerHTML, /<polyline|>12<|NaN|undefined/);
  dashboard.destroy();
});
