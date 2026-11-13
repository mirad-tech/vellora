// Display-only syntax spans. Never apply these as persistent cursor formats.
#pragma once

#include <QList>
#include <QString>
#include <QTextLayout>

namespace codehighlight {
// Display lexers for the legacy seven language groups: Bash, CSS, JavaScript,
// JSON, Markdown, TypeScript and XML/HTML, including their registered aliases.
// This is lexical colouring, not a complete highlight.js grammar interpreter.
// Empty, unknown and plaintext language tags return no spans. Input offsets are
// UTF-16 offsets, including QTextBlock's U+2028 line separators, unchanged.
QList<QTextLayout::FormatRange> ranges(const QString& text, const QString& language);
bool supports(const QString& language);
}  // namespace codehighlight
