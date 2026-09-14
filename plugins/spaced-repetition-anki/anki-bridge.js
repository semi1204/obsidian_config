// Local extension of the installed Spaced Repetition 1.15.4 bundle.
// Uses its own parser and card expansion; Anki owns all Anki scheduling.
function localClozeSyntaxRanges(text) {
  const protectedRanges = [...text.matchAll(/(`+)[^\n]*?\1|\\\([^\n]*?\\\)|\$\$[^\n]*?\$\$|\$(?:\\.|[^$\\\n])+\$/g)];
  const ranges = [];
  for (const match of text.matchAll(/\{\{((?:\d+|[ash]+);;)?(.+?)\}\}/g)) {
    if (protectedRanges.some(range => match.index >= range.index && match.index < range.index + range[0].length)) continue;
    const from = match.index, prefix = 2 + (match[1]?.length || 0), end = from + match[0].length;
    ranges.push({ kind: "cloze-syntax", from, to: from + prefix });
    const hint = match[2].indexOf(";;");
    if (hint >= 0) ranges.push({ kind: "cloze-syntax", from: from + prefix + hint, to: from + prefix + hint + 2 });
    ranges.push({ kind: "cloze-syntax", from: end - 2, to: end });
  }
  return ranges;
}

function localDimRenderedClozes(element) {
  const doc = element.ownerDocument, walker = doc.createTreeWalker(element, 4);
  const nodes = [];
  let text = "", previousBlock = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement.closest("code, pre, .math, mjx-container, .osr-cloze-syntax")) { text += "\n"; previousBlock = null; continue; }
    const block = node.parentElement.closest("p, li, th, td, h1, h2, h3, h4, h5, h6") || element;
    if (block !== previousBlock) text += "\n";
    nodes.push({ node, from: text.length, to: text.length + node.nodeValue.length });
    text += node.nodeValue;
    previousBlock = block;
  }
  const ranges = localClozeSyntaxRanges(text);
  for (const { node, from, to } of nodes) {
    const matches = ranges.filter(range => range.from < to && range.to > from);
    if (!matches.length) continue;
    const fragment = doc.createDocumentFragment(), value = node.nodeValue;
    let cursor = 0;
    for (const range of matches) {
      const start = Math.max(range.from, from) - from, end = Math.min(range.to, to) - from;
      fragment.append(doc.createTextNode(value.slice(cursor, start)));
      const span = doc.createElement("span");
      span.className = "osr-cloze-syntax";
      span.style.color = "color-mix(in srgb, var(--text-normal) 25%, transparent)";
      span.textContent = value.slice(start, end);
      fragment.append(span);
      cursor = end;
    }
    fragment.append(doc.createTextNode(value.slice(cursor)));
    node.replaceWith(fragment);
  }
}

function localCardEditorRanges(text, settings) {
  const lines = text.split("\n"), protectedLines = localProtectedCardLines(lines);
  const offsets = [];
  let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
  const ranges = [];
  for (let i = 0; i < lines.length; i++) {
    if (protectedLines.has(i)) continue;
    const line = lines[i], trimmed = line.trim();
    ranges.push(...localClozeSyntaxRanges(line).map(range => ({ ...range, from: range.from + offsets[i], to: range.to + offsets[i] })));
    const standalone = [settings.multilineCardSeparator, settings.multilineReversedCardSeparator]
      .find(marker => marker && trimmed === marker);
    const marker = standalone || localListCardMarker(line, settings)?.marker;
    if (!marker) continue;
    const from = offsets[i] + line.lastIndexOf(marker);
    ranges.push({ kind: "separator", from, to: from + marker.length });
    if (!standalone || i + 1 >= lines.length || lines[i + 1].trim()) continue;
    let next = i + 1;
    while (next < lines.length && !lines[next].trim()) next++;
    const cells = lines[next + 1]?.trim().replace(/^\||\|$/g, "").split("|") || [];
    if (protectedLines.has(next) || protectedLines.has(next + 1) || !lines[next]?.includes("|")
      || cells.length < 2 || !cells.every(cell => /^\s*:?-{2,}:?\s*$/.test(cell))) continue;
    for (let j = i + 1; j < next; j++) ranges.push({ kind: "table-gap", from: offsets[j], to: offsets[j] + lines[j].length });
  }
  return ranges;
}

var LocalAnkiBridge = class {
  constructor(plugin) {
    this.plugin = plugin;
    this.api = require("obsidian");
    this.crypto = this.api.Platform.isMobile ? null : require("crypto");
    this.busy = false;
    this.deck = plugin.app?.vault?.getName?.() || "Obsidian";
    this.model = `Obsidian SR - ${this.deck}`;
    this.profile = null;
    this.decksEnsured = new Set();
    this.reportPath = `${plugin.manifest.dir}/anki-last-sync.json`;
  }

  install() {
    this.installMarkerVisibility();
    this.plugin.registerMarkdownPostProcessor(localDimRenderedClozes);
    if (this.api.Platform.isMobile) return;
    const run = (file) => this.run(file);
    this.plugin.addCommand({ id: "anki-sync-all", name: "Anki: 모든 카드 동기화", callback: () => run() });
    this.plugin.addCommand({
      id: "anki-sync-note", name: "Anki: 현재 노트 동기화",
      checkCallback: (checking) => {
        const file = this.plugin.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void run(file);
        return true;
      }
    });
    this.plugin.addCommand({ id: "anki-check-connection", name: "Anki: 연결 확인", callback: () => this.checkConnection() });
    this.plugin.addRibbonIcon("refresh-cw", "Anki: 모든 카드 동기화", () => run());
  }

  installMarkerVisibility() {
    const { StateField, EditorState } = require("@codemirror/state");
    const { Decoration, EditorView } = require("@codemirror/view");
    const markers = doc => [
      ...[...doc.toString().matchAll(/^[ \t]*<!--ANKI:[a-f0-9]{32}-->[ \t]*$/gm)]
        .map(match => ({ from: match.index, to: match.index + match[0].length })),
      ...localCardEditorRanges(doc.toString(), this.plugin.dataManager.settingsManager.settings)
    ];
    const decorate = (state, ranges) => ({
      ranges,
      decorations: Decoration.set(ranges.map(marker => {
        if (marker.kind === "separator") return Decoration.mark({ class: "osr-card-separator" }).range(marker.from, marker.to);
        if (marker.kind === "cloze-syntax") return Decoration.mark({ class: "osr-cloze-syntax" }).range(marker.from, marker.to);
        const active = state.selection.ranges.some(range => range.from <= marker.to && range.to >= marker.from);
        if (marker.kind === "table-gap") return Decoration.line({ class: "osr-card-table-gap" + (active ? " osr-card-table-gap-active" : "") }).range(marker.from);
        return Decoration.line({ class: active ? "osr-anki-id-active" : "osr-anki-id-hidden" }).range(marker.from);
      }), true)
    });
    const field = StateField.define({
      create: state => decorate(state, markers(state.doc)),
      update: (value, transaction) => transaction.docChanged
        ? decorate(transaction.state, markers(transaction.state.doc))
        : transaction.selection ? decorate(transaction.state, value.ranges) : value,
      provide: field => EditorView.decorations.from(field, value => value.decorations)
    });
    this.plugin.registerEditorExtension([field, EditorState.transactionFilter.of(localProtectAnkiClosers), EditorView.baseTheme({
      // Keep a small, clickable line so the stored ID is still easy to inspect.
      ".cm-line.osr-anki-id-hidden": {
        opacity: "0", fontSize: "1px", lineHeight: "6px", height: "6px",
        minHeight: "6px", overflow: "hidden", paddingTop: "0", paddingBottom: "0"
      },
      ".osr-card-separator": { color: "color-mix(in srgb, var(--text-normal) 25%, transparent)" },
      ".cm-line .osr-cloze-syntax": { color: "color-mix(in srgb, var(--text-normal) 25%, transparent)" },
      ".cm-line.osr-card-table-gap:not(.osr-card-table-gap-active)": {
        fontSize: "1px", lineHeight: "4px", height: "4px", minHeight: "4px", paddingTop: "0", paddingBottom: "0"
      },
      ".cm-line.osr-card-table-gap + .cm-table-widget": { paddingTop: "4px" }
    })]);
  }

  async invoke(action, params = {}, timeoutMs = 8000) {
    if (this.api.Platform.isMobile) throw new Error("Anki 전송은 Mac의 Obsidian에서 실행하세요. 모바일에서는 노트 작성과 자체 카드 복습을 사용할 수 있습니다.");
    let timer;
    try {
      const response = await Promise.race([
        this.api.requestUrl({
          url: "http://127.0.0.1:8765", method: "POST",
          contentType: "application/json", body: JSON.stringify({ action, version: 6, params })
        }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(action === "sync"
          ? "AnkiWeb 동기화 응답 시간이 초과됐습니다. Anki에서 진행 상태를 확인하세요."
          : "AnkiConnect 응답 시간 초과. Anki를 열고 다시 실행하세요.")), timeoutMs); })
      ]);
      const data = response.json;
      if (!data || !("result" in data) || !("error" in data)) throw new Error("AnkiConnect 응답 형식이 올바르지 않습니다.");
      if (data.error) throw new Error(`${action}: ${data.error}`);
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async verifyConnection() {
    const version = await this.invoke("version");
    if (version < 6) throw new Error("AnkiConnect API 6 이상이 필요합니다.");
    const profile = await this.invoke("getActiveProfile");
    if (this.profile && profile !== this.profile) throw new Error(`Anki에서 '${this.profile}' 프로필을 여세요. 현재: ${profile}`);
    return { version, profile };
  }

  async checkConnection() {
    try {
      const { version, profile } = await this.verifyConnection();
      new this.api.Notice(`Anki 연결 성공 · API ${version} · ${profile} · 덱 ${this.deck}`);
    } catch (error) {
      new this.api.Notice(`Anki 연결 실패: ${error.message}`, 10000);
    }
  }

  addSettings(container) {
    if (this.api.Platform.isMobile) {
      new this.api.Setting(container).setName("Anki 로컬 연동")
        .setDesc("카드 파싱과 Obsidian 자체 복습은 동일하게 사용할 수 있습니다. Anki 전송은 노트 동기화 후 Mac의 Obsidian에서 실행하세요.");
      return;
    }
    new this.api.Setting(container).setName("Anki 로컬 연동")
      .setDesc(`카드 분류를 ${this.deck} 하위 덱으로 동기화합니다. 예: #flashcards/이론/원가 → ${this.deck}::이론::원가. 기존 학습 기록은 유지됩니다.`)
      .addButton(button => button.setButtonText("연결 확인").onClick(() => this.checkConnection()))
      .addButton(button => button.setButtonText("모든 카드 동기화").setCta().onClick(() => this.run()));
  }

  async ensureModel() {
    const template = {
      Front: "{{Front}}",
      Back: `<div id="osr-question">{{FrontSide}}</div>
<hr id="answer">
{{Back}}<div class="source">{{Source}}</div>
<script>
if (document.querySelector(".osr-cloze-answer,.osr-inline-answer")) {
  document.getElementById("osr-question").remove();
  document.getElementById("answer").remove();
}
</script>`
    };
    const models = await this.invoke("modelNames");
    if (!models.includes(this.model)) {
      await this.invoke("createModel", {
        modelName: this.model, inOrderFields: ["Key", "Front", "Back", "Source"],
        css: ".card{font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif;font-size:16px;text-align:left;line-height:1.5;max-width:850px;margin:auto;padding:18px}img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #888;padding:6px 12px}pre{white-space:pre-wrap}a{color:#5b8def}.source{font-size:11px;opacity:.7;margin-top:16px}",
        cardTemplates: [{ Name: "복습", ...template }]
      });
    }
    const fields = await this.invoke("modelFieldNames", { modelName: this.model });
    if (!["Key", "Front", "Back", "Source"].every(field => fields.includes(field))) {
      throw new Error(`${this.model} 노트 유형의 필드가 변경되어 동기화를 중단했습니다.`);
    }
    const templates = await this.invoke("modelTemplates", { modelName: this.model });
    if (templates["복습"]?.Front !== template.Front || templates["복습"]?.Back !== template.Back) {
      await this.invoke("updateModelTemplates", { model: { name: this.model, templates: { "복습": template } } });
    }
    const { css } = await this.invoke("modelStyling", { modelName: this.model });
    const extraCss = `/* OSR presentation start */
.card{font-size:16px;line-height:1.5;padding:18px}
.source{font-size:11px;margin-top:16px}
.osr-context{font-size:11px;line-height:1.4;opacity:.65;margin-bottom:12px;overflow-wrap:anywhere}
.osr-context p{margin:0}.osr-content{overflow-wrap:anywhere}
.osr-content h1,.osr-content h2,.osr-content h3,.osr-content h4,.osr-content h5,.osr-content h6{font-size:18px;line-height:1.4;margin:.6em 0 .4em}
.osr-content img,.osr-content video{max-width:100%;height:auto}
.osr-content ul,.osr-content ol{padding-left:1.5em}.osr-content li{margin:.25em 0}
.osr-content li>:is(ol,ul){margin-top:6px}
.osr-content :is(ol,ul):not(li :is(ol,ul))>li+li{margin-top:12px}
.osr-content ol{list-style-type:decimal}.osr-content ol ol{list-style-type:lower-alpha}.osr-content ol ol ol{list-style-type:lower-roman}
.osr-content blockquote,.osr-content .callout{border-left:3px solid #8296b0;margin:1em 0;padding:.5em 1em;background:rgba(128,128,128,.08)}
.osr-content .callout-title{font-weight:bold;display:flex;gap:.5em}.osr-content .callout-icon svg{width:1em;height:1em}
.osr-content .callout-content{display:block!important}.osr-content .callout-fold{display:none}
.osr-content mark{background:#ffe680;color:#222}.osr-content code{font-family:ui-monospace,monospace;background:rgba(128,128,128,.12);border-radius:3px;padding:.12em .25em}
.osr-content pre{white-space:pre-wrap;text-align:left;padding:.75em;background:rgba(128,128,128,.1)}.osr-content pre code{background:none;padding:0}
.osr-content table{width:100%;border-collapse:collapse;max-width:100%;table-layout:auto;font-size:1em}.osr-content td,.osr-content th{border:1px solid #888;font-size:inherit;padding:.45em .65em;overflow-wrap:anywhere}
.osr-content .token.comment{color:#859089}.osr-content .token.keyword{color:#b781d7}.osr-content .token.string{color:#80a767}.osr-content .token.number{color:#c28b59}
/* OSR presentation end */`;
    const updatedCss = css.replace(/\n?\/\* OSR presentation start \*\/[\s\S]*?\/\* OSR presentation end \*\//g, "") + "\n" + extraCss;
    if (css !== updatedCss) await this.invoke("updateModelStyling", { model: { name: this.model, css: updatedCss } });
    await this.ensureDeck(this.deck);
  }

  getDeckName(question) {
    const settings = this.plugin.dataManager.settingsManager.settings;
    const names = (question.topicPathList?.list || []).map(topic => {
      const parts = [...topic.path];
      if (!settings.convertFoldersToDecks && settings.flashcardTags.some(tag => tag.replace(/^#/, "").split("/")[0] === parts[0])) parts.shift();
      if (parts.some(part => !part.trim() || part !== part.trim() || part.includes(":") || /[\r\n\x00-\x1f]/.test(part))) {
        throw new Error("카드 분류 이름에는 콜론·제어문자·앞뒤 공백을 사용할 수 없습니다.");
      }
      return [this.deck, ...parts].join("::");
    });
    const unique = [...new Set(names)].sort((a, b) => b.length - a.length);
    const target = unique[0] || this.deck;
    if (unique.some(name => name !== target && !target.startsWith(name + "::"))) {
      throw new Error("한 카드는 한 Anki 덱에 들어갑니다. 서로 다른 분류 태그를 하나로 정리하세요: " + unique.join(", "));
    }
    return target;
  }

  async ensureDeck(deck) {
    if (this.decksEnsured.has(deck)) return;
    await this.invoke("createDeck", { deck });
    this.decksEnsured.add(deck);
  }

  escape(value) {
    return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  sourceUrl(path) {
    return `obsidian://open?vault=${encodeURIComponent(this.plugin.app.vault.getName())}&file=${encodeURIComponent(path)}`;
  }

  normalizeListIndent(markdown) {
    // A child list becomes a standalone card face. Its parent indentation is not code.
    if (!/^[ \t]+(?:[-+*]|\d+[.)])\s/m.test(markdown) || !/^[ \t]*(?:[-+*]|\d+[.)])\s/.test(markdown.trimStart())) return markdown;
    const lines = markdown.split("\n").map(line => line.replace(/^[ \t]+/, indent => {
      let width = 0;
      for (const char of indent) width += char === "\t" ? 4 - width % 4 : 1;
      return " ".repeat(width);
    }));
    const indent = Math.min(...lines.filter(line => line.trim()).map(line => line.match(/^ */)[0].length));
    return lines.map(line => line.slice(indent)).join("\n");
  }

  async contextHtml(question, file) {
    const title = file.basename || file.path.split("/").pop().replace(/\.md$/i, "");
    const parts = [title, ...(question.questionContext || [])];
    const path = parts.map(part => part.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => alias || target));
    return `<div class="osr-context">${this.escape(path.join(" › "))}</div>`;
  }

  async media(link, sourcePath) {
    let bytes, extension;
    const mimeExtensions = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/avif": "avif", "image/bmp": "bmp" };
    if (/^https?:\/\//i.test(link)) {
      const response = await this.api.requestUrl({ url: link });
      extension = mimeExtensions[(response.headers["content-type"] || "").split(";")[0].toLowerCase()];
      if (!extension) throw new Error(`${sourcePath}: 이미지 응답이 아닙니다: ${link}`);
      bytes = Buffer.from(response.arrayBuffer);
    } else if (/^data:image\//i.test(link)) {
      const match = link.match(/^data:([^;,]+)(;base64)?,([\s\S]*)$/i);
      extension = match && mimeExtensions[match[1].toLowerCase()];
      if (!extension) throw new Error(`${sourcePath}: 지원하지 않는 인라인 이미지 형식입니다.`);
      bytes = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]));
    } else {
      let path = link;
      if (/^(app|file):/i.test(path)) path = new URL(path).pathname;
      path = path.split(/[?#]/)[0];
      try { path = decodeURIComponent(path); } catch { /* Keep literal percent signs in filenames. */ }
      const base = this.plugin.app.vault.adapter.getBasePath?.();
      if (base && path.startsWith(base + "/")) path = path.slice(base.length + 1);
      const file = this.plugin.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
      if (!file) throw new Error(`${sourcePath}: 첨부파일을 찾을 수 없습니다: ${link}`);
      bytes = Buffer.from(await this.plugin.app.vault.readBinary(file));
      extension = file.extension.toLowerCase();
    }
    const filename = `osr-${this.crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.${extension}`;
    if (!this.mediaSent.has(filename)) {
      await this.invoke("storeMediaFile", { filename, data: bytes.toString("base64") });
      this.mediaSent.add(filename);
    }
    return filename;
  }

  async render(markdown, file) {
    // Preserve TeX source for Anki's MathJax, leaving fenced and inline code alone.
    const tokens = [];
    const token = html => { const key = `OSRANKI${tokens.length}PLACEHOLDER`; tokens.push(html); return key; };
    const code = [];
    let text = this.normalizeListIndent(markdown).replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?\1|(`+)[^\n]*?\2/g,
      match => { const key = `OSRANKICODE${code.length}PLACEHOLDER`; code.push(match); return key; });
    text = text.replace(/\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<!\\)\$\$[\s\S]*?(?<!\\)\$\$|(?<![\\$])\$(?!\s)(?:\\.|[^$\\\n])*(?<![\s\\])\$(?!\d)/g, match => {
      const block = match.startsWith("$$") || match.startsWith("\\[");
      const length = match.startsWith("$") && !block ? 1 : 2;
      const tex = this.escape(match.slice(length, -length).replace(/\r?\n/g, " "));
      return token(block ? `\\[${tex}\\]` : `\\(${tex}\\)`);
    });
    text = localNormalizeListDividers(text);
    // Reference images/links and footnotes can be defined elsewhere in the note.
    // A reference definition also needs its own paragraph after splitting a card.
    if (/\[[^\]\n]+\]/.test(text)) {
      this.referenceCache ||= new Map();
      if (!this.referenceCache.has(file.path)) {
        const source = await this.plugin.app.vault.read(file);
        const withoutCode = source.replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?\1/g, "");
        this.referenceCache.set(file.path, withoutCode.match(/^ {0,3}\[[^\]\n]+\]:[^\n]*(?:\n[ \t]+[^\n]+)*/gm) || []);
      }
      text = text.replace(/^( {0,3}\[[^\]\n]+\]:)/gm, "\n$1");
      text += "\n\n" + this.referenceCache.get(file.path).join("\n\n");
    }
    // Resolve Obsidian embeds before rendering so Anki receives portable media.
    const embeds = [...text.matchAll(/!\[\[([^\]]+)\]\]/g)];
    for (const match of embeds.reverse()) {
      const [path, size] = match[1].split("|");
      const extension = path.split(/[?#]/)[0].split(".").pop().toLowerCase();
      let html;
      if (/^(png|jpe?g|gif|webp|svg|avif|bmp)$/.test(extension)) {
        const filename = await this.media(path, file.path);
        const dimensions = /^(\d+)(?:x(\d+))?$/.exec(size || "");
        const width = dimensions ? ` width="${dimensions[1]}"` : "";
        const height = dimensions?.[2] ? ` height="${dimensions[2]}"` : "";
        html = `<img src="${this.escape(filename)}"${width}${height}>`;
      } else if (/^(mp3|wav|ogg|m4a|mp4|webm)$/.test(extension)) {
        html = `[sound:${await this.media(path, file.path)}]`;
      } else {
        const dest = this.plugin.app.metadataCache.getFirstLinkpathDest(path.split("#")[0], file.path);
        html = `<a href="${this.escape(this.sourceUrl(dest ? dest.path : path))}">${this.escape(path)}</a>`;
      }
      text = text.slice(0, match.index) + token(html) + text.slice(match.index + match[0].length);
    }
    const element = document.createElement("div");
    const component = new this.api.Component();
    component.load();
    try {
      text = text.replace(/OSRANKICODE(\d+)PLACEHOLDER/g, (_, index) => code[Number(index)]);
      await this.api.MarkdownRenderer.render(this.plugin.app, text, element, file.path, component);
      // Both ![](relative.png) and reference-style Markdown images may become
      // Obsidian embed spans instead of ordinary img elements.
      for (const embed of element.querySelectorAll(".internal-embed[src]")) {
        const src = embed.getAttribute("src");
        if (!/\.(png|jpe?g|gif|webp|svg|avif|bmp)(?:[?#]|$)/i.test(src)) continue;
        const img = document.createElement("img");
        img.setAttribute("data-osr-src", await this.media(src, file.path));
        for (const name of ["alt", "width", "height"]) {
          const value = embed.getAttribute(name) || embed.querySelector("img")?.getAttribute(name);
          if (value) img.setAttribute(name, value);
        }
        embed.replaceWith(img);
      }
      for (const img of element.querySelectorAll("img")) {
        if (img.hasAttribute("data-osr-src")) continue;
        const src = img.getAttribute("src") || "";
        img.setAttribute("data-osr-src", await this.media(src, file.path));
        img.removeAttribute("src");
        img.removeAttribute("srcset");
      }
      for (const link of element.querySelectorAll("a.internal-link")) {
        const target = link.getAttribute("data-href") || link.getAttribute("href");
        const dest = this.plugin.app.metadataCache.getFirstLinkpathDest(target.split("#")[0], file.path);
        link.setAttribute("href", this.sourceUrl(dest ? dest.path : target));
      }
      for (const control of element.querySelectorAll(".copy-code-button,.code-styler-copy-button,.callout-fold")) control.remove();
      return `<div class="osr-content">${element.innerHTML.replace(/ data-osr-src=/g, " src=").replace(/OSRANKI(\d+)PLACEHOLDER/g, (_, index) => tokens[Number(index)])}</div>`;
    } finally {
      component.unload();
    }
  }

  async collect(selectedFile, report = { skipped: [] }) {
    const app = this.plugin.app;
    const settings = this.plugin.dataManager.settingsManager.settings;
    const seen = new Map();
    const entries = [];
    // Check the whole vault for copied IDs even when syncing only one note.
    for (const file of app.vault.getMarkdownFiles()) {
      if (SettingsUtil.isPathInFoldersToIgnore(settings, file.path)) continue;
      const srFile = this.plugin.dataManager.createSRNoteTFile(file);
      if (SettingsUtil.isAnyTagIgnoredForFlashcards(settings, srFile.getAllTagsFromCache())) continue;
      const original = await app.vault.read(file);
      try { localValidateAnkiMarkers(original); }
      catch (error) { throw new Error(`${file.path}: ${error.message}`); }
      const note = await new NoteFileLoader(settings).load(
        srFile, this.plugin.getObsidianRtlSetting(),
        TopicPath.getFolderPathFromFilename(file, settings));
      const validQuestions = [];
      for (const question of note.questionList) {
        const id = question.questionText.ankiId;
        if (id && seen.has(id)) throw new Error(`복사된 Anki ID: ${seen.get(id)}, ${file.path}. 복사한 카드의 <!--ANKI:...--> 줄을 지운 뒤 다시 동기화하세요.`);
        if (id) seen.set(id, file.path);
        if (!selectedFile || file.path === selectedFile.path) {
          this.getDeckName(question);
          if (question.cards.some(card => !localHasCardContent(card.front) || !localHasCardContent(card.back))) {
            report.skipped.push({
              file: file.path,
              line: question.lineNo + 1,
              reason: "앞면 또는 답이 비어 있습니다."
            });
            continue;
          }
          validQuestions.push(question);
        }
      }
      if (validQuestions.length) entries.push({ file, original, questions: validQuestions });
    }
    return entries;
  }

  async assignIds(entry) {
    const newline = entry.original.includes("\r\n") ? "\r\n" : "\n";
    const lines = entry.original.split(/\r?\n/);
    for (const question of [...entry.questions].sort((a, b) => b.parsedQuestionInfo.lastLineNum - a.parsedQuestionInfo.lastLineNum)) {
      const index = question.parsedQuestionInfo.lastLineNum;
      const existing = question.questionText.ankiId;
      const id = existing || this.crypto.randomUUID().replaceAll("-", "");
      const marker = `<!--ANKI:${id}-->`;
      const line = localCardMetadataIndent(question.questionText.actualQuestion) + marker;
      if (!existing) {
        question.questionText.ankiId = id;
        lines.splice(index + 1, 0, line);
      } else if (lines[index].trim() === marker) {
        lines[index] = line;
      }
    }
    const updated = lines.join(newline);
    if (updated === entry.original) return;
    await this.plugin.app.vault.process(entry.file, current => {
      if (current !== entry.original) throw new Error(`${entry.file.path}: 동기화 중 노트가 변경되었습니다. 저장 후 다시 실행하세요.`);
      return updated;
    });
  }

  async syncCard(card, question, file, report) {
    if (!localHasCardContent(card.front) || !localHasCardContent(card.back)) {
      throw new Error(`${file.path}: 앞면 또는 답이 비어 있는 카드는 Anki에 보낼 수 없습니다.`);
    }
    const deckName = this.getDeckName(question);
    const key = `${question.questionText.ankiId}-${card.cardIdx}`;
    const context = await this.contextHtml(question, file);
    let back = await this.render(card.back, file);
    if (question.questionType === 4 /* Cloze */ || card.isCloze) back = `<div class="osr-cloze-answer">${context}${back}</div>`;
    else if (question.questionType === 0 || question.questionType === 1) back = `<div class="osr-inline-answer">${context}${back}</div>`;
    const fields = {
      Key: key,
      Front: context + await this.render(card.front, file),
      Back: back,
      Source: `<a href="${this.escape(this.sourceUrl(file.path))}">${this.escape(file.path)}</a>`
    };
    const ids = await this.invoke("findNotes", { query: `note:"${this.model}" Key:${key}` });
    const infos = ids.length ? await this.invoke("notesInfo", { notes: ids }) : [];
    const matches = infos.filter(info => info.modelName === this.model && info.fields.Key?.value === key);
    if (matches.length > 1) throw new Error(`Anki에 같은 ID의 카드가 여러 개 있습니다: ${key}`);
    const existing = matches[0];
    await this.ensureDeck(deckName);
    if (existing) {
      const cards = await this.invoke("cardsInfo", { cards: existing.cards });
      const moving = cards.filter(item => item.deckName !== deckName).map(item => item.cardId);
      if (moving.length) {
        await this.invoke("changeDeck", { cards: moving, deck: deckName });
        report.moved += moving.length;
      }
      if (Object.entries(fields).some(([name, value]) => existing.fields[name]?.value !== value)) {
        await this.invoke("updateNoteFields", { note: { id: existing.noteId, fields } });
        report.updated++;
      } else report.unchanged++;
      report.noteIds.push(existing.noteId);
    } else {
      const noteId = await this.invoke("addNote", {
        note: { deckName, modelName: this.model, fields, tags: ["obsidian_sr", `obsidian_${this.deck}`], options: { allowDuplicate: false } }
      });
      report.noteIds.push(noteId);
      report.created++;
    }
  }

  async run(selectedFile) {
    if (this.busy) { new this.api.Notice("Anki 동기화가 이미 진행 중입니다."); return; }
    if (!this.plugin.isInitialized) { new this.api.Notice("Spaced Repetition 초기화 후 다시 실행하세요."); return; }
    this.busy = true;
    this.mediaSent = new Set();
    this.referenceCache = new Map();
    this.decksEnsured = new Set();
    const report = { started: new Date().toISOString(), created: 0, updated: 0, unchanged: 0, moved: 0, skipped: [], noteIds: [], error: null, ankiWeb: { started: false, error: null } };
    try {
      await this.verifyConnection();
      const entries = await this.collect(selectedFile, report);
      await this.ensureModel();
      for (const entry of entries) {
        await this.assignIds(entry);
        for (const question of entry.questions) {
          for (const card of question.cards) await this.syncCard(card, question, entry.file, report);
        }
      }
      const skipped = report.skipped.length ? ` · 미완성 ${report.skipped.length}개 건너뜀` : "";
      const summary = `Anki 카드 전송 완료 · 새 카드 ${report.created} · 수정 ${report.updated} · 동일 ${report.unchanged} · 덱 이동 ${report.moved}${skipped}`;
      new this.api.Notice(`${summary}\nAnkiWeb 동기화를 요청합니다.`);
      try {
        await this.invoke("sync", {}, 120000);
        report.ankiWeb.started = true;
        new this.api.Notice(`${summary}\nAnkiWeb 동기화 요청 완료`);
      } catch (error) {
        report.ankiWeb.error = error.message;
        new this.api.Notice(`${summary}\nAnkiWeb 동기화 시작을 확인하지 못했습니다: ${error.message}\nAnki에서 동기화 상태와 로그인을 확인하세요.`, 12000);
      }
    } catch (error) {
      report.error = error.message;
      console.error("Spaced Repetition / Anki", error);
      new this.api.Notice(`Anki 동기화 중단: ${error.message}\nAnki를 연 뒤 다시 실행하세요. 완료된 카드는 재실행해도 중복되지 않습니다.`, 12000);
    } finally {
      report.finished = new Date().toISOString();
      try { await this.plugin.app.vault.adapter.write(this.reportPath, JSON.stringify(report, null, 2)); }
      finally { this.busy = false; }
    }
    return report;
  }
};
