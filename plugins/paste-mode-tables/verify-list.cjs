const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test'),assert=require('node:assert/strict');
const md='| 질문 | 답 |\n| --- | --- |\n| 비용 | **고정**<br>{{1;;변동}} $a+b$ ![[사진.png]] |';
const helper=vm.runInNewContext(fs.readFileSync(path.join(__dirname,'table-in-list.js'),'utf8')+';pasteTableInList',{
  import_obsidian:{htmlToMarkdown:()=>md},
  require:()=>({ensureSyntaxTree:()=>({resolveInner:()=>({name:'HyperMD-codeblock'})})})
});
function paste(line,options={}){
 const ch=options.ch??line.length;let output,prevented=false;
 const event={clipboardData:{getData:type=>options.types?options.types[type]||'':type==='text/plain'?md:''},preventDefault(){prevented=true;}};
 const editor={getCursor:()=>({line:0,ch}),getLine:()=>line,getSelection:()=>options.selection||'',listSelections:()=>Array(options.cursors||1).fill({}),inTableCell:!!options.tableCell,
  cm:options.code?{state:{}}:null,posToOffset:()=>0,transaction:t=>{output=t.replaceSelection;}};
 const handled=helper(event,editor);return {handled,prevented,output};
}
for(const [line,indent] of [['- ','  '],['\t- 제목','\t  '],['  - ','    '],['10. 항목','    '],['- [ ] 항목','  ']]){
 test('table block inside '+JSON.stringify(line),()=>{
  const r=paste(line);assert.equal(r.handled,true);assert.equal(r.prevented,true);
  assert.equal(r.output,'\n'+indent+'\n'+md.split('\n').map(x=>indent+x).join('\n')+'\n'+indent);
 });
}
test('HTML keeps converted cells and line breaks',()=>assert.equal(paste('- ',{types:{'text/html':'<table></table>'}}).output,paste('- ').output));
test('Markdown payload preserves cloze/math/media over HTML',()=>assert.equal(paste('- ',{types:{'text/markdown':md,'text/html':'<table></table>','text/plain':'flattened'}}).output,paste('- ').output));
test('one-column table with compact separator',()=>assert.equal(paste('- ',{types:{'text/plain':'| 값 |\n| - |\n| 1 |'}}).handled,true));
for(const [name,line,opts] of [
 ['plain paragraph','내용',{}],['middle of item','- 내용',{ch:2}],['selection','- 내용',{selection:'내용'}],['multiple cursors','- ',{cursors:2}],['existing table cell','- ',{tableCell:true}],['code context','- ',{code:true}],['non-table clipboard','- ',{types:{'text/plain':'일반 문장'}}]
])test(name+' is left to existing paste',()=>assert.deepEqual(paste(line,opts),{handled:false,prevented:false,output:undefined}));
