#include <QtTest>
#include <QSyntaxHighlighter>
#include <QTextDocument>
#include <QRegularExpression>
#include "code_highlight.h"
#include "theme.h"

// Expectations sampled from this project's installed legacy highlight.js
// TypeScript grammar and its actual hljs CSS, not generic token conventions.
class HighlightParity : public QObject {
  Q_OBJECT
  static QTextCharFormat token(const QString& text, const QString& word, const QString& language = "ts") {
    const int start = text.indexOf(QRegularExpression(QStringLiteral("\\b%1\\b").arg(QRegularExpression::escape(word))));
    for (const auto& range : codehighlight::ranges(text, language))
      if (range.start == start && range.length == word.size()) return range.format;
    return {};
  }
 private slots:
  void fullFunctionFixtureTypesAndCalls() {
    const QString code = "type SearchResult = {\n  count: number;\n  activeIndex: number;\n};\n\n"
                         "const message = 'fixture text';\nconsole.log(message);";
    for (const QString word : {"type", "SearchResult", "const", "log"}) {
      const auto format = token(code, word);
      QCOMPARE(format.fontWeight(), int(QFont::DemiBold)); QCOMPARE(format.foreground().color(), theme::text());
    }
    for (const QString word : {"count", "activeIndex", "number", "console"}) {
      const auto format = token(code, word);
      QCOMPARE(format.fontWeight(), int(QFont::Normal)); QCOMPARE(format.foreground().color(), theme::muted());
    }
    QCOMPARE(token(code, "message").properties().size(), 0); // ordinary binding, not a function
  }
  void primitiveTypesAreMutedOnlyInTypescript_data() {
    QTest::addColumn<QString>("word");
    for (const QString word : {"any", "boolean", "never", "number", "string", "symbol", "unknown", "object", "bigint"})
      QTest::newRow(qPrintable(word)) << word;
  }
  void primitiveTypesAreMutedOnlyInTypescript() {
    QFETCH(QString, word);
    const auto format = token(word, word);
    QCOMPARE(format.fontWeight(), int(QFont::Normal)); QCOMPARE(format.foreground().color(), theme::muted());
    QVERIFY(codehighlight::ranges(word, "js").isEmpty());
  }
  void callsClassTitlesAndBuiltins() {
    const QString code = "function f(x: number) { return Math.max(x, 1); } foo(); obj.method(); setTimeout(f);";
    for (const QString word : {"f", "Math", "max", "foo", "method"})
      QCOMPARE(token(code, word).fontWeight(), int(QFont::DemiBold));
    QCOMPARE(token(code, "setTimeout").fontWeight(), int(QFont::Normal));
    QCOMPARE(token(code, "setTimeout").foreground().color(), theme::muted());
    QCOMPARE(token("void", "void", "ts").fontWeight(), int(QFont::Normal));
    QCOMPARE(token("void", "void", "js").fontWeight(), int(QFont::DemiBold));
  }
  void stringsCommentsAndUnknownLanguageRemainSafe() {
    const QString text = "// type Alias = number; call()\nconst value = 'type Fake = number; call()';";
    const auto ranges = codehighlight::ranges(text, "ts");
    QVERIFY(!ranges.isEmpty()); QVERIFY(ranges.first().format.fontItalic());
    for (const auto& range : ranges) {
      QVERIFY(range.start >= 0 && range.length > 0 && range.start + range.length <= text.size());
      if (text.mid(range.start, range.length).contains("call()"))
        QCOMPARE(range.format.fontWeight(), int(QFont::Normal));
    }
    QVERIFY(codehighlight::ranges(text, "rust").isEmpty());
    QVERIFY(codehighlight::ranges(text, "text").isEmpty());
  }
  void displayFormattingDoesNotEditDocument() {
    class DisplayHighlighter : public QSyntaxHighlighter {
     public: using QSyntaxHighlighter::QSyntaxHighlighter;
      void highlightBlock(const QString& text) override {
        for (const auto& range : codehighlight::ranges(text, "ts")) setFormat(range.start, range.length, range.format);
      }
    };
    const QString original = "type SearchResult = { count: number; };\nconsole.log('unchanged');";
    QTextDocument document(original);
    document.clearUndoRedoStacks(); // Exclude the constructor's initial text insertion.
    document.setModified(false);
    QVERIFY(!document.isUndoAvailable());
    DisplayHighlighter highlighter(&document); highlighter.rehighlight();
    QCOMPARE(document.toPlainText(), original); QVERIFY(!document.isModified()); QVERIFY(!document.isUndoAvailable());
  }
};
QTEST_MAIN(HighlightParity)
#include "highlight_parity.moc"
