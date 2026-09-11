# ADR 0001：Rust 作为文件写入边界，Node 作为 AI sidecar

状态：由 [ADR 0006](0006-rust-rig-agent-runtime.md) 取代。

状态：接受。

FloatNote 需要本地 Markdown I/O、跨平台窗口与系统能力，也需要依赖 Node AI SDK 的长生命周期会话。将两者放到一个运行时会令权限与发布依赖混杂。

决定：Rust/Tauri 负责文件、版本、窗口、权限和协议 host；Node sidecar 只负责 AI session、工具推理与 JSONL 协议。sidecar 不拥有文件系统写权限。共享 Markdown/标签变换留在纯 TypeScript package，确保前端与 sidecar 语义一致。

后果：协议需要契约测试；发布时必须带上 sidecar runtime；UI 不得直接导入 sidecar 或 Rust 内部实现。
