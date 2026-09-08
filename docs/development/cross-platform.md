# 跨平台开发

FloatNote 面向 macOS 和 Windows。路径、文件监听、窗口行为与系统权限代码都必须在目标平台验证，不要把本机行为当作跨平台保证。

- 文件路径：前端拼接项目文件时保留原路径分隔符；Rust 使用 `Path`/`PathBuf`。现有测试覆盖 POSIX 和 Windows 路径。
- 文件监听：macOS FSEvent 与 Windows ReadDirectoryChangesW 的事件时序不同。原子保存必须先登记 self-write suppression，避免把自身写入当作外部变更。
- 系统功能：捕获、辅助功能、浏览器 attribution 与部分自动化能力有平台实现或权限要求；代码必须保留 `cfg(target_os = ...)` 分支。macOS 自动划词使用独立 listen-only event tap 与 Accessibility；Windows 使用轮询式鼠标意图监控和剪贴板兜底。Windows 捕获目标必须从鼠标按下到复制完成同时匹配 PID 与 HWND，发送复制键时暂时释放并恢复用户仍按住的 Shift/Alt，且不能释放用户原本按住的 Ctrl。剪贴板快照必须区分格式枚举结束与失败、跳过系统可合成格式、单独处理增强型图元文件，并在任何会改变剪贴板的动作前完成全部恢复句柄分配；恢复时必须以 FloatNote 自己的有效 HWND 打开剪贴板，不能用 `NULL` 或来源应用 HWND 冒充 owner。`auto` 与 `shortcut` 模式都保留全局监听以关闭被动弹窗，但只有 `auto` 模式识别选择手势并触发捕获。所有平台的捕获实现都必须在 AX、模拟复制或剪贴板读取前排除 FloatNote 自身进程。
- UI：设置窗口默认 `780 × 620`、最小 `720 × 520`，允许缩放和最大化。macOS 使用原生装饰与 Overlay 标题栏，38px 空白外壳区域可拖动并保留系统红绿灯；不抢焦点的划词弹窗使用独立、仅在可见期间启用的 listen-only mouse-move event tap，以 30Hz 合并坐标并驱动 WebView 的被动 hover 状态。不要依赖 `NSWindow.acceptsMouseMovedEvents`：Tao 已默认开启该标志，而 WebKit 内部 tracking area 在应用未激活时仍不会持续驱动 CSS `:hover`。Windows 保留原生最小化、最大化与关闭控件，不模拟红绿灯。内容信息架构和卡片间距在两个平台一致。改动这些区域时，应在 macOS 与 Windows 各验证一次。
- 窗内键盘：macOS 使用 Cmd、Windows 使用 Ctrl 作为主修饰键。主笔记字号快捷键在前端统一消费 `+`、`-`、`0`，只改变结构化编辑器的 `--editor-font`，不能依赖或触发各 WebView 不一致的页面缩放。
- 发布：Rig 与 TLS 静态链接进各目标的 Rust 主程序；必须在 macOS 与 Windows 原生 runner 分别验证 Provider 网络和包体积。
