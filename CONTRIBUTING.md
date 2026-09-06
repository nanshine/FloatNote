# 贡献指南

感谢你有兴趣为 FloatNote 出力。这里帮你快速上手，更详细的技术约定见 [AGENTS.md](AGENTS.md) 和 [docs/](docs/) 下的文档。

## 快速开始

需要 Node.js 22.19 LTS 或 Node.js 24 及以上（Node.js 23 不在支持范围内）、Rust stable，以及对应平台的 Tauri 开发依赖。

```bash
npm install
npm run tauri dev
```

## 怎么参与

- 发现 Bug 或有功能想法，欢迎开 Issue 讨论。
- 文档和说明类改动可以直接提 PR。
- 项目目标平台是 macOS 和 Windows，Windows 上的反馈和验证特别有价值。

## 提交 PR

从 `main` 拉分支，改完后确保测试通过：

```bash
npm test              # 前端、shared、sidecar 单元测试
npm run build         # 类型检查 + 构建
```

改了 Rust 代码的话，额外在 `src-tauri/` 下跑 `cargo test --lib` 和 `cargo check`。完整验证矩阵见[测试说明](docs/development/testing.md)。

提交信息用 Conventional Commits 风格即可，比如 `feat: ...`、`fix: ...`、`docs: ...`。

## 几点约定

- 编码风格和模块组织见 [AGENTS.md](AGENTS.md)，跟着现有代码走就好。
- FloatNote 同时跑在 macOS 和 Windows 上，改动涉及平台行为时留意两边一致性，详见[跨平台开发](docs/development/cross-platform.md)。
- 改动若影响了已文档化的内容（命令、模块结构、文件约定等），顺手把对应文档也更新一下。
- FloatNote 读写本地文件，路径和权限处理要谨慎，详见[安全边界](docs/architecture/security.md)。

---

保持友善、对事不对人，围绕改进 FloatNote 展开讨论就好。
