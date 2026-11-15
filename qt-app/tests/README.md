# Native Qt regressions

From the repository root in PowerShell, with Rust MSVC, Qt 6.8.3 MSVC2022 x64
(including Qt Image Formats), VS C++ tools and Windows SDK installed:

    ./qt-app/build.ps1 -Test -EmitLegacyOutput:$false
    ./qt-app/build.ps1 -Test -Clean -QtRoot C:/Qt/6.8.3/msvc2022_64 -BuildRoot C:/temp/vellora-build -CargoTargetDir C:/temp/vellora-rust -EmitLegacyOutput:$false

The script builds the Rust bridge before qmake. It never depends on an existing
bridge library or app executable. `-Test` also runs the Rust core/md/bridge test suites,
builds 14 QtTest suites and runs them with the offscreen platform. Each suite
writes `results.xml` (JUnit) and `results.txt` beside its executable in its own
`<BuildRoot>` subdirectory: `tests`, `accessibility-tests`, `serialization-tests`,
`code-copy-tests`, `conflict-tests`, `feedback-document-tests`, `focused-ui-tests`,
`parity-document-tests`, `chrome-accessibility-tests`, `chrome-ui-tests`,
`highlight-parity-tests`, `body-layout-tests`, `ime-raw-tests`, and `fidelity-tests`.
By default BuildRoot is `target/qt-release` (or `target/qt-debug`). Production
and instrumented application binaries are under `app` and `test-app` respectively.
Unless `-EmitLegacyOutput:$false` is passed, the production executable is also
copied to `qt-app/vellora.exe` after its build succeeds.

Overrides: `-QtRoot` / QT_ROOT; `-MsvcRoot` / VELLORA_MSVC_ROOT accepts either
VC/Tools/MSVC or a version directory; `-WindowsSdkRoot` / WindowsSdkDir;
`-CargoTargetDir`; `-BuildRoot`. Otherwise VS is discovered with vswhere and
the newest installed x64 Windows SDK is selected. No developer prompt required.
`-Clean` runs nmake clean inside the build directories, never deletes sources.

The assertions use temporary markdown files and public production widget APIs,
QTest key events, input-method events and toolbar signals. They cover byte-exact
unchanged saves, source/document round trips, immediate dirty guards on close
and open, heading/list/task/quote/inline preservation, undo/redo, search cycling
and IME commits. They do not open or modify user documents. They are not visual
pixel-diff acceptance tests or native OS dialog/installer/IME integration tests.

Qt must be provisioned separately from the official Qt distribution, respecting
its license (Qt 6 open-source components commonly LGPLv3/GPLv3; verify all used
modules and redistribution obligations). The script installs no machine tools.
`-EmitLegacyOutput:$false` avoids copying the executable into the installer input path.

The GitHub workflow [ci.yml](../../.github/workflows/ci.yml) runs on pushes to
`main` and pull requests. Its two `windows-latest` jobs use Rust stable and run:

    ./tools/check.ps1
    ./tools/check.ps1 -Full

The first checks Rust formatting, Clippy with warnings denied, the release panic
unwind policy, and workspace tests. `-Full` keeps those static checks and runs
`build.ps1 -Test -EmitLegacyOutput $false` for Rust and Qt regressions. This is a
mixed build/regression command, not a unit-test-only command. The Qt job installs
Qt 6.8.3 MSVC2022 x64 plus Qt Image Formats using `jurplel/install-qt-action@v4`
and the runner's VS/SDK. The workflow does not package or publish artifacts.
The open-source Qt kit remains subject to its applicable license obligations.

Additional regression cases cover CRLF edits, nested/ordered lists, raw fenced
code/reference neighbors, replace-all as one undo step, save-then-undo, external
save conflicts, cross-block replacement with undo, and two real application
processes forwarding a file in source mode (both CLI aliases). Process tests use
UUID-scoped VELLORA_TEST_INSTANCE endpoints and temporary state/screenshot files;
they never forward documents into a user's normal application instance.
The offscreen runner uses the installed Windows fonts via QT_QPA_FONTDIR when
that environment variable is not already configured.

Optional native-window numeric memory diagnostics (not a CI timing gate). Instrumented and production examples:

    ./qt-app/tests/perf.ps1 -Executable 'target/qt-release/test-app/vellora.exe' -OutputDir 'C:/temp/qt-perf-instrumented-fresh' -Runs 1
    ./qt-app/tests/perf.ps1 -Executable 'target/qt-release/app/vellora.exe' -OutputDir 'C:/temp/qt-perf-production-fresh' -Runs 1 -ProductionOnly

Both save numeric reports with `passed=false` and exit with an explicit
incomplete-verification error; use the per-stage visible sampling below for
document-verified acceptance.

Each run uses qwindows at system DPI, with no scale overrides. The default
instrumented sequence and production subset are described below.
Markdown fixtures are copied and their SHA256s are recorded. The script invokes
`tools/make-perf-images.ps1 -ImageSet All` to generate PNGs directly in the fresh
`OutputDir/fixtures`, without reading ignored repository PNGs. The 81-picture
variant uses 128x128 ARGB PNGs with seeds 2001..2081; it differs from historical
local images. References, decoding, dimensions and encoded sizes are checked
before sampling. `prepare-visible-production.ps1` generates and validates the
same 81-picture variant in its own output directory. Metadata records this
variant and actual file hashes.
Use -Synthetic only for the separate repeated-paragraph/solid-1280x720-image control.
For each stage it waits 30 seconds naturally then samples PrivateMemorySize64
10 times at one-second intervals. No forced GC, cache eviction, working-set
trim, or scrolling is used. Use Runs=3 for three independent sequential runs.
The generated fixtures and raw JSON samples remain in the fresh OutputDir.
The instrumented run checks the owned window title, observer platform, mode and
nonempty document count; these do not verify loaded file identity or content.
Production runs verify owned window identity only. Reports retain Qt/OS/DPI,
binary SHA256 and every raw sample. A failed start/forward is an error, not a memory result.

For self-contained distribution build instructions, see
[installer/README.md](../../installer/README.md). The old Rust RichEdit installer and its
performance reports must not be described as Qt artifacts/results.



Further public-API assertions cover source outline UTF-16 offsets (duplicate body
text, formatted/HTML/nested headings, emoji and CRLF), modal launch queue ordering,
stale IME close actions after switching documents, reference-preview refresh,
remote image resource rejection, all seven syntax-highlighting groups and aliases,
span bounds on truncated input, and highlighting that preserves text/undo.
Editing coverage includes list/table keys, source wrapped-line reveal, semantic
reading anchors on first mode switch, selection preservation after reparse, and
image delete/type/undo (including a pixel check that the removed red image is gone).
No test depends on redefining private access or calling mangling-altered methods.

The application and bridge-linked test qmake projects declare the Rust static
library in PRE_TARGETDEPS as well as LIBS, so a Rust-only rebuild relinks them.
The focused UI, chrome UI and highlight suites do not link the Rust bridge.
The structured 2 MiB fixture also has a generous 15-second event-loop regression
test; this is distinct from the formal qwindows memory and latency measurements.

The instrumented diagnostic sequence is empty, small, original large in document mode,
original large in source mode, small after large, generated 81-image document,
and small after images, followed by large images and small after large images.
Steady medians across three independent runs are compared
with 60/80/200 MiB limits; peak samples are reported separately. All three small-file
recovery stages must be within the same run's initial empty state plus 20 MiB.
Search-state memory can be measured separately with `perf.ps1 -SearchOnly -Runs 3`, using the instrumented executable and a fresh OutputDir. It verifies a visible search panel and nonzero matches for `mixed text` in the original large fixture. Input p95 and real Windows IME acceptance are separate checks,
not implied by this memory script.

During forwarding and the first two seconds of natural settling, `perf.ps1`
samples process memory every 10 ms; it then samples every 100 ms. The observed settling peak is a sampled bound, not an exact instantaneous allocation peak; the ten one-second samples after settling remain the steady-state measurement. No forced GC, trimming, or cache clearing is performed.

Keyboard parity tests include Ctrl+E inline code, Ctrl+Alt+1 through 6 headings, Ctrl+Shift+7/8 lists, and Ctrl+Shift+B quote (not bold), with exact disk serialization and Undo restoration. The embedded application icon is also checked independently of external files.

Production/test separation: `build.ps1` always builds `app/vellora.exe` without
VELLORA_ENABLE_TEST_HOOKS. `-Test` also builds a separate `test-app/vellora.exe`
with that macro for isolated IPC, screenshot and observation regressions. The
portable packager includes only production `app`, never `test-app`.
Instrumented memory runs use test-app and explicitly report that distinct hash.
`perf.ps1 -ProductionOnly` collects production numeric diagnostics
(empty/small/large/images/small/large-images/small), not document-verified acceptance. The fixed
`Vellora` title proves window identity only. The periodic test-app observer also
exports only mode/counts, not file identity or source contents. All `perf.ps1`
variants now save numeric reports with `document_state_evidence_complete=false`
and `passed=false`, then exit with an explicit incomplete-verification error.
Memory threshold results remain separate. No production hooks were added.
Pass `-BuildMakefile` for the matching app's Makefile to record compiler flags;
the script requires the neighboring executable hash to match the measured binary.
The production portable smoke checks missing ASCII/UTF-16 hook tokens, ignores
screenshot/state environment requests, and validates app-local runtime modules.
It refuses to contact an existing production single-instance endpoint.

The wholeAppLargeTypingLatency test reports real MainWindow event cycles on the
original structured fixture for first/middle/last editable paragraphs and the
last table. Cycles
include a deliberate 20 ms interval, Qt event processing and grab, with 1.5 seconds
of typing per location so draft timers execute. It verifies save and Undo bytes.
These cycle p95/max values are Qt-internal measurements, not DWM presentation
latency; platform is reported, and qwindows acceptance must run separately.

Visible-process sampling: start the exact test binary normally and verify its
process ID, executable path and visible 820x900 client window before passing it
to `sample-visible.ps1`. This sampler never starts or controls a window. It samples
30 seconds of natural settling at 100 ms, then ten one-second steady samples.
`run-visible-stages.ps1` forwards only copied fixture paths through the documented
application CLI to that already verified process. For acceptance, invoke it with
one `-Stages` value and `-ForwardOnly`, then have the desktop owner use official
CUA to verify the toolbar filename, actual mode and visible document content (or
search query/nonzero counter). Do not infer success from the forwarded path.
Call the sampler separately with `-UiEvidencePath` pointing to that observation's
JSON record. Initial startup peaks before sampling are unmeasured.

The record must contain `run`, `stage`, `pid`, executable `sha256`,
`observed_utc` (ISO UTC within that PID's lifetime), `observed_file` (basename,
empty string for empty state), `observed_mode` (`empty`, `document`, `source`,
or `document-search`), nonempty `observed_content` describing the actual observed
text/counter, and `observation_file` (absolute path to the saved real CUA AX or
screenshot artifact). This is external observation evidence, not a sampler UI
inspection. Record it only after the relevant CUA result was actually seen.
The sampler validates process/stage/file/mode association and hashes the artifact.
Do not navigate or change the window during sampling.

Example sequencing (substitute real PID, paths, stage and observation):

    ./qt-app/tests/run-visible-stages.ps1 -ProcessId $ownedPid -Executable $exe -OutputDir $out -Run 1 -Stages small -ForwardOnly
    # Official CUA: observe small.md, document mode and actual fixture content;
    # save the observation and its JSON record, without fabricating fields.
    ./qt-app/tests/sample-visible.ps1 -ProcessId $ownedPid -Executable $exe -OutputDir $out -Run 1 -Stage small -UiEvidencePath $actualEvidenceJson

Without `-UiEvidencePath`, the sampler and legacy batch-forward workflow still
collect numeric diagnostics but explicitly leave document verification incomplete.
`summarize-visible.ps1` reports `memory_thresholds_passed` independently and only
sets overall `passed` when all 24 stages have associated CUA evidence. Do not rerun
the new summarizer over historical output directories: preserve their original
reports and evaluate a fresh output directory for a new binary.

For an explicitly scoped final recovery recheck only, use
`summarize-visible.ps1 -OutputDir $out -KeyRecoveryOnly`. This requires exactly
three independent PIDs, each with `empty`, `large-markdown`,
`large-source-mode`, and `back-small-after-large`, with the same per-stage CUA
evidence and natural sampling. Gates are empty <=60 MiB, large/source <=200 MiB,
and each run's return-to-small growth <=20 MiB versus its own empty state.
The report is labelled `scope=key-recovery-only`; initial-small, images,
image recovery and search are explicitly unmeasured for that binary. It never
imports earlier binary measurements. The default remains full eight-stage
acceptance. Each run must keep the same PID through all its stages.

Windows heap policy is merged additively from `windows.manifest` using
/MANIFESTINPUT for the app and bridge-linked test executables. This opts only these
executables into SegmentHeap on Windows 10 2004+; it does not change OS settings,
trim the working set, or force garbage collection. Existing UAC, compatibility,
DPI and common-controls declarations must remain in the embedded manifest.
Each measured binary hash and heap variant must stay explicit in its report.

## 整理目录后的夹具

图片排版与清单编辑回归使用 `tests/fixtures/full-document/document.md` 的自包含样本，并在测试临时目录生成图片，不再搜索用户根目录文档。原布局、源码保持和撤销断言保留；这不是已删除全功能文档的逐字复测。

Image fixture generation/validation regressions run without starting Vellora:

    ./tools/test-perf-fixtures.ps1 -OutputDir ./target/review-fixes-fixtures/new-run

Use a fresh directory. The check covers 81 PNG references, decoding, dimensions,
repeatable hashes, missing/corrupt files, and the Large/All generation modes.
