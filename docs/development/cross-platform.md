# 跨平台开发

FloatNote 面向 macOS 和 Windows。路径、文件监听、窗口行为与系统权限代码都必须在目标平台验证，不要把本机行为当作跨平台保证。

- 文件路径：前端拼接项目文件时保留原路径分隔符；Rust 使用 `Path`/`PathBuf`。现有测试覆盖 POSIX 和 Windows 路径。
- 文件监听：macOS FSEvent 与 Windows ReadDirectoryChangesW 的事件时序不同。原子保存必须先登记 self-write suppression，避免把自身写入当作外部变更。
- 系统功能：捕获、辅助功能、浏览器 attribution 与部分自动化能力有平台实现或权限要求；代码必须保留 `cfg(target_os = ...)` 分支。macOS 自动划词使用独立 listen-only event tap 与 Accessibility；Windows 使用轮询式鼠标意图监控、独立取词 worker 和无窗口 MTA UIA 服务，UIA 失败再考虑剪贴板兜底。Windows 捕获目标必须从鼠标按下到复制完成同时匹配 PID 与 HWND，发送复制键时暂时释放并恢复用户仍按住的 Shift/Alt，且不能释放用户原本按住的 Ctrl。剪贴板快照必须区分格式枚举结束与失败、跳过系统可合成格式、单独处理增强型图元文件，并在任何会改变剪贴板的动作前完成全部恢复句柄分配；恢复时必须以 FloatNote 自己的有效 HWND 打开剪贴板，不能用 `NULL` 或来源应用 HWND 冒充 owner。`auto` 与 `shortcut` 模式都保留全局监听以关闭被动弹窗，但只有 `auto` 模式识别选择手势并触发捕获。所有平台都必须在 AX/UIA、模拟复制或剪贴板读取前排除 FloatNote 自身作为捕获目标；确认采集时即使浮条已聚焦，仍只能向缓存的原外部 PID 定向复制，不能复制 FloatNote 窗口。
- UI：设置窗口默认 `780 × 620`、最小 `720 × 520`，允许缩放和最大化。macOS 使用原生装饰与 Overlay 标题栏，38px 空白外壳区域可拖动并保留系统红绿灯；不抢焦点的划词弹窗使用独立、仅在可见期间启用的 listen-only mouse-move event tap，以 30Hz 合并坐标并驱动 WebView 的被动 hover 状态。不要依赖 `NSWindow.acceptsMouseMovedEvents`：Tao 已默认开启该标志，而 WebKit 内部 tracking area 在应用未激活时仍不会持续驱动 CSS `:hover`。Windows 下去除系统标题栏（`src-tauri/src/window_chrome.rs` 运行时 `set_decorations(false)` + DWM 圆角/阴影），min/max/close 由前端 `src/shared/ui/window-caption.ts` 自绘并随主题着色，边缘缩放手柄与双击最大化也由前端补回。内容信息架构和卡片间距在两个平台一致。改动这些区域时，应在 macOS 与 Windows 各验证一次。
- 窗内键盘：macOS 使用 Cmd、Windows 使用 Ctrl 作为主修饰键。主笔记字号快捷键在前端统一消费 `+`、`-`、`0`，只改变结构化编辑器的 `--editor-font`，不能依赖或触发各 WebView 不一致的页面缩放。
- 屏幕坐标：划词弹窗按逻辑坐标定位（前端 `LogicalPosition`）。`cursor.rs` 必须返回逻辑坐标——macOS Quartz 本身就是点，其余平台从 `cursor_position()` 拿到的是物理像素，必须按光标所在显示器的 `scale_factor` 换算，否则弹窗在缩放屏和多显示器下会偏离选区。
- 输入法锚点：WebView2 在宿主窗口被拖动或缩放后仍沿用过期的 caret 锚点，输入法候选框会画到屏幕角落（上游 WebView2Feedback#5675 未修，wry 已调用 `NotifyParentWindowPositionChanged` 但不足以复位）。Rust 仅在 Windows 上于 `Moved`/`Resized` 时向 `main` 发 `window-geometry-changed`，前端 `src/shared/ime-anchor.ts` 在手势停止后重新聚焦当前可编辑元素并还原选区；组合输入进行中跳过，避免吞掉未上屏的字。macOS/WebKit 无此问题，不发该事件。
- 发布：Rig 与 TLS 静态链接进各目标的 Rust 主程序；必须在 macOS 与 Windows 原生 runner 分别验证 Provider 网络和包体积。

## 引导与捕获权限

`get_capture_permission_state` 在 macOS 返回 `required/granted`，Windows 返回 `not_required`；Onboarding Lab 的权限场景只模拟 UI，不改变系统授权。真实 macOS 回归可运行 `tccutil reset Accessibility com.floatnote.desktop.dev` 后重启 FloatNote Dev，这会真实修改系统权限状态。引导切入双栏前使用显示器 `workArea` 与 `scaleFactor` 换算逻辑像素；工作区容不下双栏最小宽度时必须保留当前窗口并给出可恢复反馈。
