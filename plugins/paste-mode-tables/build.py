from pathlib import Path
import argparse

here = Path(__file__).parent
parser = argparse.ArgumentParser(description="Patch Paste Mode 5.0.2 with nested-table editing and cell merging.")
parser.add_argument("--base", required=True, type=Path, help="Path to the upstream 5.0.2 main.js")
parser.add_argument("--output", required=True, type=Path, help="Output plugin directory")
args = parser.parse_args()
output = args.output.expanduser().resolve()
output.mkdir(parents=True, exist_ok=True)
source = args.base.expanduser().resolve().read_text()
before = '''      this.app.workspace.on("editor-paste", (evt, editor) => __async(this, null, function* () {
        if (evt.defaultPrevented) {
          return;
        }
        evt.preventDefault();
        let mode = this.settings.mode;
        if (mode === Mode.Passthrough) {
          return;
        }'''
after = '''      this.registerEvent(this.app.workspace.on("editor-paste", (evt, editor) => __async(this, null, function* () {
        if (evt.defaultPrevented) {
          return;
        }
        let mode = this.settings.mode;
        if (mode === Mode.Passthrough) {
          return;
        }
        // Let Obsidian preserve table cells, line breaks, and table-editor paste behavior.
        const html = evt.clipboardData?.getData("text/html") || "";
        if ((mode === Mode.Text || mode === Mode.Markdown) && pasteTableInList(evt, editor)) {
          return;
        }
        if ((mode === Mode.Text || mode === Mode.Markdown) && /<table\\b/i.test(html)) {
          return;
        }
        evt.preventDefault();'''
assert source.count(before) == 1
source = source.replace(before, after, 1)
before = '''        editor.transaction(transaction);
      }));
      Object.values(Mode).forEach'''
after = '''        editor.transaction(transaction);
      })));
      Object.values(Mode).forEach'''
assert source.count(before) == 1
source = source.replace(before, after, 1)
before = '      yield this.loadSettings();'
assert source.count(before) == 1
source = source.replace(before, before + '\n      installNestedTablePreview(this);', 1)
(output / 'main.js').write_text(source.replace(
    'var PastetoIndentationPlugin = class',
    (here / 'table-in-list.js').read_text() + '\n' +
    (here / 'nested-table-preview.js').read_text() + '\nvar PastetoIndentationPlugin = class', 1))
print(output / 'main.js')
