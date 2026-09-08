# ADR 0006：使用 Rust/Rig 进程内 Agent runtime

状态：已接受。

## 背景

Node sidecar 需要随应用分发约 89 MiB Node runtime 和约 10 MiB Agent bundle，
同时把 Provider、会话、工具与权限拆到跨进程 JSONL 两侧。FloatNote 的其余系统与
可信文件边界已经位于 Rust。

## 决定

Agent 迁入 Tauri 进程，精确依赖 crates.io Rig 0.42.0。Rig 只负责 Provider、流式
completion、工具循环和 hook；FloatNote 自己拥有稳定事件 DTO、session JSONL、
上下文裁剪、Skills、工具、安全策略和旧 Pi 活动分支导入。除内部适配模块外不得
暴露 Rig 类型，升级 Rig 必须作为独立变更完成。

显式 Provider 收敛为 OpenAI、Anthropic、DeepSeek、Kimi 与智谱；其他
OpenAI-compatible 服务通过 OpenAI 自定义 Base URL 使用。应用不再猜测模型能力或
强制 thinking，只透传 Provider 返回的 reasoning。

## 后果

发布包不再包含 Node、sidecar、`tauri-plugin-shell` 或 JIT entitlement，工具与权限
少一层序列化和进程生命周期。代价是 Inbox Agent codec 在 Rust 中有窄幅镜像，必须
用 parity 测试保持磁盘语义一致；Rig 0.x 的升级成本由单一 adapter 和精确版本锁隔离。
