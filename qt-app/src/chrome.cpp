#include "chrome.h"
#include <algorithm>

#include <QApplication>

#include <functional>
#include <QEventLoop>
#include <QTimer>
#include <QInputMethodEvent>
#include <QPointer>
#include <QScrollArea>
#include <QScrollBar>
#include <QGraphicsDropShadowEffect>
#include <QHBoxLayout>
#include <QKeyEvent>
#include <QLabel>
#include <QLineEdit>
#include <QMouseEvent>
#include <QPainter>
#include <QPainterPath>
#include <QJsonObject>
#include <QSvgRenderer>
#include <QStyle>
#include <QStyleOptionButton>
#include <QStylePainter>
#include <QCloseEvent>
#include <QPropertyAnimation>
#include <QVariantAnimation>
#include <QStyleOptionToolButton>
#ifdef Q_OS_WIN
#include <qt_windows.h>
#endif
#include <QPushButton>
#include <QToolButton>
#include <QVBoxLayout>

#include "theme.h"

namespace {

bool surfaceMotionEnabled() {
#ifdef VELLORA_CHROME_UI_TEST_HOOKS
  const QVariant override = qApp->property("velloraTestSurfaceMotion");
  if (override.isValid()) return override.toBool();
#endif
#ifdef Q_OS_WIN
  BOOL enabled = TRUE;
  if (SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &enabled, 0)) return enabled;
#endif
  return true;
}

QEasingCurve surfaceEasing() {
  QEasingCurve curve(QEasingCurve::BezierSpline);
  curve.addCubicBezierSegment(QPointF(.165, .84), QPointF(.44, 1), QPointF(1, 1));
  return curve;
}

// CSS surface-enter: 200ms opacity + translateY(-4px), with immediate removal.
// Animate the existing effect, not widget geometry or focus/hit-test state.
class SurfaceEnterEffect final : public QGraphicsDropShadowEffect {
 public:
  explicit SurfaceEnterEffect(QWidget* owner, bool shadow = true)
      : QGraphicsDropShadowEffect(owner), animation_(this) {
    setBlurRadius(shadow ? 24 : 0); setOffset(0, shadow ? 8 : 0);
    setColor(shadow ? QColor(0, 0, 0, 40) : QColor(Qt::transparent));
    animation_.setObjectName("surfaceEnterAnimation");
    animation_.setDuration(200); animation_.setEasingCurve(surfaceEasing());
    connect(&animation_, &QVariantAnimation::valueChanged, this, [this](const QVariant& value) {
      progress_ = value.toReal(); update();
    });
    owner->installEventFilter(this);
  }
 protected:
  bool eventFilter(QObject* watched, QEvent* event) override {
    if (event->type() == QEvent::Show) {
      animation_.stop(); progress_ = surfaceMotionEnabled() ? 0 : 1;
      if (progress_ == 0) { animation_.setStartValue(0.0); animation_.setEndValue(1.0); animation_.start(); }
      update();
    } else if (event->type() == QEvent::Hide) {
      animation_.stop(); progress_ = 1; update();
    }
    return QGraphicsDropShadowEffect::eventFilter(watched, event);
  }
  QRectF boundingRectFor(const QRectF& rect) const override {
    return QGraphicsDropShadowEffect::boundingRectFor(rect).adjusted(0, -4, 0, 0);
  }
  void draw(QPainter* painter) override {
    painter->save(); painter->setOpacity(painter->opacity() * progress_);
    painter->translate(0, -4 * (1 - progress_));
    QGraphicsDropShadowEffect::draw(painter); painter->restore();
  }
 private:
  QVariantAnimation animation_;
  qreal progress_ = 1;
};

class CentredToolButton final : public QToolButton {
 public:
  using QToolButton::QToolButton;
 protected:
  void paintEvent(QPaintEvent*) override {
    QStyleOptionToolButton option; initStyleOption(&option);
    option.state &= ~QStyle::State_HasFocus; // keep real keyboard focus, without its visual outline
    const QIcon contentIcon = option.icon; const QString label = option.text;
    option.icon = QIcon(); option.text.clear();
    QStylePainter painter(this); painter.drawComplexControl(QStyle::CC_ToolButton, option);
    painter.setFont(option.font);
    const int textWidth = QFontMetrics(option.font).horizontalAdvance(label);
    const int iconWidth = contentIcon.isNull() ? 0 : iconSize().width();
    const int gap = iconWidth && !label.isEmpty() ? 6 : 0;
    const int left = (width() - iconWidth - gap - textWidth) / 2;
    if (iconWidth) contentIcon.paint(&painter, QRect(left, (height() - iconSize().height()) / 2,
                                                   iconWidth, iconSize().height()), Qt::AlignCenter,
                                      isEnabled() ? QIcon::Normal : QIcon::Disabled);
    const QColor colour = !isEnabled() ? QColor("#b6b5b2")
        : property("primary").toBool() ? theme::surface()
        : underMouse() ? theme::text() : theme::muted();
    painter.setPen(colour);
    painter.drawText(QRect(left + iconWidth + gap, 0, textWidth, height()), Qt::AlignCenter, label);
  }
};

QString toolButtonStyle() {
  return QStringLiteral(
             "QToolButton { border: 0; border-radius: 8px; background: transparent; color: %1;"
             "  padding: 0 8px; height: 32px; font-size: 13px; }"
             "QToolButton:hover { background: rgba(11,11,11,0.05); color: %2; }"
             "QToolButton:pressed { background: rgba(11,11,11,0.09); }"
             "QToolButton:checked { background: rgba(11,11,11,0.09); color: %2; }"
             "QToolButton:disabled { color: %3; }"
             "QToolButton:focus { outline: 0; }")
      .arg(theme::muted().name(), theme::text().name(), theme::faint().name());
}

QIcon strokeIcon(const QString& body, const QColor& colour = QColor(), int extent = 20) {
  const QString svg = QStringLiteral(
                          "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 %3 %3' width='20' height='20'"
                          " fill='none' stroke='%1' stroke-width='1.5' stroke-linecap='round'"
                          " stroke-linejoin='round'>%2</svg>")
                          .arg((colour.isValid() ? colour : theme::muted()).name(), body).arg(extent);
  QSvgRenderer renderer(svg.toUtf8());
  QPixmap pixmap(40, 40);
  pixmap.setDevicePixelRatio(2.0);
  pixmap.fill(Qt::transparent);
  QPainter painter(&pixmap);
  painter.setRenderHint(QPainter::Antialiasing, true);
  renderer.render(&painter, QRectF(0, 0, 20, 20));
  painter.end();
  return QIcon(pixmap);
}

// QPushButton otherwise clips long outline labels without CSS text-overflow.
class ElidedOutlineButton final : public QPushButton {
 public:
  ElidedOutlineButton(const QString& text, int level, QWidget* parent)
      : QPushButton(text, parent), inset_(8 + (level - 1) * 12) {
    setSizePolicy(QSizePolicy::Ignored, QSizePolicy::Fixed);
    setFixedHeight(32);
    setMinimumWidth(0);
  }
 protected:
  void paintEvent(QPaintEvent*) override {
    QStyleOptionButton option;
    initStyleOption(&option);
    // QStyleSheetStyle performs its own push-button text layout. Passing an
    // already-elided label through it can clip the ellipsis a second time.
    // Paint the chrome through the style, then lay out the label exactly once.
    option.text.clear();
    QStylePainter painter(this);
    painter.drawControl(QStyle::CE_PushButton, option);
    const QRect labelRect = rect().adjusted(inset_, 0, -8, 0);
    painter.save();
    painter.setClipRect(labelRect);
    painter.setPen(isEnabled() ? theme::text() : theme::faint());
    painter.drawText(labelRect, Qt::AlignLeft | Qt::AlignVCenter,
                     fontMetrics().elidedText(text(), Qt::ElideRight, qMax(0, labelRect.width())));
    painter.restore();
    if (property("currentHeading").toBool()) {
      painter.setPen(Qt::NoPen);
      painter.setBrush(theme::muted());
      painter.drawRoundedRect(QRectF(0, 8, 2, height() - 16), 1, 1);
    }
  }
 private:
  int inset_;
};

/// In-window modal backdrop: the stylesheet dims the whole app with 24% ink
/// rather than opening a separate OS window.
class Scrim : public QWidget {
 public:
  explicit Scrim(QWidget* parent) : QWidget(parent) {
    setFocusPolicy(Qt::StrongFocus);
    setCursor(Qt::ArrowCursor);
    if (parent) parent->installEventFilter(this);
  }

  std::function<void()> onDismiss;

 protected:
  bool eventFilter(QObject* watched, QEvent* event) override {
    if (watched == parentWidget() && event->type() == QEvent::Resize) {
      setGeometry(parentWidget()->rect());
      for (auto* dialog : findChildren<ModalDialog*>(QString(), Qt::FindDirectChildrenOnly)) {
        dialog->fitToParent();
      }
    }
    return QWidget::eventFilter(watched, event);
  }
  void paintEvent(QPaintEvent*) override {
    QPainter painter(this);
    painter.fillRect(rect(), QColor(11, 11, 11, 61));
  }

  void mousePressEvent(QMouseEvent* event) override {
    // A label or blank part of a card may ignore the press and propagate it.
    // Only an actual press outside every card is a backdrop dismissal.
    for (auto* dialog : findChildren<ModalDialog*>(QString(), Qt::FindDirectChildrenOnly)) {
      if (dialog->isVisible() && dialog->geometry().contains(event->position().toPoint())) {
        event->accept(); return;
      }
    }
    if (onDismiss) onDismiss();
    event->accept();
  }

  void keyPressEvent(QKeyEvent* event) override {
    if (event->key() == Qt::Key_Escape && onDismiss) onDismiss();
  }
};

}  // namespace

// Native focus/action targets share the existing custom-painted surface. They
// deliberately paint nothing, so accessibility adds no focus outline or layout.
class SegmentButton final : public QPushButton {
 public:
  using QPushButton::QPushButton;
 protected:
  void paintEvent(QPaintEvent*) override {}
  void keyPressEvent(QKeyEvent* event) override {
    if (event->key() == Qt::Key_Left || event->key() == Qt::Key_Right ||
        event->key() == Qt::Key_Home || event->key() == Qt::Key_End) {
      QApplication::sendEvent(parentWidget(), event);
      return;
    }
    if (event->key() == Qt::Key_Return || event->key() == Qt::Key_Enter) {
      click(); event->accept(); return;
    }
    QPushButton::keyPressEvent(event);
  }
};

// ---------------------------------------------------------------- SegmentedControl

SegmentedControl::SegmentedControl(QWidget* parent) : QWidget(parent) {
  setFixedSize(114, 32);
  setCursor(Qt::PointingHandCursor);
  setAttribute(Qt::WA_Hover, true);
  setMouseTracking(true);
  setFocusPolicy(Qt::NoFocus);
  setAccessibleName(QStringLiteral("查看方式"));
  for (int index = 0; index < labels_.size(); ++index) {
    auto* button = new SegmentButton(labels_[index], this);
    button->setAccessibleName(labels_[index]);
    button->setCheckable(true);
    button->setAutoExclusive(true);
    button->setChecked(index == current_);
    button->setFocusPolicy(Qt::StrongFocus);
    button->setGeometry(segmentRect(index));
    button->setCursor(Qt::PointingHandCursor);
    segments_.append(button);
    connect(button, &QPushButton::clicked, this, [this, index] { setCurrent(index); });
  }
  setFocusProxy(segments_[current_]);
  animation_ = new QPropertyAnimation(this, "slider", this);
  animation_->setDuration(120);
  animation_->setEasingCurve(QEasingCurve(QEasingCurve::OutCubic));
}

QSize SegmentedControl::sizeHint() const { return QSize(114, 32); }

QRect SegmentedControl::segmentRect(int index) const {
  // 1px track padding, then equal halves: the stylesheet's 56px button plus the
  // 1px inset on each side.
  const int width = (this->width() - 2) / 2;
  return QRect(1 + index * width, 1, width, height() - 2);
}

void SegmentedControl::setCurrent(int index, bool animate) {
  index = qBound(0, index, labels_.size() - 1);
  if (index == current_ && animation_->state() != QAbstractAnimation::Running) return;
  const bool changed = current_ != index;
  current_ = index;
  const bool hadFocus = std::any_of(segments_.cbegin(), segments_.cend(), [](QPushButton* button) { return button->hasFocus(); });
  for (int i = 0; i < segments_.size(); ++i) segments_[i]->setChecked(i == index);
  setFocusProxy(segments_[index]);
  if (hadFocus) segments_[index]->setFocus();
  if (animate) {
    animation_->stop();
    animation_->setStartValue(slider_);
    animation_->setEndValue(static_cast<qreal>(index));
    animation_->start();
  } else {
    animation_->stop();
    slider_ = index;
    update();
  }
  if (changed) emit currentChanged(index);
}

void SegmentedControl::resizeEvent(QResizeEvent* event) {
  QWidget::resizeEvent(event);
  for (int i = 0; i < segments_.size(); ++i) segments_[i]->setGeometry(segmentRect(i));
  slider_ = current_;
  update();
}

void SegmentedControl::enterEvent(QEnterEvent* event) {
  QWidget::enterEvent(event);
  hovered_ = -1;
}

void SegmentedControl::leaveEvent(QEvent* event) {
  hovered_ = -1;
  update();
  QWidget::leaveEvent(event);
}

void SegmentedControl::mouseReleaseEvent(QMouseEvent* event) {
  if (event->button() == Qt::LeftButton) {
    for (int index = 0; index < labels_.size(); ++index) {
      if (segmentRect(index).contains(event->pos())) setCurrent(index);
    }
  }
  QWidget::mouseReleaseEvent(event);
}

void SegmentedControl::mouseMoveEvent(QMouseEvent* event) {
  hovered_ = segmentRect(0).contains(event->pos()) ? 0 : 1;
  update();
  QWidget::mouseMoveEvent(event);
}

void SegmentedControl::keyPressEvent(QKeyEvent* event) {
  if (event->key() == Qt::Key_Left || event->key() == Qt::Key_Home) setCurrent(0);
  else if (event->key() == Qt::Key_Right || event->key() == Qt::Key_End) setCurrent(1);
  else if (event->key() == Qt::Key_Space) setCurrent(1 - current_);
  else { QWidget::keyPressEvent(event); return; }
  event->accept();
}

void SegmentedControl::paintEvent(QPaintEvent*) {
  QPainter painter(this);
  if (!isEnabled()) painter.setOpacity(0.4);
  painter.setRenderHint(QPainter::Antialiasing, true);

  // Track: --control-hover (5% ink) on the toolbar surface, radius 8.
  painter.setPen(Qt::NoPen);
  painter.setBrush(QColor(11, 11, 11, 13));
  painter.drawRoundedRect(QRectF(0, 0, width(), height()), theme::radiusControl(),
                          theme::radiusControl());

  QRectF thumb = segmentRect(0);
  thumb.translate(slider_ * thumb.width(), 0);
  // 0 1px 2px rgba(0,0,0,.06), 0 2px 6px -1px rgba(0,0,0,.05), inset ring .5px
  painter.setBrush(QColor(0, 0, 0, 15));
  painter.drawRoundedRect(thumb.adjusted(-0.5, 1.0, 0.5, 2.0), 7.5, 7.5);
  painter.setBrush(QColor(0, 0, 0, 10));
  painter.drawRoundedRect(thumb.adjusted(-1.0, 2.0, 1.0, 4.0), 8.0, 8.0);
  painter.setBrush(theme::raised());
  painter.drawRoundedRect(thumb, 7, 7);
  painter.setBrush(Qt::NoBrush);
  painter.setPen(QPen(QColor(11, 11, 11, 26), 0.5));
  painter.drawRoundedRect(thumb.adjusted(0.25, 0.25, -0.25, -0.25), 7, 7);


  for (int i = 0; i < labels_.size(); ++i) {
    const bool active = i == current_;
    painter.setFont(theme::uiFont(12, active ? QFont::Medium : QFont::Normal));
    painter.setPen(active || hovered_ == i ? theme::text() : theme::muted());
    painter.drawText(segmentRect(i), Qt::AlignCenter, labels_.at(i));
  }
}

// ---------------------------------------------------------------- SearchPanel

SearchPanel::SearchPanel(QWidget* parent) : QFrame(parent) {
  setObjectName("searchPanel");
  setPalette(theme::selectionPalette(palette()));
  setAttribute(Qt::WA_StyledBackground, true);
  setStyleSheet(QStringLiteral(
                    "#searchPanel { background: %1; border: 1px solid %2; border-radius: 14px; }"
                    "QLineEdit { border: 0; background: transparent; font-size: 14px; color: %3;"
                    "  selection-background-color: %4; selection-color: %5; padding: 0; }"
                    "QLineEdit:focus { outline: 0; }")
                    .arg(theme::raised().name(), theme::border().name(QColor::HexArgb), theme::text().name(),
                         theme::selectionBg().name(), theme::selectionText().name()));

  auto* outer = new QVBoxLayout(this);
  outer->setContentsMargins(0, 0, 0, 0);
  outer->setSpacing(0);

  auto* fieldRow = new QWidget(this);
  fieldRow->setFixedHeight(40);
  auto* fieldLayout = new QHBoxLayout(fieldRow);
  fieldLayout->setContentsMargins(6, 0, 6, 0);
  fieldLayout->setSpacing(6);

  auto* prefix = new QWidget(fieldRow);
  prefix->setFixedWidth(56);
  auto* prefixLayout = new QHBoxLayout(prefix);
  prefixLayout->setContentsMargins(0, 0, 0, 0);
  prefixLayout->setSpacing(4);

  auto smallButton = [&](QWidget* host) {
    auto* button = new QToolButton(host);
    button->setAutoRaise(true);
    button->setFixedSize(28, 28);
    button->setCursor(Qt::PointingHandCursor);
    button->setStyleSheet(QStringLiteral(
                              "QToolButton { border: 0; border-radius: 8px; background: transparent; }"
                              "QToolButton:hover:enabled { background: rgba(11,11,11,0.05); }"
                              "QToolButton:focus { outline: 0; }"));
    return button;
  };

  replaceToggle_ = smallButton(prefix);
  replaceToggle_->setIcon(strokeIcon("<path d='M6 4l4 4-4 4'/>", QColor(), 16));
  replaceToggle_->setIconSize(QSize(16, 16));
  replaceToggle_->setAccessibleName(QStringLiteral("展开替换"));
  replaceToggle_->setToolTip(QStringLiteral("替换 (Ctrl+H)"));
  prefixLayout->addWidget(replaceToggle_);

  auto* icon = new QLabel(prefix);
  icon->setPixmap(strokeIcon("<circle cx='8.5' cy='8.5' r='5.25'/><path d='m12.5 12.5 4 4'/>")
                      .pixmap(15, 15));
  prefixLayout->addWidget(icon);
  prefixLayout->addStretch(1);
  fieldLayout->addWidget(prefix);

  query_ = new QLineEdit(fieldRow);
  query_->setPlaceholderText(QStringLiteral("查找"));
  query_->setFixedHeight(40);
  query_->setMinimumWidth(0);
  fieldLayout->addWidget(query_, 1);

  auto* close = smallButton(fieldRow);
  close->setIcon(strokeIcon("<path d='m5 5 6 6m0-6-6 6'/>", QColor(), 16));
  close->setIconSize(QSize(16, 16));
  close->setFixedSize(28, 28);
  fieldLayout->addWidget(close);
  outer->addWidget(fieldRow);

  // Replacement row: 40px, icon right-aligned in the 56px prefix column.
  replaceRow_ = new QWidget(this);
  replaceRow_->setFixedHeight(40);
  replaceRow_->setObjectName("replacementRow");
  replaceRow_->setAttribute(Qt::WA_StyledBackground, true);
  replaceRow_->setStyleSheet(QStringLiteral(
      "#replacementRow { background: transparent; border-top: 1px solid rgba(11,11,11,0.10); }"));
  auto* replaceLayout = new QHBoxLayout(replaceRow_);
  replaceLayout->setContentsMargins(6, 0, 6, 0);
  replaceLayout->setSpacing(6);
  auto* replacePrefix = new QWidget(replaceRow_);
  replacePrefix->setFixedWidth(56);
  auto* replacePrefixLayout = new QHBoxLayout(replacePrefix);
  replacePrefixLayout->setContentsMargins(0, 0, 8, 0);
  replacePrefixLayout->addStretch(1);
  auto* replaceIcon = new QLabel(replacePrefix);
  replaceIcon->setPixmap(strokeIcon("<path d='M4 6h12m-3-3 3 3-3 3M16 14H4m3-3-3 3 3 3'/>")
                              .pixmap(16, 16));
  replacePrefixLayout->addWidget(replaceIcon);
  replaceLayout->addWidget(replacePrefix);

  replacement_ = new QLineEdit(replaceRow_);
  replacement_->setPlaceholderText(QStringLiteral("替换为"));
  replacement_->setFixedHeight(40);
  replacement_->setMinimumWidth(0);
  replaceLayout->addWidget(replacement_, 1);

  auto* tail = new QWidget(replaceRow_);
  tail->setFixedWidth(28);
  replaceLayout->addWidget(tail);
  outer->addWidget(replaceRow_);

  // Navigation row: 32px, 1px inset top rule, actions left, count right.
  navRow_ = new QWidget(this);
  navRow_->setFixedHeight(32);
  navRow_->setObjectName("navigationRow");
  navRow_->setAttribute(Qt::WA_StyledBackground, true);
  navRow_->setStyleSheet(QStringLiteral(
      "#navigationRow { background: transparent; border-top: 1px solid rgba(11,11,11,0.10); }"));
  auto* navLayout = new QHBoxLayout(navRow_);
  navLayout->setContentsMargins(8, 2, 12, 2);
  navLayout->setSpacing(4);

  auto* previous = previous_ = smallButton(navRow_);
  previous->setIcon(strokeIcon("<path d='M6 6l2-2 2 2M8 4v8'/>", QColor(), 16));
  previous->setIconSize(QSize(16, 16));
  previous->setAccessibleName(QStringLiteral("上一个匹配项"));
  previous->setToolTip(QStringLiteral("上一个匹配项"));
  navLayout->addWidget(previous);

  auto* next = next_ = smallButton(navRow_);
  next->setIcon(strokeIcon("<path d='m6 10 2 2 2-2M8 12V4'/>", QColor(), 16));
  next->setIconSize(QSize(16, 16));
  next->setAccessibleName(QStringLiteral("下一个匹配项"));
  next->setToolTip(QStringLiteral("下一个匹配项"));
  navLayout->addWidget(next);

  navLayout->addStretch(1);

  replaceOne_ = new QToolButton(navRow_);
  replaceOne_->setText(QStringLiteral("替换"));
  replaceAll_ = new QToolButton(navRow_);
  replaceAll_->setText(QStringLiteral("全部替换"));
  for (QToolButton* button : {replaceOne_, replaceAll_}) {
    button->setCursor(Qt::PointingHandCursor);
    button->setFixedHeight(28);
    button->setStyleSheet(QStringLiteral(
                              "QToolButton { border: 0px solid %1; border-radius: 8px;"
                              "  padding: 0 8px; color: %2; background: %3; font-size: 12px; }"
                              "QToolButton:hover:enabled { background: rgba(11,11,11,0.05); }"
                              "QToolButton:disabled { color: #b6b5b2; }"
                              "QToolButton:focus { outline: 0; }")
                              .arg(theme::border().name(QColor::HexArgb), theme::text().name(),
                                   theme::raised().name()));
    button->hide();
    navLayout->addWidget(button);
  }

  counter_ = new QLabel(navRow_);
  counter_->setStyleSheet(QStringLiteral("color: %1; font-size: 13px;").arg(theme::muted().name()));
  counter_->setAlignment(Qt::AlignRight | Qt::AlignVCenter);
  counter_->setMinimumWidth(48);
  navLayout->insertWidget(2, counter_);
  outer->addWidget(navRow_);
  feedback_ = new QLabel(this);
  feedback_->setWordWrap(true);
  feedback_->setTextFormat(Qt::PlainText);
  feedback_->setStyleSheet(QStringLiteral("color: %1; font-size: 12px; padding: 0 12px 8px;").arg(theme::muted().name()));
  feedback_->hide();
  outer->addWidget(feedback_);

  replaceRow_->hide();
  navRow_->hide();
  // Keep a single graphics effect on the panel. Nested effects can leave child
  // rows permanently blank in the Windows backing-store composition path.
  navigationAnimation_ = new QVariantAnimation(this);
  navigationAnimation_->setObjectName("searchNavigationAnimation");
  navigationAnimation_->setDuration(200);
  navigationAnimation_->setEasingCurve(surfaceEasing());
  connect(navigationAnimation_, &QVariantAnimation::valueChanged, this, [this](const QVariant& value) {
    const qreal height = value.toReal(); navRow_->setFixedHeight(qRound(height));
    adjustSize();
  });
  connect(navigationAnimation_, &QVariantAnimation::finished, this, [this] {
    if (navigationAnimation_->endValue().toInt() == 0) navRow_->hide();
    adjustSize();
  });

  replacementAnimation_ = new QVariantAnimation(this);
  replacementAnimation_->setObjectName("searchReplacementAnimation");
  replacementAnimation_->setDuration(200);
  replacementAnimation_->setEasingCurve(surfaceEasing());
  connect(replacementAnimation_, &QVariantAnimation::valueChanged, this, [this](const QVariant& value) {
    replaceRow_->setFixedHeight(qRound(value.toReal()));
    adjustSize();
  });
  connect(replacementAnimation_, &QVariantAnimation::finished, this, [this] {
    replaceRow_->setVisible(replaceMode_);
    adjustSize();
  });

  connect(query_, &QLineEdit::textChanged, this, [this](const QString& text) {
    setNavigationVisible(!text.trimmed().isEmpty() || replaceMode_);
    setFeedback(QString());
    setCounter(0, 0);
    emit queryChanged(text);
    adjustSize();
  });
  connect(query_, &QLineEdit::returnPressed, this, [this] {
    if (composing_ || count_ == 0) return;
    emit navigateRequested((QApplication::keyboardModifiers() & Qt::ShiftModifier) ? -1 : 1);
  });
  query_->installEventFilter(this);
  replacement_->installEventFilter(this);
  query_->setAccessibleName(QStringLiteral("搜索当前文档"));
  replacement_->setAccessibleName(QStringLiteral("替换为"));
  close->setAccessibleName(QStringLiteral("关闭查找"));
  connect(replacement_, &QLineEdit::textChanged, this, [this] { setFeedback(QString()); });
  connect(replacement_, &QLineEdit::returnPressed, this, [this] {
    if (!composing_ && replaceOne_->isEnabled()) emit replaceRequested();
  });
  setCounter(0, 0);
  connect(previous, &QToolButton::clicked, this, [this] { emit navigateRequested(-1); });
  connect(next, &QToolButton::clicked, this, [this] { emit navigateRequested(1); });
  connect(close, &QToolButton::clicked, this, [this] { emit closed(); });
  connect(replaceOne_, &QToolButton::clicked, this, [this] { emit replaceRequested(); });
  connect(replaceAll_, &QToolButton::clicked, this, [this] { emit replaceAllRequested(); });
  connect(replaceToggle_, &QToolButton::clicked, this, [this] {
    emit replaceToggled(!replaceMode_);
  });

  auto* shadow = new SurfaceEnterEffect(this);
  setGraphicsEffect(shadow);

  setFixedWidth(theme::searchWidth());
  hide();
}

void SearchPanel::restyle() { update(); }

void SearchPanel::setNavigationVisible(bool visible) {
  const int target = visible ? 32 : 0;
  if (navigationAnimation_->state() == QAbstractAnimation::Running &&
      navigationAnimation_->endValue().toInt() == target) return;
  const int start = navRow_->isHidden() ? 0 : navRow_->height();
  navigationAnimation_->stop();
  if (!isVisible() || !surfaceMotionEnabled() || start == target) {
    navRow_->setFixedHeight(target);
    navRow_->setVisible(visible); adjustSize(); return;
  }
  navRow_->setFixedHeight(start); navRow_->show();
  navigationAnimation_->setStartValue(qreal(start)); navigationAnimation_->setEndValue(qreal(target));
  navigationAnimation_->start();
}

void SearchPanel::paintEvent(QPaintEvent* event) { QFrame::paintEvent(event); }

void SearchPanel::openWith(bool replaceMode, const QString& selection) {
  setReplaceVisible(replaceMode);
  show();
  raise();
  if (!selection.isEmpty()) query_->setText(selection);
  setNavigationVisible(!query_->text().trimmed().isEmpty() || replaceMode_);
  auto* input = replaceMode && !query_->text().trimmed().isEmpty() ? replacement_ : query_;
  input->setFocus();
  if (input == query_) input->selectAll();
  adjustSize();
}

void SearchPanel::closePanel() {
  hide();
  replacementAnimation_->stop();
  navigationAnimation_->stop();
  replaceRow_->setFixedHeight(replaceMode_ ? 40 : 0);
  replaceRow_->setVisible(replaceMode_);
  const bool navigation = !query_->text().trimmed().isEmpty() || replaceMode_;
  navRow_->setFixedHeight(navigation ? 32 : 0);
  navRow_->setVisible(navigation);
  adjustSize();
}

QString SearchPanel::query() const { return query_->text(); }
QString SearchPanel::replacement() const { return replacement_->text(); }

void SearchPanel::setFeedback(const QString& text) {
  feedback_->setText(text);
  feedback_->setVisible(!text.isEmpty());
  adjustSize();
}

void SearchPanel::setCounter(int current, int total) {
  count_ = qMax(0, total);
  previous_->setEnabled(count_ > 0 && !composing_);
  next_->setEnabled(count_ > 0 && !composing_);
  replaceOne_->setEnabled(count_ > 0 && current > 0 && !composing_);
  replaceAll_->setEnabled(count_ > 0 && !composing_);

  counter_->setText(total > 0 ? QStringLiteral("%1 / %2").arg(current).arg(total)
                              : QStringLiteral("0 / 0"));
}

void SearchPanel::setReplaceVisible(bool visible) {
  // Never hide the IME target mid-composition or move focus on animation ticks.
  if (!visible && composing_) return;
  if (!visible && replacement_->hasFocus()) query_->setFocus(Qt::OtherFocusReason);
  replaceMode_ = visible;
  replaceToggle_->setAccessibleName(visible ? QStringLiteral("收起替换") : QStringLiteral("展开替换"));
  replaceToggle_->setToolTip(replaceToggle_->accessibleName());
  auto* navLayout = qobject_cast<QHBoxLayout*>(navRow_->layout());
  navLayout->removeWidget(counter_);
  navLayout->insertWidget(visible ? 2 : navLayout->count(), counter_);
  setNavigationVisible(!query_->text().trimmed().isEmpty() || visible);
  const int target = visible ? 40 : 0;
  if (replacementAnimation_->state() != QAbstractAnimation::Running ||
      replacementAnimation_->endValue().toInt() != target) {
    const int start = replaceRow_->isHidden() ? 0 : replaceRow_->height();
    replacementAnimation_->stop();
    if (!isVisible() || !surfaceMotionEnabled() || start == target) {
      replaceRow_->setFixedHeight(target);
      replaceRow_->setVisible(visible);
    } else {
      replaceRow_->setFixedHeight(start);
      replaceRow_->show();
      replacementAnimation_->setStartValue(qreal(start));
      replacementAnimation_->setEndValue(qreal(target));
      replacementAnimation_->start();
    }
  }
  replaceOne_->setVisible(visible);
  replaceAll_->setVisible(visible);
  replaceToggle_->setIcon(strokeIcon(visible ? "<path d='m4 6 4 4 4-4'/>"
                                             : "<path d='M6 4l4 4-4 4'/>", QColor(), 16));
  adjustSize();
}

bool SearchPanel::eventFilter(QObject* watched, QEvent* event) {
  if (event->type() == QEvent::InputMethod) {
    composing_ = !static_cast<QInputMethodEvent*>(event)->preeditString().isEmpty();
    previous_->setEnabled(count_ > 0 && !composing_);
    next_->setEnabled(count_ > 0 && !composing_);
    replaceOne_->setEnabled(count_ > 0 && !composing_);
    replaceAll_->setEnabled(count_ > 0 && !composing_);
  }
  if (event->type() == QEvent::KeyPress &&
      static_cast<QKeyEvent*>(event)->key() == Qt::Key_Escape) {
    if (!composing_) emit closed();
    return true;
  }
  return QFrame::eventFilter(watched, event);
}

void SearchPanel::keyPressEvent(QKeyEvent* event) {
  if (event->key() == Qt::Key_Escape && !composing_) {
    emit closed();
    return;
  }
  QFrame::keyPressEvent(event);
}

// ---------------------------------------------------------------- OutlinePanel

OutlinePanel::OutlinePanel(QWidget* parent) : QFrame(parent) {
  setObjectName("outlinePanel");
  setAttribute(Qt::WA_StyledBackground, true);
  setStyleSheet(QStringLiteral(
                    "#outlinePanel { background: %1; border-right: 1px solid %2; }"
                    "QPushButton { border: 0; border-radius: 8px; text-align: left;"
                    "  padding: 0 8px; height: 32px; font-size: 13px; color: %3; background: transparent; }"
                    "QPushButton:hover { background: rgba(11,11,11,0.05); }"
                    "QPushButton:focus { outline: 0; }")
                    .arg(theme::bg().name(), theme::border().name(QColor::HexArgb), theme::text().name()));
  setFixedWidth(232);

  auto* layout = new QVBoxLayout(this);
  // Keep the scroll track at the panel's inside edge. Text/header padding is
  // separate from the scroll area's geometry; the bottom inset clears corners.
  layout->setContentsMargins(8, 12, 0, 12);
  layout->setSpacing(4);

  auto* header = new QWidget(this);
  header->setFixedHeight(32);
  auto* headerLayout = new QHBoxLayout(header);
  // Preserve the old close-control position: its 4px internal margin plus
  // the 8px outer padding now removed from the scroll area's right edge.
  headerLayout->setContentsMargins(8, 0, 12, 0);
  auto* title = new QLabel(QStringLiteral("目录"), header);
  title->setStyleSheet(QStringLiteral("color: %1; font-size: 12px;").arg(theme::muted().name()));
  headerLayout->addWidget(title);
  headerLayout->addStretch(1);
  auto* closeButton = new QToolButton(header);
  closeButton->setAccessibleName(QStringLiteral("关闭目录"));
  closeButton->setToolTip(QStringLiteral("关闭目录"));
  closeButton->setText(QStringLiteral("×"));
  closeButton->setCursor(Qt::PointingHandCursor);
  closeButton->setFixedSize(28, 28);
  closeButton->setStyleSheet(QStringLiteral(
                                 "QToolButton { border: 0; border-radius: 6px; color: %1; font-size: 16px; }"
                                 "QToolButton:hover:enabled { background: rgba(11,11,11,0.05); }"
                              "QToolButton:disabled { color: #b6b5b2; }"
                              "QToolButton:focus { outline: 0; }")
                                 .arg(theme::muted().name()));
  connect(closeButton, &QToolButton::clicked, this, &OutlinePanel::closeRequested);
  headerLayout->addWidget(closeButton);
  layout->addWidget(header);

  auto* scroll = new QScrollArea(this);
  scroll->setWidgetResizable(true);
  scroll->setFrameShape(QFrame::NoFrame);
  scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
  scroll->setStyleSheet(QStringLiteral(
      "QScrollArea, QScrollArea > QWidget > QWidget { background: transparent; }"
      "QScrollBar:vertical { width: 10px; background: transparent; margin: 0; border: 0; }"
      "QScrollBar::handle:vertical { background: rgba(11,11,11,0.20); margin: 0 1px 0 5px; border-radius: 2px; min-height: 32px; }"
      "QScrollBar::handle:vertical:hover { background: rgba(11,11,11,0.35); }"
      "QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; border: 0; background: transparent; }"
      "QScrollBar::up-arrow:vertical, QScrollBar::down-arrow:vertical { width: 0; height: 0; background: transparent; }"
      "QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical { background: transparent; border: 0; }"
      "QScrollArea::corner { background: transparent; border: 0; }"));
  auto* contents = new QWidget(scroll);
  list_ = new QVBoxLayout(contents);
  list_->setContentsMargins(0, 0, 8, 0);
  list_->setSpacing(0);
  list_->setAlignment(Qt::AlignTop);
  scroll->setWidget(contents);
  layout->addWidget(scroll, 1);
}

void OutlinePanel::setFloating(bool floating) {
  if (floating_ == floating) return;
  floating_ = floating;
  setFixedWidth(floating ? 248 : 232);
  QString sheet = styleSheet();
  const int end = sheet.indexOf(QLatin1Char('}'));
  if (end >= 0) sheet.remove(0, end + 1);
  const QString panel = floating
      ? QStringLiteral("#outlinePanel { background: %1; border: 1px solid %2; border-radius: 12px; }")
            .arg(theme::raised().name(), theme::border().name(QColor::HexArgb))
      : QStringLiteral("#outlinePanel { background: %1; border: 0; border-right: 1px solid %2; border-radius: 0; }")
            .arg(theme::bg().name(), theme::border().name(QColor::HexArgb));
  setStyleSheet(panel + sheet);
  if (floating) {
    auto* shadow = new SurfaceEnterEffect(this);
    setGraphicsEffect(shadow);
  } else {
    setGraphicsEffect(nullptr);
  }
}

void OutlinePanel::setHeadings(const QJsonArray& headings) {
  while (auto* item = list_->takeAt(0)) {
    delete item->widget();
    delete item;
  }
  levels_.clear();
  items_.clear();
  current_ = -1;

  if (headings.isEmpty()) {
    auto* empty = new QLabel(QStringLiteral("没有标题"), this);
    empty->setStyleSheet(QStringLiteral("color: %1; font-size: 13px; padding: 8px 12px;").arg(theme::muted().name()));
    list_->addWidget(empty);
    return;
  }

  for (int index = 0; index < headings.size(); ++index) {
    const QJsonObject heading = headings.at(index).toObject();
    const int level = heading.value("level").toInt(1);
    auto* item = new ElidedOutlineButton(heading.value("text").toString(), level, this);
    item->setCursor(Qt::PointingHandCursor);
    levels_.append(level);
    item->setToolTip(item->text());
    item->setStyleSheet(QStringLiteral("padding-left: %1px;").arg(8 + (level - 1) * 12));
    connect(item, &QPushButton::clicked, this, [this, index] { emit headingSelected(index); });
    list_->addWidget(item);
    items_.append(item);
  }
}

void OutlinePanel::setCurrentHeading(int index) {
  if (index == current_) return;
  for (int i = 0; i < items_.size(); ++i) {
    items_.at(i)->setProperty("currentHeading", i == index);
    items_.at(i)->setStyleSheet(QStringLiteral("padding-left: %1px; %2")
                                    .arg(8 + (levels_.at(i) - 1) * 12)
                                    .arg(i == index ? QStringLiteral("background: rgba(11,11,11,0.05); font-weight: 500;")
                                                    : QString()));
  }
  current_ = index;
}

// ---------------------------------------------------------------- Toolbar

Toolbar::Toolbar(QWidget* parent) : QWidget(parent) {
  setFixedHeight(theme::toolbarHeight());
  setAttribute(Qt::WA_StyledBackground, true);
  setStyleSheet(QStringLiteral("Toolbar { background: %1; border-bottom: 1px solid rgba(11,11,11,0.10); }")
                    .arg(theme::bg().name()));



  openButton_ = new QToolButton(this);
  openButton_->setAccessibleName(QStringLiteral("打开文件"));
  openButton_->setText(QStringLiteral("打开"));
  openButton_->setIcon(strokeIcon("<path d='M2.5 6V4.5a1 1 0 0 1 1-1h4l2 2h6a1 1 0 0 1 1 1V8M3.5 16.5h12l2-8h-12l-2 8-1-10'/>"));
  openButton_->setIconSize(QSize(16, 16));
  openButton_->setFixedSize(64, 32);
  openButton_->setToolButtonStyle(Qt::ToolButtonTextBesideIcon);
  openButton_->setCursor(Qt::PointingHandCursor);
  openButton_->setStyleSheet(toolButtonStyle());
  connect(openButton_, &QToolButton::clicked, this, &Toolbar::openRequested);


  auto* identity = identity_ = new QWidget(this);

  nameLabel_ = new QLabel(QStringLiteral("Vellora"), identity);
  nameLabel_->setTextFormat(Qt::PlainText);
  nameLabel_->setStyleSheet(QStringLiteral("color: %1; font-size: 13px; font-weight: 500;")
                                .arg(theme::text().name()));
  statusLabel_ = new QLabel(QStringLiteral("未打开文件"), identity);
  statusLabel_->setTextFormat(Qt::PlainText);
  statusLabel_->setStyleSheet(QStringLiteral("color: %1; font-size: 11px;").arg(theme::faint().name()));



  // The stylesheet centres the switch in the toolbar's middle grid column, so it
  // is positioned manually instead of being part of the flex row.
  mode_ = new SegmentedControl(this);
  connect(mode_, &SegmentedControl::currentChanged, this, &Toolbar::modeChanged);
  mode_->raise();


  saveButton_ = new CentredToolButton(this);
  saveButton_->setAccessibleName(QStringLiteral("保存"));
  saveButton_->setText(QStringLiteral("保存"));
  saveIconMuted_ = strokeIcon(
      "<path d='M5 3.5h8.5l3 3v8.5a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 15V5A1.5 1.5 0 0 1 5 3.5Z'/>"
      "<path d='M7 3.5v4h5.5v-4M7 16.5v-5h6v5'/>");
  saveIconLight_ = strokeIcon(
      "<path d='M5 3.5h8.5l3 3v8.5a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 15V5A1.5 1.5 0 0 1 5 3.5Z'/>"
      "<path d='M7 3.5v4h5.5v-4M7 16.5v-5h6v5'/>",
      theme::surface());
  saveIconFaint_ = strokeIcon(
      "<path d='M5 3.5h8.5l3 3v8.5a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 15V5A1.5 1.5 0 0 1 5 3.5Z'/>"
      "<path d='M7 3.5v4h5.5v-4M7 16.5v-5h6v5'/>",
      QColor("#b6b5b2"));
  saveButton_->setIcon(saveIconFaint_);
  saveButton_->setIconSize(QSize(16, 16));
  saveButton_->setToolButtonStyle(Qt::ToolButtonTextBesideIcon);
  saveButton_->setCursor(Qt::PointingHandCursor);
  saveButton_->setFixedSize(72, theme::controlHeight());
  saveButton_->setStyleSheet(QStringLiteral(
      "QToolButton { border: 0; border-radius: 8px; background: transparent; color: %1;"
      "  font-size: 13px; font-weight: 500; padding: 0 6px; }"
      "QToolButton:hover { background: rgba(11,11,11,0.05); color: %2; }"
      "QToolButton:pressed { background: rgba(11,11,11,0.09); }"
      "QToolButton:disabled { color: %3; }"
      "QToolButton[primary=\"true\"] { background: %2; color: %4; }"
      "QToolButton[primary=\"true\"]:hover { background: #2c2c2a; }")
      .arg(theme::muted().name(), theme::text().name(), QStringLiteral("#b6b5b2"),
           theme::surface().name()));
  connect(saveButton_, &QToolButton::clicked, this, &Toolbar::saveRequested);


  searchButton_ = new QToolButton(this);
  searchButton_->setAccessibleName(QStringLiteral("查找"));
  searchButton_->setToolTip(QStringLiteral("查找 (Ctrl+F)"));
  searchButton_->setCheckable(true);
  searchButton_->setIcon(strokeIcon("<circle cx='8.5' cy='8.5' r='5.25'/><path d='m12.5 12.5 4 4'/>"));
  searchButton_->setIconSize(QSize(16, 16));
  searchButton_->setFixedSize(32, 32);
  searchButton_->setCursor(Qt::PointingHandCursor);
  searchButton_->setStyleSheet(toolButtonStyle() + QStringLiteral("QToolButton { padding: 0; }"));
  connect(searchButton_, &QToolButton::clicked, this, &Toolbar::searchRequested);


  outlineButton_ = new QToolButton(this);
  outlineButton_->setAccessibleName(QStringLiteral("目录"));
  outlineButton_->setToolTip(QStringLiteral("目录"));
  outlineButton_->setCheckable(true);
  outlineButton_->setIcon(strokeIcon("<rect x='2.5' y='3.5' width='15' height='13' rx='2'/><path d='M7.5 3.5v13M10.5 7h4M10.5 10h4M10.5 13h2'/>"));
  outlineButton_->setIconSize(QSize(16, 16));
  outlineButton_->setFixedSize(32, 32);
  outlineButton_->setCursor(Qt::PointingHandCursor);
  outlineButton_->setStyleSheet(toolButtonStyle() + QStringLiteral("QToolButton { padding: 0; }"));
  connect(outlineButton_, &QToolButton::clicked, this, &Toolbar::outlineRequested);
  layoutControls();
  updateAvailability();
}

void Toolbar::resizeEvent(QResizeEvent* event) {
  QWidget::resizeEvent(event);
  layoutControls();
}

void Toolbar::layoutControls() {
  if (!mode_ || !outlineButton_) return;
  const bool narrow = width() < 760;
  setFixedHeight(narrow ? 80 : 52);
  const int y = narrow ? 7 : 10;
  openButton_->move(12, y);
  mode_->move((width() - mode_->width()) / 2, y);
  outlineButton_->move(width() - 44, y);
  searchButton_->move(width() - 80, y);
  saveButton_->move(width() - 156, y);
  identity_->setGeometry(narrow ? QRect(20, 43, width() - 40, 28)
                               : QRect(88, 10, qMax(0, mode_->x() - 96), 32));
  if (narrow) {
    const int statusWidth = qMin(identity_->width() * 45 / 100, statusLabel_->fontMetrics().horizontalAdvance(documentStatus_) + 6);
    const int nameWidth = qMin(identity_->width() - statusWidth - 8, nameLabel_->fontMetrics().horizontalAdvance(documentName_) + 6);
    nameLabel_->setGeometry(0, 0, qMax(0, nameWidth), 22);
    statusLabel_->setGeometry(nameWidth + 8, 0, statusWidth, 22);
  } else {
    nameLabel_->setGeometry(0, 0, identity_->width(), 17);
    statusLabel_->setGeometry(0, 18, identity_->width(), 14);
  }
  nameLabel_->setText(nameLabel_->fontMetrics().elidedText(documentName_.isEmpty() ? QStringLiteral("Vellora") : documentName_, Qt::ElideRight, nameLabel_->width()));
  statusLabel_->setText(statusLabel_->fontMetrics().elidedText(documentStatus_, Qt::ElideRight, statusLabel_->width()));
  mode_->raise();
}

void Toolbar::setDocumentName(const QString& name, const QString& status, bool unsaved) {
  documentName_ = name.isEmpty() ? QStringLiteral("Vellora") : name;
  documentStatus_ = (unsaved ? QStringLiteral("● ") : QString()) + status;
  nameLabel_->setToolTip(name);
  layoutControls();
  statusLabel_->setStyleSheet(QStringLiteral("color: %1; font-size: 11px;")
                                 .arg(theme::muted().name()));
  saveButton_->setProperty("primary", unsaved);
  saveButton_->setIcon(unsaved ? saveIconLight_
                               : (saveButton_->isEnabled() ? saveIconMuted_ : saveIconFaint_));
  saveButton_->style()->unpolish(saveButton_);
  saveButton_->style()->polish(saveButton_);
}

void Toolbar::setMode(int mode) { mode_->setCurrent(mode, false); }
void Toolbar::setBusy(bool busy) { busy_ = busy; updateAvailability(); }
void Toolbar::setDocumentAvailable(bool available) { documentAvailable_ = available; updateAvailability(); }
void Toolbar::updateAvailability() {
  openButton_->setEnabled(!busy_);
  const bool enabled = documentAvailable_ && !busy_;
  mode_->setEnabled(enabled);
  mode_->setCursor(enabled ? Qt::PointingHandCursor : Qt::ForbiddenCursor);
  searchButton_->setEnabled(enabled);
  outlineButton_->setEnabled(enabled);
}
void Toolbar::setSaveEnabled(bool enabled) {
  saveButton_->setEnabled(enabled);
  if (saveButton_->property("primary").toBool()) {
    saveButton_->setIcon(enabled ? saveIconLight_ : saveIconFaint_);
  } else {
    saveButton_->setIcon(enabled ? saveIconMuted_ : saveIconFaint_);
  }
}
void Toolbar::setOutlineChecked(bool checked) { outlineButton_->setChecked(checked); }
void Toolbar::setSearchChecked(bool checked) { searchButton_->setChecked(checked); }

// ---------------------------------------------------------------- ModalDialog

ModalDialog::ModalDialog(QWidget* parent, const QString& title, const QString& message,
                         const QString& primary, const QString& secondary, bool destructive)
    : QFrame(parent) {
  setObjectName("modal");
  setAttribute(Qt::WA_NoMousePropagation, true);
  setAttribute(Qt::WA_StyledBackground, true);
  setAttribute(Qt::WA_DeleteOnClose, false);
  setStyleSheet(QStringLiteral(
                    "#modal, #conflictModal { background: %1; border: 1px solid %2; border-radius: 16px; }"
                    "QLabel#title { color: %3; font-size: 16px; font-weight: 600; }"
                    "QLabel#message { color: %4; font-size: 14px; }"
                    "QPushButton { border: 1px solid %2; border-radius: 8px; height: 32px; padding: 0 12px;"
                    "  background: %1; color: %3; font-size: 13px; }"
                    "QPushButton:hover { background: rgba(11,11,11,0.05); }"
                    "QPushButton:focus { outline: 0; }"
                    "QPushButton[primary=\"true\"] { background: %3; color: %5; border-color: %3; }"
                    "QPushButton[primary=\"true\"]:hover { background: #2c2c2a; }"
                    "QPushButton[destructive=\"true\"] { color: #a33125; background: #faeeeb; border-color: transparent; }"
                    "QPushButton[destructive=\"true\"]:hover { background: #f5dfd9; }")
                    .arg(theme::raised().name(), theme::border().name(QColor::HexArgb), theme::text().name(),
                         theme::muted().name(), theme::raised().name()));

  auto* layout = new QVBoxLayout(this);
  layout->setContentsMargins(24, 24, 24, 24);
  layout->setSpacing(0);
  auto* titleLabel = new QLabel(title, this);
  titleLabel->setObjectName("title");
  titleLabel->setTextFormat(Qt::PlainText);
  titleLabel->setWordWrap(true);
  titleLabel->setSizePolicy(QSizePolicy::Ignored, QSizePolicy::Preferred);
  titleLabel->setMinimumHeight(24);
  layout->addWidget(titleLabel);
  layout->addSpacing(8);
  bodyScroll_ = new QScrollArea(this);
  bodyScroll_->setObjectName("modalBodyScroll");
  bodyScroll_->setFrameShape(QFrame::NoFrame);
  bodyScroll_->setWidgetResizable(true);
  bodyScroll_->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
  bodyScroll_->setStyleSheet(QStringLiteral(
      "QScrollArea, QScrollArea > QWidget > QWidget { background: transparent; border: 0; }"
      "QScrollBar:vertical { width: 10px; background: transparent; margin: 0; border: 0; }"
      "QScrollBar::handle:vertical { background: rgba(11,11,11,0.20); margin: 0 1px 0 5px; border-radius: 2px; min-height: 32px; }"
      "QScrollBar::handle:vertical:hover { background: rgba(11,11,11,0.35); }"
      "QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; border: 0; background: transparent; }"
      "QScrollBar::up-arrow:vertical, QScrollBar::down-arrow:vertical { width: 0; height: 0; background: transparent; }"
      "QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical { background: transparent; border: 0; }"
      "QScrollArea::corner { background: transparent; border: 0; }"));
  bodyText_ = new QWidget;
  bodyText_->setSizePolicy(QSizePolicy::Ignored, QSizePolicy::Preferred);
  bodyTextLayout_ = new QVBoxLayout(bodyText_);
  bodyTextLayout_->setContentsMargins(0, 0, 0, 0);
  bodyTextLayout_->setSpacing(0);
  auto* messageLabel = new QLabel(message, bodyText_);
  messageLabel->setObjectName("message");
  messageLabel->setTextFormat(Qt::PlainText);
  messageLabel->setWordWrap(true);
  messageLabel->setSizePolicy(QSizePolicy::Ignored, QSizePolicy::Preferred);
  messageLabel->setMinimumHeight(22);
  bodyTextLayout_->addWidget(messageLabel);
  bodyScroll_->setWidget(bodyText_);
  layout->addWidget(bodyScroll_);
  layout->addSpacing(32);

  auto* buttons = new QHBoxLayout();
  buttons->setSpacing(8);
  buttons->addStretch(1);
  if (!secondary.isEmpty()) {
    auto* secondaryButton = new QPushButton(secondary, this);
    secondaryButton->setFixedHeight(32);
    connect(secondaryButton, &QPushButton::clicked, this, [this] {
      result_ = 1;
      close();
    });
    buttons->addWidget(secondaryButton);
  }
  auto* primaryButton = new QPushButton(primary, this);
  primaryButton->setFixedHeight(32);
  primaryButton->setProperty("primary", true);
  if (destructive) primaryButton->setProperty("destructive", true);
  primaryButton->setDefault(true);
  connect(primaryButton, &QPushButton::clicked, this, [this] {
    result_ = 2;
    close();
  });
  buttons->addWidget(primaryButton);
  layout->addLayout(buttons);

  fitToParent();
  auto* shadow = new QGraphicsDropShadowEffect(this);
  shadow->setBlurRadius(48);
  shadow->setOffset(0, 16);
  shadow->setColor(QColor(0, 0, 0, 48));
  setGraphicsEffect(shadow);
}

void ModalDialog::fitToParent() {
  // Measure wrapped labels at the final card width, never QLabel's heuristic
  // preferred width (which differs between otherwise equivalent short prompts).
  ensurePolished();
  const int availableHeight = parentWidget() ? qMax(1, parentWidget()->height() - 32) : 800;
  const int cardWidth = parentWidget() ? qMin(440, qMax(1, parentWidget()->width() - 32)) : 440;
  setFixedWidth(cardWidth);
  auto* outer = qobject_cast<QVBoxLayout*>(layout());
  const int margin = availableHeight < 260 ? 12 : 24;
  outer->setContentsMargins(margin, margin, margin, margin);
  const int textWidth = qMax(1, cardWidth - 2 * margin - 2 * frameWidth());
  auto* title = findChild<QLabel*>("title");
  title->ensurePolished();
  // QLabel::heightForWidth includes its minimum height. Release the previous
  // measurement before measuring a shorter message or a newly wider card.
  title->setMinimumHeight(0);
  title->setMaximumHeight(QWIDGETSIZE_MAX);
  title->setFixedHeight(qMax(24, title->heightForWidth(textWidth)));
  auto* actions = qobject_cast<QBoxLayout*>(outer->itemAt(outer->count()-1)->layout());
  int buttonsWidth = 0, buttonsCount = 0;
  for (int i = 0; i < actions->count(); ++i) {
    if (auto* widget = actions->itemAt(i)->widget(); widget && !widget->isHidden()) {
      widget->ensurePolished(); buttonsWidth += widget->sizeHint().width(); ++buttonsCount;
      widget->installEventFilter(this);
    }
  }
  const bool stacked = buttonsWidth + qMax(0, buttonsCount-1) * actions->spacing() > textWidth;
  actions->setDirection(stacked ? QBoxLayout::TopToBottom : QBoxLayout::LeftToRight);
  const int actionHeight = stacked ? buttonsCount * 32 + qMax(0, buttonsCount-1) * actions->spacing() : 32;
  const int gap = availableHeight < 260 ? 16 : 32;
  outer->itemAt(outer->count()-2)->spacerItem()->changeSize(0, gap, QSizePolicy::Minimum, QSizePolicy::Fixed);
  const int fixedHeight = 2 * margin + 2 * frameWidth() + title->height() + 8 + gap + actionHeight;
  const int maximumBody = qMax(1, availableHeight - fixedHeight);
  auto measureBody = [&](int width) {
    int height = 0;
    for (auto* label : bodyText_->findChildren<QLabel*>(QString(), Qt::FindDirectChildrenOnly)) {
      if (label->isHidden()) continue;
      label->ensurePolished();
      label->setMinimumHeight(0);
      label->setMaximumHeight(QWIDGETSIZE_MAX);
      const int required = qMax(label->objectName() == "message" ? 22 : 0, label->heightForWidth(width));
      label->setFixedHeight(required);
      height += required;
    }
    return height;
  };
  int bodyHeight = measureBody(textWidth);
  const bool scroll = bodyHeight > maximumBody;
  if (scroll) {
    auto* bar = bodyScroll_->verticalScrollBar();
    bar->ensurePolished();
    bodyHeight = measureBody(qMax(1, textWidth - bar->sizeHint().width()));
  }
  bodyScroll_->setVerticalScrollBarPolicy(scroll ? Qt::ScrollBarAlwaysOn : Qt::ScrollBarAlwaysOff);
  bodyText_->setMinimumHeight(bodyHeight);
  bodyScroll_->setFixedHeight(qMin(bodyHeight, maximumBody));
  outer->invalidate();
  setFixedHeight(fixedHeight + bodyScroll_->height());
  outer->activate();
  if (parentWidget()) move(qMax(0, (parentWidget()->width()-width())/2),
                           qMax(0, (parentWidget()->height()-height())/2));
}

bool ModalDialog::scrollBodyForKey(QKeyEvent* event) {
  auto* bar = bodyScroll_->verticalScrollBar();
  if (property("conflictBusy").toBool() || bar->maximum() <= 0 || event->modifiers() != Qt::NoModifier) return false;
  QAbstractSlider::SliderAction action;
  switch (event->key()) {
    case Qt::Key_PageUp: action = QAbstractSlider::SliderPageStepSub; break;
    case Qt::Key_PageDown: action = QAbstractSlider::SliderPageStepAdd; break;
    case Qt::Key_Up: action = QAbstractSlider::SliderSingleStepSub; break;
    case Qt::Key_Down: action = QAbstractSlider::SliderSingleStepAdd; break;
    case Qt::Key_Home: action = QAbstractSlider::SliderToMinimum; break;
    case Qt::Key_End: action = QAbstractSlider::SliderToMaximum; break;
    default: return false;
  }
  bar->triggerAction(action);
  event->accept();
  return true;
}

bool ModalDialog::eventFilter(QObject* watched, QEvent* event) {
  // Buttons normally consume arrow keys to move focus. In a scrolling card,
  // route only these reading keys to its body and leave decisions untouched.
  if (event->type() == QEvent::KeyPress && scrollBodyForKey(static_cast<QKeyEvent*>(event))) return true;
  return QFrame::eventFilter(watched, event);
}

void ModalDialog::paintEvent(QPaintEvent* event) { QFrame::paintEvent(event); }

void ModalDialog::keyPressEvent(QKeyEvent* event) {
  if (property("conflictBusy").toBool()) { event->accept(); return; }
  if (scrollBodyForKey(event)) return;
  if (event->key() == Qt::Key_Escape) {
    result_ = 1;
    close();
    return;
  }
  if (event->key() == Qt::Key_Return || event->key() == Qt::Key_Enter) {
    if (auto* button = qobject_cast<QPushButton*>(QApplication::focusWidget())) {
      if (isAncestorOf(button)) { button->click(); return; }
    }
  }
  // Keep window shortcuts behind the modal inert.
  event->accept();
}

bool ModalDialog::focusNextPrevChild(bool next) {
  const auto buttons = findChildren<QPushButton*>();
  if (buttons.isEmpty()) return false;
  int current = buttons.indexOf(qobject_cast<QPushButton*>(QApplication::focusWidget()));
  for (int step = 1; step <= buttons.size(); ++step) {
    int index = (current + (next ? step : -step) + buttons.size() * 2) % buttons.size();
    if (buttons.at(index)->isEnabled() && buttons.at(index)->isVisible()) {
      buttons.at(index)->setFocus(next ? Qt::TabFocusReason : Qt::BacktabFocusReason);
      return true;
    }
  }
  return false;
}

void ModalDialog::closeEvent(QCloseEvent* event) {
  if (property("conflictBusy").toBool()) { event->ignore(); return; }
  QFrame::closeEvent(event);
  emit finished();
}

int ModalDialog::ask(QWidget* parent, const QString& title, const QString& message,
                     const QString& primary, const QString& secondary, bool destructive,
                     const QString& tertiary) {
  QWidget* host = parent != nullptr ? parent->window() : nullptr;
  auto* scrim = new Scrim(host);
  if (host != nullptr) scrim->setGeometry(host->rect());

  auto* dialog = new ModalDialog(scrim, title, message, primary, secondary, destructive);
  if (!tertiary.isEmpty()) {
    auto* layout = qobject_cast<QVBoxLayout*>(dialog->layout());
    if (layout != nullptr) {
      auto* row = qobject_cast<QHBoxLayout*>(layout->itemAt(layout->count() - 1)->layout());
      if (row != nullptr) {
        auto* tertiaryButton = new QPushButton(tertiary, dialog);
        tertiaryButton->setFixedHeight(32);
        QObject::connect(tertiaryButton, &QPushButton::clicked, dialog, [dialog] {
          dialog->result_ = 3;
          dialog->close();
        });
        row->insertWidget(0, tertiaryButton);
      }
    }
  }
  dialog->fitToParent();

  scrim->show();
  scrim->raise();
  QPointer<QWidget> previousFocus = QApplication::focusWidget();
  scrim->setFocus();
  dialog->show();
  dialog->raise();
  const auto buttons = dialog->findChildren<QPushButton*>();
  if (!buttons.isEmpty()) buttons.first()->setFocus(Qt::OtherFocusReason);

  QEventLoop loop;
  QObject::connect(dialog, &ModalDialog::finished, &loop, &QEventLoop::quit);
  scrim->onDismiss = [&loop, dialog] {
    dialog->result_ = 1;
    loop.quit();
  };
  loop.exec();

  int result = dialog->result_;
  if (result == 0) result = 1;
  scrim->hide();
  scrim->deleteLater();
  if (previousFocus) previousFocus->setFocus(Qt::OtherFocusReason);
  return result;
}

int ModalDialog::resolveConflict(QWidget* parent, QJsonObject conflict,
    const std::function<QJsonObject(bool, const QString&)>& resolve,
    const std::function<bool()>& current) {
  auto* host = parent ? parent->window() : nullptr;
  auto* scrim = new Scrim(host);
  if (host) scrim->setGeometry(host->rect());
  auto* dialog = new ModalDialog(scrim, QStringLiteral("文件已被外部修改"),
      conflict.value("message").toString(), QStringLiteral("覆盖外部版本"),
      QStringLiteral("继续编辑"), true);
  dialog->setObjectName(QStringLiteral("conflictModal"));
  dialog->setAccessibleName(QStringLiteral("文件已被外部修改"));
  auto* layout = qobject_cast<QVBoxLayout*>(dialog->layout());
  auto* row = qobject_cast<QHBoxLayout*>(layout->itemAt(layout->count()-1)->layout());
  const auto existing = dialog->findChildren<QPushButton*>();
  auto* cancel = existing.at(0);
  auto* confirm = existing.at(1);
  auto* reload = new QPushButton(QStringLiteral("重新加载"), dialog);
  reload->setFixedHeight(32);
  row->insertWidget(row->count()-1, reload);
  auto* message = dialog->findChild<QLabel*>(QStringLiteral("message"));
  auto* feedback = new QLabel(dialog->bodyText_);
  feedback->setObjectName(QStringLiteral("conflictError"));
  feedback->setTextFormat(Qt::PlainText);
  feedback->setWordWrap(true);
  feedback->setSizePolicy(QSizePolicy::Ignored, QSizePolicy::Preferred);
  feedback->setStyleSheet(QStringLiteral("color: #a33125; margin-top: 12px;"));
  feedback->hide();
  dialog->bodyTextLayout_->addWidget(feedback);
  QObject::disconnect(confirm, nullptr, dialog, nullptr);
  confirm->setDefault(false);
  int step = 0; // choose, overwrite, reload
  const auto arrange = [&] {
    dialog->fitToParent();
  };
  const auto choose = [&](int next) {
    step = next;
    feedback->clear(); feedback->hide();
    message->setText(step == 1 ? QStringLiteral("确认用当前草稿覆盖检测到的外部版本？")
        : step == 2 ? QStringLiteral("重新加载将放弃当前草稿，确认继续？")
        : conflict.value("message").toString());
    confirm->setText(step == 1 ? QStringLiteral("确认覆盖")
        : step == 2 ? QStringLiteral("放弃草稿并重新加载") : QStringLiteral("覆盖外部版本"));
    reload->setVisible(step == 0);
    arrange();
    cancel->setFocus(Qt::OtherFocusReason);
  };
  QObject::connect(reload, &QPushButton::clicked, dialog, [&] { choose(2); });
  QObject::connect(confirm, &QPushButton::clicked, dialog, [&] {
    if (dialog->property("conflictBusy").toBool()) return;
    if (!current()) { dialog->close(); return; }
    if (step == 0) { choose(1); return; }
    dialog->setProperty("conflictBusy", true);
    for (auto* button : dialog->findChildren<QPushButton*>()) button->setEnabled(false);
    // Publish the disabled state before invoking synchronous native I/O.
    QTimer::singleShot(0, dialog, [&] {
      const QJsonObject result = current() ? resolve(step == 2, conflict.value("conflictToken").toString()) : QJsonObject();
      dialog->setProperty("conflictBusy", false);
      if (!current() || result.value("ok").toBool()) {
        dialog->result_ = result.value("ok").toBool() ? (step == 2 ? 3 : 2) : 1;
        dialog->close();
        return;
      }
      for (auto* button : dialog->findChildren<QPushButton*>()) button->setEnabled(true);
      if (result.value("code").toString() == QStringLiteral("FILE_CHANGED")) {
        conflict = result;
        choose(0);
      } else {
        feedback->setText(result.value("message").toString());
        feedback->setAccessibleName(feedback->text());
        feedback->show();
        arrange();
      }
    });
  });
  QPointer<QWidget> previousFocus = QApplication::focusWidget();
  QEventLoop loop;
  QObject::connect(dialog, &ModalDialog::finished, &loop, &QEventLoop::quit);
  // Unlike discard prompts, clicking outside a conflict is not a choice.
  scrim->onDismiss = [dialog] {
    if (!dialog->property("conflictBusy").toBool() && QApplication::keyboardModifiers() == Qt::NoModifier) {
      // Escape is handled by the dialog; backdrop clicks deliberately do nothing.
      dialog->setFocus(Qt::OtherFocusReason);
    }
  };
  QTimer stale;
  QObject::connect(&stale, &QTimer::timeout, dialog, [&] {
    if (!current() && !dialog->property("conflictBusy").toBool()) dialog->close();
  });
  stale.start(40);
  scrim->show(); scrim->raise(); dialog->show(); dialog->raise(); choose(0);
  loop.exec();
  stale.stop();
  const int result = dialog->result_;
  scrim->hide();
  // Delete synchronously: callbacks above borrow this stack frame.
  delete scrim;
  if (previousFocus && current()) previousFocus->setFocus(Qt::OtherFocusReason);
  return result;
}
