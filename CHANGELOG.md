# Changelog

## 1.1.3 - 2026-06-25

- 更新 Windows 应用图标为白底深紫文档源码图形，并补齐 PNG/ICO 生成链。
- Windows 打包改为使用本地 Electron runtime，并在 `afterPack` 阶段写入 EXE 图标资源，避免缺少小尺寸图层。
- 源码模式改为全宽源码编辑器，不再同时显示实时渲染预览。
- 打包测试新增图标结构校验，覆盖 16/32/48/64/128/256 px ICO 图层。
- 修复图标母版测试过度绑定生成图尺寸的问题，改为校验正方形且不小于 256 px。

验证：

- `npm run test:stage8`
- `npm test`
- `npm run generate:icon && npm run test:stage8`
- `npm run dist`
