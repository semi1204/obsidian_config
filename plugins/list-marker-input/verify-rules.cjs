const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { test } = require("node:test");

let syntaxName;
const sandbox = { module: {exports: {}}, require(name) {
  if (name === "obsidian") return {Plugin: class {}};
  if (name === "@codemirror/state") return {Prec: {}};
  if (name === "@codemirror/view") return {EditorView: {}};
  if (name === "@codemirror/commands") return {isolateHistory: {of: value => value}};
  if (name === "@codemirror/language") return {ensureSyntaxTree: () => ({
    resolveInner: () => ({name: syntaxName, parent: null})
  })};
  throw new Error(name);
}};
vm.runInNewContext(fs.readFileSync(__dirname + "/main.js", "utf8"), sandbox);
const plugin = new sandbox.module.exports();

const cases = [
  {name: "number to bullet", doc: "1. -", expected: "- "},
  {name: "existing content stays", doc: "12. -기존 내용", at: 5, expected: "- 기존 내용"},
  {name: "space indentation stays", doc: "- 부모\n  2. -", expected: "- 부모\n  - "},
  {name: "tab indentation stays", doc: "- 부모\n\t2. -", expected: "- 부모\n\t- "},
  {name: "parenthesis number marker", doc: "2) -", expected: "- "},
  {name: "typed marker together", doc: "3. ", input: "- ", expected: "- "},
  {name: "bullet to number still works", doc: "- 1.", expected: "1. "},
  {name: "number inside sentence unchanged", doc: "1. 기존 내용 -", expected: null},
  {name: "negative number unchanged", doc: "1. -5", expected: null},
  {name: "wait for space", doc: "1. ", input: "-", expected: null},
  {name: "checkbox unchanged", doc: "1. [ ] -", expected: null},
  {name: "code unchanged", doc: "1. -", syntax: "HyperMD-codeblock", expected: null},
  {name: "YAML unchanged", doc: "1. -", syntax: "hmd-frontmatter", expected: null},
  {name: "plain text unchanged", doc: "1. -", syntax: "Paragraph", expected: null},
  {name: "composition unchanged", doc: "1. -", composing: true, expected: null},
  {name: "multiple cursors unchanged", doc: "1. -", multiple: true, expected: null}
];
for (const c of cases) test(c.name, () => {
  syntaxName = c.syntax || "formatting_formatting-list_formatting-list-ol_list-1";
  const at = c.at ?? c.doc.length;
  let transaction;
  const view = {composing: !!c.composing, state: {
    selection: {ranges: c.multiple ? [{}, {}] : [{}], main: {empty: true}},
    doc: {
      lineAt: pos => ({from: c.doc.lastIndexOf("\n", pos - 1) + 1}),
      sliceString: (from, to) => c.doc.slice(from, to)
    }
  }, dispatch: tr => { transaction = tr; }};
  const handled = plugin.convertInput(view, at, at, c.input ?? " ");
  assert.equal(handled, c.expected !== null);
  if (!handled) { assert.equal(transaction, undefined); return; }
  const change = transaction.changes;
  assert.equal(c.doc.slice(0, change.from) + change.insert + c.doc.slice(change.to), c.expected);
  assert.equal(transaction.selection.anchor, change.from + change.insert.length);
});
