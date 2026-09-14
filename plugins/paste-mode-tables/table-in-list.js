// Keep a pasted table as a block inside the current list item.
function pasteTableInList(evt, editor) {
  const cursor = editor.getCursor();
  const line = editor.getLine(cursor.line);
  const item = /^([ \t]*)(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(line);
  if (!item || cursor.ch !== line.length || editor.getSelection() ||
      editor.listSelections().length !== 1 || editor.inTableCell) return false;

  if (editor.cm?.state) {
    const offset = editor.posToOffset({line: cursor.line, ch: item[1].length});
    let node = require('@codemirror/language').ensureSyntaxTree(editor.cm.state, offset + 1, 50)?.resolveInner(offset + 1, -1);
    while (node) {
      if (/code|comment|frontmatter|yaml|math/i.test(node.name)) return false;
      node = node.parent;
    }
  }

  const data = evt.clipboardData;
  const html = data.getData('text/html');
  const markdown = data.getData('text/markdown') ||
    (/<table\b/i.test(html) ? (0, import_obsidian.htmlToMarkdown)(html) :
      data.getData('text/plain') || data.getData('text'));
  const rows = markdown.trim().split(/\r?\n/).map(row => row.trim());
  if (rows.length < 2 || !rows[0].includes('|') ||
      !/^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?$/.test(rows[1]) ||
      rows.some(row => !row.includes('|'))) return false;

  const indent = item[0].replace(/\S/g, ' ');
  evt.preventDefault();
  editor.transaction({replaceSelection: '\n' + indent + '\n' + rows.map(row => indent + row).join('\n') + '\n' + indent});
  return true;
}
