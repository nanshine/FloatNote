# 架构总览

## 原则

1. Rust 是本地文件写入、版本快照与系统能力的唯一可信执行者。
2. 前端 feature 不直接依赖另一个 feature 的内部模块；跨窗口的 Tauri 调用和 DTO 必须经 `src/platform/`。
3. `shared/note-logic` 是不依赖 DOM、Node I/O 与 Tauri API 的前端纯逻辑；Agent 所需子集在 Rust 中以 parity 测试维护。
4. Rig 和模型输出不拥有文件权限；所有读写都经过 Rust 虚拟工作区与权限事务。
5. 发布产物不包含 Node runtime；Rig 依赖精确锁定并静态链接进 Tauri 主程序。

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

## Agent 运行模型

`AgentService` 是进程内运行时，Rig 0.42 负责 Provider 与工具循环，FloatNote 负责
session、Skills、上下文窗口和权限。debug 与 release 使用同一 Rust 路径；Node 只在
开发机上构建 WebView 前端。详见 [Rust Agent runtime](agent-runtime.md)。
