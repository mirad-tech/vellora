## 变更内容 / What changed

<!-- 说明解决的问题和用户可观察到的变化。关联 Issue 时写 Fixes #123。 / Describe the resolved problem and user-visible change. Link Issues with Fixes #123. -->

## 风险与边界 / Risks and boundaries

<!-- 特别说明文件读写、链接、图片、权限、未保存关闭或安装升级影响。 / Note effects on file access, links, images, permissions, unsaved-close handling, or installation and updates. -->

- [ ] 没有扩大通用文件系统、Shell 或任意 URL 权限 / No broader arbitrary filesystem, Shell, or URL permissions
- [ ] 仍只允许打开和保存 `.md` / `.markdown` / Only `.md` / `.markdown` can still be opened or saved
- [ ] 本地图片与 Markdown 链接仍受当前文档目录边界限制 / Local images and Markdown links remain inside the current document directory
- [ ] 不适用；原因已在上方说明 / Not applicable; rationale is above

## 验证 / Validation

<!-- 勾选实际运行过的命令；未运行的项目请说明原因。 / Check only commands actually run and explain skipped checks. -->

- [ ] `npm run version:check`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run test:rust`
- [ ] `npm run test:e2e`
- [ ] `npm run build:web`
- [ ] 其他手动验证 / Other manual validation:

## 界面检查 / UI review

<!-- 有 UI 变化时附截图，并覆盖相关 loading/empty/error/disabled 状态。 / For UI changes, attach screenshots and cover applicable loading, empty, error, and disabled states. -->

- [ ] 无界面变化 / No UI changes
- [ ] 已附截图或录屏 / Screenshots or recording attached

## 发布影响 / Release impact

- [ ] 不需要版本号或 CHANGELOG 变更 / No version or CHANGELOG change needed
- [ ] 已同步版本号并更新 `CHANGELOG.md` / Version fields and `CHANGELOG.md` updated
