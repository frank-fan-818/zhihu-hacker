import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { applySuggestion } from '../src/domain.mjs';

// Regression coverage for the production audit findings.
// Execute the shipped UI with minimal DOM/fetch fixtures; never call live services.
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  .replace('init().catch(fail);', '/* audit: initialization driven by fixture */');
function ui(respond = () => ({})) {
  const elements = new Map(), clicks = [], calls = [], local = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      value: '', textContent: '', innerHTML: '', hidden: false,
      addEventListener() {}, insertAdjacentHTML() {}, focus() {},
      click() { return this.onclick?.(); },
    });
    return elements.get(selector);
  };
  const context = vm.createContext({
    document: { querySelector: element, addEventListener: (name, fn) => { if (name === 'click') clicks.push(fn); } },
    window: { addEventListener() {} },
    localStorage: { getItem: k => local.get(k), setItem: (k,v) => local.set(k,v), removeItem: k => local.delete(k) },
    setTimeout: () => 1, clearTimeout() {}, setInterval() {},
    confirm: () => true, crypto: { randomUUID: () => 'fixture-key' },
    location: { assign() {}, href: 'https://fixture.invalid/' },
    fetch: async (path, options) => {
      const call = { path, method: options.method, body: options.body && JSON.parse(options.body) };
      calls.push(call); return { ok: true, json: async () => respond(call, element) };
    },
  });
  vm.runInContext(source, context);
  vm.runInContext(`project={id:'p1',revision:1,text:'original fixture text',updated:0,findings:[],suggestions:[],history:[],sources:[],verification:{}}; draft.value=project.text;`,context);
  return { calls, element, local, run: code => vm.runInContext(code, context), click: (action,id='s1') => clicks[0]({ target: { closest: () => ({ dataset: { action, id } }) } }) };
}

test('anonymous recheck updates the working copy and checks the new revision', async () => {
  const app = ui(call => call.method==='PATCH'?{...app.run('project'),text:call.body.text,revision:2}:{ id: 'op1' });
  app.run(`draft.value='new text that should be checked';dirty=true;poll=async()=>{};`);
  await app.run(`run('quick_check')`);
  assert.equal(app.calls[0].method, 'PATCH');
  assert.equal(app.calls[0].body.text, 'new text that should be checked');
  assert.equal(app.calls[1].path, '/api/projects/p1/operations');
  assert.equal(app.calls[1].body.revision, 2);
  assert.equal(app.run('dirty'), false);
  assert.equal(app.run('project.text'), app.element('#draft').value);
  assert.equal(app.local.has('cognitive-project'), false);
});

test('anonymous apply preserves newer text and the real domain rejects the stale suggestion', async () => {
  const app = ui(call => {
    if(call.method==='PATCH')return {...app.run('project'),revision:2,text:call.body.text};
    return applySuggestion(app.run('project'),{baseRevision:1,quote:'original fixture text',start:0,end:21,text:'replacement of old fixture text'});
  });
  app.run(`draft.value='valuable unsaved new paragraph';dirty=true;`);
  await app.click('apply');
  assert.equal(app.calls[0].method, 'PATCH');
  assert.equal(app.element('#draft').value, 'valuable unsaved new paragraph');
  assert.equal(app.run('dirty'), false);
  assert.match(app.run('error'), /原稿版本已变化/);
});

test('anonymous login requests the selected project transfer and restores its pointer', async () => {
  const app = ui(() => ({ url: 'https://fixture.invalid/oauth' }));
  await app.run('startLogin()');
  assert.equal(app.calls[0].path, '/api/auth/start');
  assert.equal(app.calls[0].body.projectId, 'p1');
  assert.equal(app.local.get('cognitive-pending'), 'original fixture text');
  assert.equal(app.local.get('cognitive-project'), 'p1');
});

test('signed-in apply retains edits typed while a valid apply response is pending', async () => {
  const app = ui((call, element) => {
    if (call.path.endsWith('/apply')) {
      const serverProject = app.run('project');
      assert.equal(call.body.revision, serverProject.revision);
      const text = applySuggestion(serverProject, {
        baseRevision: 1, quote: serverProject.text, start: 0, end: serverProject.text.length,
        text: 'applied stale text with sufficient length',
      });
      element('#draft').value = 'new typing while apply is in flight';
      app.run('dirty=true');
      return { id:'p1',revision:2,text,updated:0,findings:[],suggestions:[],history:[],sources:[],verification:{} };
    }
    if (call.path === '/api/projects') return [];
    throw new Error('Unexpected fixture route');
  });
  app.run(`account={name:'fixture'};dirty=false;`);
  await app.click('apply');
  assert.equal(app.calls.some(c => c.path.endsWith('/apply')), true);
  assert.equal(app.element('#draft').value, 'new typing while apply is in flight');
  assert.equal(app.run('project.text'), 'applied stale text with sufficient length');
  assert.equal(app.run('dirty'), true);
  assert.equal(app.run('extraBusy'), false);
});

test('failed anonymous PATCH keeps dirty text and does not start a check', async () => {
  const app=ui(()=>{throw new Error('fixture save failure');});
  app.run(`draft.value='edited fixture text after save failure';dirty=true;`);
  await assert.rejects(app.run(`run('quick_check')`),/fixture save failure/);
  assert.equal(app.calls.length,1);
  assert.equal(app.run('dirty'),true);
  assert.equal(app.run('extraBusy'),false);
});

test('new input during PATCH prevents applying a suggestion until saved',async()=>{
  const app=ui((call,element)=>{
    element('#draft').value='new input while draft save is pending';
    return {...app.run('project'),revision:2,text:call.body.text};
  });
  app.run(`dirty=true;draft.value='initial changed fixture draft';`);
  await app.click('apply');
  assert.equal(app.calls.length,1);
  assert.equal(app.calls[0].method,'PATCH');
  assert.equal(app.run('dirty'),true);
  assert.match(app.run('error'),/保存期间有新的编辑/);
});

test('undo preserves input typed during its response',async()=>{
  const app=ui((call,element)=>{
    element('#draft').value='new input while undo is pending';
    app.run('dirty=true');
    return {...app.run('project'),revision:2,text:'restored original fixture text'};
  });
  await app.click('undo');
  assert.equal(app.element('#draft').value,'new input while undo is pending');
  assert.equal(app.run('dirty'),true);
});

test('loading another project cannot replace text typed during its request',async()=>{
  const app=ui((call,element)=>{
    element('#draft').value='new input while project load is pending';
    app.run('dirty=true');
    return {...app.run('project'),id:'p2',text:'different project fixture text'};
  });
  await app.click('open','p2');
  assert.equal(app.run('project.id'),'p1');
  assert.equal(app.element('#draft').value,'new input while project load is pending');
  assert.equal(app.run('dirty'),true);
});

test('declining login transfer does not associate the anonymous project',async()=>{
  const app=ui(()=>({url:'https://fixture.invalid/oauth'}));
  app.run('confirm=()=>false');
  await app.run('startLogin()');
  assert.equal(app.calls[0].body.projectId,null);
  assert.equal(app.local.has('cognitive-project'),false);
});

test('deleting current project preserves text entered during the delete request',async()=>{
  const app=ui((call,element)=>{
    element('#draft').value='new input during delete request';
    app.run('dirty=true');return {};
  });
  await app.click('delete','p1');
  assert.equal(app.run('project'),null);
  assert.equal(app.element('#draft').value,'new input during delete request');
  assert.equal(app.run('dirty'),true);
});
