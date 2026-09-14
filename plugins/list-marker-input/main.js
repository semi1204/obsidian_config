const { Plugin } = require("obsidian");
const { Prec } = require("@codemirror/state");
const { EditorView, ViewPlugin } = require("@codemirror/view");
const { ensureSyntaxTree } = require("@codemirror/language");
const { isolateHistory } = require("@codemirror/commands");

module.exports = class ListMarkerInput extends Plugin {
  onload() {
    this.registerEditorExtension(Prec.highest(EditorView.inputHandler.of(
      (view, from, to, text) => this.convertInput(view, from, to, text)
    )));
    this.registerEditorExtension(ViewPlugin.fromClass(class {
      constructor(view) {
        this.view = view;
        this.win = view.dom.ownerDocument.defaultView;
        this.frame = 0;
        this.update();
      }
      update() {
        if (this.frame) return;
        this.frame = this.win.requestAnimationFrame(() => {
          this.frame = 0;
          for (const marker of this.view.dom.querySelectorAll(".cm-formatting-list-ol .list-number")) {
            const line = marker.closest(".HyperMD-list-line");
            const depth = Number(line?.className.match(/\bHyperMD-list-line-(\d+)\b/)?.[1]);
            const ordinal = /^\s*(\d+)[.)]\s*$/.exec(marker.textContent);
            if (depth > 1 && ordinal) {
              const level = String(Math.min(depth, 3)), number = String(Number(ordinal[1]));
              if (marker.dataset.readableListDepth !== level) marker.dataset.readableListDepth = level;
              if (marker.style.getPropertyValue("--readable-list-number") !== number) marker.style.setProperty("--readable-list-number", number);
            } else {
              marker.removeAttribute("data-readable-list-depth");
              marker.style.removeProperty("--readable-list-number");
            }
          }
        });
      }
      destroy() {
        this.win.cancelAnimationFrame(this.frame);
        for (const marker of this.view.dom.querySelectorAll("[data-readable-list-depth]")) {
          marker.removeAttribute("data-readable-list-depth");
          marker.style.removeProperty("--readable-list-number");
        }
      }
    }));
  }

  convertInput(view, from, to, text) {
    const { state } = view;
    if (view.composing || from !== to || state.selection.ranges.length !== 1 ||
        !state.selection.main.empty || !text.endsWith(" ") || /[\r\n]/.test(text)) {
      return false;
    }
    const line = state.doc.lineAt(from);
    const prefix = state.doc.sliceString(line.from, from) + text;
    const match = /^([ \t]*)(?:[-+*][ \t]+(\d{1,9})\.|\d{1,9}[.)][ \t]+-) $/.exec(prefix);
    if (!match) return false;

    const marker = line.from + match[1].length;
    const tree = ensureSyntaxTree(state, marker + 1, 50);
    let node = tree?.resolveInner(marker + 1, -1);
    let isList = false;
    while (node) {
      if (/code|comment|frontmatter|yaml/i.test(node.name)) return false;
      if (/formatting-list|list-\d|BulletList|OrderedList/.test(node.name)) isList = true;
      node = node.parent;
    }
    if (!isList) return false;

    const insert = match[2] ? `${match[2]}. ` : "- ";
    view.dispatch({
      changes: { from: marker, to, insert },
      selection: { anchor: marker + insert.length },
      userEvent: "input.type",
      annotations: isolateHistory.of("full"),
      scrollIntoView: true
    });
    return true;
  }
};
