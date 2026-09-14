const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const source = fs.readFileSync(process.env.PASTE_BUNDLE || path.join(__dirname, 'main.js'), 'utf8');
const registrationStart = source.indexOf('      this.registerEvent(this.app.workspace.on("editor-paste"');
const start = registrationStart < 0 ? source.indexOf('      this.app.workspace.on("editor-paste"') : registrationStart;
const code = source.slice(start, source.indexOf('      Object.values(Mode).forEach', start));
const html = '<table><thead><tr><th>구분</th><th>변동제조원가</th><th>고정제조간접원가</th></tr></thead><tbody><tr><td>고정예산</td><td>기준조업도 × SP</td><td>고정제조간접원가예산<br>두 번째 줄</td></tr></tbody></table>';
const text = '구분\t변동제조원가\t고정제조간접원가\n고정예산\t기준조업도 × SP\t고정제조간접원가예산\n두 번째 줄';

async function paste(mode, types, options = {}) {
  let handler, registered, output;
  const eventRef = {};
  const plugin = {
    settings: {mode, saveFilesLocation: 'Attachments', saveFilesOverrideLocations: []},
    app: {workspace: {on: (_, fn) => {handler = fn; return eventRef;}, getActiveFile: () => ({path:'test.md',parent:{path:''}})}},
    registerEvent: ref => {registered = ref;}
  };
  const context = vm.createContext({Mode:Object.fromEntries(['Text','Markdown','Passthrough','CodeBlock','TextBlockquote','MarkdownBlockquote','CodeBlockBlockquote'].map(k=>[k,k])),
    __async: async (self, args, fn) => {
      const it = fn.apply(self, args || []);
      let step = it.next();
      while (!step.done) step = it.next(await step.value);
      return step.value;
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'table-in-list.js'),'utf8') + '\n(function(){' + code + '})', context).call(plugin);
  const evt = {defaultPrevented:!!options.prevented, clipboardData:{files:[],getData:type=>types[type] || ''}, preventDefault(){this.defaultPrevented=true;}};
  await handler(evt, {getCursor:()=>({line:0}),getLine:()=>options.line || '',transaction:value=>{output=value.replaceSelection;}});
  return {prevented:evt.defaultPrevented,output,registered:registered === eventRef};
}

for (const mode of ['Text','Markdown']) test(`${mode}: HTML tables reach native paste without flattening cells`, async () => {
  const r = await paste(mode, {'text/html':html,text});
  assert.equal(r.prevented,false);
  assert.equal(r.output,undefined);
});
test('Plain text keeps the existing indentation behavior', async () => {
  const r=await paste('Text',{text:'첫 줄\n둘째 줄','text/html':'<p>첫 줄</p><p>둘째 줄</p>'},{line:'  - '});
  assert.equal(r.prevented,true);
  assert.equal(r.output,'첫 줄\n    둘째 줄');
});
test('Explicit code-block mode still pastes table text as code', async () => {
  const r=await paste('CodeBlock',{'text/html':html,text});
  assert.equal(r.prevented,true);
  assert.equal(r.output,'```\n'+text+'\n```');
});
test('Passthrough leaves the native paste event untouched', async () => {
  const r=await paste('Passthrough',{text:'내용'});
  assert.equal(r.prevented,false);
  assert.equal(r.output,undefined);
});
test('Paste already handled by another plugin is not inserted again', async () => {
  const r=await paste('Text',{'text/html':html,text},{prevented:true});
  assert.equal(r.output,undefined);
});
test('The paste listener is registered for cleanup on plugin reload', async () => {
  assert.equal((await paste('Text',{text:'내용'})).registered,true);
});
