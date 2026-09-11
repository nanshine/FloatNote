# 打包

发布前，`npm run tauri build` 的 `beforeBuildCommand` 只构建前端；Rig 与 Agent 代码随 Rust 主程序静态链接。macOS 默认 bundle target 是 `.dmg` 并使用 hardened runtime，不再申请 V8 JIT entitlement。GitHub Release 工作流显式构建 `app,dmg`，确保 `.app` 在 DMG 完成后仍保留用于验证和归档。根包的 Tauri 包装器继续以范围受限的 `SetFile` shim 清除 DMG 自定义卷图标标记。

Tauri bundle 只把内置 Skills 映射到 `resource_dir()/skills`。发布包不包含 Node runtime、Agent JavaScript bundle、external binary 或 `tauri-plugin-shell`。

Tauri 的增量资源复制可能在 `target` 或旧 bundle 中留下已从源码删除的 Skill
目录。Rust 只枚举当前内置 Skill ID 清单，
因此陈旧副本不会在运行时复活；debug 模式直接使用源码 Skill 目录。

Apple Silicon 在 `macos-15` runner 上构建 `aarch64-apple-darwin`，Intel 在 `macos-15-intel` runner 上构建 `x86_64-apple-darwin`；Windows 使用原生 runner。Rust TLS 与目标架构由 Cargo/Tauri 正常解析，不再需要单独提供 Node runtime。

应用版本以根 `package.json` 为唯一来源；Tauri 配置通过 `"version": "../package.json"` 读取它。`scripts/release-version.mjs` 同步 Cargo、workspace package 和 lockfile 中的版本副本，并在发布前校验 Git 标签。
