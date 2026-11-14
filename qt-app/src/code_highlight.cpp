#include "code_highlight.h"

#include <QSet>
#include <QStringList>

#include "theme.h"

namespace codehighlight {
namespace {

QString normalizedLanguage(const QString& value) {
  QString tag = value.trimmed().toLower();
  if (tag.startsWith(QStringLiteral("language-"))) tag.remove(0, 9);
  if (QStringList{"sh", "zsh"}.contains(tag)) return QStringLiteral("bash");
  if (QStringList{"md", "mkd", "mkdown"}.contains(tag)) return QStringLiteral("markdown");
  if (QStringList{"html", "xhtml", "rss", "atom", "xjb", "xsd", "xsl", "plist", "wsf", "svg"}
          .contains(tag)) {
    return QStringLiteral("xml");
  }
  return tag;
}

bool isJavaScript(const QString& language) {
  return language == QStringLiteral("javascript") || language == QStringLiteral("js") ||
         language == QStringLiteral("typescript") || language == QStringLiteral("ts") ||
         language == QStringLiteral("mjs") || language == QStringLiteral("cjs") ||
         language == QStringLiteral("mts") || language == QStringLiteral("cts") ||
         language == QStringLiteral("jsx") || language == QStringLiteral("tsx");
}

bool lineBreak(QChar ch) {
  return ch == QLatin1Char('\n') || ch == QLatin1Char('\r') || ch == QChar::LineSeparator ||
         ch == QChar::ParagraphSeparator;
}

bool wordStart(QChar ch) {
  return ch.isLetter() || ch == QLatin1Char('_') || ch == QLatin1Char('$');
}

bool wordPart(QChar ch) { return wordStart(ch) || ch.isDigit(); }

QTextCharFormat tokenFormat(bool strong = false, bool comment = false) {
  QTextCharFormat format;
  format.setForeground(strong ? theme::text() : theme::muted());
  if (strong) format.setFontWeight(QFont::DemiBold);
  if (comment) format.setFontItalic(true);
  return format;
}

struct LexerFormats {
  QTextCharFormat muted = tokenFormat();
  QTextCharFormat strong = tokenFormat(true);
  QTextCharFormat comment = tokenFormat(false, true);
  QTextCharFormat emphasis = [] {
    QTextCharFormat fmt;
    fmt.setFontItalic(true);
    return fmt;
  }();
};

void appendRange(QList<QTextLayout::FormatRange>& result, qsizetype begin, qsizetype end,
                 const QTextCharFormat& format) {
  if (end > begin) result.append({int(begin), int(end - begin), format});
}

bool startsAt(const QString& text, qsizetype at, const char* literal) {
  return QStringView(text).mid(at).startsWith(QLatin1StringView(literal));
}

qsizetype scanThrough(const QString& text, qsizetype at, const char* terminator) {
  const QString token = QString::fromLatin1(terminator);
  const qsizetype end = text.indexOf(token, at);
  return end < 0 ? text.size() : end + token.size();
}

qsizetype scanEndOfLine(const QString& text, qsizetype at) {
  const qsizetype size = text.size();
  while (at < size && !lineBreak(text.at(at))) ++at;
  return at;
}

qsizetype scanQuotedToken(const QString& text, qsizetype begin, bool allowEscape) {
  const qsizetype size = text.size();
  const QChar quote = text.at(begin);
  qsizetype i = begin + 1;
  while (i < size) {
    if (allowEscape && text.at(i) == QLatin1Char('\\')) {
      i = qMin(size, i + 2);
      continue;
    }
    if (text.at(i++) == quote) break;
  }
  return i;
}

qsizetype scanNumberWithUnit(const QString& text, qsizetype begin) {
  const qsizetype size = text.size();
  qsizetype i = begin + 1;
  while (i < size && (text.at(i).isLetterOrNumber() || QStringLiteral(".%").contains(text.at(i)))) {
    ++i;
  }
  return i;
}

bool tryScanMarkdownLineStart(const QString& text, qsizetype& i, bool& atLineStart,
                              const LexerFormats& fmt, QList<QTextLayout::FormatRange>& result) {
  const qsizetype size = text.size();
  const qsizetype begin = i;
  const QChar ch = text.at(i);
  const qsizetype lineEnd = scanEndOfLine(text, i);

  if (ch == QLatin1Char('#')) {
    qsizetype end = i;
    while (end < lineEnd && text.at(end) == QLatin1Char('#')) ++end;
    if (end - i <= 6 && (end == lineEnd || text.at(end).isSpace())) {
      i = lineEnd;
      appendRange(result, begin, i, fmt.strong);
      return true;
    }
  }
  if (startsAt(text, i, "```") || startsAt(text, i, "~~~")) {
    const QString fence = text.mid(i, 3);
    i = lineEnd;
    while (i < size) {
      ++i;
      const qsizetype nextEnd = scanEndOfLine(text, i);
      if (text.mid(i, nextEnd - i).trimmed().startsWith(fence)) {
        i = nextEnd;
        break;
      }
      i = nextEnd;
    }
    appendRange(result, begin, i, fmt.muted);
    return true;
  }
  if (ch == QLatin1Char('>')) {
    i = lineEnd;
    appendRange(result, begin, i, fmt.comment);
    return true;
  }
  if (QStringLiteral("-*+").contains(ch) && i + 1 < size && text.at(i + 1).isSpace()) {
    ++i;
    appendRange(result, begin, i, fmt.muted);
    atLineStart = false;
    return true;
  }
  if (ch.isDigit()) {
    qsizetype end = i + 1;
    while (end < size && text.at(end).isDigit()) ++end;
    if (end + 1 < size && QStringLiteral(".)").contains(text.at(end)) &&
        text.at(end + 1).isSpace()) {
      i = end + 1;
      appendRange(result, begin, i, fmt.muted);
      atLineStart = false;
      return true;
    }
  }
  const QString line = text.mid(i, lineEnd - i).trimmed();
  if (!line.isEmpty() &&
      (line == QString(line.size(), QLatin1Char('=')) ||
       line == QString(line.size(), QLatin1Char('-')))) {
    i = lineEnd;
    appendRange(result, begin, i, fmt.strong);
    return true;
  }
  return false;
}

QList<QTextLayout::FormatRange> markdownRanges(const QString& text) {
  QList<QTextLayout::FormatRange> result;
  const LexerFormats fmt;
  const qsizetype size = text.size();
  qsizetype i = 0;
  bool atLineStart = true;

  while (i < size) {
    const qsizetype begin = i;
    const QChar ch = text.at(i);
    if (lineBreak(ch)) {
      ++i;
      atLineStart = true;
      continue;
    }
    if (ch.isSpace()) {
      ++i;
      continue;
    }
    if (startsAt(text, i, "<!--")) {
      i = scanThrough(text, i + 4, "-->");
      appendRange(result, begin, i, fmt.comment);
      atLineStart = false;
      continue;
    }
    if (atLineStart && tryScanMarkdownLineStart(text, i, atLineStart, fmt, result)) {
      continue;
    }
    atLineStart = false;

    if (ch == QLatin1Char('\\')) {
      i = qMin(size, i + 2);
      continue;
    }
    if (ch == QLatin1Char('`')) {
      qsizetype end = i;
      while (end < size && text.at(end) == ch) ++end;
      const QString fence = text.mid(i, end - i);
      const qsizetype close = text.indexOf(fence, end);
      i = close < 0 ? end : close + fence.size();
      appendRange(result, begin, i, fmt.muted);
      continue;
    }
    if (ch == QLatin1Char('*') || ch == QLatin1Char('_')) {
      const bool bold = i + 1 < size && text.at(i + 1) == ch;
      const QString delimiter(bold ? 2 : 1, ch);
      const qsizetype close = text.indexOf(delimiter, i + delimiter.size());
      if (close >= 0 && close < scanEndOfLine(text, i)) {
        i = close + delimiter.size();
        appendRange(result, begin, i, bold ? fmt.strong : fmt.emphasis);
        continue;
      }
    }
    if (ch == QLatin1Char('[') || startsAt(text, i, "![")) {
      const qsizetype lineEnd = scanEndOfLine(text, i);
      const qsizetype label = text.indexOf(QLatin1Char(']'), i + 1);
      if (label >= 0 && label < lineEnd && label + 1 < size &&
          text.at(label + 1) == QLatin1Char('(')) {
        const qsizetype close = text.indexOf(QLatin1Char(')'), label + 2);
        if (close >= 0 && close < lineEnd) {
          i = close + 1;
          appendRange(result, begin, i, fmt.muted);
          continue;
        }
      }
    }
    ++i;
  }
  return result;
}

QList<QTextLayout::FormatRange> xmlRanges(const QString& text) {
  QList<QTextLayout::FormatRange> result;
  const LexerFormats fmt;
  const qsizetype size = text.size();
  qsizetype i = 0;
  bool insideTag = false;
  bool tagName = false;
  bool declaration = false;

  while (i < size) {
    const qsizetype begin = i;
    const QChar ch = text.at(i);
    if (lineBreak(ch) || ch.isSpace()) {
      ++i;
      continue;
    }
    if (startsAt(text, i, "<!--")) {
      i = scanThrough(text, i + 4, "-->");
      appendRange(result, begin, i, fmt.comment);
      continue;
    }
    if (startsAt(text, i, "<![CDATA[")) {
      i = scanThrough(text, i + 9, "]]>");
      appendRange(result, begin, i, fmt.muted);
      continue;
    }
    if (ch == QLatin1Char('<')) {
      ++i;
      insideTag = true;
      tagName = true;
      declaration = false;
      if (i < size && text.at(i) == QLatin1Char('/')) {
        ++i;
      } else if (i < size && QStringLiteral("!?").contains(text.at(i))) {
        ++i;
        declaration = true;
      }
      continue;
    }
    if (insideTag && ch == QLatin1Char('>')) {
      insideTag = false;
      ++i;
      continue;
    }
    if (ch == QLatin1Char('&')) {
      const qsizetype close = text.indexOf(QLatin1Char(';'), i + 1);
      if (close >= 0 && close - i <= 32) {
        i = close + 1;
        appendRange(result, begin, i, fmt.muted);
        continue;
      }
    }
    if (!insideTag) {
      ++i;
      continue;
    }
    if (ch == QLatin1Char('"') || ch == QLatin1Char('\'')) {
      i = scanQuotedToken(text, begin, true);
      appendRange(result, begin, i, fmt.muted);
      continue;
    }
    if (ch.isDigit()) {
      i = scanNumberWithUnit(text, begin);
      appendRange(result, begin, i, fmt.muted);
      continue;
    }
    if (wordStart(ch) || ch == QLatin1Char('-')) {
      ++i;
      while (i < size && (wordPart(text.at(i)) || text.at(i) == QLatin1Char('-') ||
                          text.at(i) == QLatin1Char(':'))) {
        ++i;
      }
      appendRange(result, begin, i, tagName && !declaration ? fmt.strong : fmt.muted);
      tagName = false;
      continue;
    }
    ++i;
  }
  return result;
}

QList<QTextLayout::FormatRange> bashRanges(const QString& text) {
  static const QSet<QString> shellKeywords = {
      QStringLiteral("if"),       QStringLiteral("then"),   QStringLiteral("else"),
      QStringLiteral("elif"),     QStringLiteral("fi"),     QStringLiteral("for"),
      QStringLiteral("while"),    QStringLiteral("until"),  QStringLiteral("do"),
      QStringLiteral("done"),     QStringLiteral("case"),   QStringLiteral("esac"),
      QStringLiteral("in"),       QStringLiteral("function"), QStringLiteral("select"),
      QStringLiteral("time"),     QStringLiteral("coproc")};
  static const QSet<QString> shellBuiltins = {
      QStringLiteral("echo"),     QStringLiteral("printf"),  QStringLiteral("read"),
      QStringLiteral("cd"),       QStringLiteral("pwd"),     QStringLiteral("export"),
      QStringLiteral("local"),    QStringLiteral("declare"), QStringLiteral("typeset"),
      QStringLiteral("readonly"), QStringLiteral("unset"),   QStringLiteral("set"),
      QStringLiteral("shift"),    QStringLiteral("source"),  QStringLiteral("eval"),
      QStringLiteral("exec"),     QStringLiteral("exit"),    QStringLiteral("return"),
      QStringLiteral("break"),    QStringLiteral("continue"), QStringLiteral("test"),
      QStringLiteral("trap"),     QStringLiteral("wait"),    QStringLiteral("true"),
      QStringLiteral("false"),    QStringLiteral("alias"),   QStringLiteral("unalias"),
      QStringLiteral("let"),      QStringLiteral("getopts"), QStringLiteral("command")};

  QList<QTextLayout::FormatRange> result;
  const LexerFormats fmt;
  const qsizetype size = text.size();
  qsizetype i = 0;

  while (i < size) {
    const qsizetype begin = i;
    const QChar ch = text.at(i);
    if (lineBreak(ch) || ch.isSpace()) {
      ++i;
      continue;
    }
    if (ch == QLatin1Char('#') &&
        (i == 0 || text.at(i - 1).isSpace() || lineBreak(text.at(i - 1)) ||
         QStringLiteral(";|&(").contains(text.at(i - 1)))) {
      i = scanEndOfLine(text, i);
      appendRange(result, begin, i, fmt.comment);
      continue;
    }
    if (ch == QLatin1Char('"') || ch == QLatin1Char('\'') || ch == QLatin1Char('`')) {
      i = scanQuotedToken(text, begin, ch != QLatin1Char('\''));
      appendRange(result, begin, i, fmt.muted);
      continue;
    }
    if (ch == QLatin1Char('$')) {
      ++i;
      if (i < size && text.at(i) == QLatin1Char('{')) {
        i = scanThrough(text, i + 1, "}");
      } else if (i < size && QStringLiteral("?#!@$*0123456789").contains(text.at(i))) {
        ++i;
      } else {
        while (i < size && wordPart(text.at(i))) ++i;
      }
      appendRange(result, begin, i, fmt.muted);
      continue;
    }
    if (ch.isDigit()) {
      i = scanNumberWithUnit(text, begin);
      appendRange(result, begin, i, fmt.muted);
      continue;
    }
    if (wordStart(ch) || ch == QLatin1Char('-')) {
      ++i;
      while (i < size && (wordPart(text.at(i)) || text.at(i) == QLatin1Char('-'))) ++i;
      const QString word = text.mid(begin, i - begin);
      if (shellKeywords.contains(word)) {
        appendRange(result, begin, i, fmt.strong);
      } else if (shellBuiltins.contains(word) || (i < size && text.at(i) == QLatin1Char('='))) {
        appendRange(result, begin, i, fmt.muted);
      }
      continue;
    }
    ++i;
  }
  return result;
}

QList<QTextLayout::FormatRange> cssRanges(const QString& text) {
  QList<QTextLayout::FormatRange> result;
  const LexerFormats fmt;
  const qsizetype size = text.size();
  qsizetype i = 0;
  int cssDepth = 0;

  while (i < size) {
    const qsizetype begin = i;
    const QChar ch = text.at(i);
    if (lineBreak(ch) || ch.isSpace()) {
      ++i;
      continue;
    }
    if (startsAt(text, i, "/*")) {
      i = scanThrough(text, i + 2, "*/");
      appendRange(result, begin, i, fmt.comment);
      continue;
    }
    if (ch == QLatin1Char('"') || ch == QLatin1Char('\'')) {
      i = scanQuotedToken(text, begin, true);
      appendRange(result, begin, i, fmt.muted);
      continue;
    }
    if (ch == QLatin1Char('{')) {
      ++cssDepth;
      ++i;
      continue;
    }
    if (ch == QLatin1Char('}')) {
      cssDepth = qMax(0, cssDepth - 1);
      ++i;
      continue;
    }
    if (ch == QLatin1Char('@') || ch == QLatin1Char('#') || ch == QLatin1Char('.') ||
        ch == QLatin1Char(':')) {
      ++i;
      while (i < size && (wordPart(text.at(i)) || text.at(i) == QLatin1Char('-'))) ++i;
      if (i > begin + 1) {
        appendRange(result, begin, i, ch == QLatin1Char('@') ? fmt.strong : fmt.muted);
      }
      continue;
    }
    if (ch.isDigit()) {
      i = scanNumberWithUnit(text, begin);
      appendRange(result, begin, i, fmt.muted);
      continue;
    }
    if (wordStart(ch) || ch == QLatin1Char('-')) {
      ++i;
      while (i < size && (wordPart(text.at(i)) || text.at(i) == QLatin1Char('-'))) ++i;
      appendRange(result, begin, i, cssDepth == 0 ? fmt.strong : fmt.muted);
      continue;
    }
    ++i;
  }
  return result;
}

// Language-specific display lexers. These consume source without executing,
// unescaping, rewriting, or interpreting markup as Qt rich text.
QList<QTextLayout::FormatRange> otherRanges(const QString& text, const QString& tag) {
  if (tag == QStringLiteral("markdown")) return markdownRanges(text);
  if (tag == QStringLiteral("xml")) return xmlRanges(text);
  if (tag == QStringLiteral("bash")) return bashRanges(text);
  if (tag == QStringLiteral("css")) return cssRanges(text);
  return {};
}

}  // namespace

bool supports(const QString& language) {
  const QString tag = normalizedLanguage(language);
  return isJavaScript(tag) ||
         QStringList{"json", "jsonc", "bash", "css", "markdown", "xml"}.contains(tag);
}

QList<QTextLayout::FormatRange> ranges(const QString& text, const QString& language) {
  QList<QTextLayout::FormatRange> result;
  const QString tag = normalizedLanguage(language);
  if (!supports(tag)) return result;
  if (QStringList{"bash", "css", "markdown", "xml"}.contains(tag)) return otherRanges(text, tag);

  const bool javascript = isJavaScript(tag);
  const bool typescript = QStringList{"typescript", "ts", "mts", "cts", "tsx"}.contains(tag);
  const bool comments = javascript || tag == QStringLiteral("jsonc");
  static const QSet<QString> keywords = {
      QStringLiteral("as"),         QStringLiteral("async"),      QStringLiteral("await"),
      QStringLiteral("break"),      QStringLiteral("case"),       QStringLiteral("catch"),
      QStringLiteral("class"),      QStringLiteral("const"),      QStringLiteral("continue"),
      QStringLiteral("debugger"),   QStringLiteral("declare"),    QStringLiteral("default"),
      QStringLiteral("delete"),     QStringLiteral("do"),         QStringLiteral("else"),
      QStringLiteral("enum"),       QStringLiteral("export"),     QStringLiteral("extends"),
      QStringLiteral("finally"),    QStringLiteral("for"),        QStringLiteral("from"),
      QStringLiteral("function"),   QStringLiteral("get"),        QStringLiteral("if"),
      QStringLiteral("implements"), QStringLiteral("import"),     QStringLiteral("in"),
      QStringLiteral("infer"),      QStringLiteral("instanceof"), QStringLiteral("interface"),
      QStringLiteral("is"),         QStringLiteral("keyof"),      QStringLiteral("let"),
      QStringLiteral("namespace"),  QStringLiteral("new"),        QStringLiteral("of"),
      QStringLiteral("override"),   QStringLiteral("private"),    QStringLiteral("protected"),
      QStringLiteral("public"),     QStringLiteral("readonly"),   QStringLiteral("return"),
      QStringLiteral("satisfies"),  QStringLiteral("set"),        QStringLiteral("static"),
      QStringLiteral("super"),      QStringLiteral("switch"),     QStringLiteral("this"),
      QStringLiteral("throw"),      QStringLiteral("try"),        QStringLiteral("type"),
      QStringLiteral("typeof"),     QStringLiteral("var"),        QStringLiteral("void"),
      QStringLiteral("while"),      QStringLiteral("with"),       QStringLiteral("yield")};
  // Match the registered legacy TypeScript grammar: primitive type names are
  // built_in (muted), not keyword (semibold). Keep these out of JavaScript.
  static const QSet<QString> typeBuiltins = {"any",    "boolean", "never",  "number", "string",
                                             "symbol", "unknown", "void",   "object", "bigint"};
  static const QSet<QString> classTitles = {"JSON",   "Math",   "Promise", "Array",  "Object",
                                            "String", "Number", "Boolean", "Date",   "Map",
                                            "Set",    "RegExp", "Error"};
  static const QSet<QString> literals = {
      QStringLiteral("true"), QStringLiteral("false"), QStringLiteral("null"),
      QStringLiteral("undefined"), QStringLiteral("NaN"), QStringLiteral("Infinity")};
  static const QSet<QString> builtins = {
      QStringLiteral("console"),    QStringLiteral("window"),     QStringLiteral("document"),
      QStringLiteral("JSON"),       QStringLiteral("Math"),       QStringLiteral("Promise"),
      QStringLiteral("Array"),      QStringLiteral("Object"),     QStringLiteral("String"),
      QStringLiteral("Number"),     QStringLiteral("Boolean"),    QStringLiteral("Date"),
      QStringLiteral("Map"),        QStringLiteral("Set"),        QStringLiteral("RegExp"),
      QStringLiteral("Error"),      QStringLiteral("setTimeout"), QStringLiteral("setInterval"),
      QStringLiteral("parseInt"),   QStringLiteral("parseFloat")};

  const QTextCharFormat muted = tokenFormat();
  const QTextCharFormat strong = tokenFormat(true);
  const QTextCharFormat comment = tokenFormat(false, true);
  const qsizetype size = text.size();
  qsizetype i = 0;
  bool declarationName = false;
  bool regexAllowed = true;

  while (i < size) {
    const QChar ch = text.at(i);
    if (ch.isSpace() || lineBreak(ch)) {
      ++i;
      continue;
    }
    const qsizetype start = i;
    if (comments && ch == QLatin1Char('/') && i + 1 < size && text.at(i + 1) == QLatin1Char('/')) {
      i = scanEndOfLine(text, i + 2);
      appendRange(result, start, i, comment);
      continue;
    }
    if (comments && ch == QLatin1Char('/') && i + 1 < size && text.at(i + 1) == QLatin1Char('*')) {
      i += 2;
      while (i < size && !(text.at(i - 1) == QLatin1Char('*') && text.at(i) == QLatin1Char('/'))) {
        ++i;
      }
      if (i < size) ++i;
      appendRange(result, start, i, comment);
      continue;
    }
    if (ch == QLatin1Char('"') ||
        (javascript && (ch == QLatin1Char('\'') || ch == QLatin1Char('`')))) {
      ++i;
      while (i < size) {
        const QChar current = text.at(i);
        if (current == QLatin1Char('\\')) {
          i = qMin(size, i + 2);
          continue;
        }
        if (current == ch) {
          ++i;
          break;
        }
        if (ch != QLatin1Char('`') && lineBreak(current)) break;
        ++i;
      }
      appendRange(result, start, i, muted);
      regexAllowed = false;
      declarationName = false;
      continue;
    }
    if (javascript && ch == QLatin1Char('/') && regexAllowed) {
      ++i;
      bool characterClass = false;
      while (i < size && !lineBreak(text.at(i))) {
        const QChar current = text.at(i++);
        if (current == QLatin1Char('\\')) {
          if (i < size) ++i;
          continue;
        }
        if (current == QLatin1Char('[')) characterClass = true;
        if (current == QLatin1Char(']')) characterClass = false;
        if (current == QLatin1Char('/') && !characterClass) {
          while (i < size && text.at(i).isLetter()) ++i;
          break;
        }
      }
      appendRange(result, start, i, muted);
      regexAllowed = false;
      continue;
    }
    if (ch.isDigit() || (ch == QLatin1Char('.') && i + 1 < size && text.at(i + 1).isDigit())) {
      ++i;
      while (i < size && (text.at(i).isLetterOrNumber() || text.at(i) == QLatin1Char('_') ||
                          text.at(i) == QLatin1Char('.'))) {
        ++i;
      }
      if (i < size && i > start &&
          (text.at(i - 1) == QLatin1Char('e') || text.at(i - 1) == QLatin1Char('E')) &&
          (text.at(i) == QLatin1Char('+') || text.at(i) == QLatin1Char('-'))) {
        ++i;
        while (i < size && text.at(i).isDigit()) ++i;
      }
      appendRange(result, start, i, muted);
      regexAllowed = false;
      declarationName = false;
      continue;
    }
    if (wordStart(ch)) {
      ++i;
      while (i < size && wordPart(text.at(i))) ++i;
      const QString word = text.mid(start, i - start);
      qsizetype next = i;
      while (next < size && text.at(next).isSpace()) ++next;
      if (typescript && typeBuiltins.contains(word)) {
        appendRange(result, start, i, muted);
      } else if (javascript &&
                 (declarationName || keywords.contains(word) || classTitles.contains(word))) {
        appendRange(result, start, i, strong);
      } else if (literals.contains(word) ||
                 (javascript &&
                  (builtins.contains(word) || (next < size && text.at(next) == QLatin1Char(':'))))) {
        appendRange(result, start, i, muted);
      } else if (javascript && next < size && text.at(next) == QLatin1Char('(')) {
        appendRange(result, start, i, strong);
      }
      declarationName = javascript && (word == QStringLiteral("function") ||
                                       word == QStringLiteral("class") ||
                                       word == QStringLiteral("interface") ||
                                       (typescript && word == QStringLiteral("type")));
      regexAllowed = javascript && (word == QStringLiteral("return") ||
                                    word == QStringLiteral("throw") ||
                                    word == QStringLiteral("yield") ||
                                    word == QStringLiteral("case"));
      continue;
    }
    regexAllowed = QStringLiteral("=([{,:;!?&|+-*%").contains(ch);
    if (ch != QLatin1Char('*')) declarationName = false;
    ++i;
  }
  return result;
}

}  // namespace codehighlight
