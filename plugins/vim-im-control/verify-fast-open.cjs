const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

function setup(source = 'main.js') {
  const timers = new Map();
  let serial = 0, currentIM = 'Korean';
  const calls = [], cleanup = [];
  const sandbox = { module: { exports: {} }, process: { platform: 'darwin', env: {} },
    console: { debug() {}, warn() {}, error() {} },
    setTimeout: callback => { const id = ++serial; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    require(name) {
      if (name === 'obsidian') return { Plugin: class {}, PluginSettingTab: class {} };
      if (name === 'child_process') return {};
      throw Error(name);
    }
  };
  vm.runInNewContext(fs.readFileSync(__dirname + '/' + source, 'utf8'), sandbox);
  const plugin = new sandbox.module.exports.default();
  const originalGetCodeMirrorEditor = plugin.getCodeMirrorEditor.bind(plugin);
  plugin.settings = { isAsync: false };
  plugin.setting = { cmdGetCurrentIM: 'get', cmdOnInsertLeave: 'English', cmdOnInsertEnter: '{{im}}' };
  plugin.runCommandSync = command => { calls.push(command); if (command === 'get') return currentIM; currentIM = command; return ''; };
  plugin.register = callback => cleanup.push(callback);
  let inDispatch = false;
  const commands = [];
  const target = { closest: () => null, ownerDocument: { defaultView: { CodeMirror: { Vim: {
    handleKey() { throw new Error('Legacy CodeMirror Vim must not handle a CM6 editor'); }
  } } } } };
  class EditorAdapter {}
  EditorAdapter.Vim = {
    handleKey(editor, key, origin) {
      assert.equal(event.defaultPrevented, true, 'native character input must be cancelled before the Vim command');
      commands.push({ key, origin });
      editor.state.vim.insertMode = true;
      plugin.onVimModeChanged({ mode: 'insert' });
    }
  };
  const contentDOM = { contains: node => node === target || !!node?.insideEditor };
  const editor = Object.assign(new EditorAdapter(), { state: { vim: { insertMode: false, visualMode: false } }, cm6: { contentDOM } });
  plugin.getActiveMarkdownView = () => ({});
  plugin.getCodeMirrorEditor = () => editor;
  let event;
  const dispatch = overrides => {
    event = { key: 'o', code: 'KeyO', target, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...overrides };
    inDispatch = true;
    plugin.handleNormalOpen(event);
    inDispatch = false;
    return event;
  };
  const originalEnter = plugin.onInsertEnter.bind(plugin);
  plugin.onInsertEnter = () => { assert.equal(inDispatch, false, 'IME restoration must wait until key dispatch ends'); originalEnter(); };
  return { plugin, editor, calls, commands, cleanup, dispatch, originalGetCodeMirrorEditor,
    im: () => currentIM,
    flush() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
    pending: () => timers.size
  };
}

test('a native table cell uses its own Vim adapter', () => {
  const s = setup();
  const target = {};
  const localAdapter = {state: {vim: {}}};
  const localView = {contentDOM: {contains: node => node === target}, cm: localAdapter};
  const mainAdapter = {};
  const view = {sourceMode: {tableCell: {cm: localView}, cmEditor: {cm: {cm: mainAdapter}}}};
  assert.equal(s.originalGetCodeMirrorEditor(view, target), localAdapter);
  assert.equal(s.originalGetCodeMirrorEditor(view, {}), mainAdapter);
});

for (const key of ['o', 'ㅐ', 'Process']) test(`fast Escape → ${key}/KeyO opens once and restores Korean after dispatch`, () => {
  const s = setup();
  s.plugin.prevVimMode = 'insert';
  s.plugin.onVimModeChanged({ mode: 'normal' });
  assert.equal(s.im(), 'English');
  const e = s.dispatch({ key, isComposing: key === 'Process', keyCode: key === 'Process' ? 229 : 79 });
  assert.ok(e.defaultPrevented && e.stopped);
  assert.deepEqual(s.commands, [{ key: 'o', origin: 'user' }]);
  assert.equal(s.im(), 'English');
  s.flush();
  assert.equal(s.im(), 'Korean');
});

test('Shift+O uses the above-line command', () => {
  const s = setup(); s.dispatch({ key: 'ㅒ', shiftKey: true });
  assert.equal(s.commands[0].key, 'O');
});

test('missing adapter Vim leaves the key available to the editor', () => {
  const s = setup();
  delete s.editor.constructor.Vim;
  assert.ok(!s.dispatch().defaultPrevented);
  assert.equal(s.commands.length, 0);
});

test('an unavailable adapter handler does not swallow the key', () => {
  const s = setup();
  s.editor.constructor.Vim.handleKey = undefined;
  assert.ok(!s.dispatch().defaultPrevented);
  assert.equal(s.commands.length, 0);
});

for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) test(`${modifier} shortcuts pass through`, () => {
  const s = setup(), e = s.dispatch({ [modifier]: true });
  assert.ok(!e.defaultPrevented); assert.equal(s.commands.length, 0);
});

for (const state of ['insertMode', 'visualMode', 'expectLiteralNext']) test(`${state} keeps its native o/ㅐ behavior`, () => {
  const s = setup(); s.editor.state.vim[state] = true;
  assert.ok(!s.dispatch({ key: 'ㅐ' }).defaultPrevented); assert.equal(s.commands.length, 0);
});

test('non-Vim editors, other keys, and other DOM targets are untouched', () => {
  const s = setup();
  assert.ok(!s.dispatch({ code: 'KeyA' }).defaultPrevented);
  assert.ok(!s.dispatch({ target: {} }).defaultPrevented);
  s.editor.state.vim = undefined;
  assert.ok(!s.dispatch().defaultPrevented);
});

test('text controls inside the editor keep normal typing', () => {
  const s = setup();
  const control = {insideEditor: true, closest: () => control};
  const e = s.dispatch({target: control, key: 'o'});
  assert.ok(!e.defaultPrevented);
  assert.equal(s.commands.length, 0);
});

test('a following Escape cancels a stale Korean restoration', () => {
  const s = setup(); s.plugin.prevVimMode = 'insert'; s.plugin.onVimModeChanged({ mode: 'normal' });
  s.dispatch(); s.editor.state.vim.insertMode = false; s.plugin.onVimModeChanged({ mode: 'normal' });
  s.flush(); assert.equal(s.im(), 'English'); assert.equal(s.pending(), 0);
  assert.equal(s.plugin.imToRestore, 'Korean');
  s.dispatch(); s.flush(); assert.equal(s.im(), 'Korean');
});

test('duplicate mode notifications restore only once', () => {
  const s = setup(); s.plugin.imToRestore = 'Korean';
  s.plugin.onVimModeChanged({ mode: 'insert' }); s.plugin.onVimModeChanged({ mode: 'insert' });
  assert.equal(s.pending(), 1); s.flush(); assert.deepEqual(s.calls, ['Korean']);
});

test('unload cancels pending input-source changes', () => {
  const s = setup(); s.plugin.onVimModeChanged({ mode: 'insert' }); s.plugin.onunload();
  s.flush(); assert.deepEqual(s.calls, []);
});

test('registering an existing Insert editor tracks its mode and removes its handler on unload', () => {
  const s = setup(); s.editor.state.vim.insertMode = true;
  let handler;
  s.editor.on = (event, callback) => { assert.equal(event, 'vim-mode-change'); handler = callback; };
  s.editor.off = (event, callback) => { assert.equal(event, 'vim-mode-change'); assert.equal(callback, handler); handler = null; };
  s.plugin.registerVimModeChangeEvent(); assert.equal(s.plugin.prevVimMode, 'insert');
  handler({ mode: 'normal' }); assert.equal(s.im(), 'English');
  s.cleanup.forEach(callback => callback()); assert.equal(handler, null);
});
