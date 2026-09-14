const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {test} = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'nested-table-preview.js'), 'utf8');
const prefix = source.slice(0, source.indexOf('function installNestedTablePreview'));
const helpers = vm.runInThisContext('(() => {' + prefix + ';return {tableMergeGrid, tableHasMerges, expandTableMergeBounds};})()');

const sizes = grid => helpers.tableMergeGrid(grid).span.map(row => row.map(size => size ? size.columns + 'x' + size.rows : '.'));

test('plain table has no spans', () => {
  const grid = [['A', 'B'], ['1', '2']];
  assert.deepEqual(sizes(grid), [['1x1', '1x1'], ['1x1', '1x1']]);
  assert.equal(helpers.tableHasMerges(helpers.tableMergeGrid(grid).span), false);
});

test('merges to the left within a row', () => {
  assert.deepEqual(sizes([['A', 'B', 'C'], ['합계', '<', '<']]), [['1x1', '1x1', '1x1'], ['3x1', '.', '.']]);
});

test('merges upward inside the body only', () => {
  assert.deepEqual(sizes([['A', 'B'], ['^', '1'], ['^', '2']]), [['1x1', '1x1'], ['1x2', '1x1'], ['.', '1x1']]);
});

test('does not let the first body row merge into the header', () => {
  assert.deepEqual(sizes([['A', 'B'], ['^', '1']]), [['1x1', '1x1'], ['1x1', '1x1']]);
});

test('combines left and up markers into a rectangle', () => {
  assert.deepEqual(sizes([['A', 'B', 'C'], ['1', '2', '3'], ['x', '<', '4'], ['^', '^', '5']]),
    [['1x1', '1x1', '1x1'], ['1x1', '1x1', '1x1'], ['2x2', '.', '1x1'], ['.', '.', '1x1']]);
});

test('ignores surrounding whitespace and non-marker text', () => {
  assert.deepEqual(sizes([['A', 'B'], ['1', ' < '], ['2', '<< ']]), [['1x1', '1x1'], ['2x1', '.'], ['1x1', '1x1']]);
});

test('a left marker in the first column stays its own cell', () => {
  assert.deepEqual(sizes([['A', 'B'], ['<', '1']]), [['1x1', '1x1'], ['1x1', '1x1']]);
});

test('expands a partial selection to whole merged regions', () => {
  const {owner, span} = helpers.tableMergeGrid([['A', 'B', 'C'], ['1', '2', '3'], ['x', '<', '4'], ['^', '^', '5']]);
  assert.deepEqual(helpers.expandTableMergeBounds(owner, span, {minRow: 3, maxRow: 3, minCol: 1, maxCol: 2}),
    {minRow: 2, maxRow: 3, minCol: 0, maxCol: 2});
});

test('leaves a selection that already covers full regions unchanged', () => {
  const {owner, span} = helpers.tableMergeGrid([['A', 'B'], ['1', '2'], ['3', '4']]);
  assert.deepEqual(helpers.expandTableMergeBounds(owner, span, {minRow: 1, maxRow: 2, minCol: 0, maxCol: 1}),
    {minRow: 1, maxRow: 2, minCol: 0, maxCol: 1});
});
