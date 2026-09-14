from pathlib import Path
import argparse
import hashlib
import json

HERE = Path(__file__).parent
parser = argparse.ArgumentParser(description="Patch Spaced Repetition 1.15.4 with the local parser and Anki bridge.")
parser.add_argument("--base", required=True, type=Path, help="Path to the upstream 1.15.4 main.js")
parser.add_argument("--output", required=True, type=Path, help="Output plugin directory")
args = parser.parse_args()
plugin = args.output.expanduser().resolve()
plugin.mkdir(parents=True, exist_ok=True)
source = args.base.expanduser().resolve().read_text()
patch_count = 0

def replace_once(before, after):
    global source, patch_count
    assert source.count(before) == 1, f'Expected exactly one patch target: {before[:100]}'
    source = source.replace(before, after, 1)
    patch_count += 1

replace_once(
    '    return new _QuestionText(original, topicPathWithWs, actualQuestion, textDirection, blockId);',
    '''    const result = new _QuestionText(original, topicPathWithWs, actualQuestion, textDirection, blockId);
    result.ankiId = original.match(/<!--ANKI:([a-f0-9]{32})-->/)?.[1] || null;
    return result;''')
replace_once(
    '    const originalWithoutSR = DataStore.getInstance().removeScheduleInfo(original);',
    r'''    const originalWithoutSR = DataStore.getInstance().removeScheduleInfo(original.replace(/\r?\n?[ \t]*<!--ANKI:[a-f0-9]{32}-->/g, ""));''')
replace_once(
    '    return result;\n  }\n  updateQuestionWithinNoteText(noteText, settings) {',
    r'''    const metadataIndent = localCardMetadataIndent(this.questionText.actualQuestion);
    if (hasSchedule && metadataIndent) result = result.replace(/\n(?=<!--SR:[^\n]*-->$)/, "\n" + metadataIndent);
    if (this.questionText.ankiId) result += `\n${metadataIndent}<!--ANKI:${this.questionText.ankiId}-->`;
    return result;
  }
  updateQuestionWithinNoteText(noteText, settings) {''')
replace_once(
    '        this.isInitialized = true;\n        this._reminderManager.restartReviewReminders();',
    '        this.isInitialized = true;\n        this.localAnkiBridge = new LocalAnkiBridge(this);\n        this.localAnkiBridge.install();\n        this._reminderManager.restartReviewReminders();')
replace_once(
    '    this.containerEl.addClass("sr-main-page");',
    '    this.containerEl.addClass("sr-main-page");\n    this.plugin.localAnkiBridge?.addSettings(this.containerEl);')
replace_once(
    '      await this.checkAndUpdatePluginVersion();',
    '      void this.checkAndUpdatePluginVersion();')
# Keep card-boundary decisions in one source instead of patching parser branches.
start = source.index('function parse(text, options) {')
end = source.index('\n// src/ui/', start)
replace_once(source[start:end], '''function parse(text, options) {
  const cards = localParseCardBlocks(text, options);
  if (debugParser) console.log("Parsed cards:", cards);
  return cards;
}
''')
# Both forward and reversed multiline cards share the same nested-list rules.
start = source.index('var QuestionTypeMultiLineBasic = class {')
end = source.index('var QuestionTypeCloze = class {', start)
replace_once(source[start:end], '''var QuestionTypeMultiLineBasic = class {
  expand(questionText, settings) {
    return localExpandMultilineCards(questionText, settings, false);
  }
};
var QuestionTypeMultiLineReversed = class {
  expand(questionText, settings) {
    return localExpandMultilineCards(questionText, settings, true);
  }
};
''')
# Mixed questions contain both cloze siblings and a full-answer sibling.
replace_once(
    '''    const questionContext = this.noteFile.getQuestionContext(
      parsedQuestionInfo.firstLineNum
    );''',
    '''    const questionContext = this.noteFile.getQuestionContext(
      parsedQuestionInfo.firstLineNum,
      this.contentText,
      this.settings
    );''')
start = source.index('  getQuestionContext(cardLine) {')
end = source.index('\n  }\n};', start) + len('\n  }')
replace_once(source[start:end], '''  getQuestionContext(cardLine, noteText, settings) {
    const fileCachedData = this.metadataCache.getFileCache(this.file) || {};
    return localQuestionHeadingContext(noteText, cardLine, fileCachedData.headings || [], settings);
  }''')
replace_once(
    '''  static expand(questionType, questionText, settings) {
    const handler = QuestionTypeFactory.create(questionType);
    return handler.expand(questionText, settings);''',
    '''  static expand(questionType, questionText, settings, parentText = "") {
    const handler = QuestionTypeFactory.create(questionType);
    return localPresentCardPairs(questionType, handler.expand(questionText, settings), parentText);''')
replace_once(
    '      const question = this.createQuestionObject(parsedQuestionInfo, textDirection);',
    '''      const question = this.createQuestionObject(parsedQuestionInfo, textDirection);
      question.localParentText = localCardParentText(this.contentText, parsedQuestionInfo.firstLineNum, this.settings);''')
replace_once(
    '''        question.questionText.actualQuestion,
        this.settings
      );''',
    '''        question.questionText.actualQuestion,
        this.settings,
        question.localParentText
      );''')
replace_once(
    '''      text,
      this.settings
    );
    q2.actualQuestion''',
    '''      text,
      this.settings,
      question.localParentText || ""
    );
    q2.actualQuestion''')
replace_once(
    '      const { front, back } = cardFrontBackList[i2];\n      const hasScheduleInfo',
    '      const { front, back, isCloze } = cardFrontBackList[i2];\n      const hasScheduleInfo')
replace_once(
    '        back,\n        cardIdx: i2',
    '        back,\n        isCloze,\n        cardIdx: i2')
replace_once(
    '    if (sessionData.currentQuestion.questionType === 4 /* Cloze */) {',
    '    if (sessionData.currentQuestion.questionType === 4 /* Cloze */ || sessionData.cardData.currentCard.isCloze) {')
replace_once(
    '    if (sessionData.currentQuestion.questionType !== 4 /* Cloze */) {',
    '    if (sessionData.currentQuestion.questionType > 1 && sessionData.currentQuestion.questionType !== 4 /* Cloze */ && !sessionData.cardData.currentCard.isCloze) {')
source += '\n\n' + (HERE / 'card-syntax.js').read_text()
source += '\n\n' + (HERE / 'card-parser.js').read_text()
source += '\n\n' + (HERE / 'anki-bridge.js').read_text()
(plugin / 'main.js').write_text(source)
(plugin / 'anki-bridge.js').write_text((HERE / 'anki-bridge.js').read_text())
(plugin / 'build-info.json').write_text(json.dumps({
    'base': 'Spaced Repetition 1.15.4',
    'patches': patch_count,
    'base_sha256': hashlib.sha256(args.base.expanduser().resolve().read_bytes()).hexdigest(),
    'modified_sha256': hashlib.sha256(source.encode()).hexdigest(),
}, indent=2))
print(f'Built local Anki integration: {plugin / "main.js"}')
