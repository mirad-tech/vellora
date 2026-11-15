# DocumentView 原生文本无障碍

`document_accessibility.cpp` 为自绘文档提供 Qt 标准
`QAccessibleTextInterface` 与 `QAccessibleEditableTextInterface`。这不是仅给
窗口加名称：辅助技术可以读取正文、按字符/词/句/视觉行/段获取文本、读写光标和
选区、查询屏幕坐标并滚动到文本位置。

## 已实现的边界

- 所有位置使用 Qt 的 UTF-16 偏移；换行和表格分隔符保留一对一的位置对应。
  不将图片替代字符扩展为任意长度的文字，也不利用 QTextCursor 的复杂表格选区
  来读取单个字符。
- 编辑复用 DocumentView 的 insertTyped/deleteBackward、Undo 和 dirty 路径。
  不允许编辑只读预览、隐藏的 raw 源码、预览占位块或表格结构分隔符。
  raw 源码通过现有按钮显露后可以编辑。跨越只读范围的编辑整体拒绝。
- IME 预编辑期间不接受辅助技术的光标/选区/编辑操作；不拆开 UTF-16 代理对。
- 无障碍接口注册本身不启用系统读屏器。未查询接口时没有 observer 或正文副本。
  查询后缓存一份文本以生成准确的 TextUpdated 事件；更新按事件循环合并。
  选区、光标、只读状态和滚动位置使用对应的标准 Qt 事件。
- 源文件、用户文档及操作系统设置均无需修改。正文不写入诊断日志。

## 自动测试

独立项目：`accessibility_regressions.pro`，目标名
`vellora-accessibility-regressions.exe`。使用与主项目相同的 Qt 6.8 MSVC kit 和
新构建的 `vellora_bridge.lib`。`BRIDGE_DIR` 可覆盖桥接库位置。

在配置好 MSVC/Windows SDK 环境后，在独立输出目录执行：

```powershell
qmake <repo>/qt-app/tests/accessibility_regressions.pro CONFIG+=release BRIDGE_DIR=<bridge-directory>
nmake /NOLOGO
$env:QT_QPA_PLATFORM = 'offscreen'
$env:QT_QPA_FONTDIR = Join-Path $env:WINDIR 'Fonts'
./vellora-accessibility-regressions.exe -o results.txt,txt -o results.xml,junitxml
```

测试使用内存中生成的 Markdown、公开 Qt 接口和真实键盘/IME 事件，验证正文逐字
偏移（含表格、raw、图片对象、中英文、emoji）、边界、逆向选区、纵横滚动与
坐标、insert/delete/replace 的 Undo/dirty、表格结构保护、跨只读范围、格式
属性、IME/disabled、标准无障碍事件，以及多次创建和销毁。

## 语义子树

根节点继续提供完整 Text/EditableText 接口，不以语义子树替代正文编辑。
在首次查询子节点后，按实际 QTextBlock、QTextFragment、QTextTable 建立惰性树：

- 标题使用 Heading 角色和 Qt 6.8 AttributesInterface 的 Level 整数，级别来自
  文档本身保存的标题级别。标题内的链接、图片保持父子关系。
- 链接提供可见文字、title、HyperlinkInterface 目标及 UTF-16 范围。跨 bold 等
  格式片段的连续同目标链接合并为一个节点。Press 只发出原 linkActivated 信号，
  仍由 MainWindow 的路径检查/外链确认处理，不直接打开 URL，也不改变实际焦点。
- 每个图片原子单独提供 Graphic 与 ImageInterface，Name/imageDescription 来自
  alt，Description 来自 title，屏幕位置/大小来自实际排版。正文仍保留一个 U+FFFC，
  不以 alt 长度篡改编辑偏移，也不读取新的图片路径或扩大图片授权。
- 表格提供 TableInterface、单元格/行列头提供 TableCellInterface，包含真实行列、
  rowspan/colspan、cellAt（覆盖合并区域返回同一对象）。Markdown 首行仍为列头；
  HTML 逐格保留 th/td 和 scope，不把混合首行中的 td 冒充列头。显式 row/col
  与首行 auto 列头提供相应的行列关联，合并跨度参与关联计算。
  单元格名称不包含为了排版添加的透明 spacer。
- 辅助节点不冒充可编辑或可获焦的控件；表格的行列选择操作返回 false，因为
  当前编辑器没有独立的行/列选择模型。已存在的文本/表格选区仍可读取。
- 节点统一注册到 Qt registry。普通文本修改复用同位置角色的节点，结构删除、
  切文件及窗口销毁注销旧 ID；不保留无限增长的旧树。使用旧 ID 查询失效，不能
  解引用已经删除的 C++ 指针。结构/名称变化发送标准事件。
- 重复 childCount/child/childAt 复用现有树，仅文档内容或排版结构变化才重建；
  字符及节点几何按需读取。语义查询不设置 dirty，不创建 Undo 步骤。

新增测试覆盖标题级别、格式分段链接/安全信号路径、图片 alt/title/对象粒度、
父子/索引一致性、表格表头与合并单元格、混合 th/td、scope=row 的跨行关联、
不确定 scope 的保留及不虚构关联、raw 只读表格、节点 ID 更新/失效，
以及 600 个标题与 600 个链接上的重复查询稳定性。

## 尚未验收或未提供的语义

- 未启动 Windows Narrator 或 NVDA，没有声称真实读屏器的朗读和导航体验已验收。
  自动测试验证的是 Qt 无障碍接口和事件，不替代 Windows UIA/读屏器实机验收。
- HTML 的 headers/id、caption/summary 和完整自动表头关联算法未实现。
  rowgroup/colgroup 的方向角色和 scope 已保留，但没有编造组成员关联；非首行
  auto 或非法 scope 的 th 以 Cell 及 Custom 属性 tag=th、scope=auto/unknown
  保留，方向不确定时不假称行头或列头。Custom 属性是否朗读取决于平台/读屏器。
  新增元数据仅用于预览和无障碍，不参与原始 HTML 的保存或改写。
- 主文档的文本流包含 raw 源码；已渲染的 raw 预览通过嵌套的只读 DocumentView
  接口读取。隐藏源码没有伪造的可见字符矩形。raw 源码与渲染结果的统一朗读
  顺序仍需后续设计与实机验证。列表层级现已提供；完整浏览器 ARIA 行为仍不做等同承诺。

## 2026-11-12 列表与控件对照修复

- 列表/列表项提供嵌套父子、level、posinset、setsize、ordered/start 和真实范围；标题/链接/图片/表格保留为所属列表项子节点。
- 搜索、目录、结果导航、展开替换、关闭等按钮具有明确中文名称；文档/源码各有独立切换按钮和checked状态。视觉焦点环保持移除。
- 新增列表3项回归、独立chrome语义/键盘回归；实屏UIA与真实读屏器的验证范围以最新交付报告为准。
