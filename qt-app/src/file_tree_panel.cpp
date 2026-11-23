#include "file_tree_panel.h"

#include <utility>

#include <QAbstractFileIconProvider>
#include <QApplication>
#include <QClipboard>
#include <QDir>
#include <QFileInfo>
#include <QFileSystemModel>
#include <QGraphicsDropShadowEffect>
#include <QHBoxLayout>
#include <QHideEvent>
#include <QItemSelectionModel>
#include <QKeyEvent>
#include <QLabel>
#include <QLineEdit>
#include <QMenu>
#include <QPainter>
#include <QAction>
#include <QPushButton>
#include <QShowEvent>
#include <QStyle>
#include <QScrollBar>
#include <QSortFilterProxyModel>
#include <QStackedWidget>
#include <QStyleHints>
#include <QStyledItemDelegate>
#include <QSvgRenderer>
#include <QToolButton>
#include <QTreeView>
#include <QVBoxLayout>
#include <algorithm>

#include "chrome.h"
#include "theme.h"

#ifdef Q_OS_WIN
#include <qt_windows.h>

#include <string>
#endif

namespace {

constexpr int kRowHeight = 30;
constexpr int kIconInset = 4;
constexpr int kTextInset = kIconInset + 16 + 6;
constexpr int kGlyphFolder = 0;
constexpr int kGlyphFolderOpen = 1;
constexpr int kGlyphFile = 2;

Qt::CaseSensitivity pathCase() {
#ifdef Q_OS_WIN
  return Qt::CaseInsensitive;
#else
  return Qt::CaseSensitive;
#endif
}

QPixmap strokePixmap(const QString& body, const QColor& colour, int size = 16) {
  const QString svg = QStringLiteral(
                          "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' width='20' height='20'"
                          " fill='none' stroke='%1' stroke-width='1.5' stroke-linecap='round'"
                          " stroke-linejoin='round'>%2</svg>")
                          .arg(colour.name(), body);
  QSvgRenderer renderer(svg.toUtf8());
  QPixmap pixmap(size * 2, size * 2);
  pixmap.setDevicePixelRatio(2.0);
  pixmap.fill(Qt::transparent);
  QPainter painter(&pixmap);
  painter.setRenderHint(QPainter::Antialiasing, true);
  renderer.render(&painter, QRectF(0, 0, size, size));
  painter.end();
  return pixmap;
}

const char* const kFolderSvg = "<path d='M2.5 5.5a1 1 0 0 1 1-1h4l2 2h7a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1Z'/>";
const char* const kFolderOpenSvg = "<path d='M2.5 15V5.5a1 1 0 0 1 1-1h4l2 2h6a1 1 0 0 1 1 1V9'/><path d='M2.5 15.5 5 9.5h13l-2.5 6Z'/>";
const char* const kFileSvg = "<path d='M5.5 2.5h6l4 4v10a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Z'/><path d='M11.5 2.5v4h4'/>";

// The file-info thread asks the provider for icons. Shell icons are slow and a
// pixmap may not be created off the GUI thread, so the delegate paints glyphs.
class NoShellIcons final : public QAbstractFileIconProvider {
 public:
  QIcon icon(IconType) const override { return {}; }
  QIcon icon(const QFileInfo&) const override { return {}; }
};

// Hides dot-entries and hidden entries inside the root. The root's ancestors
// always pass so the root index stays reachable, even under a hidden folder.
class VisibleEntryFilter final : public QSortFilterProxyModel {
 public:
  using QSortFilterProxyModel::QSortFilterProxyModel;
  QString root;

 protected:
  bool filterAcceptsRow(int row, const QModelIndex& parent) const override {
    const auto* files = static_cast<const QFileSystemModel*>(sourceModel());
    const QModelIndex index = files->index(row, 0, parent);
    if (!index.isValid()) return false;
    if (!FileTreePanel::isInside(files->filePath(index), root)) return true;
    if (files->fileName(index).startsWith(QLatin1Char('.'))) return false;
    return !files->fileInfo(index).isHidden();
  }
};

class FileTreeDelegate final : public QStyledItemDelegate {
 public:
  explicit FileTreeDelegate(FileTreePanel* panel) : QStyledItemDelegate(panel), panel_(panel) {}

  QSize sizeHint(const QStyleOptionViewItem& option, const QModelIndex&) const override {
    return {option.rect.width(), kRowHeight};
  }

  void paint(QPainter* painter, const QStyleOptionViewItem& option, const QModelIndex& index) const override {
    painter->save();
    painter->setRenderHint(QPainter::Antialiasing, true);
    const QRect row = option.rect.adjusted(0, 1, -6, -1);
    const bool current = panel_->isCurrentIndex(index);
    const bool hovered = option.state.testFlag(QStyle::State_MouseOver);
    const bool keyboard = option.state.testFlag(QStyle::State_HasFocus) &&
                          option.state.testFlag(QStyle::State_Selected);
    QColor fill;
    if (current) fill = theme::pressed();
    else if (hovered || keyboard) fill = theme::hover();
    if (fill.isValid()) {
      painter->setPen(Qt::NoPen);
      painter->setBrush(fill);
      painter->drawRoundedRect(row, 6, 6);
    }
    if (keyboard) {
      painter->setBrush(Qt::NoBrush);
      painter->setPen(QPen(theme::focusRing(), 1));
      painter->drawRoundedRect(QRectF(row).adjusted(0.5, 0.5, -0.5, -0.5), 6, 6);
    }

    const bool directory = panel_->isDirectory(index);
    const int kind = directory ? (panel_->isExpandedIndex(index) ? kGlyphFolderOpen : kGlyphFolder) : kGlyphFile;
    painter->drawPixmap(QRect(row.left() + kIconInset, row.top() + (row.height() - 16) / 2, 16, 16),
                        panel_->glyph(kind));

    const QFont font = theme::uiFont(13, current ? QFont::Medium : QFont::Normal);
    painter->setFont(font);
    const QFontMetrics metrics(font);
    const bool dot = current && panel_->isCurrentDirty();
    const int left = row.left() + kTextInset;
    const QRect text(left, row.top(), qMax(0, row.right() - left - (dot ? 16 : 4)), row.height());
    const QString name = index.data(Qt::DisplayRole).toString();
    const int split = directory ? -1 : name.lastIndexOf(QLatin1Char('.'));
    if (split > 0 && metrics.horizontalAdvance(name) <= text.width()) {
      const QString base = name.left(split);
      painter->setPen(theme::text());
      painter->drawText(text, Qt::AlignLeft | Qt::AlignVCenter, base);
      painter->setPen(theme::faint());
      painter->drawText(text.adjusted(metrics.horizontalAdvance(base), 0, 0, 0), Qt::AlignLeft | Qt::AlignVCenter,
                        name.mid(split));
    } else {
      painter->setPen(theme::text());
      painter->drawText(text, Qt::AlignLeft | Qt::AlignVCenter,
                        metrics.elidedText(name, Qt::ElideMiddle, text.width()));
    }
    if (dot) {
      painter->setPen(Qt::NoPen);
      painter->setBrush(theme::muted());
      painter->drawEllipse(QPointF(row.right() - 9, row.top() + row.height() / 2.0), 3.5, 3.5);
    }
    painter->restore();
  }

 private:
  FileTreePanel* panel_;
};

QToolButton* headerButton(QWidget* parent, const QString& name, int extent = 24) {
  auto* button = new QToolButton(parent);
  button->setAccessibleName(name);
  button->setToolTip(name);
  button->setCursor(Qt::PointingHandCursor);
  button->setIconSize(QSize(14, 14));
  button->setFixedSize(extent, extent);
  return button;
}

}  // namespace

// ---------------------------------------------------------------- paths

QString FileTreePanel::normalizedPath(QString path) {
  if (path.startsWith(QLatin1String("\\\\?\\UNC\\"))) path = QStringLiteral("\\\\") + path.mid(8);
  else if (path.startsWith(QLatin1String("\\\\?\\"))) path = path.mid(4);
  if (path.isEmpty()) return {};
  return QDir::cleanPath(QDir::fromNativeSeparators(path));
}

QString FileTreePanel::expandedPath(const QString& path) {
  const QString normal = normalizedPath(path);
#ifdef Q_OS_WIN
  // GetLongPathNameW needs an existing path: expand the longest existing
  // prefix and keep the rest as written. A short name always contains '~', so
  // once the remaining prefix has none there is nothing left to expand.
  QString prefix = normal;
  QString rest;
  while (prefix.contains(QLatin1Char('~'))) {
    const std::wstring native = QDir::toNativeSeparators(prefix).toStdWString();
    const DWORD size = GetLongPathNameW(native.c_str(), nullptr, 0);
    if (size > 0) {
      std::wstring buffer(size, L'\0');
      const DWORD written = GetLongPathNameW(native.c_str(), buffer.data(), size);
      if (written > 0 && written < size) {
        buffer.resize(written);
        return normalizedPath(QString::fromStdWString(buffer) + rest);
      }
    }
    const int slash = prefix.lastIndexOf(QLatin1Char('/'));
    if (slash <= 0) break;
    rest.prepend(prefix.mid(slash));
    prefix.truncate(slash);
  }
#endif
  return normal;
}

bool FileTreePanel::samePath(const QString& a, const QString& b) {
  const QString left = normalizedPath(a);
  return !left.isEmpty() && left.compare(normalizedPath(b), pathCase()) == 0;
}

bool FileTreePanel::isInside(const QString& child, const QString& parent) {
  const QString base = normalizedPath(parent);
  if (base.isEmpty()) return false;
  const QString prefix = base.endsWith(QLatin1Char('/')) ? base : base + QLatin1Char('/');
  const QString candidate = normalizedPath(child);
  return candidate.size() > prefix.size() && candidate.startsWith(prefix, pathCase());
}

// ---------------------------------------------------------------- panel

FileTreePanel::FileTreePanel(QWidget* parent) : QFrame(parent), icons_(new NoShellIcons) {
  setObjectName(QStringLiteral("fileTreePanel"));
  setAccessibleName(QStringLiteral("文件"));
  setAttribute(Qt::WA_StyledBackground, true);

  auto* layout = new QVBoxLayout(this);
  layout->setContentsMargins(0, 0, 0, 0);
  layout->setSpacing(4);

  header_ = new QWidget(this);
  header_->setFixedHeight(32);
  auto* headerLayout = new QHBoxLayout(header_);
  headerLayout->setContentsMargins(8, 0, 12, 0);
  headerLayout->setSpacing(2);
  titleLabel_ = new QLabel(QStringLiteral("文件"), header_);
  titleLabel_->setTextFormat(Qt::PlainText);
  titleLabel_->setMinimumWidth(0);
  titleLabel_->setSizePolicy(QSizePolicy::Ignored, QSizePolicy::Preferred);
  headerLayout->addWidget(titleLabel_, 1);
  newButton_ = headerButton(header_, QStringLiteral("新建 Markdown 文件"));
  folderButton_ = headerButton(header_, QStringLiteral("打开文件夹"));
  collapseButton_ = headerButton(header_, QStringLiteral("全部折叠"));
  for (auto* button : {newButton_, folderButton_, collapseButton_}) headerLayout->addWidget(button);
  layout->addWidget(header_);

  tree_ = new QTreeView(this);
  tree_->setObjectName(QStringLiteral("fileTree"));
  tree_->setAccessibleName(QStringLiteral("文件列表"));
  tree_->setHeaderHidden(true);
  tree_->setIndentation(14);
  tree_->setUniformRowHeights(true);
  tree_->setAnimated(false);
  tree_->setExpandsOnDoubleClick(false);
  tree_->setMouseTracking(true);
  tree_->setFrameShape(QFrame::NoFrame);
  tree_->setSelectionMode(QAbstractItemView::SingleSelection);
  tree_->setEditTriggers(QAbstractItemView::NoEditTriggers);
  tree_->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
  tree_->setContextMenuPolicy(Qt::CustomContextMenu);
  tree_->setItemDelegate(new FileTreeDelegate(this));
  tree_->installEventFilter(this);
  tree_->viewport()->installEventFilter(this);
  layout->addWidget(tree_, 1);

  empty_ = new QWidget(this);
  auto* emptyLayout = new QVBoxLayout(empty_);
  emptyLayout->setContentsMargins(8, 8, 12, 8);
  emptyLayout->setSpacing(10);
  emptyLabel_ = new QLabel(QStringLiteral("还没有打开文件夹。"), empty_);
  emptyLabel_->setWordWrap(true);
  emptyButton_ = new QPushButton(QStringLiteral("打开文件夹"), empty_);
  emptyButton_->setCursor(Qt::PointingHandCursor);
  emptyButton_->setFixedHeight(32);
  emptyHint_ = new QLabel(QStringLiteral("也可以把文件夹拖进窗口。打开文件时会自动显示它所在的文件夹。"), empty_);
  emptyHint_->setWordWrap(true);
  emptyLayout->addWidget(emptyLabel_);
  emptyLayout->addWidget(emptyButton_, 0, Qt::AlignLeft);
  emptyLayout->addWidget(emptyHint_);
  emptyLayout->addStretch(1);
  layout->addWidget(empty_, 1);

  connect(newButton_, &QToolButton::clicked, this, [this] {
    emit newFileRequested(targetDirectory(tree_->currentIndex()));
  });
  connect(folderButton_, &QToolButton::clicked, this, &FileTreePanel::openFolderRequested);
  connect(emptyButton_, &QPushButton::clicked, this, &FileTreePanel::openFolderRequested);
  connect(collapseButton_, &QToolButton::clicked, this, [this] {
    cancelRename();
    tree_->collapseAll();
    expanded_.clear();
  });
  connect(tree_, &QTreeView::clicked, this, [this](const QModelIndex& index) {
    if (std::exchange(pressOnBranch_, false)) return;
    activate(index, true);
  });
  connect(tree_, &QTreeView::customContextMenuRequested, this, &FileTreePanel::showContextMenu);
  connect(tree_, &QTreeView::expanded, this, [this](const QModelIndex& index) {
    expanded_.insert(pathForIndex(index));
    QTimer::singleShot(0, this, &FileTreePanel::positionRenameEditor);
  });
  connect(tree_, &QTreeView::collapsed, this, [this](const QModelIndex& index) {
    expanded_.remove(pathForIndex(index));
    QTimer::singleShot(0, this, &FileTreePanel::positionRenameEditor);
  });
  connect(tree_->verticalScrollBar(), &QScrollBar::valueChanged, this, &FileTreePanel::positionRenameEditor);
  renameTimer_.setInterval(50);
  connect(&renameTimer_, &QTimer::timeout, this, &FileTreePanel::tryBeginRename);

  applyTheme();
  if (auto* hints = QGuiApplication::styleHints()) {
    connect(hints, &QStyleHints::colorSchemeChanged, this, &FileTreePanel::applyTheme);
  }
  refreshHeader();
}

FileTreePanel::~FileTreePanel() {
  renameTimer_.stop();
  if (renameEditor_) renameEditor_->removeEventFilter(this);
  releaseModel();
  delete icons_;
}

void FileTreePanel::applyTheme() {
  const QString hover = theme::rgbaCss(theme::hover());
  // The sidebar paints the column; the panel only lays out its rows.
  const QString panel = QStringLiteral("#fileTreePanel { background: transparent; border: 0; }");
  setStyleSheet(panel + QStringLiteral(
      "QToolButton { border: 0; border-radius: 6px; background: transparent; color: %1; font-size: 16px; }"
      "QToolButton:hover:enabled { background: %2; }"
      "QToolButton:focus { outline: 0; }"
      "QTreeView { background: transparent; border: 0; outline: 0; }"
      "QTreeView::item { border: 0; }"
      "QTreeView::item:hover, QTreeView::item:selected { background: transparent; }"
      "QScrollBar:vertical { width: 10px; background: transparent; margin: 0; border: 0; }"
      "QScrollBar::handle:vertical { background: %3; margin: 0 1px 0 5px; border-radius: 2px; min-height: 32px; }"
      "QScrollBar::handle:vertical:hover { background: %4; }"
      "QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; border: 0; background: transparent; }"
      "QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical { background: transparent; border: 0; }"
      "QLineEdit#fileTreeRenameEditor { border: 1px solid %5; border-radius: 6px; padding: 0 5px;"
      "  background: %6; color: %7; font-size: 13px; }")
      .arg(theme::muted().name(), hover, theme::rgbaCss(theme::scrollbarThumb()),
           theme::rgbaCss(theme::scrollbarThumbHover()), theme::focusRing().name(), theme::raised().name(),
           theme::text().name()));
  titleLabel_->setStyleSheet(QStringLiteral("color: %1; font-size: 12px;").arg(theme::muted().name()));
  emptyLabel_->setStyleSheet(QStringLiteral("color: %1; font-size: 13px;").arg(theme::muted().name()));
  emptyHint_->setStyleSheet(QStringLiteral("color: %1; font-size: 12px;").arg(theme::faint().name()));
  emptyButton_->setStyleSheet(QStringLiteral(
      "QPushButton { border: 1px solid %1; border-radius: 8px; padding: 0 12px; background: transparent;"
      "  color: %2; font-size: 13px; }"
      "QPushButton:hover { background: %3; }"
      "QPushButton:focus { outline: 0; border-color: %4; }")
      .arg(theme::rgbaCss(theme::borderStrong()), theme::text().name(), hover, theme::focusRing().name()));
  newButton_->setIcon(QIcon(strokePixmap(QStringLiteral("<path d='M10 4.5v11M4.5 10h11'/>"), theme::muted())));
  folderButton_->setIcon(QIcon(strokePixmap(QString::fromLatin1(kFolderOpenSvg), theme::muted())));
  collapseButton_->setIcon(QIcon(strokePixmap(QStringLiteral("<path d='M6 8l4-4 4 4M6 16l4-4 4 4'/>"), theme::muted())));
  glyphs_[kGlyphFolder] = strokePixmap(QString::fromLatin1(kFolderSvg), theme::muted());
  glyphs_[kGlyphFolderOpen] = strokePixmap(QString::fromLatin1(kFolderOpenSvg), theme::muted());
  glyphs_[kGlyphFile] = strokePixmap(QString::fromLatin1(kFileSvg), theme::faint());
  tree_->viewport()->update();
  update();
}

const QPixmap& FileTreePanel::glyph(int kind) const { return glyphs_[qBound(0, kind, 2)]; }

void FileTreePanel::focusTree() {
  if (rootPath_.isEmpty()) emptyButton_->setFocus(Qt::OtherFocusReason);
  else tree_->setFocus(Qt::OtherFocusReason);
}

void FileTreePanel::refreshHeader() {
  const bool open = !rootPath_.isEmpty();
  if (open) {
    const QString name = QFileInfo(rootPath_).fileName();
    titleLabel_->setText(name.isEmpty() ? QDir::toNativeSeparators(rootPath_) : name);
    titleLabel_->setToolTip(QDir::toNativeSeparators(rootPath_));
  } else {
    titleLabel_->setText(QStringLiteral("文件"));
    titleLabel_->setToolTip(QString());
  }
  newButton_->setVisible(open);
  collapseButton_->setVisible(open);
  tree_->setVisible(open);
  empty_->setVisible(!open);
}

// ---------------------------------------------------------------- model

void FileTreePanel::releaseModel() {
  cancelRename();
  if (!model_) return;
  QItemSelectionModel* selection = tree_->selectionModel();
  tree_->setModel(nullptr);
  delete selection;
  // Deleting the model stops its file-info thread and closes every directory
  // watch before this returns.
  delete std::exchange(proxy_, nullptr);
  delete std::exchange(model_, nullptr);
}

void FileTreePanel::rebuildModel() {
  releaseModel();
  if (rootPath_.isEmpty()) return;
  model_ = new QFileSystemModel(this);
  model_->setIconProvider(icons_);
  model_->setOption(QFileSystemModel::DontUseCustomDirectoryIcons);
  model_->setReadOnly(true);
  model_->setFilter(QDir::AllDirs | QDir::Files | QDir::NoDotAndDotDot | QDir::Hidden);
  model_->setNameFilters({QStringLiteral("*.md"), QStringLiteral("*.markdown")});
  model_->setNameFilterDisables(false);
  auto* filter = new VisibleEntryFilter(this);
  filter->root = rootPath_;
  filter->setSourceModel(model_);
  proxy_ = filter;
  QItemSelectionModel* previous = tree_->selectionModel();
  tree_->setModel(proxy_);
  delete previous;
  for (int column = 1; column < model_->columnCount(); ++column) tree_->setColumnHidden(column, true);
  const QModelIndex root = model_->setRootPath(rootPath_);
  model_->sort(0, Qt::AscendingOrder);
  tree_->setRootIndex(proxy_->mapFromSource(root));
  connect(model_, &QFileSystemModel::directoryLoaded, this, [this](const QString& path) {
    if (pendingScroll_ >= 0 && samePath(path, rootPath_)) {
      tree_->verticalScrollBar()->setValue(std::exchange(pendingScroll_, -1));
    }
    positionRenameEditor();
  });
  connect(proxy_, &QAbstractItemModel::rowsInserted, this, [this] {
    QTimer::singleShot(0, this, &FileTreePanel::positionRenameEditor);
  });
  connect(proxy_, &QAbstractItemModel::rowsRemoved, this, [this] {
    QTimer::singleShot(0, this, &FileTreePanel::positionRenameEditor);
  });
  connect(proxy_, &QAbstractItemModel::layoutChanged, this, [this] {
    QTimer::singleShot(0, this, &FileTreePanel::positionRenameEditor);
  });
  restoreExpanded();
  if (revealPending_.isEmpty() && isInside(currentFile_, rootPath_)) revealPending_ = currentFile_;
  applyReveal();
}

void FileTreePanel::restoreExpanded() {
  QStringList paths(expanded_.cbegin(), expanded_.cend());
  std::sort(paths.begin(), paths.end(), [](const QString& a, const QString& b) { return a.size() < b.size(); });
  for (const QString& path : paths) {
    const QModelIndex index = indexForPath(path);
    if (index.isValid() && isDirectory(index)) tree_->expand(index);
    else expanded_.remove(path);
  }
}

void FileTreePanel::setRootPath(const QString& path) {
  // Model paths are built on this root, so it must use the core's long names.
  const QString root = expandedPath(path);
  if (root == rootPath_) return;
  rootPath_ = root;
  expanded_.clear();
  pendingScroll_ = -1;
  revealPending_.clear();
  if (isVisible()) rebuildModel();
  else releaseModel();
  refreshHeader();
}

void FileTreePanel::showEvent(QShowEvent* event) {
  QFrame::showEvent(event);
  if (!model_ && !rootPath_.isEmpty()) rebuildModel();
}

void FileTreePanel::hideEvent(QHideEvent* event) {
  QFrame::hideEvent(event);
  // A minimised window keeps its listing; only a real hide releases it.
  if (event->spontaneous() || (window() && window()->isMinimized()) || !model_) return;
  pendingScroll_ = tree_->verticalScrollBar()->value();
  releaseModel();
}

void FileTreePanel::suspendWatching() {
  if (!model_) return;
  pendingScroll_ = tree_->verticalScrollBar()->value();
  releaseModel();
}

void FileTreePanel::resumeWatching(const QString& renamedFrom, const QString& renamedTo) {
  const QString from = expandedPath(renamedFrom);
  const QString to = expandedPath(renamedTo);
  if (!from.isEmpty() && !to.isEmpty()) {
    const auto rebase = [&](const QString& path) {
      if (samePath(path, from)) return to;
      if (isInside(path, from)) return QString(to + path.mid(from.size()));
      return path;
    };
    QSet<QString> rebased;
    for (const QString& path : std::as_const(expanded_)) rebased.insert(rebase(path));
    expanded_ = rebased;
    rootPath_ = rebase(rootPath_);
    currentFile_ = rebase(currentFile_);
  }
  if (isVisible() && !rootPath_.isEmpty()) rebuildModel();
  refreshHeader();
}

QModelIndex FileTreePanel::indexForPath(const QString& path) const {
  if (!model_ || !proxy_) return {};
  const QString normal = normalizedPath(path);
  if (samePath(normal, rootPath_)) return tree_->rootIndex();
  if (!isInside(normal, rootPath_)) return {};
  return proxy_->mapFromSource(model_->index(normal));
}

QString FileTreePanel::pathForIndex(const QModelIndex& index) const {
  if (!model_ || !proxy_ || !index.isValid()) return {};
  return normalizedPath(model_->filePath(proxy_->mapToSource(index)));
}

bool FileTreePanel::isDirectory(const QModelIndex& index) const {
  return model_ && proxy_ && index.isValid() && model_->isDir(proxy_->mapToSource(index));
}

bool FileTreePanel::isExpandedIndex(const QModelIndex& index) const { return tree_->isExpanded(index); }

bool FileTreePanel::isCurrentIndex(const QModelIndex& index) const {
  return !currentFile_.isEmpty() && samePath(pathForIndex(index), currentFile_);
}

QStringList FileTreePanel::visibleChildNames(const QString& directory) const {
  QStringList names;
  const QModelIndex parent = indexForPath(directory);
  if (!proxy_ || !parent.isValid()) return names;
  for (int row = 0; row < proxy_->rowCount(parent); ++row) {
    names << proxy_->index(row, 0, parent).data(Qt::DisplayRole).toString();
  }
  return names;
}

void FileTreePanel::expandAncestors(const QString& path) {
  QStringList chain;
  for (QString folder = QFileInfo(normalizedPath(path)).absolutePath(); isInside(folder, rootPath_);
       folder = QFileInfo(folder).absolutePath()) {
    chain.prepend(folder);
  }
  for (const QString& folder : chain) {
    const QModelIndex index = indexForPath(folder);
    if (index.isValid()) tree_->expand(index);
  }
}

void FileTreePanel::revealFile(const QString& path) {
  const QString file = expandedPath(path);
  if (file.isEmpty()) return;
  if (rootPath_.isEmpty()) {
    setRootPath(QFileInfo(file).absolutePath());
  } else if (!isInside(file, rootPath_)) {
    // Opened from elsewhere (Ctrl+O, a drop, another window): keep the folder.
    revealPending_.clear();
    return;
  }
  revealPending_ = file;
  applyReveal();
}

void FileTreePanel::applyReveal() {
  if (!model_ || revealPending_.isEmpty()) return;
  const QString file = std::exchange(revealPending_, QString());
  expandAncestors(file);
  QTimer::singleShot(0, this, [this, file] {
    const QModelIndex index = indexForPath(file);
    if (index.isValid()) {
      tree_->setCurrentIndex(index);
      tree_->scrollTo(index);
    }
  });
}

void FileTreePanel::setCurrentFile(const QString& path, bool dirty) {
  const QString file = normalizedPath(path);
  if (file == currentFile_ && dirty == currentDirty_) return;
  currentFile_ = file;
  currentDirty_ = dirty;
  tree_->viewport()->update();
}

// ---------------------------------------------------------------- interaction

void FileTreePanel::activate(const QModelIndex& index, bool fromMouse) {
  if (!index.isValid()) return;
  if (isDirectory(index)) {
    // The second press of a double click must not undo the first toggle.
    if (fromMouse && lastToggle_ == index && lastToggleClock_.isValid() &&
        lastToggleClock_.elapsed() < QGuiApplication::styleHints()->mouseDoubleClickInterval()) {
      return;
    }
    lastToggle_ = index;
    lastToggleClock_.restart();
    tree_->setExpanded(index, !tree_->isExpanded(index));
    return;
  }
  emit fileActivated(pathForIndex(index));
}

QString FileTreePanel::targetDirectory(const QModelIndex& index) const {
  if (!index.isValid()) return rootPath_;
  const QString path = pathForIndex(index);
  return isDirectory(index) ? path : QFileInfo(path).absolutePath();
}

void FileTreePanel::showContextMenu(const QPoint& position) {
  if (rootPath_.isEmpty()) return;
  const QModelIndex index = tree_->indexAt(position);
  const QString path = index.isValid() ? pathForIndex(index) : rootPath_;
  QMenu menu(this);
  menu.setObjectName(QStringLiteral("fileTreeMenu"));
  menu.setStyleSheet(QStringLiteral(
      "QMenu { background: %1; border: 1px solid %2; border-radius: 8px; padding: 4px; color: %3; font-size: 13px; }"
      "QMenu::item { padding: 6px 24px 6px 12px; border-radius: 6px; }"
      "QMenu::item:selected { background: %4; }"
      "QMenu::separator { height: 1px; background: %2; margin: 4px 8px; }")
      .arg(theme::raised().name(), theme::rgbaCss(theme::border()), theme::text().name(),
           theme::rgbaCss(theme::hover())));
  QAction* create = menu.addAction(QStringLiteral("新建 Markdown 文件"));
  QAction* rename = nullptr;
  if (index.isValid()) {
    rename = menu.addAction(QStringLiteral("重命名"));
    rename->setShortcut(QKeySequence(Qt::Key_F2));
  }
  menu.addSeparator();
  QAction* copy = menu.addAction(QStringLiteral("复制路径"));
  QAction* chosen = menu.exec(tree_->viewport()->mapToGlobal(position));
  if (chosen == create) emit newFileRequested(targetDirectory(index));
  else if (chosen && chosen == rename) beginRename(path);
  else if (chosen == copy) QGuiApplication::clipboard()->setText(QDir::toNativeSeparators(path));
}

bool FileTreePanel::eventFilter(QObject* watched, QEvent* event) {
  if (watched == tree_->viewport()) {
    if (event->type() == QEvent::MouseButtonPress) {
      const auto* mouse = static_cast<const QMouseEvent*>(event);
      const QModelIndex index = tree_->indexAt(mouse->pos());
      pressOnBranch_ =
          index.isValid() && isDirectory(index) && mouse->pos().x() < tree_->visualRect(index).left();
    } else if (event->type() == QEvent::MouseButtonRelease) {
      QTimer::singleShot(0, this, [this] { pressOnBranch_ = false; });
    }
    return QFrame::eventFilter(watched, event);
  }
  if (watched == renameEditor_) {
    if (event->type() == QEvent::KeyPress) {
      const auto* key = static_cast<QKeyEvent*>(event);
      if (key->key() == Qt::Key_Escape) { cancelRename(true); return true; }
      if (key->key() == Qt::Key_Return || key->key() == Qt::Key_Enter) { commitRename(true); return true; }
    } else if (event->type() == QEvent::FocusOut) {
      const auto* focus = static_cast<const QFocusEvent*>(event);
      if (focus->reason() != Qt::PopupFocusReason && focus->reason() != Qt::ActiveWindowFocusReason) {
        commitRename(false);
      }
    }
    return QFrame::eventFilter(watched, event);
  }
  if (watched == tree_ && event->type() == QEvent::KeyPress) {
    const auto* key = static_cast<QKeyEvent*>(event);
    if (key->modifiers() == Qt::NoModifier || key->modifiers() == Qt::KeypadModifier) {
      if (key->key() == Qt::Key_Return || key->key() == Qt::Key_Enter) {
        activate(tree_->currentIndex(), false);
        return true;
      }
      if (key->key() == Qt::Key_F2 && tree_->currentIndex().isValid()) {
        beginRename(pathForIndex(tree_->currentIndex()));
        return true;
      }
    }
  }
  return QFrame::eventFilter(watched, event);
}

// ---------------------------------------------------------------- rename

void FileTreePanel::beginRename(const QString& path) {
  cancelRename();
  pendingRename_ = expandedPath(path);
  renameAttempts_ = 0;
  if (pendingRename_.isEmpty()) return;
  renameTimer_.start();
  tryBeginRename();
}

void FileTreePanel::tryBeginRename() {
  if (pendingRename_.isEmpty()) { renameTimer_.stop(); return; }
  // The model lists a new or renamed entry asynchronously; give up after ~3 s.
  if (++renameAttempts_ > 60) { pendingRename_.clear(); renameTimer_.stop(); return; }
  const QModelIndex index = indexForPath(pendingRename_);
  if (!index.isValid() || !isVisible()) return;
  expandAncestors(pendingRename_);
  tree_->scrollTo(index);
  const QRect rect = tree_->visualRect(index);
  if (!rect.isValid() || rect.isEmpty()) return;
  renameTimer_.stop();
  openRenameEditor(index, std::exchange(pendingRename_, QString()));
}

void FileTreePanel::openRenameEditor(const QModelIndex& index, const QString& path) {
  renamePath_ = path;
  renameIndex_ = QPersistentModelIndex(index);
  tree_->setCurrentIndex(index);
  renameEditor_ = new QLineEdit(tree_->viewport());
  renameEditor_->setObjectName(QStringLiteral("fileTreeRenameEditor"));
  renameEditor_->setAccessibleName(QStringLiteral("重命名"));
  const QString name = QFileInfo(path).fileName();
  renameEditor_->setText(name);
  const int dot = isDirectory(index) ? -1 : name.lastIndexOf(QLatin1Char('.'));
  renameEditor_->setSelection(0, dot > 0 ? dot : name.size());
  renameEditor_->installEventFilter(this);
  positionRenameEditor();
  renameEditor_->show();
  renameEditor_->setFocus(Qt::OtherFocusReason);
}

void FileTreePanel::positionRenameEditor() {
  if (!renameEditor_) return;
  if (!renameIndex_.isValid()) { cancelRename(); return; }
  const QRect rect = tree_->visualRect(renameIndex_);
  if (rect.isEmpty()) { renameEditor_->hide(); return; }
  renameEditor_->setGeometry(rect.left() + kTextInset - 6, rect.top() + 2,
                             qMax(64, rect.width() - kTextInset), rect.height() - 4);
  renameEditor_->show();
}

void FileTreePanel::commitRename(bool refocus) {
  if (!renameEditor_) return;
  const QString path = std::exchange(renamePath_, QString());
  const QString name = renameEditor_->text();
  closeRenameEditor(refocus);
  if (path.isEmpty() || name.trimmed().isEmpty() || name == QFileInfo(path).fileName()) return;
  emit renameRequested(path, name);
}

void FileTreePanel::cancelRename(bool refocus) {
  pendingRename_.clear();
  renameTimer_.stop();
  renamePath_.clear();
  closeRenameEditor(refocus);
}

void FileTreePanel::closeRenameEditor(bool refocus) {
  renameIndex_ = QPersistentModelIndex();
  QLineEdit* editor = std::exchange(renameEditor_, nullptr);
  if (!editor) return;
  editor->removeEventFilter(this);
  editor->hide();
  editor->deleteLater();
  if (refocus) tree_->setFocus(Qt::OtherFocusReason);
}

// ---------------------------------------------------------------- sidebar

SidePanel::SidePanel(QWidget* parent) : QFrame(parent) {
  setObjectName(QStringLiteral("sidePanel"));
  setAccessibleName(QStringLiteral("侧边栏"));
  setAttribute(Qt::WA_StyledBackground, true);
  setFixedWidth(232);

  auto* layout = new QVBoxLayout(this);
  layout->setContentsMargins(8, 10, 0, 12);
  layout->setSpacing(6);

  auto* header = new QWidget(this);
  header->setFixedHeight(28);
  auto* row = new QHBoxLayout(header);
  row->setContentsMargins(2, 0, 12, 0);
  row->setSpacing(2);
  const auto makeTab = [header, row](const QString& text) {
    auto* tab = new QToolButton(header);
    tab->setObjectName(QStringLiteral("sideTab"));
    tab->setText(text);
    tab->setAccessibleName(text);
    tab->setCheckable(true);
    tab->setAutoExclusive(true);
    tab->setToolButtonStyle(Qt::ToolButtonTextOnly);
    tab->setFixedHeight(26);
    tab->setCursor(Qt::PointingHandCursor);
    tab->setFocusPolicy(Qt::TabFocus);
    row->addWidget(tab);
    return tab;
  };
  filesTab_ = makeTab(QStringLiteral("文件"));
  outlineTab_ = makeTab(QStringLiteral("大纲"));
  row->addStretch(1);
  closeButton_ = headerButton(header, QStringLiteral("关闭侧边栏"), 26);
  closeButton_->setObjectName(QStringLiteral("sideClose"));
  row->addWidget(closeButton_);
  layout->addWidget(header);

  stack_ = new QStackedWidget(this);
  files_ = new FileTreePanel(stack_);
  outline_ = new OutlinePanel(stack_);
  outline_->setEmbedded(true);
  stack_->addWidget(files_);
  stack_->addWidget(outline_);
  layout->addWidget(stack_, 1);

  connect(filesTab_, &QToolButton::clicked, this, [this] {
    preferred_ = Files;
    showTab(Files);
    emit tabChosen(Files);
  });
  connect(outlineTab_, &QToolButton::clicked, this, [this] {
    preferred_ = Outline;
    showTab(Outline);
    emit tabChosen(Outline);
  });
  connect(closeButton_, &QToolButton::clicked, this, &SidePanel::closeRequested);

  applyTheme();
  if (auto* hints = QGuiApplication::styleHints()) {
    connect(hints, &QStyleHints::colorSchemeChanged, this, &SidePanel::applyTheme);
  }
  refreshTabs();
}

SidePanel::Tab SidePanel::currentTab() const {
  return stack_->currentWidget() == outline_ ? Outline : Files;
}

void SidePanel::setCurrentTab(Tab tab) {
  preferred_ = tab;
  showTab(tab);
}

void SidePanel::setOutlineAvailable(bool available) {
  if (outlineAvailable_ == available) return;
  outlineAvailable_ = available;
  showTab(preferred_);
}

void SidePanel::showTab(Tab tab) {
  const Tab shown = tab == Outline && outlineAvailable_ ? Outline : Files;
  const bool changed = currentTab() != shown;
  stack_->setCurrentWidget(shown == Outline ? static_cast<QWidget*>(outline_) : files_);
  refreshTabs();
  if (changed) emit currentTabChanged(shown);
}

void SidePanel::refreshTabs() {
  outlineTab_->setEnabled(outlineAvailable_);
  outlineTab_->setToolTip(outlineAvailable_ ? QString() : QStringLiteral("打开文档后可查看大纲"));
  (currentTab() == Outline ? outlineTab_ : filesTab_)->setChecked(true);
}

void SidePanel::focusCurrent() {
  if (currentTab() == Files) files_->focusTree();
  else outlineTab_->setFocus(Qt::OtherFocusReason);
}

void SidePanel::setFloating(bool floating) {
  if (floating_ == floating) return;
  floating_ = floating;
  setFixedWidth(floating ? 248 : 232);
  // Same surface as the original floating outline: shadow and enter motion.
  setGraphicsEffect(floating ? createSurfaceEnterEffect(this) : nullptr);
  applyTheme();
}

void SidePanel::applyTheme() {
  const QString border = theme::rgbaCss(theme::border());
  const QString hover = theme::rgbaCss(theme::hover());
  const QString panel = floating_
      ? QStringLiteral("#sidePanel { background: %1; border: 1px solid %2; border-radius: 12px; }")
            .arg(theme::raised().name(), border)
      : QStringLiteral("#sidePanel { background: %1; border: 0; border-right: 1px solid %2; border-radius: 0; }")
            .arg(theme::bg().name(), border);
  setStyleSheet(panel + QStringLiteral(
      "QToolButton#sideTab { border: 1px solid transparent; border-radius: 6px; background: transparent;"
      "  color: %1; padding: 0 10px; font-size: 12px; }"
      "QToolButton#sideTab:hover:enabled { background: %2; }"
      "QToolButton#sideTab:checked { background: %3; color: %4; font-weight: 500; }"
      "QToolButton#sideTab:disabled { color: %5; }"
      "QToolButton#sideTab:focus { outline: 0; border-color: %6; }"
      "QToolButton#sideClose { border: 0; border-radius: 6px; background: transparent; }"
      "QToolButton#sideClose:hover { background: %2; }"
      "QToolButton#sideClose:focus { outline: 0; }")
      .arg(theme::muted().name(), hover, theme::rgbaCss(theme::pressed()), theme::text().name(),
           theme::disabled().name(), theme::focusRing().name()));
  closeButton_->setIcon(QIcon(strokePixmap(QStringLiteral("<path d='M5.5 5.5l9 9M14.5 5.5l-9 9'/>"), theme::muted())));
  if (auto* effect = qobject_cast<QGraphicsDropShadowEffect*>(graphicsEffect())) effect->setColor(theme::shadowColor());
  update();
}
