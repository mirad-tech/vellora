# 一份安静、清晰的 Markdown 工作区

Vellora 用于阅读、直接编辑与源码编辑。这份文档用于对照中文、English、数字 0123456789，以及 **强调内容**、*斜体* 和 `inline code` 在同一段落中的节奏。

## 01 阅读与编辑

内容从页面顶部开始，正文保持稳定的阅读宽度。目录和搜索帮助定位信息，工具栏负责展示文件状态。

> 好的工作区让内容自然成为视觉中心。引用使用轻量边线，在长文档中形成清楚的停顿。

- 第一项：普通说明与 [外部链接](https://example.com/)。
- 第二项：中文与 English 混排，观察字体回退和基线。
  - 子项目：检查列表缩进和上下间距。
- 第三项：编辑之后，保存操作应该清楚可见。

### 01.1 表格与长内容

| 项目 | 当前状态 | 说明 |
| --- | --- | --- |
| 文档模式 | 可编辑 | 点击支持的正文块，沿用现有直接编辑行为。 |
| 源码模式 | 可编辑 | 搜索 `Vellora`，验证命中与光标位置一致。 |
| 长文本 | 自身滚动 | this_is_a_deliberately_long_unbroken_table_cell_for_checking_horizontal_overflow_without_widening_the_document_workspace_0123456789_abcdefghijklmnopqrstuvwxyz |

### 01.2 代码块

```typescript
const document = { name: 'Vellora', saved: false };
const longLine = 'This deliberately long code line must scroll within its own code block, while the surrounding document keeps its reading width.';

function describeDocument() {
  return `${document.name}: ${document.saved ? '已保存' : '未保存'}`;
}
```

## 02 搜索与导航

Vellora 的重复词用于搜索导航：Vellora、Vellora。中英文查询都应保持命中位置准确。

#### 02.1 多级目录

这是一段四级标题下的正文。

###### 02.1.1 这是一个用于验证多级目录缩进与完整标题提示的很长很长的中文标题

窄窗口选择标题后，目录浮层关闭并保留正确的文档定位。

## 03 图片与必要状态

![故意缺失的示例图片](missing-ui-review-image.png)

这张图片故意不存在，用于验收缺失图片提示；不读取个人文件或远程图片。

---

最终检查：文件名省略提示、焦点轮廓、保存中和失败恢复、搜索高亮、目录浮层、外链确认与未保存关闭保护。
