// Markdown source editor: monospace, same 800px measure as the document view,
// plain text and search highlights, matching the legacy textarea.
#pragma once

#include <QPlainTextEdit>


class SourceView : public QPlainTextEdit {
  Q_OBJECT
 public:
  explicit SourceView(QWidget* parent = nullptr);

  void setMarkdown(const QString& text);
  void setExtraSelections(const QList<QTextEdit::ExtraSelection>& selections);
  void revealOffset(int offset);
  int topInset() const { return topInset_; }
  void restoreTopInset(int inset);
  QString markdown() const { return toPlainText(); }
  QString selectedText() const;
  bool isComposing() const { return composing_; }

 signals:
  void compositionStateChanged(bool composing);

 protected:
  void resizeEvent(QResizeEvent* event) override;
  void inputMethodEvent(QInputMethodEvent* event) override;
  void keyPressEvent(QKeyEvent* event) override;

 private:
  void rebuildMargins();
  void updateSelectionPalette();
  QTextCursor currentSearchMatch_;
  bool composing_ = false;
  bool marginPending_ = false;
  int topInset_ = 32;
};
