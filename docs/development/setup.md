# 开发环境

需要 Node.js 22.19 LTS 或 Node.js 24 及以上、Rust stable，以及目标平台的 Tauri 开发依赖。Node.js 23 不在项目依赖的支持范围内；可使用仓库根目录的 `.nvmrc` 切换到 Node.js 24。项目支持 macOS 和 Windows；在对应平台开发或发布时，使用该平台可运行的 Node 与 Rust toolchain。

```bash
npm install
npm run tauri dev
```

只启动 WebView 前端时使用 `npm run dev`。完整桌面流程使用 `npm run tauri dev`，它会启动 Vite 并在 Tauri 进程中运行 Rust Agent。

## 开发身份与隔离档案

`npm run tauri dev` 会由 `scripts/tauri.mjs` 最后合并 `tauri.dev.conf.json`，因此开发应用名为 **FloatNote Dev**、bundle identifier 为 `com.floatnote.desktop.dev`。所有 debug 运行写入 `src-tauri/target/dev-profiles/default/`；release 构建不加载该配置，也忽略 profile 环境变量。

首次引导专项运行使用 `npm run tauri:dev:onboarding`；`npm run tauri:dev:onboarding:reset` 只清除 onboarding profile 后退出；`npm run tauri:dev:onboarding:fresh` 安全清除后立即启动。reset 启动器只接受解析后的精确路径 `src-tauri/target/dev-profiles/onboarding`，拒绝其他 profile、父目录、相对路径和符号链接。

常用验证命令见 [测试与质量门禁](testing.md)。发布结构见 [打包架构](../architecture/packaging.md) 和 [发布流程](release.md)。
