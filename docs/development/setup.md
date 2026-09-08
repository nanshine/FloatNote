# 开发环境

需要 Node.js 22.19 LTS 或 Node.js 24 及以上、Rust stable，以及目标平台的 Tauri 开发依赖。Node.js 23 不在项目依赖的支持范围内；可使用仓库根目录的 `.nvmrc` 切换到 Node.js 24。项目支持 macOS 和 Windows；在对应平台开发或发布时，使用该平台可运行的 Node 与 Rust toolchain。

```bash
npm install
npm run tauri dev
```

只启动 WebView 前端时使用 `npm run dev`。完整桌面流程使用 `npm run tauri dev`，它会启动 Vite 并在 Tauri 进程中运行 Rust Agent。

常用验证命令见 [测试与质量门禁](testing.md)。发布结构见 [打包架构](../architecture/packaging.md) 和 [发布流程](release.md)。
