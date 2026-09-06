# 架构总览

## 原则

1. Rust 是本地文件写入、版本快照与系统能力的唯一可信执行者。
2. 前端 feature 不直接依赖另一个 feature 的内部模块；跨窗口的 Tauri 调用和 DTO 必须经 `src/platform/`。
3. `shared/note-logic` 只能包含同时被前端和 sidecar 使用的纯逻辑，禁止 DOM、Node I/O 与 Tauri API。
4. sidecar 不能直接写用户文件；所有读取/写入请求必须通过 JSONL host protocol 和 Rust 的权限闸。
5. 发布产物必须包含 sidecar bundle 与运行时，不能依赖用户的 PATH、Node 安装或源码目录。

## 前端

根目录 HTML 是 Vite 多页面入口。`src/note/main.ts` 只启动 `startNoteApp()`；笔记窗口的组装和控制流在 `src/note/note-app.ts`。新增共享能力应优先放到以下位置：

- `src/platform/`：Tauri commands/events、聊天与 agent DTO。
- `src/shared/`：纯 UI、Markdown、escape、快捷键与 toast。
- `src/note/`：笔记编辑、项目空间、标签、任务、图片和布局。
- `src/assistant/`：助手 UI、消息 reducer 与渲染。

跨 feature 的 agent、chat history、Markdown 和 UI 组件从 `src/platform/` 或
`src/shared/` 的正式入口直接导入，不在 feature 目录保留转发模块。

## Rust

`src-tauri/src/lib.rs` 仅负责装配。`AppState` 保存运行期资源；领域逻辑位于 `notes`、`project`、`versions`、`chat_history` 和 `agent`。

`commands.rs` 是 Tauri adapter 的入口，并已按领域拆出 `commands/agent.rs`、`commands/chat.rs` 和 `commands/settings.rs`。其余命令仍保留在根 adapter；新增命令应优先放入相应领域模块。命令只做参数转换、授权和错误映射；文件操作留在领域模块。

## Sidecar 发布模型

`sidecar/scripts/bundle.mjs` 使用 esbuild 生成 `dist/floatnote-agent.mjs`。它是一个可由 Node 22 运行的单文件 ESM bundle，并提供 `npm run smoke` JSONL ready 握手检查。

`sidecar/scripts/prepare-tauri.mjs` 将 bundle 复制到 `src-tauri/resources/sidecar/`，并将构建机 Node runtime 复制成符合 Tauri target-triple 约定的 `src-tauri/binaries/floatnote-node-<triple>`。交叉构建必须提供：

```text
FLOATNOTE_TARGET_TRIPLE=<tauri target triple>
FLOATNOTE_NODE_RUNTIME=<matching Node executable>
```

Release Rust 代码通过 `tauri-plugin-shell` 启动 external Node binary，并将 resource bundle 作为第一个参数；debug 构建仍使用本地 `tsx`，便于开发。
