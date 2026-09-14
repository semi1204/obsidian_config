// Line-based boundaries shared by Obsidian review and the Anki bridge.
// Regexes recognize syntax; card state decides whether that syntax is content.
function localHasCardContent(text) {
  return text.replace(/<!--[\s\S]*?-->/g, "").trim().length > 0;
}

function localParseCardBlocks(text, options) {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const protectedLines = localProtectedCardLines(lines);
  const clozecrafter = new import_clozecraft2.ClozeCrafter(options.clozePatterns);
  const inline = [
    { separator: options.singleLineCardSeparator, type: 0 },
    { separator: options.singleLineReversedCardSeparator, type: 1 }
  ].sort((a, b) => b.separator.length - a.separator.length);
  const multilineType = line => line === options.multilineCardSeparator ? 2
    : line === options.multilineReversedCardSeparator ? 3 : null;
  const heading = line => /^ {0,3}(#{1,6})(?:[ \t]+|$)/.exec(line)?.[1].length || 0;
  const isMultiline = () => type === 2 || type === 3;
  const cards = [];
  let start = -1, type = null, level = 0, hasAnswer = false, ids = [], listIndent = null;

  const reset = () => { start = -1; type = null; level = 0; hasAnswer = false; ids = []; listIndent = null; };
  const finish = end => {
    while (start >= 0 && end >= start && !lines[end].trim()) end--;
    if (type !== null && start >= 0 && end >= start) {
      const raw = lines.slice(start, end + 1)
        .map((line, offset) => protectedLines.has(start + offset) ? line : line.trimEnd()).join("\n").trimEnd();
      const pairs = isMultiline()
        ? localExpandMultilineCards(raw.replace(/<!--[\s\S]*?-->/g, ""), options, type === 3) : null;
      const primary = pairs?.find(pair => !pair.isCloze);
      if (!pairs || (localHasCardContent(primary.front) && localHasCardContent(primary.back))) {
        if (new Set(ids).size > 1) throw new Error(`${start + 1}행: 한 카드에 서로 다른 Anki ID가 있습니다. 식별자 위치를 확인하세요.`);
        cards.push(new ParsedQuestionInfo(type, raw, start, end));
      }
    }
    reset();
  };
  const nextNonblank = from => {
    while (from < lines.length && !lines[from].trim()) from++;
    return from;
  };
  const startsQuestion = from => {
    from = nextNonblank(from);
    for (let i = from; i < lines.length && lines[i].trim(); i++) {
      if (protectedLines.has(i) || heading(lines[i]) || lines[i].trimStart().startsWith("<!--")) return false;
      if (!/^[ \t]/.test(lines[i]) && multilineType(lines[i].trim()) !== null) return true;
      if (!/^[ \t|]/.test(lines[i]) && inline.some(({separator}) => hasInlineMarker(lines[i], separator))) return true;
    }
    return false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], trimmed = line.trim();
    if (protectedLines.has(i)) {
      if (start < 0) start = i;
      if (isMultiline() && localHasCardContent(line)) hasAnswer = true;
      continue;
    }
    // Ignore comment syntax without skipping the line after its closing marker.
    if (trimmed.startsWith("<!--") && !trimmed.startsWith("<!--SR:") && !trimmed.startsWith("<!--ANKI:")) {
      while (i + 1 < lines.length && !lines[i].includes("-->")) i++;
      continue;
    }
    const id = /^<!--ANKI:([a-f0-9]{32})-->$/.exec(trimmed);
    if (id) {
      if (type !== null) {
        ids.push(id[1]);
        // An ID before an answer cannot turn a draft into an empty card.
        if (!isMultiline() || hasAnswer) finish(i);
      }
      continue;
    }
    if (options.multilineCardEndMarker && trimmed === options.multilineCardEndMarker) {
      finish(i - 1);
      continue;
    }
    if (listIndent !== null && trimmed && localCardIndent(line) <= listIndent) finish(i - 1);
    const nextLevel = heading(line);
    if (nextLevel && (type === null || !level || nextLevel <= level)) {
      if (type !== null) finish(i - 1);
      // Ancestor headings describe context, not the front of this question.
      start = i;
      level = nextLevel;
    }
    if (!trimmed) {
      const next = nextNonblank(i + 1);
      if (type !== null && /^<!--ANKI:[a-f0-9]{32}-->$/.test(lines[next]?.trim() || "")) continue;
      if (isMultiline()) {
        if (listIndent !== null || options.multilineCardEndMarker || !hasAnswer || (level && !startsQuestion(i + 1))) continue;
      } else if (type === null && level) {
        if (next < lines.length && multilineType(lines[next].trim()) !== null) continue;
      } else if (type !== null && options.multilineCardEndMarker) continue;
      finish(i - 1);
      continue;
    }
    const listMarker = localListCardMarker(line, options);
    if (listMarker && !isMultiline()) {
      if (type !== null) finish(i - 1);
      start = i;
      type = listMarker.reversed ? 3 : 2;
      level = 0;
      listIndent = localCardIndent(line);
      hasAnswer = false;
      continue;
    }
    if (start < 0) start = i;
    const separatorType = multilineType(trimmed);
    if (separatorType !== null) {
      if (!isMultiline()) { type = separatorType; hasAnswer = false; }
      continue;
    }
    // A cloze block ends at the next inline question. Multiline answers and
    // table cells retain their literal inline separators.
    if (type === 4 && !/^\s*\|/.test(line) && !clozecrafter.isClozeNote(line)
      && inline.some(({ separator }) => hasInlineMarker(
        line.replace(/\\\(.*?\\\)|\$\$.*?\$\$|\$(?:\\.|[^$\\])+\$/g, ""), separator))) finish(i - 1);
    // Inline syntax inside a multiline answer/table is literal content.
    if (type === null) {
      const match = inline.find(({separator}) => hasInlineMarker(line, separator));
      if (match) {
        start = i;
        type = match.type;
        if (i + 1 < lines.length && lines[i + 1].trimStart().startsWith("<!--SR:")) i++;
        else if (i + 1 < lines.length && lines[i + 1].startsWith(SR_METADATA_CALLOUT)) {
          while (i + 1 < lines.length) { if (lines[++i].includes("<!--SR:")) break; }
        }
        const next = nextNonblank(i + 1);
        const followingId = /^<!--ANKI:([a-f0-9]{32})-->$/.exec(lines[next]?.trim() || "");
        if (followingId) { ids.push(followingId[1]); i = next; }
        finish(i);
        continue;
      }
      if (clozecrafter.isClozeNote(line)) type = 4;
    }
    if (isMultiline() && localHasCardContent(line)) hasAnswer = true;
  }
  finish(lines.length - 1);
  return cards;
}
