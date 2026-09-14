const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {test} = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'nested-table-preview.js'), 'utf8');
const prefix = source.slice(0, source.indexOf('function installNestedTablePreview'));
const helpers = vm.runInNewContext(prefix + ';({listTableCellRanges, encodeListTableCell})');

test('finds cells in an indented pipe table row', () => {
  const cells = helpers.listTableCellRanges('\t  | 구분 | 답 |', 3);
  assert.deepEqual(Array.from(cells, cell => ({from: cell.from, to: cell.to})), [
    {from: 5, to: 7},
    {from: 10, to: 11}
  ]);
});

test('supports rows without outer pipes', () => {
  const cells = helpers.listTableCellRanges('  구분 | 답', 2);
  assert.deepEqual(Array.from(cells, cell => cell.raw.trim()), ['구분', '답']);
});

test('does not split an escaped pipe', () => {
  const cells = helpers.listTableCellRanges('  | A \\| B | C |', 2);
  assert.deepEqual(Array.from(cells, cell => cell.raw.trim()), ['A \\| B', 'C']);
});

test('encodes cell pipes and line breaks without double escaping input', () => {
  assert.equal(helpers.encodeListTableCell('고정|변동\n둘째'), '고정\\|변동<br>둘째');
  assert.equal(helpers.encodeListTableCell('이미 \\| 처리'), '이미 \\| 처리');
});
