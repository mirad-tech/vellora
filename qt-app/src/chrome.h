// Toolbar, segmented mode switch, search popover, outline panel and modal
// dialogs, styled from the same design tokens as the legacy stylesheet.
#pragma once

#include <QFrame>
#include <QIcon>
#include <QJsonArray>
#include <QJsonObject>
#include <functional>
#include <QVector>
#include <QWidget>

class QLabel;
class QPropertyAnimation;
class QVariantAnimation;
class QLineEdit;
class QPushButton;
class QToolButton;
class QVBoxLayout;
class QScrollArea;

class SegmentedControl : public QWidget {
  Q_OBJECT
  Q_PROPERTY(qreal slider READ slider WRITE setSlider)
 public:
  explicit SegmentedControl(QWidget* parent = nullptr);
  void setCurrent(int index, bool animate = true);
  int current() const { return current_; }
  qreal slider() const { return slider_; }
  void setSlider(qreal value) { slider_ = value; update(); }

 signals:
  void currentChanged(int index);

 protected:
  void paintEvent(QPaintEvent* event) override;
  void mouseReleaseEvent(QMouseEvent* event) override;
  void mouseMoveEvent(QMouseEvent* event) override;
  void keyPressEvent(QKeyEvent* event) override;
  void resizeEvent(QResizeEvent* event) override;
  QSize sizeHint() const override;
  void enterEvent(QEnterEvent* event) override;
  void leaveEvent(QEvent* event) override;

 private:
  QRect segmentRect(int index) const;
  QStringList labels_{QStringLiteral("文档"), QStringLiteral("源码")};
  QVector<QPushButton*> segments_;
  int current_ = 0;
  qreal slider_ = 0.0;
  int hovered_ = -1;
  QPropertyAnimation* animation_ = nullptr;
};

class SearchPanel : public QFrame {
  Q_OBJECT
 public:
  explicit SearchPanel(QWidget* parent = nullptr);
  void openWith(bool replaceMode, const QString& selection = QString());
  void closePanel();
  bool isReplaceMode() const { return replaceMode_; }
  bool isComposing() const { return composing_; }
  QString query() const;
  QString replacement() const;
  void setCounter(int current, int total);
  void setFeedback(const QString& text);
  void setReplaceVisible(bool visible);

 signals:
  void queryChanged(const QString& query);
  void navigateRequested(int delta);
  void replaceRequested();
  void replaceAllRequested();
  void replaceToggled(bool open);
  void closed();

 protected:
  void keyPressEvent(QKeyEvent* event) override;
  void paintEvent(QPaintEvent* event) override;

 private:
  void restyle();
  void setNavigationVisible(bool visible);
  bool eventFilter(QObject* watched, QEvent* event) override;
  QToolButton* previous_ = nullptr;
  QToolButton* next_ = nullptr;
  bool composing_ = false;
  int count_ = 0;

  QLineEdit* query_ = nullptr;
  QLineEdit* replacement_ = nullptr;
  QLabel* counter_ = nullptr;
  QLabel* feedback_ = nullptr;
  QWidget* replaceRow_ = nullptr;
  QWidget* navRow_ = nullptr;
  QToolButton* replaceToggle_ = nullptr;
  QToolButton* replaceOne_ = nullptr;
  QToolButton* replaceAll_ = nullptr;
  bool replaceMode_ = false;
  QVariantAnimation* navigationAnimation_ = nullptr;
  QVariantAnimation* replacementAnimation_ = nullptr;
};

class OutlinePanel : public QFrame {
  Q_OBJECT
 public:
  explicit OutlinePanel(QWidget* parent = nullptr);
  void setHeadings(const QJsonArray& headings);
  void setCurrentHeading(int index);
  void setFloating(bool floating);

 signals:
  void headingSelected(int index);
  void closeRequested();

 private:
  QVBoxLayout* list_ = nullptr;
  QVector<int> levels_;
  bool floating_ = false;
  QVector<QPushButton*> items_;
  int current_ = -1;
};

class Toolbar : public QWidget {
  Q_OBJECT
 public:
  explicit Toolbar(QWidget* parent = nullptr);
  void setDocumentName(const QString& name, const QString& status, bool unsaved);
  void setMode(int mode);
  void setBusy(bool busy);
  void setDocumentAvailable(bool available);
  void setSaveEnabled(bool enabled);
  void setOutlineChecked(bool checked);
  void setSearchChecked(bool checked);
  SegmentedControl* modeSwitch() const { return mode_; }

 protected:
  void resizeEvent(QResizeEvent* event) override;

 signals:
  void openRequested();
  void saveRequested();
  void searchRequested();
  void outlineRequested();
  void modeChanged(int mode);

 private:
  void layoutControls();
  void updateAvailability();
  bool busy_ = false;
  bool documentAvailable_ = false;
  QWidget* identity_ = nullptr;
  QString documentName_;
  QString documentStatus_;
  QToolButton* openButton_ = nullptr;
  QLabel* nameLabel_ = nullptr;
  QLabel* statusLabel_ = nullptr;
  QToolButton* saveButton_ = nullptr;
  QIcon saveIconMuted_;
  QIcon saveIconLight_;
  QIcon saveIconFaint_;
  QToolButton* searchButton_ = nullptr;
  QToolButton* outlineButton_ = nullptr;
  SegmentedControl* mode_ = nullptr;
};

class ModalDialog : public QFrame {
  Q_OBJECT
 public:
  explicit ModalDialog(QWidget* parent, const QString& title, const QString& message,
                       const QString& primary, const QString& secondary, bool destructive = false);
  static int ask(QWidget* parent, const QString& title, const QString& message,
                 const QString& primary, const QString& secondary, bool destructive = false,
                 const QString& tertiary = QString());

  void fitToParent();

  // One modal owns every conflict step, including recoverable failures.
  static int resolveConflict(QWidget* parent, QJsonObject conflict,
      const std::function<QJsonObject(bool, const QString&)>& resolve,
      const std::function<bool()>& current);

 signals:
  void finished();

 protected:
  bool eventFilter(QObject* watched, QEvent* event) override;
  void paintEvent(QPaintEvent* event) override;
  void keyPressEvent(QKeyEvent* event) override;
  void closeEvent(QCloseEvent* event) override;
  bool focusNextPrevChild(bool next) override;

 private:
  bool scrollBodyForKey(QKeyEvent* event);
  int result_ = 0;
  QScrollArea* bodyScroll_ = nullptr;
  QWidget* bodyText_ = nullptr;
  QVBoxLayout* bodyTextLayout_ = nullptr;
};
