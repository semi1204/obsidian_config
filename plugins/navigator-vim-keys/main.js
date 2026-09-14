const { Plugin, Notice } = require("obsidian");

const ARROWS = { KeyH: "ArrowLeft", KeyJ: "ArrowDown", KeyK: "ArrowUp", KeyL: "ArrowRight" };

module.exports = class NavigatorVimKeys extends Plugin {
  onload() {
    this.previews = new Map();
    this.registerDomEvent(document, "keydown", event => this.handleKey(event), true);
    this.registerDomEvent(document, "pointerdown", event => {
      const pane = event.target?.closest?.(".nn-navigation-pane-scroller");
      if (pane) this.clearPreview(pane.closest(".nn-split-container") || pane);
    }, true);
  }

  onunload() {
    for (const pane of this.previews.keys()) this.clearPreview(pane);
  }

  getNavigationIndex(pane, items) {
    const preview = this.previews.get(pane);
    if (!preview) return null;
    const index = items.findIndex(item => item.data === preview.folder);
    if (index >= 0) return index;
    this.clearPreview(pane);
    return null;
  }

  previewNavigationItem(pane, item, commit) {
    if (!pane || !Array.isArray(item.data?.children)) {
      if (pane) this.clearPreview(pane);
      return false;
    }
    let preview = this.previews.get(pane);
    if (!preview) {
      const observer = new MutationObserver(() => this.paintPreview(pane));
      observer.observe(pane, {childList: true, subtree: true});
      preview = {observer};
      this.previews.set(pane, preview);
    }
    preview.folder = item.data;
    preview.commit = commit;
    this.paintPreview(pane);
    return true;
  }

  paintPreview(pane) {
    const folder = this.previews.get(pane)?.folder;
    for (const row of pane.querySelectorAll(".nn-navitem.nn-folder")) {
      row.classList.toggle("nn-vim-folder-cursor", !!folder && row.dataset.path === folder.path);
    }
  }

  clearPreview(pane) {
    this.previews.get(pane)?.observer.disconnect();
    this.previews.delete(pane);
    this.paintPreview(pane);
  }

  commitPreview(pane) {
    const commit = this.previews.get(pane)?.commit;
    this.clearPreview(pane);
    commit?.();
    // Use Navigator's keyboard handoff so it also selects a file when needed.
    const KeyboardEventClass = pane.ownerDocument.defaultView?.KeyboardEvent || KeyboardEvent;
    pane.dispatchEvent(new KeyboardEventClass("keydown", {
      key: "Tab", code: "Tab", bubbles: true, cancelable: true
    }));
  }

  async openSelectedFile() {
    const navigator = this.app.plugins.plugins["notebook-navigator"];
    const selection = navigator.api.selection.getCurrent();
    const file = selection.focused || selection.files[0];
    if (!file) return;
    const result = await navigator.commandQueue.executeOpenActiveFile(file, async leaf => {
      await leaf.openFile(file, {active: true});
      this.app.workspace.setActiveLeaf(leaf, {focus: true});
    }, {active: true, getLeaf: () => this.app.workspace.getLeaf(false)});
    if (!result.success) new Notice("노트를 열지 못했습니다: " + result.error);
  }

  handleKey(event) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const target = event.target;
    if (!target?.closest || target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
    const scroller = target.closest(".nn-navigation-pane-scroller, .nn-list-pane-scroller");
    const pane = target.closest(".nn-split-container") || scroller;
    if (!pane) return;
    // Navigator normally focuses the shared root, not the individual scroller.
    const navigation = scroller ? scroller.matches(".nn-navigation-pane-scroller") :
      pane.dataset.focusPane === "navigation";
    const files = scroller ? scroller.matches(".nn-list-pane-scroller") :
      pane.dataset.focusPane === "files";
    if (files && (event.key === "Enter" || event.code === "Enter" || event.code === "NumpadEnter")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) void this.openSelectedFile();
      return;
    }
    if (navigation && (event.code === "Space" || event.key === " ")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) this.commitPreview(pane);
      return;
    }
    if (navigation && this.previews.has(pane) && ["F2", "Delete", "Backspace"].includes(event.key)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      new Notice("Space로 폴더를 확정한 뒤 실행하세요.");
      return;
    }

    // Physical key codes also work while the Korean IME reports a Korean key or Process.
    const code = event.code || (event.key.length === 1 ? `Key${event.key.toUpperCase()}` : "");
    let key = ARROWS[code];
    if (!key) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (code === "KeyL" && !navigation) return;
    const KeyboardEventClass = target.ownerDocument.defaultView?.KeyboardEvent || KeyboardEvent;
    target.dispatchEvent(new KeyboardEventClass("keydown", {
      key, code: key, bubbles: true, cancelable: true, repeat: event.repeat,
      isComposing: false
    }));
  }
};
