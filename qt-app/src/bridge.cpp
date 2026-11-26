#include "bridge.h"

#include <cstddef>
#include <cstdint>
#include <utility>

#include <string>

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>

#ifdef Q_OS_WIN
#include <qt_windows.h>
#include <shellapi.h>
#include <shobjidl.h>
#endif

#if defined(Q_OS_WIN) && !defined(FOFX_RECYCLEONDELETE)
// Windows 8 and later; older SDK headers omit it.
#define FOFX_RECYCLEONDELETE 0x00080000
#endif

extern "C" {
char* vellora_open(const char* path);
char* vellora_plan_n(const uint8_t* content, size_t contentLen);
char* vellora_save_n(const char* path, const uint8_t* content, size_t contentLen, const char* token);
char* vellora_image_read(const char* documentPath, const char* src, uint8_t** data, size_t* len);
void vellora_free_bytes(uint8_t* data, size_t len);
char* vellora_image_stat(const char* documentPath, const char* src);
char* vellora_image(const char* documentPath, const char* src);
char* vellora_inspect_link(const char* documentPath, const char* href);
char* vellora_open_link(const char* documentPath, const char* href);
char* vellora_open_external(const char* url);
char* vellora_session_matches(const char* path);
char* vellora_rename(const char* path, const char* newName);
char* vellora_create_markdown(const char* directory, const char* name);
char* vellora_remove_empty_markdown(const char* path);
char* vellora_inspect_move(const char* path, const char* directory, const uint8_t* draft, size_t draftLen,
                           int hasDraft);
char* vellora_move_entry(const char* path, const char* directory);
char* vellora_inspect_delete(const char* path);
char* vellora_delete_entry(const char* path, int permanent, int (*remove)(const char* path, int permanent));
char* vellora_version();
char* vellora_splice_text_n(const uint8_t* content, size_t contentLen, const char* edits);
void vellora_free(char* pointer);
}

namespace {

QJsonObject consume(char* raw) {
  if (raw == nullptr) {
    return QJsonObject{{"ok", false}, {"code", "BRIDGE"}, {"message", "native bridge returned null"}};
  }
  const QByteArray bytes(raw);
  vellora_free(raw);
  const QJsonDocument document = QJsonDocument::fromJson(bytes);
  if (!document.isObject()) {
    return QJsonObject{{"ok", false}, {"code", "BRIDGE"}, {"message", "invalid bridge payload"}};
  }
  return document.object();
}

QByteArray utf8(const QString& value) { return value.toUtf8(); }

// Document text crosses the ABI with an explicit length. U+0000 is valid Markdown
// content: passing constData() alone would let Rust stop at the first NUL and
// save a truncated file. Paths, tokens and JSON edits cannot contain NUL.
const uint8_t* bytes(const QByteArray& value) { return reinterpret_cast<const uint8_t*>(value.constData()); }
size_t length(const QByteArray& value) { return static_cast<size_t>(value.size()); }

bridge::DiskDeleter& diskDeleter() {
  static bridge::DiskDeleter deleter;
  return deleter;
}

#ifdef Q_OS_WIN
// Refuses, before anything is touched, an item the shell would destroy instead
// of recycling: a network share, a removable drive, a disabled or full recycle
// bin. Without it, FOF_NOCONFIRMATION would delete such an item for good.
// QFile::moveToTrash() relies on the same flag.
class RecycleOnly final : public IFileOperationProgressSink {
 public:
  explicit RecycleOnly(bool permanent) : permanent_(permanent) {}
  bool refused() const { return refused_; }

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** object) override {
    if (object == nullptr) return E_POINTER;
    if (riid == IID_IUnknown || riid == __uuidof(IFileOperationProgressSink)) {
      *object = static_cast<IFileOperationProgressSink*>(this);
      AddRef();
      return S_OK;
    }
    *object = nullptr;
    return E_NOINTERFACE;
  }
  // Lives on the caller's stack and outlives the operation that holds it.
  ULONG STDMETHODCALLTYPE AddRef() override { return static_cast<ULONG>(InterlockedIncrement(&refs_)); }
  ULONG STDMETHODCALLTYPE Release() override { return static_cast<ULONG>(InterlockedDecrement(&refs_)); }

  HRESULT STDMETHODCALLTYPE PreDeleteItem(DWORD flags, IShellItem*) override {
    if (permanent_ || (flags & TSF_DELETE_RECYCLE_IF_POSSIBLE) != 0) return S_OK;
    refused_ = true;
    // A failure here cancels this item and everything after it.
    return HRESULT_FROM_WIN32(ERROR_CANCELLED);
  }
  HRESULT STDMETHODCALLTYPE StartOperations() override { return S_OK; }
  HRESULT STDMETHODCALLTYPE FinishOperations(HRESULT) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE PreRenameItem(DWORD, IShellItem*, LPCWSTR) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE PostRenameItem(DWORD, IShellItem*, LPCWSTR, HRESULT, IShellItem*) override {
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE PreMoveItem(DWORD, IShellItem*, IShellItem*, LPCWSTR) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE PostMoveItem(DWORD, IShellItem*, IShellItem*, LPCWSTR, HRESULT, IShellItem*) override {
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE PreCopyItem(DWORD, IShellItem*, IShellItem*, LPCWSTR) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE PostCopyItem(DWORD, IShellItem*, IShellItem*, LPCWSTR, HRESULT, IShellItem*) override {
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE PostDeleteItem(DWORD, IShellItem*, HRESULT, IShellItem*) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE PreNewItem(DWORD, IShellItem*, LPCWSTR) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE PostNewItem(DWORD, IShellItem*, LPCWSTR, LPCWSTR, DWORD, HRESULT, IShellItem*) override {
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE UpdateProgress(UINT, UINT) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE ResetTimer() override { return S_OK; }
  HRESULT STDMETHODCALLTYPE PauseTimer() override { return S_OK; }
  HRESULT STDMETHODCALLTYPE ResumeTimer() override { return S_OK; }

 private:
  LONG refs_ = 1;
  bool permanent_ = false;
  bool refused_ = false;
};

int shellDelete(const QString& path, bool permanent) {
  const HRESULT init = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
  // The UI thread normally has COM already: Qt's drag and drop needs OLE.
  if (FAILED(init) && init != RPC_E_CHANGED_MODE) return static_cast<int>(init);
  RecycleOnly guard(permanent);
  IFileOperation* operation = nullptr;
  IShellItem* item = nullptr;
  DWORD cookie = 0;
  bool advised = false;
  BOOL aborted = FALSE;
  const std::wstring native = QDir::toNativeSeparators(path).toStdWString();
  HRESULT result = CoCreateInstance(CLSID_FileOperation, nullptr, CLSCTX_ALL, IID_PPV_ARGS(&operation));
  if (SUCCEEDED(result)) result = SHCreateItemFromParsingName(native.c_str(), nullptr, IID_PPV_ARGS(&item));
  if (SUCCEEDED(result)) {
    // No confirmation, progress or error UI: Vellora asked already and reports
    // failures itself. FOFX_EARLYFAILURE stops at the first failing item.
    DWORD flags = FOF_NOCONFIRMATION | FOF_NOCONFIRMMKDIR | FOF_SILENT | FOF_NOERRORUI | FOFX_EARLYFAILURE;
    // As QFile::moveToTrash() does: recycle explicitly, never delete in passing.
    if (!permanent) flags |= FOF_ALLOWUNDO | FOFX_RECYCLEONDELETE;
    result = operation->SetOperationFlags(flags);
  }
  if (SUCCEEDED(result)) {
    result = operation->Advise(&guard, &cookie);
    advised = SUCCEEDED(result);
  }
  if (SUCCEEDED(result)) result = operation->DeleteItem(item, nullptr);
  if (SUCCEEDED(result)) result = operation->PerformOperations();
  if (SUCCEEDED(result)) operation->GetAnyOperationsAborted(&aborted);
  if (advised) operation->Unadvise(cookie);
  if (item != nullptr) item->Release();
  if (operation != nullptr) operation->Release();
  if (SUCCEEDED(init)) CoUninitialize();
  if (guard.refused()) return 1;
  if (FAILED(result)) return static_cast<int>(result);
  if (aborted) return static_cast<int>(HRESULT_FROM_WIN32(ERROR_CANCELLED));
  return 0;
}
#endif

// Called by the core inside its session lock, with the entry it checked.
int deleteOnDisk(const char* path, int permanent) {
  const QString target = QString::fromUtf8(path);
  if (const auto& deleter = diskDeleter()) return deleter(target, permanent != 0);
#ifdef Q_OS_WIN
  return shellDelete(target, permanent != 0);
#else
  if (permanent == 0) return QFile::moveToTrash(target) ? 0 : 1;
  const bool removed = QFileInfo(target).isDir() ? QDir(target).removeRecursively() : QFile::remove(target);
  return removed ? 0 : -1;
#endif
}

}  // namespace

namespace bridge {

ImageReadResult::ImageReadResult(ImageReadResult&& other) noexcept
    : status(std::move(other.status)),
      data(std::exchange(other.data, nullptr)),
      size(std::exchange(other.size, 0)) {}

ImageReadResult& ImageReadResult::operator=(ImageReadResult&& other) noexcept {
  if (this != &other) {
    if (data != nullptr) {
      vellora_free_bytes(data, static_cast<size_t>(size));
    }
    status = std::move(other.status);
    data = std::exchange(other.data, nullptr);
    size = std::exchange(other.size, 0);
  }
  return *this;
}

ImageReadResult::~ImageReadResult() {
  if (data != nullptr) {
    vellora_free_bytes(data, static_cast<size_t>(size));
  }
}

QJsonObject openDocument(const QString& path) {
  return consume(vellora_open(utf8(path).constData()));
}

QJsonObject planFor(const QString& markdown) {
  const QByteArray content = utf8(markdown);
  return consume(vellora_plan_n(bytes(content), length(content)));
}

QJsonObject saveDocument(const QString& path, const QString& content, const QString& conflictToken) {
  const QByteArray text = utf8(content);
  return consume(vellora_save_n(utf8(path).constData(), bytes(text), length(text),
                                utf8(conflictToken).constData()));
}

ImageReadResult readImage(const QString& documentPath, const QString& source) {
  const QByteArray docBytes = utf8(documentPath);
  const QByteArray srcBytes = utf8(source);
  uint8_t* rawData = nullptr;
  size_t rawLen = 0;
  ImageReadResult result;
  result.status = consume(vellora_image_read(docBytes.constData(), srcBytes.constData(), &rawData, &rawLen));
  result.data = rawData;
  result.size = static_cast<qsizetype>(rawLen);
  return result;
}

QJsonObject statImage(const QString& documentPath, const QString& source) {
  return consume(vellora_image_stat(utf8(documentPath).constData(), utf8(source).constData()));
}

QJsonObject resolveImage(const QString& documentPath, const QString& source) {
  return consume(vellora_image(utf8(documentPath).constData(), utf8(source).constData()));
}

QJsonObject inspectLink(const QString& documentPath, const QString& href) {
  return consume(vellora_inspect_link(utf8(documentPath).constData(), utf8(href).constData()));
}

QJsonObject openLink(const QString& documentPath, const QString& href) {
  return consume(vellora_open_link(utf8(documentPath).constData(), utf8(href).constData()));
}

QJsonObject openExternal(const QString& url) {
  return consume(vellora_open_external(utf8(url).constData()));
}

QJsonObject spliceSegments(const QString& content, const QJsonArray& edits) {
  const QByteArray payload = QJsonDocument(edits).toJson(QJsonDocument::Compact);
  const QByteArray draft = utf8(content);
  return consume(vellora_splice_text_n(bytes(draft), length(draft), payload.constData()));
}

QJsonObject sessionMatches(const QString& path) {
  return consume(vellora_session_matches(utf8(path).constData()));
}

QJsonObject renameEntry(const QString& path, const QString& newName) {
  return consume(vellora_rename(utf8(path).constData(), utf8(newName).constData()));
}

QJsonObject createMarkdown(const QString& directory, const QString& name) {
  return consume(vellora_create_markdown(utf8(directory).constData(), utf8(name).constData()));
}

QJsonObject removeEmptyMarkdown(const QString& path) {
  return consume(vellora_remove_empty_markdown(utf8(path).constData()));
}

QJsonObject inspectMove(const QString& path, const QString& directory, const QString* draft) {
  const QByteArray text = draft != nullptr ? utf8(*draft) : QByteArray();
  return consume(vellora_inspect_move(utf8(path).constData(), utf8(directory).constData(), bytes(text),
                                      length(text), draft != nullptr ? 1 : 0));
}

QJsonObject moveEntry(const QString& path, const QString& directory) {
  return consume(vellora_move_entry(utf8(path).constData(), utf8(directory).constData()));
}

QJsonObject inspectDelete(const QString& path) {
  return consume(vellora_inspect_delete(utf8(path).constData()));
}

QJsonObject deleteEntry(const QString& path, bool permanent) {
  return consume(vellora_delete_entry(utf8(path).constData(), permanent ? 1 : 0, &deleteOnDisk));
}

void setDiskDeleterForTesting(DiskDeleter deleter) { diskDeleter() = std::move(deleter); }

QString version() {
  const QJsonObject result = consume(vellora_version());
  return result.value("version").toString();
}

}  // namespace bridge
