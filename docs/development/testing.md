# 测试与质量门禁

| 命令 | 覆盖范围 |
| --- | --- |
| `npm run test:frontend` | 前端与 shared 纯逻辑 Vitest 测试 |
| `npm run test:infra` | review 编排、WebDriver 探针和配置隔离测试 |
| `npm run build:frontend` | TypeScript 类型检查与 Vite MPA 构建 |
| `npm run check` | 全部前端/基础设施测试与构建 |
| `npm run ci:local` | 从 `npm ci` 开始，随后执行版本一致性检查与完整 JS/TS 门禁 |
| `npm run release:check -- --tag vX.Y.Z` | 校验发布标签、完整 JS/TS 与 Rust 门禁 |
| `cargo test --lib` | Rust 领域、Rig adapter、会话和工具单测 |
| `cargo check --release` | 发布分支编译 |
| `npm run review:ui` | Chrome 中挂载真实前端组件，回归 UI 与交互状态 |
| `npm run review:native:doctor` | 从当前源码启动 Tauri dev，探测 embedded WebDriver 状态和会话生命周期 |

文件系统删除测试在无 Finder/桌面会话的 CI 或沙箱中应使用可替换的 trash adapter；不要把 OS 自动化失败误判为领域逻辑回归。

Markdown 内核改动必须扩充结构化黄金语料并验证语义往返，而不是比较字节：至少覆盖
嵌套/非 1 起始列表、任务项、列表后的段落、列表内公式、代码块语言、GFM 表格、
图片属性、`[!quote]` 卡、CRLF、中文及无法识别的输入。Inbox 还必须覆盖重叠 mark、
格式编辑后的 offset 重建、损坏 metadata 只读保护；composer 必须覆盖 IME、候选优先级、
结构化引用剪贴板和提交失败保留草稿。浏览器回归重点检查列表后首行、公式基线、
光标/选区、空文档留白点击与 placeholder、标签筛选投影的挂载层级、可拖动滚动条、
折叠与 macOS/Windows WebView 布局差异。

## 本地 CI 分层

开发中可先运行受影响的单测；Agent 或开发者准备声明改动完成时，从仓库根目录运行：

```bash
npm run ci:local
```

这条命令首先执行 `npm ci`，因此不仅验证当前 `node_modules`，也验证 `package.json` 与 `package-lock.json` 能否完成全新安装。随后执行 `npm run version:check` 和 `npm run check`。依赖或 lockfile 变更不得只用已有依赖目录下的 `npm run check` 作为完成证据。

涉及 Rust 的普通开发仍按改动范围补充 `cargo test --lib`、`cargo check` 和 `cargo check --release`。准备版本标签时，改用发布预检命令统一执行这些步骤：

```bash
npm run release:check -- --tag v0.2.0
```

本地命令跨 macOS 与 Windows 使用相同的 Node 编排；Windows 会调用 `npm.cmd`。GitHub Actions 的 macOS/Windows runner 仍是平台差异的最终验证环境。

## 浏览器 UI 回归

`npm run review:ui` 自动启动或复用 Vite，再由 WebdriverIO browser mode 驱动托管的 Chrome。`tests/review/browser/assistant-fixture.ts` 直接挂载生产 `mountAssistant` 和生产 CSS；`note-surfaces-fixture.ts` 直接创建生产 Inbox/Piece 编辑器，验证空白底部点击、焦点 chrome、字体/间距、`---` 分隔线一致性与长文档滚动。fixture 不复制组件实现，也不需要 Tauri binary 或 `.app`。

- spec 位于 `tests/review/browser/`，配置见 `wdio.browser.conf.ts`；失败截图写入 `artifacts/browser-review/`。
- 适合验证 DOM、计算样式、焦点、动画前后状态和前端 IPC 参数；不用于证明 Rust、真实 webview 或系统窗口行为。
- 编排脚本自动管理 Vite 生命周期，并把 `127.0.0.1,localhost` 加入 `NO_PROXY` 与 `no_proxy`。Chrome 与匹配 driver 由 WebdriverIO 管理和缓存，不依赖仓库里的裸 binary。
- Computer Use 不作为自动化测试依赖。辅助功能、全局快捷键等 OS 集成优先用单元/集成测试覆盖边界，必要时再做人工验收。

## 原生运行时诊断

`npm run review:native:doctor` 只诊断原生测试通道：它执行当前工作树的 `tauri dev --no-watch --features e2e-wdio`，等待 `GET /status`，创建绑定 `main` 窗口的 WebDriver 会话，再删除会话。原始 stdout/stderr 保存在 `artifacts/native-doctor/<timestamp>/`，失败信息会给出对应目录。

- `tauri-plugin-wdio` 与 `tauri-plugin-wdio-webdriver` 是可选依赖，只在 debug + `e2e-wdio` feature 下注册。
- `wdio:default` 只在 `tauri.review.conf.json` 内联启用，普通 dev/release 使用的 `default` capability 与默认扫描目录都不包含测试权限。
- `src-tauri/tauri.review.conf.json` 只供这条显式诊断命令使用；普通配置仍保持 `withGlobalTauri: false`。
- 这条命令验证启动、端口和协议握手，不承担产品 UI 回归；UI 回归由更快、更稳定的 browser mode 完成。

## 排错

如果 `/status` 已 ready，但 `POST /session` 报 `UND_ERR_SOCKET`、连接重置或 4445 很快关闭，先检查代理环境。WebDriver 客户端会读取 `HTTP_PROXY/HTTPS_PROXY`；本地地址未进入 `NO_PROXY/no_proxy` 时，会话请求可能错误地经过代理。两条 review 命令已自动补齐 loopback 排除项。

升级 `@wdio/tauri-service` 时，应重新验证 browser mode、embedded session 和 `@wdio/native-utils` override；不要恢复依赖 `src-tauri/target/debug/floatnote` 的独立运行脚本，因为它无法保证对应当前源码。

## Agent 虚拟工作区的跨平台证据

当前自动化覆盖 Windows 风格反斜杠与盘符绝对路径拒绝、路径大小写/文件名规则、CRLF clean Markdown 搜索、Pi session 导入，以及 create-only/同名竞态。macOS 上的完整 Rust 和浏览器 UI 门禁通过不代表 Windows 原生 UI 已验证。

Windows 发布前仍需人工复核：project picker 与 active-note 路径、Skill 目录 realpath、审批弹窗、piece create/rewrite/snapshot、外部编辑造成的 stale commit、watcher 自写抑制，以及五个 Provider 的流式请求。
