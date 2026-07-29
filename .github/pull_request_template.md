## 变更内容

<!-- 说明解决的问题和用户可观察到的变化。关联 Issue 时写 Fixes #123。 -->

## 风险与边界

<!-- 特别说明文件读写、链接、图片、权限、未保存关闭或安装升级相关影响。 -->

- [ ] 没有扩大通用文件系统、Shell 或任意 URL 权限
- [ ] 仍只允许打开和保存 `.md` / `.markdown`
- [ ] 本地图片与 Markdown 链接仍受当前文档目录边界限制
- [ ] 不适用；原因已在上方说明

## 验证

<!-- 勾选实际运行过的命令；未运行的项目请说明原因。 -->

- [ ] `npm run version:check`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run test:rust`
- [ ] `npm run test:e2e`
- [ ] `npm run build:web`
- [ ] 其他手动验证：

## 界面检查

<!-- 有 UI 变化时附截图，并覆盖相关 loading/empty/error/disabled 状态。 -->

- [ ] 无界面变化
- [ ] 已附截图或录屏

## 发布影响

- [ ] 不需要版本号或 CHANGELOG 变更
- [ ] 已同步版本号并更新 `CHANGELOG.md`
