function listTableCellRanges(text, indentLength) {
  const boundaries = [indentLength - 1];
  let slashes = 0;
  for (let i = indentLength; i < text.length; i++) {
    if (text[i] === '|' && slashes % 2 === 0) boundaries.push(i);
    slashes = text[i] === '\\' ? slashes + 1 : 0;
  }
  boundaries.push(text.length);
  const cells = boundaries.slice(1).map((end, index) => {
    const start = boundaries[index] + 1, raw = text.slice(start, end);
    const from = start + raw.length - raw.trimStart().length;
    return {from, to: Math.max(from, start + raw.trimEnd().length), raw};
  });
  if (!cells[0].raw.trim()) cells.shift();
  if (cells.length && !cells[cells.length - 1].raw.trim()) cells.pop();
  return cells;
}

function encodeListTableCell(value) {
  let result = '', slashes = 0;
  for (const char of value.replace(/\r?\n/g, '<br>')) {
    result += char === '|' && slashes % 2 === 0 ? '\\|' : char;
    slashes = char === '\\' ? slashes + 1 : 0;
  }
  return result;
}

const TABLE_MERGE_LEFT = '<', TABLE_MERGE_UP = '^';

function tableMergeGrid(grid) {
  const owner = [], span = [];
  for (let row = 0; row < grid.length; row++) {
    owner.push([]);
    span.push([]);
    for (let column = 0; column < grid[row].length; column++) {
      const text = (grid[row][column] || '').trim();
      const left = column > 0 ? owner[row][column - 1] : null;
      // Row 1 may not merge into the header: rowspan cannot cross thead/tbody.
      const above = row > 1 ? owner[row - 1][column] : null;
      owner[row][column] = text === TABLE_MERGE_LEFT && left ? left
        : text === TABLE_MERGE_UP && above ? above
        : {row, column};
      span[row][column] = null;
    }
  }
  for (let row = 0; row < owner.length; row++) {
    for (let column = 0; column < owner[row].length; column++) {
      const master = owner[row][column];
      if (master.row !== row || master.column !== column) continue;
      let columns = 1, rows = 1;
      while (owner[row][column + columns] === master) columns++;
      while (owner[row + rows] && owner[row + rows][column] === master) rows++;
      span[row][column] = {columns, rows};
    }
  }
  return {owner, span};
}

function tableHasMerges(span) {
  return span.some(row => row.some(size => size && (size.columns > 1 || size.rows > 1)));
}

function expandTableMergeBounds(owner, span, bounds) {
  let result = bounds, changed = true;
  while (changed) {
    changed = false;
    for (let row = result.minRow; row <= result.maxRow; row++) {
      for (let column = result.minCol; column <= result.maxCol; column++) {
        const master = owner[row] && owner[row][column];
        if (!master) continue;
        const size = span[master.row][master.column];
        const next = {
          minRow: Math.min(result.minRow, master.row),
          maxRow: Math.max(result.maxRow, master.row + size.rows - 1),
          minCol: Math.min(result.minCol, master.column),
          maxCol: Math.max(result.maxCol, master.column + size.columns - 1)
        };
        if (next.minRow !== result.minRow || next.maxRow !== result.maxRow ||
            next.minCol !== result.minCol || next.maxCol !== result.maxCol) {
          result = next;
          changed = true;
        }
      }
    }
  }
  return result;
}

function applyTableMergesToDOM(tableElement) {
  if (tableElement.dataset.tableMerged) return;
  tableElement.dataset.tableMerged = '1';
  const cells = Array.from(tableElement.rows).map(row => Array.from(row.cells));
  const {span} = tableMergeGrid(cells.map(row => row.map(cell => cell.textContent)));
  cells.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
    const size = span[rowIndex][columnIndex];
    if (!size) return cell.remove();
    cell.dataset.tableRow = rowIndex;
    cell.dataset.tableCol = columnIndex;
    if (size.columns > 1) cell.colSpan = size.columns;
    if (size.rows > 1) cell.rowSpan = size.rows;
  }));
}

function installNestedTablePreview(plugin) {
  const {StateField, StateEffect} = require('@codemirror/state');
  const {EditorView, Decoration, WidgetType} = require('@codemirror/view');
  const {ensureSyntaxTree} = require('@codemirror/language');
  const {undo, redo, isolateHistory} = require('@codemirror/commands');
  const {Component, MarkdownRenderer, editorInfoField, editorLivePreviewField} = import_obsidian;
  const components = new WeakMap();
  const setActiveTable = StateEffect.define();

  function sourceModeFor(view) {
    let result = null;
    plugin.app.workspace.iterateAllLeaves(leaf => {
      const mode = leaf.view?.currentMode;
      if (mode?.cm === view) result = mode;
    });
    return result;
  }

  let NativeTableClass = null;
  function nativeTableConstructor() {
    if (NativeTableClass) return NativeTableClass;
    for (const element of document.querySelectorAll('.cm-table-widget:not(.list-table-preview)')) {
      const widget = element.cmTile?.widget;
      if (widget && Array.isArray(widget.rows) && typeof widget.receiveCellFocus === 'function') {
        NativeTableClass = widget.constructor;
        return NativeTableClass;
      }
    }
    return null;
  }

  function indentColumns(indent, tabSize) {
    let columns = 0;
    for (const char of indent) columns += char === '\t' ? tabSize - columns % tabSize : 1;
    return columns;
  }

  class NestedTableWidget extends WidgetType {
    constructor(markdown, from, to, indent) {
      super();
      this.markdown = markdown;
      this.from = from;
      this.to = to;
      this.indent = indent;
    }
    eq(other) {
      return this.markdown === other.markdown && this.from === other.from && this.to === other.to && this.indent === other.indent;
    }
    updateDOM(dom, view) {
      if (dom.nativeListTable) {
        const state = dom.nativeListTable;
        dom.tableSpec = this;
        state.spec = this;
        state.view = view;
        dom.style.paddingInlineStart = indentColumns(this.indent, view.state.tabSize) + 'ch';
        if (state.table.doc.toString() !== this.markdown) {
          if (state.editor.tableCell?.table === state.table) state.editor.destroyTableCell();
          state.table.doc = view.state.toText(this.markdown);
          state.table.start = 0;
          state.table.end = state.table.doc.length;
          state.table.render();
        }
        return true;
      }
      if (!dom.cellEditor) return false;
      dom.tableSpec = this;
      const edit = dom.cellEditor, range = this.cellRange(view, edit.row, edit.column);
      if (!range) return false;
      const value = view.state.doc.sliceString(range.from, range.to);
      if (value !== edit.saved) edit.textarea.value = edit.saved = value;
      return true;
    }

    nativeDOM(view) {
      const NativeTable = nativeTableConstructor(), sourceMode = sourceModeFor(view);
      if (!NativeTable || !sourceMode) return null;

      const state = {spec: this, view, table: null, editor: null, mapDoc: null, wholeTable: false};
      const mapLocal = (position, localDoc = state.mapDoc || state.table.doc) => {
        const spec = state.spec, outerDoc = state.view.state.doc;
        const local = localDoc.lineAt(Math.max(0, Math.min(position, localDoc.length)));
        const firstLine = outerDoc.lineAt(spec.from).number;
        const outerLine = outerDoc.line(Math.min(outerDoc.lines, firstLine + local.number - 1));
        return Math.min(outerLine.to, outerLine.from + spec.indent.length + position - local.from);
      };
      const addIndent = text => text.split('\n').map(line => state.spec.indent + line).join('\n');
      const mainCM = view;
      const cm = new Proxy(mainCM, {
        get(target, property) {
          if (property === 'dispatch') {
            return transaction => {
              if (!transaction?.changes) return target.dispatch(transaction);
              const changes = Array.isArray(transaction.changes) ? transaction.changes : [transaction.changes];
              const localDoc = state.mapDoc || state.table.doc;
              const fullTable = state.wholeTable || changes.some(change =>
                change.from === 0 && change.to === localDoc.length && String(change.insert ?? '').includes('\n'));
              const mapped = changes.map(change => {
                if (fullTable && change.from === 0 && change.to === localDoc.length) {
                  return {from: state.spec.from, to: state.spec.to, insert: addIndent(String(change.insert ?? ''))};
                }
                return {
                  from: mapLocal(change.from, localDoc),
                  to: mapLocal(change.to, localDoc),
                  insert: change.insert
                };
              });
              return target.dispatch({...transaction, changes: mapped});
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
      const editor = new Proxy(sourceMode, {
        get(target, property) {
          if (property === 'cm') return cm;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
        set(target, property, value) {
          if (property === 'cm') return false;
          return Reflect.set(target, property, value, target);
        }
      });
      state.editor = editor;

      const table = new NativeTable(plugin.app, editor, view.state.toText(this.markdown), true);
      state.table = table;
      table.start = 0;
      table.end = table.doc.length;
      const patchCells = () => {
        for (const row of table.rows) for (const cell of row) {
          cell.getAbsoluteOffsets = function() {
            return {
              start: mapLocal(this.start),
              end: mapLocal(this.end),
              textStart: mapLocal(this.start + this.padStart),
              textEnd: mapLocal(this.end - this.padEnd)
            };
          };
        }
      };
      const mergeGrid = () => tableMergeGrid(table.rows.map(row => row.map(cell => cell.text)));
      const applyMerges = () => {
        const {span} = mergeGrid();
        table.rows.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
          const size = span[rowIndex] && span[rowIndex][columnIndex];
          if (!cell.el) return;
          cell.el.style.display = size ? '' : 'none';
          cell.el.colSpan = size ? size.columns : 1;
          cell.el.rowSpan = size ? size.rows : 1;
        }));
      };
      const render = table.render.bind(table);
      table.render = () => {
        const result = render();
        patchCells();
        applyMerges();
        return result;
      };
      const getNextCell = table.getNextCell.bind(table);
      table.getNextCell = (cell, direction) => {
        const {span} = mergeGrid();
        let next = getNextCell(cell, direction);
        while (next && !span[next.row][next.col]) next = getNextCell(next, direction);
        return next;
      };
      const receiveCellFocus = table.receiveCellFocus.bind(table);
      table.receiveCellFocus = (row, column, ...rest) => {
        const owners = mergeGrid().owner, master = owners[row] && owners[row][column];
        return receiveCellFocus(master ? master.row : row, master ? master.column : column, ...rest);
      };
      const getClosestCell = table.getClosestCell.bind(table);
      table.getClosestCell = (x, y) => {
        const {span} = mergeGrid();
        if (!tableHasMerges(span)) return getClosestCell(x, y);
        let closest = null, shortest = Infinity;
        for (const row of table.rows) for (const cell of row) {
          if (!cell.el || !span[cell.row][cell.col]) continue;
          const rect = cell.el.getBoundingClientRect();
          const dx = Math.max(rect.left - x, 0, x - rect.right), dy = Math.max(rect.top - y, 0, y - rect.bottom);
          if (dx * dx + dy * dy < shortest) {
            shortest = dx * dx + dy * dy;
            closest = cell;
          }
        }
        return closest || getClosestCell(x, y);
      };
      const commitMerge = bounds => {
        table.colWidths = table.alignments.map((alignment, column) =>
          table.rows.reduce((width, row) => Math.max(width, (row[column] ? row[column].text.length : 0) + 2), 5));
        table.deselectCells();
        table.dispatchTable(bounds.minRow, bounds.minCol);
      };
      const eachCell = (bounds, callback) => {
        for (let row = bounds.minRow; row <= bounds.maxRow; row++) {
          for (let column = bounds.minCol; column <= bounds.maxCol; column++) callback(table.rows[row][column], row, column);
        }
      };
      const onContextMenu = table.onContextMenu.bind(table);
      table.onContextMenu = (cell, menu) => {
        const result = onContextMenu(cell, menu);
        const {owner, span} = mergeGrid();
        const selection = table.getSelectionBounds();
        const bounds = expandTableMergeBounds(owner, span, selection ||
          {minRow: cell.row, maxRow: cell.row, minCol: cell.col, maxCol: cell.col});
        const single = bounds.minRow === bounds.maxRow && bounds.minCol === bounds.maxCol;
        let merged = false;
        eachCell(bounds, (target, row, column) => {
          const size = span[row][column];
          merged = merged || !!(size && (size.columns > 1 || size.rows > 1));
        });
        if (selection && !single && !(bounds.minRow === 0 && bounds.maxRow > 0)) {
          menu.addItem(item => item.setSection('table').setIcon('lucide-table-cells-merge').setTitle('셀 병합').onClick(() => {
            const parts = new Set();
            eachCell(bounds, target => {
              const text = target.text.trim();
              if (text && text !== TABLE_MERGE_LEFT && text !== TABLE_MERGE_UP) parts.add(text);
            });
            eachCell(bounds, (target, row, column) => {
              target.text = row === bounds.minRow && column === bounds.minCol ? [...parts].join('<br>')
                : row === bounds.minRow ? TABLE_MERGE_LEFT : TABLE_MERGE_UP;
            });
            commitMerge(bounds);
          }));
        }
        if (merged) {
          menu.addItem(item => item.setSection('table').setIcon('lucide-table-cells-split').setTitle('병합 해제').onClick(() => {
            eachCell(bounds, target => {
              const text = target.text.trim();
              if (text === TABLE_MERGE_LEFT || text === TABLE_MERGE_UP) target.text = '';
            });
            commitMerge(bounds);
          }));
        }
        return result;
      };
      const dispatchUpdate = table.dispatchUpdate.bind(table);
      table.dispatchUpdate = (...args) => {
        state.mapDoc = table.doc;
        try {
          return dispatchUpdate(...args);
        } finally {
          state.mapDoc = null;
          table.start = 0;
          table.end = table.doc.length;
        }
      };
      const dispatchTable = table.dispatchTable.bind(table);
      table.dispatchTable = (...args) => {
        state.mapDoc = table.doc;
        state.wholeTable = true;
        try {
          return dispatchTable(...args);
        } finally {
          state.mapDoc = null;
          state.wholeTable = false;
          table.start = 0;
          table.end = table.doc.length;
        }
      };
      table.placeCursorAround = where => {
        const doc = view.state.doc, spec = state.spec;
        const line = where === 'before' ? doc.lineAt(spec.from).number - 1 : doc.lineAt(spec.to).number + 1;
        if (line >= 1 && line <= doc.lines) {
          view.dispatch({selection: {anchor: doc.line(line).from}, scrollIntoView: true});
          view.focus();
        }
      };
      table.addNewLine = where => {
        const position = where === 'before' ? state.spec.from : state.spec.to;
        const insert = where === 'before' ? '\n' : '\n' + state.spec.indent;
        view.dispatch({changes: {from: position, insert}, selection: {anchor: position + insert.length}, scrollIntoView: true});
        view.focus();
      };

      const dom = table.toDOM();
      dom.classList.add('list-table-preview', 'native-list-table');
      dom.style.paddingInlineStart = indentColumns(this.indent, view.state.tabSize) + 'ch';
      dom.tableSpec = this;
      dom.nativeListTable = state;
      dom.setAttribute('aria-label', 'Obsidian 표 편집');
      return dom;
    }

    cellRange(view, row, column) {
      const first = view.state.doc.lineAt(this.from).number;
      const number = first + (row > 0 ? row + 1 : 0);
      if (number > view.state.doc.lines) return null;
      const line = view.state.doc.line(number);
      const cell = listTableCellRanges(line.text, this.indent.length)[column];
      return cell && {from: line.from + cell.from, to: line.from + cell.to};
    }
    toDOM(view) {
      const native = this.nativeDOM(view);
      if (native) return native;
      const dom = document.createElement('div');
      dom.className = 'list-table-preview';
      dom.tabIndex = 0;
      dom.setAttribute('role', 'button');
      dom.setAttribute('aria-label', '표 셀 편집');
      dom.tableSpec = this;
      dom.style.paddingInlineStart = indentColumns(this.indent, view.state.tabSize) + 'ch';
      const body = dom.createDiv({cls: 'markdown-rendered'});
      const info = view.state.field(editorInfoField, false);
      const render = () => {
        components.get(dom)?.unload();
        body.replaceChildren();
        const component = new Component();
        component.load();
        components.set(dom, component);
        return MarkdownRenderer.render(plugin.app, dom.tableSpec.markdown, body, info?.file?.path || '', component).then(() => {
          body.querySelectorAll('table').forEach(applyTableMergesToDOM);
          if (dom.isConnected) view.requestMeasure();
        });
      };
      const finish = (next, focusEditor = false) => {
        if (!dom.cellEditor) return;
        dom.cellEditor = null;
        render().then(() => {
          if (next && dom.isConnected) begin(next.row, next.column);
        });
        if (focusEditor) {
          const firstLine = view.state.doc.lineAt(dom.tableSpec.from).number;
          const anchor = firstLine > 1 ? view.state.doc.line(firstLine - 1).from : Math.min(view.state.doc.length, dom.tableSpec.to + 1);
          view.dispatch({selection: {anchor}, effects: setActiveTable.of(null), scrollIntoView: true});
          view.focus();
        }
      };
      const begin = (row, column) => {
        if (dom.cellEditor) {
          if (dom.cellEditor.row !== row || dom.cellEditor.column !== column) finish({row, column});
          return;
        }
        const table = body.querySelector('table');
        const cell = table?.querySelector('[data-table-row="' + row + '"][data-table-col="' + column + '"]');
        const range = dom.tableSpec.cellRange(view, row, column);
        if (!cell || !range) return;
        const headerCells = Array.from(table.rows[0].cells);
        if (headerCells.every(cell => cell.colSpan === 1)) {
          const widths = headerCells.map(cell => cell.getBoundingClientRect().width);
          table.style.tableLayout = 'fixed';
          for (const tr of table.rows) Array.from(tr.cells).forEach(cell => {
            const width = widths[Number(cell.dataset.tableCol)];
            if (cell.colSpan === 1 && width != null) cell.style.width = width + 'px';
          });
        }
        const textarea = document.createElement('textarea');
        textarea.className = 'list-table-cell-editor';
        textarea.setAttribute('aria-label', (row + 1) + '행 ' + (column + 1) + '열 편집');
        textarea.value = view.state.doc.sliceString(range.from, range.to);
        const edit = dom.cellEditor = {row, column, textarea, saved: textarea.value, firstInput: true};
        view.dispatch({effects: setActiveTable.of({from: dom.tableSpec.from, to: dom.tableSpec.to})});
        const height = cell.getBoundingClientRect().height;
        cell.replaceChildren(textarea);
        const resize = () => {
          textarea.style.height = '0';
          textarea.style.height = Math.max(height - 16, textarea.scrollHeight, 28) + 'px';
          view.requestMeasure();
        };
        textarea.addEventListener('input', () => {
          const current = dom.tableSpec.cellRange(view, row, column);
          if (!current) return;
          edit.saved = encodeListTableCell(textarea.value);
          view.dispatch({
            changes: {from: current.from, to: current.to, insert: edit.saved},
            userEvent: 'input.type',
            annotations: edit.firstInput ? isolateHistory.of('before') : []
          });
          edit.firstInput = false;
          resize();
        });
        textarea.addEventListener('blur', () => { if (dom.cellEditor === edit) finish(); });
        textarea.addEventListener('keydown', event => {
          event.stopPropagation();
          if (event.isComposing || event.keyCode === 229) return;
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
            event.preventDefault();
            (event.shiftKey ? redo : undo)(view);
            resize();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            finish(null, true);
          } else if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
            event.preventDefault();
            const positions = Array.from(table.querySelectorAll('[data-table-row]'))
              .map(cell => ({row: Number(cell.dataset.tableRow), column: Number(cell.dataset.tableCol)}));
            const index = positions.findIndex(position => position.row === row && position.column === column);
            const next = event.key === 'Tab'
              ? positions[index + (event.shiftKey ? -1 : 1)]
              : positions.find(position => position.row > row && position.column === column);
            finish(next || null, !next);
          }
        });
        resize();
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      };
      render();
      dom.addEventListener('click', event => {
        if (event.target.closest?.('textarea')) return;
        const cell = event.target.closest?.('th, td');
        if (!cell || cell.dataset.tableRow == null) return;
        event.preventDefault();
        event.stopPropagation();
        begin(Number(cell.dataset.tableRow), Number(cell.dataset.tableCol));
      }, true);
      dom.addEventListener('keydown', event => {
        if (event.target === dom && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          begin(0, 0);
        }
      });
      return dom;
    }
    ignoreEvent() { return true; }
    destroy(dom) {
      if (dom.nativeListTable) {
        const {table, editor} = dom.nativeListTable;
        if (editor.tableCell?.table === table) editor.destroyTableCell();
        table.clear();
        return;
      }
      components.get(dom)?.unload();
    }
  }

  function decorate(state, active) {
    if (!state.field(editorLivePreviewField, false)) return Decoration.none;
    const decorations = [];
    for (let number = 1; number < state.doc.lines; number++) {
      const first = state.doc.line(number);
      const match = /^([ \t]+)(\S.*\|.*)$/.exec(first.text);
      if (!match) continue;
      const indent = match[1], separator = state.doc.line(number + 1).text;
      if (!separator.startsWith(indent) ||
          !/^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?$/.test(separator.trim())) continue;
      let node = ensureSyntaxTree(state, first.to, 30)?.resolveInner(first.from + indent.length + 1, -1);
      let list = false, literal = false;
      while (node) {
        if (/list-\d/.test(node.name)) list = true;
        if (/code|comment|frontmatter|yaml|math/i.test(node.name)) literal = true;
        node = node.parent;
      }
      if (!list || literal) continue;
      let end = number + 1;
      while (end < state.doc.lines) {
        const text = state.doc.line(end + 1).text;
        if (!text.startsWith(indent) || !/^\S.*\|/.test(text.slice(indent.length))) break;
        end++;
      }
      const to = state.doc.line(end).to;
      const gap = number > 1 && state.doc.line(number - 1);
      if (gap && !gap.text.trim() && !state.selection.ranges.some(range => range.from <= gap.to && range.to >= gap.from)) {
        decorations.push(Decoration.line({class: 'list-table-gap'}).range(gap.from));
      }
      const markdown = state.doc.sliceString(first.from, to).split('\n').map(line => line.slice(indent.length)).join('\n');
      decorations.push(Decoration.replace({block: true, widget: new NestedTableWidget(markdown, first.from, to, indent)}).range(first.from, to));
      number = end;
    }
    return Decoration.set(decorations);
  }
  plugin.registerMarkdownPostProcessor(element => element.querySelectorAll('table').forEach(applyTableMergesToDOM));
  plugin.registerEditorExtension([
    StateField.define({
      create: state => ({active: null, decorations: decorate(state, null)}),
      update(value, transaction) {
        let active = value.active;
        if (active && transaction.docChanged) {
          active = {from: transaction.changes.mapPos(active.from, -1), to: transaction.changes.mapPos(active.to, 1)};
        }
        let explicitlySet = false;
        for (const effect of transaction.effects) {
          if (effect.is(setActiveTable)) {
            active = effect.value;
            explicitlySet = true;
          }
        }
        if (!explicitlySet && active && !transaction.state.selection.ranges.some(range => range.from <= active.to && range.to >= active.from)) {
          active = null;
        }
        return transaction.docChanged || transaction.selection || transaction.effects.length ? {active, decorations: decorate(transaction.state, active)} : value;
      },
      provide: field => EditorView.decorations.from(field, value => value.decorations)
    }),
    EditorView.baseTheme({
      '.cm-line.list-table-gap': {height: '4px !important', minHeight: '0 !important', lineHeight: '4px !important', fontSize: '0 !important', paddingTop: '0 !important', paddingBottom: '0 !important'},
      '.list-table-preview': {boxSizing: 'border-box', width: '100%', margin: '0 0 .35em', cursor: 'text'},
      '.native-list-table.cm-table-widget': {boxSizing: 'border-box', width: '100%', margin: '0 0 .35em'},
      '.list-table-preview .markdown-rendered': {overflowX: 'auto'},
      '.list-table-preview table': {width: '100%', tableLayout: 'auto', borderCollapse: 'collapse', margin: '0', fontSize: 'var(--font-text-size)'},
      '.list-table-preview th, .list-table-preview td': {fontSize: 'inherit', padding: '.45em .65em', border: '1px solid var(--table-border-color)', overflowWrap: 'anywhere'},
      '.list-table-preview p': {margin: '0'},
      '.list-table-preview img': {maxWidth: '100%'}
      ,'.list-table-cell-editor': {display: 'block', width: '100%', minWidth: '0', maxWidth: '100%', boxSizing: 'border-box', margin: '0', padding: '2px', resize: 'none', font: 'inherit', lineHeight: 'inherit', color: 'var(--text-normal)', background: 'var(--background-primary)', border: '1px solid var(--interactive-accent)'}
    })
  ]);
}
