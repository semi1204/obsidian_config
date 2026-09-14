const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const bundle = process.env.OSR_BUNDLE;
if (!bundle) throw new Error('Set OSR_BUNDLE to the patched Spaced Repetition main.js');
const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config/plugin-settings/spaced-repetition.json'))).settings;
const obsidian = new Proxy({ Platform: {}, moment: { locale: () => 'en' }, getLanguage: () => 'en' }, {
  get: (object, key) => key in object ? object[key] : class {}
});
const context = vm.createContext({ module: { exports: {} }, exports: {}, require: name => name === 'obsidian' ? obsidian : require(name), window: {}, navigator: { language: 'en' }, console, Buffer, URL, setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync(bundle, 'utf8'), context);
context.settingsForTest = settings;
vm.runInContext('DataStore.instance = new NotesDataStore(settingsForTest, null);', context);
function questions(text) {
  context.testText = text;
  return vm.runInContext(`parse(testText, settingsForTest).map(info => {
    const question = Question.Create(settingsForTest, info, null, 1, []);
    question.setCardList(CardFrontBackUtil.expand(question.questionType, question.questionText.actualQuestion, settingsForTest).map((pair, cardIdx) => new Card({...pair, cardIdx})));
    return question;
  })`, context);
}
const id = '1234567890abcdef1234567890abcdef';
const fixture = '#flashcards\n\n자산::부채 + 자본\n\n차변:::대변\n\n재무상태표\n???\n일정 시점의 재무상태\n\n매출\n????\n수익\n\n{{1;;자산}} = {{2;;부채}} + 자본\n\n계산식::$a^2 + b^2$ 및 **강조**\n';
fs.writeFileSync(path.join(__dirname, 'fixture.md'), fixture);

test('Mobile loads without Node APIs, retains native cards and ID hiding, and disables desktop Anki commands', async () => {
  const requested = [];
  const mobileApi = new Proxy({ ...obsidian, Platform: { isMobile: true, isIosApp: true } }, {
    get: (object, key) => key in object ? object[key] : class {}
  });
  const mobile = vm.createContext({ module: { exports: {} }, exports: {}, window: {}, navigator: { language: 'en' }, console, URL, setTimeout, clearTimeout,
    require: name => {
      requested.push(name);
      if (name === 'obsidian') return mobileApi;
      if (name === '@codemirror/state') return { StateField: { define: field => field }, EditorState: { transactionFilter: { of: filter => filter } } };
      if (name === '@codemirror/view') return { Decoration: {}, EditorView: { baseTheme: theme => theme } };
      throw new Error(`Node module unavailable on mobile: ${name}`);
    }
  });
  vm.runInContext(fs.readFileSync(bundle, 'utf8'), mobile);
  mobile.settingsForTest = settings;
  mobile.testText = '#### 배분법\n???\n\n| 구분 | 답 |\n| --- | --- |\n| A | {{하나}} |\n| B | {{둘}} |\n\n#### 목록\n- 생산량 > 판매량 ???\n  - 전부 > 변동 > 초변동';
  const pairs = vm.runInContext(`(() => {
    DataStore.instance = new NotesDataStore(settingsForTest, null);
    return parse(testText, settingsForTest).flatMap(info => {
      const q = Question.Create(settingsForTest, info, null, 1, []);
      return CardFrontBackUtil.expand(q.questionType, q.questionText.actualQuestion, settingsForTest);
    });
  })()`, mobile);
  assert.equal(pairs.length, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(pairs)), JSON.parse(JSON.stringify(
    questions(mobile.testText).flatMap(q => q.cards.map(({ front, back, isCloze }) => ({ front, back, ...(isCloze ? { isCloze } : {}) })))
  )));
  let editorExtensions;
  const Bridge = vm.runInContext('LocalAnkiBridge', mobile);
  const bridge = new Bridge({ manifest: { dir: 'plugin' },
    registerEditorExtension: value => { editorExtensions = value; },
    registerMarkdownPostProcessor: value => { assert.equal(typeof value, 'function'); },
    addCommand: () => assert.fail('Desktop-only Anki command on mobile'),
    addRibbonIcon: () => assert.fail('Desktop-only Anki ribbon on mobile')
  });
  bridge.install();
  assert.equal(editorExtensions.length, 3);
  assert.equal(bridge.crypto, null);
  assert.ok(!requested.includes('crypto'));
  await assert.rejects(bridge.invoke('version'), /Mac의 Obsidian/);
});

test('Original single, reversed, multiline, multiline reversed, cloze, and math cards still expand', () => {
  const list = questions(fixture);
  assert.equal(list.length, 6);
  assert.deepEqual(Array.from(list, q => q.cards.length), [1, 2, 1, 2, 2, 1]);
});

test('Stable IDs survive parsing and SR note rewrites without appearing on cards or changing scheduling hashes', () => {
  for (const question of questions(fixture)) {
    const original = question.questionText.original;
    const tagged = `${original}\n<!--ANKI:${id}-->`;
    const parsed = questions(tagged)[0];
    assert.equal(parsed.questionText.ankiId, id);
    assert.equal(parsed.questionText.textHash, question.questionText.textHash);
    assert.equal(parsed.questionText.actualQuestion, question.questionText.actualQuestion);
    const rewritten = parsed.formatForNote(settings);
    assert.equal(questions(rewritten)[0].questionText.ankiId, id);
    for (const card of parsed.cards) assert.ok(!card.front.includes('ANKI:') && !card.back.includes('ANKI:'));
  }
});

test('SR scheduling comments, block references, fenced code, and following cards retain their boundaries', () => {
  for (const original of [
    '질문::답 ^existing-block\n<!--SR:!2026-09-11,2,250-->',
    '질문::답 <!--SR:!2026-09-11,2,250--> ^existing-block',
    '코드\n???\n```js\nconst x = "::";\n```',
    '단서 {{정답}}\n<!--SR:!2026-09-11,2,250-->'
  ]) {
    const before = questions(original)[0];
    const after = questions(`${original}\n<!--ANKI:${id}-->\n\n다음::답`);
    assert.equal(after.length, 2);
    assert.equal(after[0].questionText.ankiId, id);
    assert.equal(after[0].questionText.actualQuestion, before.questionText.actualQuestion);
    assert.equal(after[0].questionText.obsidianBlockId, before.questionText.obsidianBlockId);
    assert.equal(after[1].questionText.actualQuestion, '다음::답');
  }
});

test('ID insertion preserves all questions and prevents writes when the user edits during sync', async () => {
  const Bridge = vm.runInContext('LocalAnkiBridge', context);
  let current = fixture;
  const bridge = new Bridge({ manifest: { dir: 'plugin' }, app: { vault: { process: async (_, mutate) => { current = mutate(current); } } } });
  await bridge.assignIds({ file: {}, original: fixture, questions: questions(fixture) });
  const parsed = questions(current);
  assert.equal(parsed.length, 6);
  assert.equal(new Set(parsed.map(q => q.questionText.ankiId)).size, 6);
  assert.deepEqual(Array.from(parsed, q => q.cards.length), [1, 2, 1, 2, 2, 1]);
  current = fixture + '\n새 편집';
  await assert.rejects(bridge.assignIds({ file: {}, original: fixture, questions: questions(fixture) }), /노트가 변경/);
  assert.equal(current, fixture + '\n새 편집');
});

test('Repeated sync edits fields in place and never calls Anki scheduling or deletion APIs', async () => {
  const Bridge = vm.runInContext('LocalAnkiBridge', context);
  const bridge = new Bridge({ manifest: { dir: 'plugin' }, dataManager: { settingsManager: { settings } }, app: { vault: { getName: () => '회계사' } } });
  bridge.render = async text => text;
  let existing;
  const calls = [];
  bridge.invoke = async (action, params) => {
    calls.push(action);
    if (action === 'findNotes') return existing ? [42] : [];
    if (action === 'notesInfo') return [existing];
    if (action === 'createDeck') return 1;
    if (action === 'cardsInfo') return [{ cardId: 84, deckName: '회계사' }];
    if (action === 'addNote') { existing = { noteId: 42, cards: [84], modelName: bridge.model, fields: Object.fromEntries(Object.entries(params.note.fields).map(([key, value]) => [key, {value}])) }; return 42; }
    if (action === 'updateNoteFields') { assert.equal(params.note.id, 42); for (const [key, value] of Object.entries(params.note.fields)) existing.fields[key] = { value }; return null; }
    throw new Error(`Unexpected action ${action}`);
  };
  const report = { created: 0, updated: 0, unchanged: 0, moved: 0, noteIds: [] };
  const question = questions(`질문::답\n<!--ANKI:${id}-->`)[0];
  await bridge.syncCard(question.cards[0], question, { path: 'test.md' }, report);
  await bridge.syncCard(question.cards[0], question, { path: 'test.md' }, report);
  question.cards[0].front = '수정된 질문';
  question.cards[0].back = '수정된 답';
  await bridge.syncCard(question.cards[0], question, { path: 'renamed.md' }, report);
  assert.deepEqual(report, { created: 1, updated: 1, unchanged: 1, moved: 0, noteIds: [42, 42, 42] });
  assert.ok(calls.every(action => ['findNotes', 'notesInfo', 'addNote', 'updateNoteFields', 'createDeck', 'cardsInfo'].includes(action)));
});

function treeBridge(options = {}) {
  const Bridge = vm.runInContext('LocalAnkiBridge', context);
  return new Bridge({ manifest: { dir: 'plugin' }, dataManager: { settingsManager: { settings: { ...settings, ...options } } }, app: { vault: { getName: () => '회계사' } } });
}

function classified(...paths) {
  return { topicPathList: { list: paths.map(path => ({ path: path.split('/') })) } };
}

test('Nested tags become Anki subdecks, with parent tags resolving to their most specific descendant', () => {
  const bridge = treeBridge();
  assert.equal(bridge.getDeckName(classified('flashcards/이론/원가/오답내역')), '회계사::이론::원가::오답내역');
  assert.equal(bridge.getDeckName(classified('flashcards')), '회계사');
  assert.equal(bridge.getDeckName(classified('flashcards', 'flashcards/기출', 'flashcards/기출/1회')), '회계사::기출::1회');
  assert.equal(bridge.getDeckName(classified('flashcards/기출/1회', 'flashcards/기출/1회')), '회계사::기출::1회');
  assert.throws(() => bridge.getDeckName(classified('flashcards/기출', 'flashcards/이론')), /한 카드는 한 Anki 덱/);
  assert.throws(() => bridge.getDeckName(classified('flashcards/원가::오답')), /콜론/);
});

test('Folder mode uses the full folder tree and configured tag roots preserve their descendants', () => {
  const bridge = treeBridge({ convertFoldersToDecks: true });
  assert.equal(bridge.getDeckName(classified('이론/원가/오답내역')), '회계사::이론::원가::오답내역');
  assert.equal(bridge.getDeckName(classified('flashcards/원가')), '회계사::flashcards::원가');
  assert.equal(treeBridge({ flashcardTags: ['#study'] }).getDeckName(classified('study/기출/1회')), '회계사::기출::1회');
});

test('Changing classification moves the existing card without creating a duplicate or touching its schedule', async () => {
  const bridge = treeBridge();
  bridge.render = async text => text;
  const question = questions(`질문::답\n<!--ANKI:${id}-->`)[0];
  Object.assign(question, classified('flashcards/이론/원가/오답내역'));
  const existing = { noteId: 42, modelName: bridge.model, cards: [84], fields: { Key: { value: `${id}-0` } } };
  const calls = [];
  bridge.invoke = async (action, params) => {
    calls.push([action, params]);
    if (action === 'findNotes') return [42];
    if (action === 'notesInfo') return [existing];
    if (action === 'createDeck') return 1;
    if (action === 'cardsInfo') return [{ cardId: 84, deckName: '회계사::기출::1회', reps: 12, interval: 30 }];
    if (action === 'changeDeck') return null;
    if (action === 'updateNoteFields') return null;
    throw new Error(`Unexpected action ${action}`);
  };
  const report = { created: 0, updated: 0, unchanged: 0, moved: 0, noteIds: [] };
  await bridge.syncCard(question.cards[0], question, { path: 'test.md' }, report);
  assert.equal(report.created, 0);
  assert.equal(report.moved, 1);
  assert.deepEqual(report.noteIds, [42]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(([action]) => action === 'changeDeck')[1])), { cards: [84], deck: '회계사::이론::원가::오답내역' });
  assert.ok(calls.every(([action]) => ['findNotes', 'notesInfo', 'createDeck', 'cardsInfo', 'changeDeck', 'updateNoteFields'].includes(action)));
});

test('Standalone child-list faces lose parent indentation while nested lists and intentional code remain intact', () => {
  const bridge = treeBridge();
  assert.equal(bridge.normalizeListIndent('\t- ![](../Sorce/image.png)\n\t- ==강조==\n\t\t- 중첩'), '- ![](../Sorce/image.png)\n- ==강조==\n    - 중첩');
  assert.equal(bridge.normalizeListIndent('  - 답\n    - 세부'), '- 답\n  - 세부');
  assert.equal(bridge.normalizeListIndent('    const value = 1;'), '    const value = 1;');
  assert.equal(bridge.normalizeListIndent('```js\n    value();\n```'), '```js\n    value();\n```');
});

test('Anki context contains the note title and ordered heading ancestry, with aliases and HTML escaped', async () => {
  const html = await treeBridge().contextHtml({ questionContext: ['원가 분류', '[[단원|제조원가]]', '<script>'] }, { path: 'Rough Notes/원가.md', basename: '원가' });
  assert.equal(html, '<div class="osr-context">원가 › 원가 분류 › 제조원가 › &lt;script&gt;</div>');
});

test('Local, Obsidian resource, remote, and inline images share portable hashed Anki media names', async () => {
  const bridge = treeBridge();
  const bytes = Buffer.from('same image bytes');
  const found = [];
  bridge.plugin.app.vault.adapter = { getBasePath: () => '/test/vault' };
  bridge.plugin.app.vault.readBinary = async () => bytes;
  bridge.plugin.app.metadataCache = { getFirstLinkpathDest: (path, source) => { found.push([path, source]); return { extension: 'png' }; } };
  bridge.api = { requestUrl: async () => ({ arrayBuffer: bytes, headers: { 'content-type': 'image/png' } }) };
  bridge.mediaSent = new Set();
  const stored = [];
  bridge.invoke = async (action, params) => { assert.equal(action, 'storeMediaFile'); stored.push(params); };
  const names = [];
  for (const link of ['../images/a%20b.png', 'app://local/test/vault/images/a%20b.png?123', 'data:image/png;base64,' + bytes.toString('base64'), 'https://example.com/image']) names.push(await bridge.media(link, 'folder/note.md'));
  assert.equal(new Set(names).size, 1);
  assert.match(names[0], /^osr-[a-f0-9]{32}\.png$/);
  assert.equal(stored.length, 1);
  assert.deepEqual(found, [['../images/a b.png', 'folder/note.md'], ['images/a b.png', 'folder/note.md']]);
  assert.equal(stored[0].data, bytes.toString('base64'));
});

test('Model presentation is upgraded once and stays stable on later syncs', async () => {
  const bridge = treeBridge();
  const state = {
    css: '.user-rule{color:red}\n/* OSR presentation start */old/* OSR presentation end */',
    templates: { '복습': { Front: '{{Front}}', Back: '{{FrontSide}}<hr id="answer">{{Back}}' } }
  };
  const updates = [];
  bridge.invoke = async (action, params) => {
    if (action === 'modelNames') return [bridge.model];
    if (action === 'modelFieldNames') return ['Key', 'Front', 'Back', 'Source'];
    if (action === 'modelTemplates') return state.templates;
    if (action === 'modelStyling') return { css: state.css };
    if (action === 'updateModelTemplates') { state.templates = params.model.templates; updates.push(action); return; }
    if (action === 'updateModelStyling') { state.css = params.model.css; updates.push(action); return; }
    if (action === 'createDeck') return;
    throw new Error(`Unexpected action ${action}`);
  };
  await bridge.ensureModel();
  const once = JSON.stringify(state);
  await bridge.ensureModel();
  assert.equal(JSON.stringify(state), once);
  assert.deepEqual(updates, ['updateModelTemplates', 'updateModelStyling']);
  assert.ok(state.css.startsWith('.user-rule{color:red}'));
  assert.equal((state.css.match(/OSR presentation start/g) || []).length, 1);
});

test('Cloze and inline answers replace the front with a single complete answer', async () => {
  const bridge = treeBridge();
  bridge.render = async text => `<div class="osr-content">${text}</div>`;
  const sent = [];
  bridge.invoke = async (action, params) => {
    if (action === 'findNotes') return [];
    if (action === 'createDeck') return;
    if (action === 'addNote') { sent.push(params.note); return sent.length; }
    throw new Error(`Unexpected action ${action}`);
  };
  for (const text of ['| 항목 | 값 |\n| --- | --- |\n| A | {{정답}} |', '질문::답']) {
    const question = questions(`${text}\n<!--ANKI:${id}-->`)[0];
    question.questionContext = ['과목', '79번'];
    await bridge.syncCard(question.cards[0], question, { path: '1회.md' }, { created: 0, noteIds: [] });
  }
  assert.match(sent[0].fields.Back, /^<div class="osr-cloze-answer"><div class="osr-context">1회 › 과목 › 79번<\/div>/);
  assert.ok(sent[0].fields.Back.includes('정답'));
  assert.ok(!sent[0].fields.Back.includes('[...]'));
  assert.equal((sent[0].fields.Back.match(/osr-context/g) || []).length, 1);
  assert.equal(sent[1].fields.Back, '<div class="osr-inline-answer"><div class="osr-context">1회 › 과목 › 79번</div><div class="osr-content">질문 → 답</div></div>');
  assert.deepEqual(Object.keys(sent[0].fields), ['Key', 'Front', 'Back', 'Source']);
});

test('A following heading stays out of a cloze table and nested categories expand at both levels', () => {
  const source = `#flashcards/demo
### 항목 79
#### 첫 질문
???
- 첫 답
<!--ANKI:e04974cdd1ff4ff49dd706b1e9fe87c5-->

| 구분 | 값 |
| --- | --- |
| A | {{정답}} |
<!--ANKI:61a7354fbd0c40cc8dda4f8b0a2fa01d-->
### 항목 80
#### 큰 분류
???
1. 작은 분류
   ???
\t1. 세부 A
\t2. 세부 B
\t3. 세부 C
\t   ---
\t4. 세부 D
<!--ANKI:5061bf2cddf644f6ba5091506c512916-->`;
  const list = questions(source);
  assert.equal(list.length, 3);
  assert.equal(list[1].questionText.ankiId, '61a7354fbd0c40cc8dda4f8b0a2fa01d');
  assert.ok(list[1].cards.every(card => !card.front.includes('항목 80') && !card.back.includes('항목 80')));
  const category = list[2];
  assert.equal(category.questionText.ankiId, '5061bf2cddf644f6ba5091506c512916');
  assert.equal(category.cards.length, 2);
  assert.equal(category.cards[0].front.trim(), '#### 큰 분류');
  assert.equal(category.cards[0].back.trim(), '1. 작은 분류\n\t1. 세부 A\n\t2. 세부 B\n\t3. 세부 C\n\t   ---\n\t4. 세부 D');
  assert.equal(category.cards[1].front.trim(), '작은 분류');
  assert.match(category.cards[1].back, /1\. 세부 A/);
  assert.match(category.cards[1].back, /4\. 세부 D/);
  assert.ok(category.cards.every(card => !card.front.includes('???') && !card.back.includes('???')));
  assert.deepEqual(Array.from(questions(category.formatForNote(settings))[0].cards, card => [card.front, card.back]), Array.from(category.cards, card => [card.front, card.back]));
});

test('Peer and ancestor headings start new questions before IDs exist, while deeper answer headings remain content', () => {
  for (const type of ['???', '????']) {
    const list = questions(`### 79번\n${type}\n답\n#### 세부 설명\n추가 답\n### 80번\n${type}\n다음 답`);
    assert.equal(list.length, 2);
    assert.equal(list[0].parsedQuestionInfo.firstLineNum, 0);
    assert.equal(list[0].parsedQuestionInfo.lastLineNum, 4);
    assert.equal(list[1].parsedQuestionInfo.firstLineNum, 5);
    assert.ok(list[0].cards[0].back.includes('#### 세부 설명'));
    assert.ok(!list[0].cards[0].back.includes('80번'));
    assert.equal(list[1].cards[0].front, '### 80번');
  }
  const cloze = questions('### 79번\n| A | B |\n| --- | --- |\n| 값 | {{답}} |\n## 다음 단원\n질문::답');
  assert.equal(cloze.length, 2);
  assert.ok(!cloze[0].cards[0].back.includes('다음 단원'));
});

test('Stable IDs close adjacent questions without consuming the following heading or changing IDs on a second parse', async () => {
  const otherId = 'abcdefabcdefabcdefabcdefabcdefab';
  const text = `#### 첫 질문\n???\n답\n<!--SR:!2026-09-11,2,250-->\n<!--ANKI:${id}-->\n##### 다음 질문\n???\n다음 답\n<!--ANKI:${otherId}-->`;
  const list = questions(text);
  assert.equal(list.length, 2);
  assert.equal(list[0].questionText.ankiId, id);
  assert.equal(list[1].questionText.ankiId, otherId);
  assert.equal(list[0].parsedQuestionInfo.lastLineNum, 4);
  assert.equal(list[1].parsedQuestionInfo.firstLineNum, 5);
  assert.equal(list[1].cards[0].front, '##### 다음 질문');
  const withoutIds = text.replace(/\n<!--ANKI:[a-f0-9]{32}-->/g, '').replace('##### 다음', '#### 다음');
  let current = withoutIds;
  const bridge = treeBridge();
  bridge.plugin.app.vault.process = async (_, mutate) => { current = mutate(current); };
  await bridge.assignIds({ file: {}, original: withoutIds, questions: questions(withoutIds) });
  const assigned = questions(current);
  assert.equal(assigned.length, 2);
  assert.deepEqual(Array.from(assigned, q => q.cards[0].front), ['#### 첫 질문', '#### 다음 질문']);
  assert.equal(new Set(assigned.map(q => q.questionText.ankiId)).size, 2);
  const before = current;
  await bridge.assignIds({ file: {}, original: current, questions: assigned });
  assert.equal(current, before);
});

test('Category answers include the complete subtree, with sibling boundaries and reversed child cards preserved', () => {
  const text = '# 큰 분류\n???\n1. 작은 A\n   ???\n   1. 세부 A\n      ???\n      - 내용 A\n   2. 세부 B\n2. 작은 B\n   ????\n   - 내용 B';
  const list = questions(text);
  assert.equal(list.length, 1);
  assert.equal(list[0].questionType, 2);
  assert.deepEqual(Array.from(list[0].cards, c => [c.front.trim(), treeBridge().normalizeListIndent(c.back).trim()]), [
    ['# 큰 분류', '1. 작은 A\n   1. 세부 A\n      - 내용 A\n   2. 세부 B\n2. 작은 B\n   - 내용 B'],
    ['작은 A', '1. 세부 A\n   - 내용 A\n2. 세부 B'],
    ['세부 A', '- 내용 A'],
    ['작은 B', '- 내용 B'],
    ['- 내용 B', '작은 B']
  ]);
});

test('Indented code, display math, and inline code keep literal markers and headings inside a card', () => {
  const text = '### 코드 예시\n???\n- 코드\n    ````md\n    ```\n    ### 가짜 헤더\n    ???\n    ---\n    ```\n    ````\n$$\nx = 1\n\n# 기호\n$$\n`???` 그대로\n### 실제 다음\n다음::답';
  const list = questions(text);
  assert.equal(list.length, 2);
  assert.equal(list[0].cards.length, 1);
  assert.ok(list[0].cards[0].back.includes('    ### 가짜 헤더\n    ???\n    ---'));
  assert.ok(list[0].cards[0].back.includes('$$\nx = 1\n\n# 기호\n$$'));
  assert.ok(list[0].cards[0].back.includes('`???` 그대로'));
  assert.ok(!list[0].cards[0].back.includes('실제 다음'));
});

test('List dividers cannot turn the preceding item into a heading; table borders and explicit headings stay intact', () => {
  const normalize = text => { context.dividerText = text; return vm.runInContext('localNormalizeListDividers(dividerText)', context); };
  const source = '1. 첫 항목\n   1. 작은 항목\n      ---\n   2. 다른 항목\n2. 마지막';
  assert.equal(normalize(source), source.replace('      ---', '      <hr>'));
  assert.equal(normalize('1. 첫 항목\n   이어지는 문장\n   ---'), '1. 첫 항목\n   이어지는 문장\n   <hr>');
  for (const unchanged of ['제목\n---', '| A | B |\n| --- | --- |', '1. 항목\n\n#### 명시적 제목', '1. 항목\n별도 문단\n---']) assert.equal(normalize(unchanged), unchanged);
});

test('Heading cards retain paragraph breaks, tables, images, and math up to their section boundary', () => {
  const text = '#### 이익차이 조정\n\n???\n\n| 구분 | 조정항목 |\n| --- | --- |\n| 시작 | 초변동 영업이익 |\n\n설명 문단\n\n![[표.png]]\n\n$$\nx = 1\n\n+ 2\n$$\n\n#### 다음 질문\n???\n다음 답';
  const list = questions(text);
  assert.equal(list.length, 2);
  assert.equal(list[0].cards[0].front.trim(), '#### 이익차이 조정');
  assert.match(list[0].cards[0].back, /초변동 영업이익/);
  assert.match(list[0].cards[0].back, /설명 문단\n\n!\[\[표.png\]\]/);
  assert.match(list[0].cards[0].back, /\$\$\nx = 1\n\n\+ 2\n\$\$/);
  assert.ok(!list[0].cards[0].back.includes('다음 질문'));
});

test('A blank before the first answer is allowed, but unheaded cards still use blank-line boundaries', () => {
  const list = questions('질문\n???\n\n답\n\n다른 질문\n???\n다른 답');
  assert.equal(list.length, 2);
  assert.equal(list[0].cards[0].back.trim(), '답');
  assert.equal(list[1].cards[0].front, '다른 질문');
});

test('An explicit next question after a blank is not swallowed by a heading card', () => {
  for (const next of ['다음 질문\n???\n다음 답', '다음 질문::다음 답']) {
    const list = questions('#### 첫 질문\n???\n첫 답\n\n'+next);
    assert.equal(list.length, 2);
    assert.equal(list[0].cards[0].back.trim(), '첫 답');
    assert.equal(list[1].cards[0].front.trim(), '다음 질문');
  }
});

test('Empty drafts do not create cards or receive new Anki IDs', async () => {
  for (const marker of ['???', '????']) for (const tail of ['', '\n\n', '\n<!-- 설명만 있음 -->', `\n<!--ANKI:${id}-->`]) {
    const source = '#### 작성 중\n'+marker+tail;
    assert.equal(questions(source).length, 0, source);
  }
  assert.equal(questions('???\n답만 있음').length, 0);
  let source = '#### 작성 중\n???\n\n#### 완성\n???\n답';
  const bridge = treeBridge();
  bridge.plugin.app.vault.process = async (_, mutate) => { source = mutate(source); };
  await bridge.assignIds({file:{},original:source,questions:questions(source)});
  assert.equal((source.match(/<!--ANKI:/g)||[]).length, 1);
  assert.equal(questions(source)[0].cards[0].front, '#### 완성');
});

test('A premature ID is metadata, not an empty answer, and conflicting IDs fail without choosing one', () => {
  const source = `#### 표 질문\n???\n<!--ANKI:${id}-->\n\n| A | B |\n| --- | --- |\n| 시작 | 답 |`;
  const list = questions(source);
  assert.equal(list.length, 1);
  assert.equal(list[0].questionText.ankiId, id);
  assert.match(list[0].cards[0].back, /시작/);
  assert.equal(questions(list[0].formatForNote(settings))[0].questionText.ankiId, id);
  assert.throws(() => questions(source+'\n<!--ANKI:abcdefabcdefabcdefabcdefabcdefab-->'), /Anki ID/);
});

test('Blank lines around nested markers preserve the complete parent and each child subtree', () => {
  const list = questions('#### 분류\n???\n\n1. 작은 A\n\n   ???\n\n   - 설명 A\n\n2. 작은 B\n   ????\n\n   - 설명 B\n\n#### 다음\n???\n답');
  assert.equal(list.length, 2);
  assert.equal(list[0].cards.length, 4);
  assert.ok(!list[0].cards[0].back.includes('???'));
  assert.match(list[0].cards[0].back, /설명 A[\s\S]*설명 B/);
  assert.equal(list[0].cards[1].front.trim(), '작은 A');
  assert.equal(list[0].cards[1].back.trim(), '- 설명 A');
  assert.equal(list[0].cards[2].front.trim(), '작은 B');
});

test('Inline separators in an existing answer cannot discard its question or split table cells', () => {
  const list = questions('#### 문법\n???\n| 기호 | 예 |\n| --- | --- |\n| 범위 | a::b |\n`q::a`는 예시\n<!--ANKI:'+id+'-->');
  assert.equal(list.length, 1);
  assert.equal(list[0].cards[0].front, '#### 문법');
  assert.match(list[0].cards[0].back, /a::b/);
});

test('Comments are not questions and cannot eat the following question', () => {
  const list = questions('<!--\n???\n{{가짜}}\n-->\n질문::답');
  assert.equal(list.length, 1);
  assert.equal(list[0].cards[0].front, '질문');
});

test('Heading blocks preserve IDs, line ranges and repeated ID assignment across paragraph breaks', async () => {
  let source = '#### 첫 질문\n???\n\n답\n\n추가 답\n\n#### 둘째\n???\n답';
  const bridge = treeBridge();
  bridge.plugin.app.vault.process = async (_, mutate) => { source = mutate(source); };
  await bridge.assignIds({file:{},original:source,questions:questions(source)});
  const first = questions(source);
  assert.equal(first.length, 2);
  assert.match(first[0].cards[0].back, /답\n\n추가 답/);
  const snapshot = source;
  await bridge.assignIds({file:{},original:source,questions:first});
  assert.equal(source,snapshot);
  assert.deepEqual(Array.from(questions(source),q=>q.questionText.ankiId),Array.from(first,q=>q.questionText.ankiId));
});

test('Anki refuses an empty front or answer before making any API calls', async () => {
  const bridge = treeBridge();
  bridge.invoke = async () => { throw new Error('API must not be called'); };
  for (const pair of [{front:'질문',back:''},{front:'',back:'답'},{front:'질문',back:'<!-- 빈 답 -->'}]) {
    await assert.rejects(bridge.syncCard(pair, {}, {path:'test.md'}, {}), /빈|비어/);
  }
});

test('Empty notes, leading blank lines, and plain templates do not create cards or crash', () => {
  for (const text of ['', '\n', '\n\n', '\n# 제목\n\n일반 메모\n', '<!-- 메모 -->\n\n']) {
    assert.equal(questions(text).length, 0);
  }
});

test('A separator above a cloze table keeps its two original cloze indices and adds a complete-answer card', () => {
  const table = '| 구분 | 배분대상 |\n| --- | --- |\n| DM | {{원재료, 재공품}} |\n| 기타 | {{제품, 매출원가}} |';
  const old = questions(table+`\n<!--ANKI:${id}-->`)[0];
  const mixed = questions('#### 총원가 비례배분법\n???\n\n'+table+`\n\n<!--ANKI:${id}-->`)[0];
  assert.equal(mixed.questionText.ankiId, id);
  assert.equal(mixed.cards.length, 3);
  for (let i=0; i<2; i++) {
    assert.equal(mixed.cards[i].cardIdx, i);
    assert.equal(mixed.cards[i].front.trim(),old.cards[i].front.trim());
    assert.equal(mixed.cards[i].back.trim(),old.cards[i].back.trim());
    assert.equal(mixed.cards[i].isCloze,true);
  }
  assert.equal(mixed.cards[2].front,'#### 총원가 비례배분법');
  assert.match(mixed.cards[2].back,/원재료, 재공품/);
  assert.match(mixed.cards[2].back,/제품, 매출원가/);
  assert.ok(!mixed.cards[2].back.includes('{{'));
  assert.ok(!mixed.cards[2].isCloze);
  context.mixedText = mixed.questionText.actualQuestion;
  const native = vm.runInContext('new NoteQuestionParser(settingsForTest).createCardList(CardFrontBackUtil.expand(2,mixedText,settingsForTest),[])',context);
  assert.deepEqual(Array.from(native,c=>!!c.isCloze),[true,true,false]);
});

test('Cloze-like braces in code and math remain literal when mixed cards are expanded', () => {
  const code='```js\n{{literal}}\n```', math='$$\n\\frac{{a}}{{b}}\n$$';
  const list=questions('#### 문법\n???\n'+code+'\n\n'+math+'\n\n`{{inline}}` ${{x}}$와 \\({{y}}\\)\n\n실제 {{정답}}');
  assert.equal(list.length,1);
  assert.equal(list[0].cards.length,2);
  assert.match(list[0].cards[0].back, /^실제 <span/);
  assert.doesNotMatch(list[0].cards[0].back, /literal|frac|inline/);
  for (const card of list[0].cards.filter(c=>!c.isCloze)) {
    assert.ok(card.back.includes(code));
    assert.ok(card.back.includes(math));
    assert.ok(card.back.includes('`{{inline}}` ${{x}}$와 \\({{y}}\\)'));
  }
});

test('Mixed cloze answers use the single-table template while their full-answer card keeps the question', async () => {
  const bridge=treeBridge();bridge.render=async text=>`<div>${text}</div>`;
  const sent=[];
  bridge.invoke=async (action,params)=>{
    if(action==='findNotes')return [];
    if(action==='createDeck')return 1;
    if(action==='addNote'){sent.push(params.note);return sent.length;}
    throw Error(action);
  };
  const q=questions(`#### 표\n???\n\n| A | B |\n| --- | --- |\n| 값 | {{답}} |\n<!--ANKI:${id}-->`)[0];
  for(const c of q.cards)await bridge.syncCard(c,q,{path:'test.md'},{created:0,noteIds:[]});
  assert.match(sent[0].fields.Back,/^<div class="osr-cloze-answer">/);
  assert.ok(!sent[1].fields.Back.includes('osr-cloze-answer'));
  assert.equal(sent[0].fields.Key,`${id}-0`);
  assert.equal(sent[1].fields.Key,`${id}-1`);
});

test('Blank lines before metadata do not detach existing inline or cloze card IDs', () => {
  for (const source of ['질문::답','| A | B |\n| --- | --- |\n| 값 | {{답}} |']) {
    const list=questions(source+`\n\n<!--ANKI:${id}-->\n\n다음::답`);
    assert.equal(list.length,2);
    assert.equal(list[0].questionText.ankiId,id);
    assert.ok(!list[0].cards[0].back.includes('다음'));
    assert.equal(list[0].parsedQuestionInfo.lastLineNum,source.split('\n').length+1);
  }
});

test('Configured end markers retain multi-paragraph cards and close them explicitly', () => {
  context.settingsForTest={...settings,multilineCardEndMarker:'END'};
  try {
    const list=questions('질문\n???\n답\n\n추가 답\nEND\n다음\n???\n답\nEND');
    assert.equal(list.length,2);
    assert.equal(list[0].cards[0].back,'답\n\n추가 답');
    assert.equal(list[0].parsedQuestionInfo.lastLineNum,4);
  } finally {context.settingsForTest=settings;}
});

test('A trailing list separator uses its item as the front and only its subtree as the answer', () => {
  const source='# 전부원가계산\n\n- ### 비교\n\t- 생산량 > 판매량 ???\n\t\t- 전부 > 변동 > 초변동\n- ### 다음 항목\n\t- 다른 내용';
  const list=questions(source);
  assert.equal(list.length,1);
  assert.equal(list[0].cards.length,1);
  assert.equal(list[0].cards[0].front,'생산량 > 판매량');
  assert.equal(list[0].cards[0].back,'- 전부 > 변동 > 초변동');
  assert.equal(list[0].parsedQuestionInfo.firstLineNum,3);
  assert.equal(list[0].parsedQuestionInfo.lastLineNum,4);
});

test('Sibling trailing-list questions and ordinary sibling content stay separate without blank lines', () => {
  const list=questions('- 질문 A ???\n  - 답 A\n- 설명\n  - 카드가 아닌 내용\n- 질문 B ???\n  - 답 B\n본문');
  assert.deepEqual(Array.from(list,q=>[q.cards[0].front,q.cards[0].back]),[['질문 A','- 답 A'],['질문 B','- 답 B']]);
});

test('Trailing nested questions retain the complete parent answer and generate their own cards', () => {
  const list=questions('- 큰 분류 ???\n  - 작은 분류 ???\n    - 세부 답\n  - 다른 분류 ????\n    - 다른 답');
  assert.equal(list.length,1);
  assert.deepEqual(Array.from(list[0].cards,c=>c.front),['큰 분류','작은 분류','다른 분류','  - 다른 답']);
  assert.equal(list[0].cards[0].back,'- 작은 분류\n  - 세부 답\n- 다른 분류\n  - 다른 답');
  assert.ok(list[0].cards.every(c=>!c.front.includes('???')&&!c.back.includes('???')));
});

test('Trailing nested markers can be mixed with existing standalone parent and child separators', () => {
  const list=questions('#### 전체\n???\n- 하위 A ???\n  - 답 A\n- 하위 B\n  ???\n  - 답 B\n#### 다음 제목');
  assert.equal(list.length,1);
  assert.equal(list[0].cards.length,3);
  assert.equal(list[0].cards[0].back,'- 하위 A\n  - 답 A\n- 하위 B\n  - 답 B');
  assert.deepEqual(Array.from(list[0].cards.slice(1),c=>c.front),['하위 A','하위 B']);
});

test('Ordered lists and trailing reversed separators use the same subtree boundary', () => {
  const list=questions('  1. 질문 ????\n     - 정답\n  2. 다음 항목');
  assert.equal(list.length,1);
  assert.deepEqual(Array.from(list[0].cards,c=>[c.front,c.back]),[['질문','- 정답'],['- 정답','질문']]);
});

test('Trailing-list answers preserve blank paragraphs, tables, images and fenced math before the next sibling', () => {
  const list=questions('- 자료 ???\n\n  - ![[사진.png]]\n\n  | A | B |\n  | --- | --- |\n  | 값 | 값 |\n\n  $$\n  \\text{???}\n  $$\n- 다음');
  assert.equal(list.length,1);
  assert.equal(list[0].cards.length,1);
  assert.ok(list[0].cards[0].back.includes('\n\n| A | B |'));
  assert.ok(list[0].cards[0].back.includes('$$\n\\text{???}\n$$'));
  assert.ok(!list[0].cards[0].back.includes('다음'));
});

test('Trailing-list markers in code and math, escaped markers, ordinary prose and empty drafts are not cards', () => {
  for(const source of [
    '```md\n- 예시 ???\n  - 답\n```',
    '$$\n- 수식 ???\n  - 수식\n$$',
    '- `예시 ???`\n  - 설명',
    '- 예시 \\???\n  - 설명',
    '일반 문장 ???\n답',
    '- 작성 중 ???',
    '- 작성 중 ???\n- 다음 항목\n  - 다음 내용',
    '- 작성 중 ???\n들여쓰지 않은 내용'
  ]) assert.equal(questions(source).length,0,source);
});

test('Trailing-list IDs preserve source syntax, line numbers and stable cards on repeated assignment', async () => {
  const source='- 첫 질문 ???\n  - 답\n\n- 다음 질문 ???\n  - 다음 답';
  let current=source;
  const Bridge=vm.runInContext('LocalAnkiBridge',context);
  const bridge=new Bridge({manifest:{dir:'plugin'},app:{vault:{process:async(_,mutate)=>{current=mutate(current);}}}});
  const initial=questions(source);
  await bridge.assignIds({file:{},original:source,questions:initial});
  assert.equal(current.replace(/\n[ \t]*<!--ANKI:[a-f0-9]{32}-->/g,''),source);
  const parsed=questions(current);
  assert.deepEqual(Array.from(parsed,q=>q.questionText.ankiId),Array.from(initial,q=>q.questionText.ankiId));
  assert.deepEqual(Array.from(parsed,q=>q.cards[0].front),['첫 질문','다음 질문']);
  const withIds=current;
  await bridge.assignIds({file:{},original:current,questions:parsed});
  assert.equal(current,withIds);
  for(const q of parsed) assert.ok(q.formatForNote(settings).includes(q.cards[0].front+' ???'));
});

test('Trailing-list questions also support full-answer and cloze siblings', () => {
  const list=questions('- 표 ???\n  | 구분 | 값 |\n  | --- | --- |\n  | A | {{하나}} |\n  | B | {{둘}} |');
  assert.equal(list.length,1);
  assert.equal(list[0].cards.length,3);
  assert.deepEqual(Array.from(list[0].cards,c=>!!c.isCloze),[true,true,false]);
  assert.match(list[0].cards[0].back,/^- 표\n\n  \| 구분 \| 값 \|/);
  assert.equal(list[0].cards[2].front,'표');
  assert.ok(!list[0].cards[2].back.includes('{{'));
});

test('Math or code opened on a list item ends before subsequent real questions', () => {
  for(const [open,body,close] of [['$$','\\text{???}','$$'],['```md','- 예시 ???','```']]) {
    const source='계산\n???\n\t- '+open+'\n\t  '+body+'\n\t  '+close+'\n\n### 다음\n???\n답\n\n# 전부원가\n- 비교\n\t- 생산량 > 판매량 ???\n\t\t- 전부 > 변동 > 초변동';
    const list=questions(source);
    assert.equal(list.length,3);
    assert.ok(list[0].cards[0].back.endsWith(close));
    assert.equal(list[1].cards[0].front,'### 다음');
    assert.equal(list[2].cards[0].front,'생산량 > 판매량');
    assert.equal(list[2].cards[0].back,'- 전부 > 변동 > 초변동');
  }
});

test('New inline-card IDs stay inside the owning list item and preserve its card text', async () => {
  const source='- ### 지문\n\t- 원가<u>회피</u> :: 변동원가계산\n\t- 원가<u>부착</u> :: 전부원가계산';
  let current=source;
  const Bridge=vm.runInContext('LocalAnkiBridge',context);
  const bridge=new Bridge({manifest:{dir:'plugin'},app:{vault:{process:async(_,mutate)=>{current=mutate(current);}}}});
  const initial=questions(source);
  await bridge.assignIds({file:{},original:source,questions:initial});
  assert.equal((current.match(/^\t  <!--ANKI:[a-f0-9]{32}-->$/gm)||[]).length,2);
  const parsed=questions(current);
  assert.equal(parsed.length,2);
  assert.deepEqual(Array.from(parsed,q=>q.questionText.textHash),Array.from(initial,q=>q.questionText.textHash));
  assert.deepEqual(Array.from(parsed,q=>[q.cards[0].front,q.cards[0].back]),Array.from(initial,q=>[q.cards[0].front,q.cards[0].back]));
});

test('Existing flush-left IDs are repaired in place without replacing their identities', async () => {
  const other='abcdefabcdefabcdefabcdefabcdefab';
  const source=`- 부모\n\t- 질문::답\n<!--ANKI:${id}-->\n\t- 두 번째::답\n<!--ANKI:${other}-->`;
  let current=source,writes=0;
  const Bridge=vm.runInContext('LocalAnkiBridge',context);
  const bridge=new Bridge({manifest:{dir:'plugin'},app:{vault:{process:async(_,mutate)=>{writes++;current=mutate(current);}}}});
  await bridge.assignIds({file:{},original:source,questions:questions(source)});
  assert.equal(current,source.replace(/\n<!--ANKI:/g,'\n\t  <!--ANKI:'));
  assert.deepEqual(Array.from(questions(current),q=>q.questionText.ankiId),[id,other]);
  await bridge.assignIds({file:{},original:current,questions:questions(current)});
  assert.equal(writes,1);
});

test('Metadata follows the last list item or continuation indentation for ordered, nested and formula answers', async () => {
  for (const [source,indent] of [
    ['  12. 질문::답','      '],
    ['- 질문 ???\n  - 답\n    - 세부','      '],
    ['- #### 공식 ???\n  $$a=b$$','  '],
    ['제목\n???\n- 답','  '],
    ['일반 질문::답','']
  ]) {
    let current=source;
    const Bridge=vm.runInContext('LocalAnkiBridge',context);
    const bridge=new Bridge({manifest:{dir:'plugin'},app:{vault:{process:async(_,mutate)=>{current=mutate(current);}}}});
    const initial=questions(source);
    await bridge.assignIds({file:{},original:source,questions:initial});
    assert.ok(current.endsWith('\n'+indent+'<!--ANKI:'+initial[0].questionText.ankiId+'-->'),source);
    const parsed=questions(current)[0];
    assert.equal(parsed.questionText.textHash,initial[0].questionText.textHash);
    assert.ok(parsed.formatForNote(settings).endsWith('\n'+indent+'<!--ANKI:'+parsed.questionText.ankiId+'-->'));
  }
});

test('Native SR rewrites preserve indentation for schedule comments and Anki IDs', () => {
  const q=questions(`\t- 질문::답\n<!--ANKI:${id}-->`)[0];
  q.cards[0].scheduleInfo={};
  const algorithm=vm.runInContext('DataStoreAlgorithm',context),getInstance=algorithm.getInstance;
  algorithm.getInstance=()=>({questionFormatScheduleAsHtmlComment:()=> '<!--SR:!2026-09-11,2,250-->'});
  try {
    const output=q.formatForNote({...settings,cardCommentOnSameLine:false,useCalloutsForSchedulingComments:false});
    assert.equal(output,`\t- 질문::답\n\t  <!--SR:!2026-09-11,2,250-->\n\t  <!--ANKI:${id}-->`);
    const parsed=questions(output)[0];
    assert.equal(parsed.questionText.ankiId,id);
    assert.equal(parsed.questionText.textHash,q.questionText.textHash);
  } finally {algorithm.getInstance=getInstance;}
});

test('Metadata-only repair retains CRLF and refuses to overwrite concurrent edits', async () => {
  const source=`- 질문::답\r\n<!--ANKI:${id}-->`;
  let current=source+'\r\n사용자 편집';
  const Bridge=vm.runInContext('LocalAnkiBridge',context);
  const bridge=new Bridge({manifest:{dir:'plugin'},app:{vault:{process:async(_,mutate)=>{current=mutate(current);}}}});
  await assert.rejects(bridge.assignIds({file:{},original:source,questions:questions(source)}),/노트가 변경/);
  assert.equal(current,source+'\r\n사용자 편집');
  current=source;
  await bridge.assignIds({file:{},original:source,questions:questions(source)});
  assert.equal(current,`- 질문::답\r\n  <!--ANKI:${id}-->`);
});

test('Smart arrow substitution is repaired only in Anki comment closers', () => {
  const repair=vm.runInContext('localAnkiCloserRepairs',context);
  const apply=text=>{for(const c of Array.from(repair(text)).reverse())text=text.slice(0,c.from)+c.insert+text.slice(c.to);return text;};
  const source=`일반 문장 -> →\n\t  <!--ANKI:${id}-→\n다음 문장`;
  assert.equal(apply(source),source.replace(id+'-→',id+'-->'));
  for(const text of ['일반 문장 -→',`<!--ANKI:${id}-->`,`\`<!--ANKI:${id}-→\``,`\`\`\`md\n<!--ANKI:${id}-→\n\`\`\``,`$$\n<!--ANKI:${id}-→\n$$`])assert.equal(apply(text),text);
});

test('The editor transaction filter preserves ordinary edits and repairs the replacement transaction', () => {
  const filter=vm.runInContext('localProtectAnkiClosers',context);
  const ordinary={docChanged:true,newDoc:{toString:()=> '일반 텍스트 →'}};
  assert.equal(filter(ordinary),ordinary);
  const tr={docChanged:true,newDoc:{toString:()=> `<!--ANKI:${id}-→`}};
  const result=filter(tr);
  assert.equal(result[0],tr);
  assert.equal(result[1].sequential,true);
  assert.equal(result[1].changes[0].insert,'-->');
});

test('Damaged metadata is rejected before it can receive a new identity', async () => {
  const validate=vm.runInContext('localValidateAnkiMarkers',context);
  for(const suffix of ['-→','--','', '--> 잘못된 뒤쪽 내용'])assert.throws(()=>validate(`질문::답\n<!--ANKI:${id}${suffix}`),/2행.*식별자가 손상/);
  for(const source of [`질문::답\n  <!--ANKI:${id}-->`,`\`\`\`md\n<!--ANKI:${id}-→\n\`\`\``])assert.doesNotThrow(()=>validate(source));
  const Bridge=vm.runInContext('LocalAnkiBridge',context);
  const file={path:'손상.md'};
  const bridge=new Bridge({manifest:{dir:'plugin'},dataManager:{settingsManager:{settings},createSRNoteTFile:()=>({getAllTagsFromCache:()=>[]})},app:{vault:{getMarkdownFiles:()=>[file],read:async()=>`<!--ANKI:${id}-→`}}});
  await assert.rejects(bridge.collect(file),/손상.md: 1행.*식별자가 손상/);
});

function syncRunBridge() {
  const events=[], notices=[], reports=[];
  const Bridge=vm.runInContext('LocalAnkiBridge',context);
  const bridge=new Bridge({isInitialized:true,manifest:{dir:'plugin'},app:{vault:{adapter:{write:async(_,text)=>reports.push(JSON.parse(text))}}}});
  bridge.api={Notice:class {constructor(text){notices.push(text);}}};
  bridge.verifyConnection=async()=>events.push('connection');
  bridge.collect=async()=>[{file:{path:'test.md'},questions:[{cards:[{cardIdx:0},{cardIdx:1}]}]}];
  bridge.ensureModel=async()=>events.push('model');
  bridge.assignIds=async()=>events.push('ids');
  bridge.syncCard=async(card,question,file,report)=>{events.push('card:'+card.cardIdx);report.unchanged++;};
  bridge.invoke=async(action,params,timeout)=>{events.push(action);assert.equal(timeout,120000);};
  return {bridge,events,notices,reports};
}

test('AnkiWeb starts once after all cards finish, even when cards are unchanged', async()=>{
  const {bridge,events,notices,reports}=syncRunBridge();
  const result=await bridge.run();
  assert.deepEqual(events,['connection','model','ids','card:0','card:1','sync']);
  assert.equal(result.unchanged,2);
  assert.equal(result.ankiWeb.started,true);
  assert.equal(result.ankiWeb.error,null);
  assert.equal(result.error,null);
  assert.match(notices.at(-1),/AnkiWeb/);
  assert.equal(reports[0].ankiWeb.started,true);
  assert.equal(bridge.busy,false);
});

test('Card transfer failures and rejected concurrent runs never request AnkiWeb sync', async()=>{
  const {bridge,events}=syncRunBridge();
  bridge.syncCard=async()=>{throw Error('card write failed');};
  const result=await bridge.run();
  assert.equal(result.error,'card write failed');
  assert.equal(result.ankiWeb.started,false);
  assert.ok(!events.includes('sync'));
  events.length=0;
  bridge.busy=true;
  assert.equal(await bridge.run(),undefined);
  assert.deepEqual(events,[]);
});

test('AnkiWeb failures preserve successful local transfers and report their own error', async()=>{
  const {bridge,events,notices,reports}=syncRunBridge();
  bridge.invoke=async(action)=>{events.push(action);throw Error('sync: auth not configured');};
  const result=await bridge.run();
  assert.equal(result.error,null);
  assert.equal(result.unchanged,2);
  assert.equal(result.ankiWeb.started,false);
  assert.equal(result.ankiWeb.error,'sync: auth not configured');
  assert.equal(events.filter(e=>e==='sync').length,1);
  assert.match(notices.at(-1),/카드 전송.*완료/);
  assert.match(notices.at(-1),/AnkiWeb/);
  assert.equal(reports[0].ankiWeb.error,result.ankiWeb.error);
  assert.equal(bridge.busy,false);
});

test('AnkiWeb gets a longer response timeout while ordinary Anki calls stay short', async()=>{
  const Bridge=vm.runInContext('LocalAnkiBridge',context),bridge=new Bridge({manifest:{dir:'plugin'}});
  const timeouts=[],oldSetTimeout=context.setTimeout,oldClearTimeout=context.clearTimeout;
  bridge.api={Platform:{},requestUrl:async()=>({json:{result:null,error:null}})};
  context.setTimeout=(fn,delay)=>{timeouts.push(delay);return 1;};
  context.clearTimeout=()=>{};
  try {
    await bridge.invoke('version');
    await bridge.invoke('sync',{},120000);
    assert.deepEqual(timeouts,[8000,120000]);
  } finally {context.setTimeout=oldSetTimeout;context.clearTimeout=oldClearTimeout;}
});

test('Card display identifies only question markers and the blank gap before a real table',()=>{
  const source='## 책임중심점의 유형\n???\n\n| 구분 | 답 |\n| --- | :---: |\n| A | B |\n\n- 다른 질문 ???\n  - 답\n\n양방향\n????\n\n문단 답\n';
  const ranges=vm.runInContext('localCardEditorRanges',context)(source,settings);
  assert.deepEqual(Array.from(ranges.filter(r=>r.kind==='separator'),r=>source.slice(r.from,r.to)),['???','???','????']);
  const gaps=ranges.filter(r=>r.kind==='table-gap');
  assert.equal(gaps.length,1);
  assert.equal(gaps[0].from,source.indexOf('\n\n| 구분')+1);
});

test('Card display leaves code, math, ordinary question marks and non-table blank lines alone',()=>{
  const source='```md\n???\n\n| 구분 | 답 |\n| --- | --- |\n```\n\n$$\n???\n$$\n\n일반 문장 ???\n`???`\n\n???\n\n| 표처럼 보이는 문장 |\n실제 구분선 아님\n';
  const ranges=vm.runInContext('localCardEditorRanges',context)(source,settings);
  assert.equal(ranges.length,1);
  assert.equal(ranges[0].kind,'separator');
  assert.equal(ranges[0].from,source.lastIndexOf('???'));
});

test('Cloze display dims delimiters and group IDs while preserving answer and hint text',()=>{
  const source='{{1;;이익}}보다 {{1;;수익}} / {{투자중심점}} / {{2;;제조부문;;힌트}}';
  const ranges=vm.runInContext('localCardEditorRanges',context)(source,settings);
  assert.deepEqual(Array.from(ranges,r=>source.slice(r.from,r.to)),['{{1;;','}}','{{1;;','}}','{{','}}','{{2;;',';;','}}']);
  for(const word of ['이익','수익','투자중심점','제조부문','힌트']) {
    const start=source.indexOf(word);
    assert.ok(ranges.every(r=>r.to<=start||r.from>=start+word.length));
  }
});

test('Cloze display protects fenced code and inline or block math while covering table cells',()=>{
  const source='```md\n{{1;;코드}}\n```\n$$\n{{2;;수식}}\n$$\n`{{3;;인라인}}` ${{4;;수식}}$ \\({{5;;수식}}\\)\n\n| 구분 | 답 |\n| --- | --- |\n| A | {{1;;표 답}} |';
  const ranges=vm.runInContext('localCardEditorRanges',context)(source,settings);
  assert.deepEqual(Array.from(ranges,r=>source.slice(r.from,r.to)),['{{1;;','}}']);
  assert.equal(ranges[0].from,source.lastIndexOf('{{1;;'));
});

test('Inline answers share a paragraph with the prompt, preserving rich text and inline math', () => {
  assert.equal(questions('**질문** :: *정답*')[0].cards[0].back, '**질문** → *정답*');
  const reverse = questions('- 용어 ::: 뜻')[0].cards;
  assert.deepEqual(Array.from(reverse, c=>c.back), ['- 용어 → 뜻', '뜻 → 용어']);
  assert.equal(questions('비율 :: $$\\frac{a}{b}$$')[0].cards[0].back, '비율 → $\\frac{a}{b}$');
});

test('Cloze shows its own line and list ancestors, excluding siblings and descendants', () => {
  const card=questions('- 큰 분류\n  - 작은 분류\n    - 대상 {{정답}} $x^2$ ![[그림.png]]\n      - 하위 설명\n    - 옆 문장\n  - 다른 분류')[0].cards[0];
  for (const face of [card.front,card.back]) {
    assert.match(face, /- 큰 분류\n  - 작은 분류\n    - 대상/);
    assert.match(face, /\$x\^2\$ !\[\[그림.png\]\]/);
    assert.doesNotMatch(face, /하위 설명|옆 문장|다른 분류/);
  }
});

test('Grouped cloze lines keep their separate parent branches in one card', () => {
  const q=questions('- 큰 분류\n  - A\n    - {{1;;하나}}\n    - 잡담\n  - B\n    - {{1;;둘}}\n  - C\n    - {{2;;셋}}')[0];
  assert.equal(q.cards.length,2);
  assert.match(q.cards[0].back, /- 큰 분류[\s\S]*- A[\s\S]*하나[\s\S]*- B[\s\S]*둘/);
  assert.doesNotMatch(q.cards[0].back, /잡담|- C|셋/);
  assert.doesNotMatch(q.cards[1].back, /- A|- B|하나|둘/);
});

test('Table clozes retain the header and grouped target rows, without unrelated rows', () => {
  const q=questions('| 구분 | 내용 |\n| --- | --- |\n| A | {{1;;하나}} |\n| B | 일반 |\n| C | {{1;;둘}} |\n| D | {{2;;셋}} |')[0];
  assert.equal(q.cards.length,2);
  assert.match(q.cards[0].front,/^\| 구분 \| 내용 \|\n\| --- \| --- \|/);
  assert.match(q.cards[0].back,/\| A \|[\s\S]*\| C \|/);
  assert.doesNotMatch(q.cards[0].back,/\| B \||\| D \|/);
  assert.doesNotMatch(q.cards[1].back,/\| A \||\| B \||\| C \|/);
});

test('Native parsing retains external ancestors across card metadata without changing identity', () => {
  context.parentSource = '- 상위\n  - 중간 ???\n    - 이전 :: 답\n      <!--ANKI:'+id+'-->\n    - 대상 {{정답}}\n      <!--ANKI:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-->\n    - 다른 항목';
  const result = vm.runInContext(`(() => {
    const parser = new NoteQuestionParser(settingsForTest);
    parser.contentText = parentSource;
    parser.noteFile = {path:'test.md',getQuestionContext:()=>[]};
    return parser.doCreateQuestionList(parentSource,1,{},[]);
  })()`,context);
  const q=result.find(q=>q.questionText.ankiId==='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.ok(q);
  assert.match(q.cards[0].back, /^- 상위\n  - 중간\n    - 대상/);
  assert.doesNotMatch(q.cards[0].back, /이전|다른 항목|ANKI|\?\?\?/);
  const direct=questions(q.questionText.original)[0];
  assert.equal(q.questionText.textHash,direct.questionText.textHash);
  assert.equal(q.cards.length,direct.cards.length);
});

test('Clozes inside a multiline list card retain the prompt as their parent', () => {
  const q=questions('- 외부\n  - 질문 ???\n    - 대상 {{정답}}\n    - 다른 내용')[0];
  assert.match(q.cards[0].back, /^- 질문\n  - 대상/);
  assert.doesNotMatch(q.cards[0].back, /다른 내용/);
  assert.match(q.cards[1].back, /다른 내용/);
});

test('Inline formatting never turns an empty side into a valid card', () => {
  context.emptyPairs=[{front:'질문',back:''},{front:'',back:'답'},{front:'질문',back:'<!-- 빈 답 -->'}];
  const before=JSON.stringify(context.emptyPairs);
  vm.runInContext('localPresentCardPairs(0,emptyPairs,"")',context);
  assert.equal(JSON.stringify(context.emptyPairs),before);
});

test('List headings contribute their hash-level ancestry to card context', () => {
  context.headingText='# 전부원가계산\n- ### 초변동원가\n- #### 영업이익 ???\n  $$x=1$$\n- ### 지문\n  - 문장 {{답}}';
  context.headingCache=[{heading:'전부원가계산',level:1,position:{start:{line:0}}}];
  assert.deepEqual(Array.from(vm.runInContext('localQuestionHeadingContext(headingText,2,headingCache,settingsForTest)',context)),['전부원가계산','초변동원가','영업이익']);
  assert.deepEqual(Array.from(vm.runInContext('localQuestionHeadingContext(headingText,5,headingCache,settingsForTest)',context)),['전부원가계산','지문']);
});

test('List heading context ignores code, math and comments and preserves cached headings', () => {
  context.headingText='상위\n===\n- ### [비교](marginnote4app://note/123)\n  ```md\n  - ## 코드\n  ```\n  $$\n  - ## 수식\n  $$\n<!--\n- ## 주석\n-->\n  - #### 세부 ????\n    - 답';
  context.headingCache=[{heading:'상위[^1]',level:1,position:{start:{line:0}}}];
  const cache=JSON.stringify(context.headingCache);
  assert.deepEqual(Array.from(vm.runInContext('localQuestionHeadingContext(headingText,13,headingCache,settingsForTest)',context)),['상위','비교','세부']);
  assert.equal(JSON.stringify(context.headingCache),cache);
});

test('Inline list questions after a cloze become separate cards and retain the final grouped cloze ID', () => {
  const source='- ### 지문\n\t- 책임중심점은 {{투자중심점}}이다.\n\t- 투자수익률 :: 매출액이익률 x 총자산회전률\n\t- 총자산회전률 :: $$\\frac{매출액}{총자산} $$\n\t- {{1;;수익}}보다 {{1;;이익}}중심점이 바람직하다\n\t- \n\t<!--ANKI:'+id+'-->';
  const list=questions(source);
  assert.deepEqual(Array.from(list,q=>q.questionType),[4,0,0,4]);
  assert.deepEqual(Array.from(list,q=>q.cards.length),[1,1,1,1]);
  assert.match(list[0].cards[0].back,/투자중심점/);
  assert.equal(list[1].cards[0].back,'- 투자수익률 → 매출액이익률 x 총자산회전률');
  assert.equal(list[2].cards[0].back,'- 총자산회전률 → $\\frac{매출액}{총자산}$');
  assert.equal(list[3].questionText.ankiId,id);
  assert.ok(list.slice(0,3).every(q=>!q.questionText.ankiId));
  assert.match(list[3].cards[0].front,/\[\.\.\.\][\s\S]*\[\.\.\.\]/);
});

test('Cloze boundaries accept reversed questions but keep table, code, math and cloze text literal', () => {
  const list=questions('- {{기억}}\n- 앞 ::: 뒤\n- {{끝}}');
  assert.deepEqual(Array.from(list,q=>q.cards.length),[1,2,1]);
  for(const literal of ['| 구분 | 내용 |\n| --- | --- |\n| A | a::b |','`a::b`','$$a::b$$','수식 $a::b$','수식 \\(a::b\\)','```md\na::b\n```','- {{a::b}}']) {
    const parsed=questions('- {{기억}}\n'+literal);
    assert.equal(parsed.length,1,literal);
    assert.equal(parsed[0].questionType,4,literal);
  }
});

test('Assigning IDs after mixed-card separation preserves list formatting and is repeatable', async () => {
  const source='- ### 지문\n\t- {{투자중심점}}\n\t- 투자수익률 :: 이익률 x 회전률\n\t- 총자산회전률 :: $$\\frac{매출액}{총자산}$$\n\t- {{1;;수익}} → {{1;;이익}}\n\t<!--ANKI:'+id+'-->';
  let current=source;
  const Bridge=vm.runInContext('LocalAnkiBridge',context);
  const bridge=new Bridge({manifest:{dir:'plugin'},app:{vault:{process:async(_,mutate)=>{current=mutate(current);}}}});
  await bridge.assignIds({file:{},original:current,questions:questions(current)});
  const added=current,parsed=questions(current);
  assert.equal(parsed.length,4);
  assert.equal(parsed[3].questionText.ankiId,id);
  assert.equal(new Set(parsed.map(q=>q.questionText.ankiId)).size,4);
  const withoutIds=text=>text.replace(/\n[ \t]*<!--ANKI:[a-f0-9]{32}-->/g,'');
  assert.equal(withoutIds(current),withoutIds(source));
  await bridge.assignIds({file:{},original:current,questions:parsed});
  assert.equal(current,added);
});
