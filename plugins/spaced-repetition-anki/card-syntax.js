// Shared by the native SR parser and its Anki card expansion.
function localCardIndent(line) {
  let width = 0;
  for (const char of line.match(/^[ \t]*/)[0]) width += char === "\t" ? 4 - width % 4 : 1;
  return width;
}

function localCardMetadataIndent(text) {
  const last = text.split(/\r?\n/).filter(line => line.trim()).at(-1) || "";
  const item = /^([ \t]*(?:[-+*]|\d+[.)])[ \t]+)/.exec(last);
  return item ? item[1].replace(/\S/g, " ") : last.match(/^[ \t]*/)[0];
}

function localAnkiCloserRepairs(text) {
  const lines = text.split("\n"), protectedLines = localProtectedCardLines(lines);
  const changes = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = /^([ \t]*<!--ANKI:[a-f0-9]{32})-→[ \t]*$/.exec(lines[i]);
    if (match && !protectedLines.has(i)) {
      changes.push({ from: offset + match[1].length, to: offset + match[1].length + 2, insert: "-->" });
    }
    offset += lines[i].length + 1;
  }
  return changes;
}

function localProtectAnkiClosers(transaction) {
  if (!transaction.docChanged) return transaction;
  const changes = localAnkiCloserRepairs(transaction.newDoc.toString());
  return changes.length ? [transaction, { changes, sequential: true }] : transaction;
}

function localValidateAnkiMarkers(text) {
  const lines = text.split(/\r?\n/), protectedLines = localProtectedCardLines(lines);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!protectedLines.has(i) && line.startsWith("<!--ANKI:") && !/^<!--ANKI:[a-f0-9]{32}-->$/.test(line)) {
      throw new Error(`${i + 1}행: Anki 식별자가 손상됐습니다. 식별자를 복구한 뒤 동기화하세요.`);
    }
  }
}

function localProtectedCardLines(lines) {
  const protectedLines = new Set();
  let fence = null, mathEnd = null;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trimStart();
    // Fences and display math can begin on a list item's first line.
    if (!fence && !mathEnd) line = line.replace(/^(?:[-+*]|\d+[.)])[ \t]+/, "");
    if (fence) {
      protectedLines.add(i);
      const close = /^(`+|~+)\s*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
    } else if (mathEnd) {
      protectedLines.add(i);
      if (line.includes(mathEnd)) mathEnd = null;
    } else {
      const open = /^(`{3,}|~{3,})(.*)$/.exec(line);
      if (open && (open[1][0] === "~" || !open[2].includes("`"))) {
        protectedLines.add(i);
        fence = open[1];
      } else if (line.startsWith("$$") || line.startsWith("\\[")) {
        protectedLines.add(i);
        const end = line.startsWith("$$") ? "$$" : "\\]";
        if (!line.slice(2).includes(end)) mathEnd = end;
      }
    }
  }
  return protectedLines;
}

function localListCardMarker(line, settings) {
  const item = /^([ \t]*(?:[-+*]|\d+[.)])[ \t]+)(.+?)\s*$/.exec(line);
  if (!item) return null;
  for (const [marker, reversed] of [[settings.multilineReversedCardSeparator, true], [settings.multilineCardSeparator, false]]) {
    if (!marker || !item[2].endsWith(marker)) continue;
    const front = item[2].slice(0, -marker.length);
    if (/\S[ \t]+$/.test(front)) return { front: front.trimEnd(), marker, reversed, prefix: item[1] };
  }
  return null;
}

function localExpandMultilineCards(text, settings, reversed) {
  let lines = text.split("\n");
  const root = localListCardMarker(lines[0], settings);
  if (root) {
    // A nested list item becomes a standalone face without code-block indentation.
    const body = lines.slice(1).map(line => " ".repeat(localCardIndent(line)) + line.trimStart());
    const indent = Math.min(...body.filter(line => line.trim()).map(localCardIndent));
    lines = [root.front, root.marker, ...body.map(line => line.slice(indent))];
  }
  const originalProtected = localProtectedCardLines(lines);
  lines = lines.flatMap((line, i) => {
    const item = !originalProtected.has(i) && localListCardMarker(line, settings);
    return item ? [item.prefix + item.front, item.prefix.replace(/\S/g, " ") + item.marker] : [line];
  });
  const protectedLines = localProtectedCardLines(lines);
  const separator = reversed ? settings.multilineReversedCardSeparator : settings.multilineCardSeparator;
  const first = lines.findIndex((line, i) => !protectedLines.has(i) && line.trim() === separator);
  const nodes = [{ marker: first, end: lines.length, front: lines.slice(0, first).join("\n"), reversed }];
  for (let i = first + 1; i < lines.length; i++) {
    if (protectedLines.has(i)) continue;
    const marker = lines[i].trim();
    if (marker !== settings.multilineCardSeparator && marker !== settings.multilineReversedCardSeparator) continue;
    // Blank lines between a list prompt and its separator do not change scope.
    let prompt = i - 1;
    while (prompt > first && !lines[prompt].trim()) prompt--;
    const item = /^([ \t]*(?:[-+*]|\d+[.)])[ \t]+)(.+)$/.exec(lines[prompt]);
    if (!item || protectedLines.has(prompt)) continue;
    const contentIndent = localCardIndent(item[1].replace(/\S/g, " "));
    if (localCardIndent(lines[i]) < contentIndent) continue;
    const itemIndent = localCardIndent(lines[prompt]);
    let end = i + 1;
    while (end < lines.length && (!lines[end].trim() || protectedLines.has(end) || localCardIndent(lines[end]) > itemIndent)) end++;
    nodes.push({ marker: i, end, front: item[2], reversed: marker === settings.multilineReversedCardSeparator });
  }
  const pairs = nodes.flatMap(node => {
    const children = nodes.filter(child => child.marker > node.marker && child.end <= node.end);
    const back = lines.slice(node.marker + 1, node.end).filter((_, offset) => {
      const index = node.marker + 1 + offset;
      // Keep the complete subtree in the answer; omit only its card separators.
      return !children.some(child => index === child.marker);
    }).join("\n").trimEnd();
    const pair = new CardFrontBack(node.front, back);
    return node.reversed ? [pair, new CardFrontBack(back, node.front)] : [pair];
  });
  const answer = localAnswerClozes(pairs[0].back, settings);
  if (!answer.cards.length) return pairs;
  if (root) {
    const sourceBody = text.split("\n").slice(1).filter(line => line.trim());
    const indent = Math.min(...sourceBody.map(localCardIndent));
    for (const pair of answer.cards) for (const side of ["front", "back"]) {
      pair[side] = root.prefix + root.front + "\n" + pair[side].split("\n").map(line => " ".repeat(indent) + line).join("\n");
    }
  }
  for (const pair of pairs) {
    pair.front = localAnswerClozes(pair.front, settings).revealed;
    pair.back = localAnswerClozes(pair.back, settings).revealed;
  }
  // Keep the existing cloze siblings at their original indices. The full-answer
  // card follows them when a separator is added to an existing cloze table.
  return [...answer.cards, ...pairs];
}

function localAnswerClozes(text, settings) {
  const lines = text.split("\n"), protectedLines = localProtectedCardLines(lines);
  const tokens = [];
  const hide = value => { const key = `OSRCLOZELITERAL${tokens.length}TOKEN`; tokens.push(value); return key; };
  const restore = value => value.replace(/OSRCLOZELITERAL(\d+)TOKEN/g, (_, index) => tokens[Number(index)]);
  const masked = lines.map((line, i) => protectedLines.has(i) ? hide(line)
    : line.replace(/(`+).*?\1|\\\(.*?\\\)|\$\$.*?\$\$|\$(?:\\.|[^$\\])+\$/g, hide)).join("\n");
  const note = new import_clozecraft.ClozeCrafter(settings.clozePatterns).createClozeNote(masked);
  if (!note || !note.numCards) return {cards: [], revealed: text};
  const plain = {asking: answer => answer, showingAnswer: answer => answer, hiding: answer => answer};
  const cards = new QuestionTypeCloze().expand(masked, settings).map(pair => {
    pair.front = restore(pair.front);
    pair.back = restore(pair.back);
    pair.isCloze = true;
    return pair;
  });
  return {cards, revealed: restore(note.getCardBack(0, plain))};
}

function localNormalizeListDividers(text) {
  const contentIndents = [];
  return text.split("\n").map(line => {
    if (!line.trim()) return line;
    const indent = localCardIndent(line);
    const item = /^([ \t]*(?:[-+*]|\d+[.)])[ \t]+)\S/.exec(line);
    while (contentIndents.length && contentIndents.at(-1) > indent) contentIndents.pop();
    if (item) contentIndents.push(localCardIndent(item[1].replace(/\S/g, " ")));
    // Inside a list, --- is a divider, never an accidental setext heading.
    if (contentIndents.length && /^\s*-{3,}\s*$/.test(line)) return line.match(/^[ \t]*/)[0] + "<hr>";
    return line;
  }).join("\n");
}

// Obsidian's heading cache omits headings written inside list items.
function localQuestionHeadingContext(text = "", cardLine, cachedHeadings, settings = {}) {
  const headings = new Map(cachedHeadings.map(h => [h.position.start.line, { level: h.level, heading: h.heading }]));
  const lines = text.split(/\r?\n/), protectedLines = localProtectedCardLines(lines);
  let comment = false;
  for (let i = 0; i <= cardLine && i < lines.length; i++) {
    if (protectedLines.has(i)) continue;
    if (comment || lines[i].trimStart().startsWith("<!--")) {
      comment = !lines[i].includes("-->");
      continue;
    }
    const marker = localListCardMarker(lines[i], settings);
    const line = marker ? marker.prefix + marker.front : lines[i];
    const match = /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+(#{1,6})(?:[ \t]+(.*)|$)/.exec(line);
    if (match) headings.set(i, { level: match[1].length, heading: (match[2] || "").replace(/[ \t]+#+[ \t]*$/, "") });
  }
  const stack = [];
  for (const [line, heading] of [...headings].sort((a, b) => a[0] - b[0])) {
    if (line > cardLine) break;
    while (stack.length && stack.at(-1).level >= heading.level) stack.pop();
    stack.push(heading);
  }
  return stack.map(({ heading }) => heading.replace(/\[\^\d+\]/g, "")
    .replace(/\[([^\]\n]+)\]\([^\n)]*\)/g, "$1").trim());
}

// A list's ancestors can live before another card's ID, outside this card block.
function localCardParentIndices(lines) {
  const protectedLines = localProtectedCardLines(lines), stack = [];
  return lines.map((line, index) => {
    if (!line.trim() || protectedLines.has(index) || /^\s*<!--(?:ANKI|SR):/.test(line)) return [...stack];
    const indent = localCardIndent(line);
    while (stack.length && localCardIndent(lines[stack.at(-1)]) >= indent) stack.pop();
    const parents = [...stack];
    if (/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+\S/.test(line)) stack.push(index);
    return parents;
  });
}

function localCardParentText(text, firstLine, settings) {
  const lines = text.split(/\r?\n/);
  return (localCardParentIndices(lines)[firstLine] || []).map(index => {
    const marker = localListCardMarker(lines[index], settings);
    return localAnswerClozes(marker ? marker.prefix + marker.front : lines[index], settings).revealed;
  }).join("\n");
}

function localFocusCloze(pair, parentText) {
  const prefix = parentText ? parentText + "\n" : "";
  const front = (prefix + pair.front).split("\n"), back = (prefix + pair.back).split("\n");
  // ClozeCrafter substitutes within lines. Keep its output if a custom formatter
  // changes the line structure rather than risking the wrong card contents.
  if (front.length !== back.length) return;
  const targets = front.map((line, i) => line !== back[i] ? i : -1).filter(i => i >= 0);
  if (!targets.length) return;
  const ancestors = localCardParentIndices(back), keep = new Set();
  const isRow = line => /^\s*\|.*\|\s*$/.test(line || "");
  const isDivider = line => /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(line || "");
  for (const index of targets) {
    keep.add(index);
    for (const parent of ancestors[index]) keep.add(parent);
    if (isRow(back[index])) {
      let start = index;
      while (start && isRow(back[start - 1])) start--;
      if (isDivider(back[start + 1])) { keep.add(start); keep.add(start + 1); }
    }
  }
  const indices = [...keep].sort((a, b) => a - b);
  const indent = Math.min(...indices.map(i => localCardIndent(back[i])));
  const select = lines => indices.map((i, position) => {
    // A table beneath a retained list parent needs its own Markdown block.
    const tableBreak = position > 0 && isRow(back[i]) && isDivider(back[i + 1]) && !isRow(back[indices[position - 1]]);
    return (tableBreak ? "\n" : "") + (" ".repeat(localCardIndent(lines[i])) + lines[i].trimStart()).slice(indent);
  }).join("\n");
  pair.front = select(front);
  pair.back = select(back);
}

function localPresentCardPairs(type, pairs, parentText) {
  for (const pair of pairs) {
    if (type === 4 || pair.isCloze) localFocusCloze(pair, parentText);
    else if (type === 0 || type === 1) {
      if (!localHasCardContent(pair.front) || !localHasCardContent(pair.back)) continue;
      // Display-math shorthand on an inline card should remain in the sentence.
      const inlineMath = text => text.replace(/(`+).*?\1|\$\$(.*?)\$\$|\\\[(.*?)\\\]/g,
        (match, code, dollars, brackets) => code ? match : "$" + (dollars ?? brackets).trim() + "$");
      const answer = pair.back.trim().replace(/^(?:[-+*]|\d+[.)])[ \t]+/, "");
      pair.back = inlineMath(pair.front.trim()) + " → " + inlineMath(answer);
    }
  }
  return pairs;
}
