import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {isPublicAddress} from '../public/modules/wallet.js';

const app = readFileSync(new URL('../public/modules/app.js', import.meta.url), 'utf8');
const invalidation = app.match(/function invalidateFilteredInspection\(\)\{[\s\S]*?\n\}/)?.[0];
const accountChange = app.match(/onChange:address=>\{([\s\S]*?)\n \},/)?.[1];
const manualFilter = app.match(/\$\('#useWalletAddress'\)\.onclick=\(\)=>\{([\s\S]*?)\n\};/)?.[1];
assert.ok(invalidation && accountChange && manualFilter, 'Use the actual shipped wallet filter callbacks');

function fixture() {
  const nodes = new Map(), calls = [];
  const $ = key => {
    if (!nodes.has(key)) nodes.set(key, {value:'', hidden:false, close(){calls.push('close');}});
    return nodes.get(key);
  };
  const context = {
    S: {filter:{address:''}, filterAddress:'', selectedEvent:{id:'previous-event'},
      playback:{playing:true, step:3}, example:{count:12}},
    $, isPublicAddress, walletAction:0, walletBusy:false,
    wallet:{address:null,cancelPending(){calls.push('cancel');},disconnect(){calls.push('disconnect');}},
    workbench:{pause(){calls.push('pause-workbench');}},
    resetPlayback(){context.S.playback.playing=false;context.S.playback.step=-1;calls.push('reset');},
    syncWalletLabel(){},renderUnified(){calls.push('instruments');},renderEvents(){calls.push('events');},renderWallets(){},
    go:route=>calls.push(route), notify:message=>calls.push(message),
  };
  vm.createContext(context);
  vm.runInContext(`${invalidation}\nfunction accountChange(address){${accountChange}}\nfunction manualFilter(){${manualFilter}}`,context);
  return {context,$,calls};
}

test('wallet account changes and disconnection clear old evidence and stop its replay', () => {
  for (const address of ['11111111111111111111111111111111',null]) {
    const {context,$,calls}=fixture();
    context.accountChange(address);
    assert.equal(context.S.selectedEvent,null);
    assert.equal($('#eventDetail').hidden,true);
    assert.equal(context.S.playback.playing,false);
    assert.equal(context.S.playback.step,-1);
    assert.equal(context.S.filter.address,address||'');
    assert.equal(context.S.example.count,12);
    assert.ok(calls.indexOf('reset')<calls.indexOf('events'));
  }
});

test('manual public-address filtering invalidates an inspected event without invoking connection or signing', () => {
  const {context,$,calls}=fixture();
  $('#walletAddress').value='11111111111111111111111111111111';
  context.manualFilter();
  assert.equal(context.S.selectedEvent,null);
  assert.equal($('#eventDetail').hidden,true);
  assert.equal(context.S.playback.playing,false);
  assert.equal(context.S.filter.address,'11111111111111111111111111111111');
  assert.equal(context.S.example.count,12);
  assert.ok(calls.includes('#live'));
  assert.ok(calls.includes('close'));
});

test('invalid manual input leaves the current inspection and data intact', () => {
  const {context,$,calls}=fixture();
  $('#walletAddress').value='invalid-address';
  context.manualFilter();
  assert.equal(context.S.selectedEvent.id,'previous-event');
  assert.equal(context.S.playback.playing,true);
  assert.equal(context.S.filter.address,'');
  assert.ok(!calls.includes('reset'));
});
