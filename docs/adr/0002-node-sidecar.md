# ADR 0002：以 Node sidecar 承载 AI agent

状态：由 [ADR 0006](0006-rust-rig-agent-runtime.md) 取代。

状态：接受。

AI agent 依赖 Node 生态和长生命周期会话，而桌面应用的文件、窗口与系统集成由 Rust/Tauri 管理。

决定：将 agent 运行在独立 Node process，通过 JSONL 与 Rust host 通信。Rust 负责启动、协议校验、用户可见事件和所有文件访问；sidecar 负责 provider 配置、会话生命周期、工具推理与事件转换。

后果：发布包需要包含 Node runtime 与 ESM bundle；协议变更必须同时检查 Rust 与 TypeScript 两端；sidecar 无权直接操作用户工作目录。
