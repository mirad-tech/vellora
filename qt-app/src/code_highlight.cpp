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
  if (QStringList{"html", "xhtml", "rss", "atom", "xjb", "xsd", "xsl", "plist", "wsf", "svg"}.contains(tag)) return QStringLiteral("xml");
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
  return ch == QLatin1Char('\n') || ch == QLatin1Char('\r') ||
         ch == QChar::LineSeparator || ch == QChar::ParagraphSeparator;
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

// Language-specific display lexers. These consume source without executing,
// unescaping, rewriting, or interpreting markup as Qt rich text.
QList<QTextLayout::FormatRange> otherRanges(const QString& text, const QString& tag) {
  QList<QTextLayout::FormatRange> result;
  const QTextCharFormat muted = tokenFormat();
  const QTextCharFormat strong = tokenFormat(true);
  const QTextCharFormat comment = tokenFormat(false, true);
  QTextCharFormat emphasis; emphasis.setFontItalic(true);
  const bool bash = tag == QStringLiteral("bash");
  const bool css = tag == QStringLiteral("css");
  const bool xml = tag == QStringLiteral("xml");
  const bool markdown = tag == QStringLiteral("markdown");
  const qsizetype size = text.size();
  auto append = [&](qsizetype begin, qsizetype end, const QTextCharFormat& format) {
    if (end > begin) result.append({int(begin), int(end - begin), format});
  };
  auto starts = [&](qsizetype at, const char* literal) {
    return QStringView(text).mid(at).startsWith(QLatin1StringView(literal));
  };
  auto through = [&](qsizetype at, const char* terminator) {
    const QString token = QString::fromLatin1(terminator);
    const qsizetype end = text.indexOf(token, at);
    return end < 0 ? size : end + token.size();
  };
  auto endOfLine = [&](qsizetype at) {
    while (at < size && !lineBreak(text.at(at))) ++at;
    return at;
  };
  const QSet<QString> shellKeywords = {"if", "then", "else", "elif", "fi", "for", "while", "until",
      "do", "done", "case", "esac", "in", "function", "select", "time", "coproc"};
  const QSet<QString> shellBuiltins = {"echo", "printf", "read", "cd", "pwd", "export", "local", "declare",
      "typeset", "readonly", "unset", "set", "shift", "source", "eval", "exec", "exit", "return", "break",
      "continue", "test", "trap", "wait", "true", "false", "alias", "unalias", "let", "getopts", "command"};
  qsizetype i = 0;
  bool insideTag = false;
  bool tagName = false;
  bool declaration = false;
  bool atLineStart = true;
  int cssDepth = 0;
  while (i < size) {
    const qsizetype begin = i;
    const QChar ch = text.at(i);
    if (lineBreak(ch)) { ++i; atLineStart = true; continue; }
    if (ch.isSpace()) { ++i; continue; }
    if ((xml || markdown) && starts(i, "<!--")) {
      i = through(i + 4, "-->"); append(begin, i, comment); atLineStart = false; continue;
    }
    if (css && starts(i, "/*")) {
      i = through(i + 2, "*/"); append(begin, i, comment); continue;
    }
    if (bash && ch == QLatin1Char('#') && (i == 0 || text.at(i - 1).isSpace() || lineBreak(text.at(i - 1)) ||
        QStringLiteral(";|&(").contains(text.at(i - 1)))) {
      i = endOfLine(i); append(begin, i, comment); continue;
    }
    if (markdown && atLineStart) {
      const qsizetype lineEnd = endOfLine(i);
      if (ch == QLatin1Char('#')) {
        qsizetype end = i;
        while (end < lineEnd && text.at(end) == QLatin1Char('#')) ++end;
        if (end - i <= 6 && (end == lineEnd || text.at(end).isSpace())) {
          i = lineEnd; append(begin, i, strong); continue;
        }
      }
      if (starts(i, "```") || starts(i, "~~~")) {
        const QString fence = text.mid(i, 3);
        i = lineEnd;
        while (i < size) {
          ++i; const qsizetype nextEnd = endOfLine(i);
          if (text.mid(i, nextEnd - i).trimmed().startsWith(fence)) { i = nextEnd; break; }
          i = nextEnd;
        }
        append(begin, i, muted); continue;
      }
      if (ch == QLatin1Char('>')) { i = lineEnd; append(begin, i, comment); continue; }
      if (QStringLiteral("-*+").contains(ch) && i + 1 < size && text.at(i + 1).isSpace()) {
        ++i; append(begin, i, muted); atLineStart = false; continue;
      }
      if (ch.isDigit()) {
        qsizetype end = i + 1;
        while (end < size && text.at(end).isDigit()) ++end;
        if (end + 1 < size && QStringLiteral(".)").contains(text.at(end)) && text.at(end + 1).isSpace()) {
          i = end + 1; append(begin, i, muted); atLineStart = false; continue;
        }
      }
      const QString line = text.mid(i, lineEnd - i).trimmed();
      if (!line.isEmpty() && (line == QString(line.size(), '=') || line == QString(line.size(), '-'))) {
        i = lineEnd; append(begin, i, strong); continue;
      }
    }
    atLineStart = false;
    if (markdown) {
      if (ch == QLatin1Char('\\')) { i = qMin(size, i + 2); continue; }
      if (ch == QLatin1Char('`')) {
        qsizetype end = i;
        while (end < size && text.at(end) == ch) ++end;
        const QString fence = text.mid(i, end - i);
        const qsizetype close = text.indexOf(fence, end);
        i = close < 0 ? end : close + fence.size(); append(begin, i, muted); continue;
      }
      if (ch == QLatin1Char('*') || ch == QLatin1Char('_')) {
        const bool bold = i + 1 < size && text.at(i + 1) == ch;
        const QString delimiter(bold ? 2 : 1, ch);
        const qsizetype close = text.indexOf(delimiter, i + delimiter.size());
        if (close >= 0 && close < endOfLine(i)) {
          i = close + delimiter.size(); append(begin, i, bold ? strong : emphasis); continue;
        }
      }
      if (ch == QLatin1Char('[') || starts(i, "![")) {
        const qsizetype label = text.indexOf(QLatin1Char(']'), i + 1);
        if (label >= 0 && label < endOfLine(i) && label + 1 < size && text.at(label + 1) == QLatin1Char('(')) {
          const qsizetype close = text.indexOf(QLatin1Char(')'), label + 2);
          if (close >= 0 && close < endOfLine(i)) { i = close + 1; append(begin, i, muted); continue; }
        }
      }
      ++i; continue;
    }
    if (xml) {
      if (starts(i, "<![CDATA[")) { i = through(i + 9, "]]>"); append(begin, i, muted); continue; }
      if (ch == QLatin1Char('<')) {
        ++i; insideTag = true; tagName = true; declaration = false;
        if (i < size && text.at(i) == QLatin1Char('/')) ++i;
        else if (i < size && QStringLiteral("!?").contains(text.at(i))) { ++i; declaration = true; }
        continue;
      }
      if (insideTag && ch == QLatin1Char('>')) { insideTag = false; ++i; continue; }
      if (ch == QLatin1Char('&')) {
        const qsizetype close = text.indexOf(QLatin1Char(';'), i + 1);
        if (close >= 0 && close - i <= 32) { i = close + 1; append(begin, i, muted); continue; }
      }
      if (!insideTag) { ++i; continue; }
    }
    if (ch == QLatin1Char('"') || ch == QLatin1Char('\'') || (bash && ch == QLatin1Char('`'))) {
      ++i;
      while (i < size) {
        if (text.at(i) == QLatin1Char('\\') && !(bash && ch == QLatin1Char('\''))) { i = qMin(size, i + 2); continue; }
        if (text.at(i++) == ch) break;
      }
      append(begin, i, muted); continue;
    }
    if (bash && ch == QLatin1Char('$')) {
      ++i;
      if (i < size && text.at(i) == QLatin1Char('{')) { i = through(i + 1, "}"); }
      else if (i < size && QStringLiteral("?#!@$*0123456789").contains(text.at(i))) ++i;
      else while (i < size && wordPart(text.at(i))) ++i;
      append(begin, i, muted); continue;
    }
    if (css && ch == QLatin1Char('{')) { ++cssDepth; ++i; continue; }
    if (css && ch == QLatin1Char('}')) { cssDepth = qMax(0, cssDepth - 1); ++i; continue; }
    if (css && (ch == QLatin1Char('@') || ch == QLatin1Char('#') || ch == QLatin1Char('.') || ch == QLatin1Char(':'))) {
      ++i;
      while (i < size && (wordPart(text.at(i)) || text.at(i) == QLatin1Char('-'))) ++i;
      if (i > begin + 1) append(begin, i, ch == QLatin1Char('@') ? strong : muted);
      continue;
    }
    if (ch.isDigit()) {
      ++i;
      while (i < size && (text.at(i).isLetterOrNumber() || QStringLiteral(".%").contains(text.at(i)))) ++i;
      append(begin, i, muted); continue;
    }
    if (wordStart(ch) || ch == QLatin1Char('-')) {
      ++i;
      while (i < size && (wordPart(text.at(i)) || text.at(i) == QLatin1Char('-') || (xml && text.at(i) == QLatin1Char(':')))) ++i;
      const QString word = text.mid(begin, i - begin);
      if (xml) { append(begin, i, tagName && !declaration ? strong : muted); tagName = false; }
      else if (bash) {
        if (shellKeywords.contains(word)) append(begin, i, strong);
        else if (shellBuiltins.contains(word) || (i < size && text.at(i) == QLatin1Char('='))) append(begin, i, muted);
      } else if (css) append(begin, i, cssDepth == 0 ? strong : muted);
      continue;
    }
    ++i;
  }
  return result;
}
}  // namespace

bool supports(const QString& language) {
  const QString tag = normalizedLanguage(language);
  return isJavaScript(tag) || QStringList{"json", "jsonc", "bash", "css", "markdown", "xml"}.contains(tag);
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
      QStringLiteral("as"), QStringLiteral("async"), QStringLiteral("await"),
      QStringLiteral("break"), QStringLiteral("case"), QStringLiteral("catch"),
      QStringLiteral("class"), QStringLiteral("const"), QStringLiteral("continue"),
      QStringLiteral("debugger"), QStringLiteral("declare"), QStringLiteral("default"),
      QStringLiteral("delete"), QStringLiteral("do"), QStringLiteral("else"),
      QStringLiteral("enum"), QStringLiteral("export"), QStringLiteral("extends"),
      QStringLiteral("finally"), QStringLiteral("for"), QStringLiteral("from"),
      QStringLiteral("function"), QStringLiteral("get"), QStringLiteral("if"),
      QStringLiteral("implements"), QStringLiteral("import"), QStringLiteral("in"),
      QStringLiteral("infer"), QStringLiteral("instanceof"), QStringLiteral("interface"),
      QStringLiteral("is"), QStringLiteral("keyof"), QStringLiteral("let"),
      QStringLiteral("namespace"), QStringLiteral("new"), QStringLiteral("of"),
      QStringLiteral("override"), QStringLiteral("private"), QStringLiteral("protected"),
      QStringLiteral("public"), QStringLiteral("readonly"), QStringLiteral("return"),
      QStringLiteral("satisfies"), QStringLiteral("set"), QStringLiteral("static"),
      QStringLiteral("super"), QStringLiteral("switch"), QStringLiteral("this"),
      QStringLiteral("throw"), QStringLiteral("try"), QStringLiteral("type"),
      QStringLiteral("typeof"), QStringLiteral("var"), QStringLiteral("void"),
      QStringLiteral("while"), QStringLiteral("with"), QStringLiteral("yield")};
  // Match the registered legacy TypeScript grammar: primitive type names are
  // built_in (muted), not keyword (semibold). Keep these out of JavaScript.
  static const QSet<QString> typeBuiltins = {"any", "boolean", "never", "number", "string",
      "symbol", "unknown", "void", "object", "bigint"};
  static const QSet<QString> classTitles = {"JSON", "Math", "Promise", "Array", "Object",
      "String", "Number", "Boolean", "Date", "Map", "Set", "RegExp", "Error"};
  static const QSet<QString> literals = {QStringLiteral("true"), QStringLiteral("false"),
      QStringLiteral("null"), QStringLiteral("undefined"), QStringLiteral("NaN"), QStringLiteral("Infinity")};
  static const QSet<QString> builtins = {QStringLiteral("console"), QStringLiteral("window"),
      QStringLiteral("document"), QStringLiteral("JSON"), QStringLiteral("Math"),
      QStringLiteral("Promise"), QStringLiteral("Array"), QStringLiteral("Object"),
      QStringLiteral("String"), QStringLiteral("Number"), QStringLiteral("Boolean"),
      QStringLiteral("Date"), QStringLiteral("Map"), QStringLiteral("Set"),
      QStringLiteral("RegExp"), QStringLiteral("Error"), QStringLiteral("setTimeout"),
      QStringLiteral("setInterval"), QStringLiteral("parseInt"), QStringLiteral("parseFloat")};
  const QTextCharFormat muted = tokenFormat();
  const QTextCharFormat strong = tokenFormat(true);
  const QTextCharFormat comment = tokenFormat(false, true);
  auto append = [&](qsizetype start, qsizetype end, const QTextCharFormat& format) {
    if (end > start) result.append({int(start), int(end - start), format});
  };
  const qsizetype size = text.size();
  qsizetype i = 0;
  bool declarationName = false;
  bool regexAllowed = true;
  while (i < size) {
    const QChar ch = text.at(i);
    if (ch.isSpace() || lineBreak(ch)) { ++i; continue; }
    const qsizetype start = i;
    if (comments && ch == QLatin1Char('/') && i + 1 < size && text.at(i + 1) == QLatin1Char('/')) {
      i += 2;
      while (i < size && !lineBreak(text.at(i))) ++i;
      append(start, i, comment);
      continue;
    }
    if (comments && ch == QLatin1Char('/') && i + 1 < size && text.at(i + 1) == QLatin1Char('*')) {
      i += 2;
      while (i < size && !(text.at(i - 1) == QLatin1Char('*') && text.at(i) == QLatin1Char('/'))) ++i;
      if (i < size) ++i;
      append(start, i, comment);
      continue;
    }
    if (ch == QLatin1Char('"') || (javascript && (ch == QLatin1Char('\'') || ch == QLatin1Char('`')))) {
      ++i;
      while (i < size) {
        const QChar current = text.at(i);
        if (current == QLatin1Char('\\')) { i = qMin(size, i + 2); continue; }
        if (current == ch) { ++i; break; }
        if (ch != QLatin1Char('`') && lineBreak(current)) break;
        ++i;
      }
      append(start, i, muted);
      regexAllowed = false;
      declarationName = false;
      continue;
    }
    if (javascript && ch == QLatin1Char('/') && regexAllowed) {
      ++i;
      bool characterClass = false;
      while (i < size && !lineBreak(text.at(i))) {
        const QChar current = text.at(i++);
        if (current == QLatin1Char('\\')) { if (i < size) ++i; continue; }
        if (current == QLatin1Char('[')) characterClass = true;
        if (current == QLatin1Char(']')) characterClass = false;
        if (current == QLatin1Char('/') && !characterClass) {
          while (i < size && text.at(i).isLetter()) ++i;
          break;
        }
      }
      append(start, i, muted);
      regexAllowed = false;
      continue;
    }
    if (ch.isDigit() || (ch == QLatin1Char('.') && i + 1 < size && text.at(i + 1).isDigit())) {
      ++i;
      while (i < size && (text.at(i).isLetterOrNumber() || text.at(i) == QLatin1Char('_') ||
                          text.at(i) == QLatin1Char('.'))) ++i;
      if (i < size && i > start && (text.at(i - 1) == QLatin1Char('e') || text.at(i - 1) == QLatin1Char('E')) &&
          (text.at(i) == QLatin1Char('+') || text.at(i) == QLatin1Char('-'))) {
        ++i;
        while (i < size && text.at(i).isDigit()) ++i;
      }
      append(start, i, muted);
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
      if (typescript && typeBuiltins.contains(word)) append(start, i, muted);
      else if (javascript && (declarationName || keywords.contains(word) || classTitles.contains(word))) append(start, i, strong);
      else if (literals.contains(word) || (javascript && (builtins.contains(word) ||
               (next < size && text.at(next) == QLatin1Char(':'))))) append(start, i, muted);
      else if (javascript && next < size && text.at(next) == QLatin1Char('(')) append(start, i, strong);
      declarationName = javascript && (word == QStringLiteral("function") || word == QStringLiteral("class") ||
                                      word == QStringLiteral("interface") || (typescript && word == QStringLiteral("type")));
      regexAllowed = javascript && (word == QStringLiteral("return") || word == QStringLiteral("throw") ||
                                    word == QStringLiteral("yield") || word == QStringLiteral("case"));
      continue;
    }
    regexAllowed = QStringLiteral("=([{,:;!?&|+-*%").contains(ch);
    if (ch != QLatin1Char('*')) declarationName = false;
    ++i;
  }
  return result;
}
}  // namespace codehighlight
