//! Windows 自绘标题栏配套：运行时为指定窗口去除系统装饰（左上角图标与
//! 系统色 min/max/close 按钮区），并用 DWM 补回 Win11 圆角与窗口阴影。
//! 仅 Windows 构建；macOS 继续走 `titleBarStyle:"Overlay"` 的原生红绿灯。

use std::ffi::c_void;
use std::mem::size_of;
use tauri::WebviewWindow;
use windows_sys::Win32::Graphics::Dwm::{
    DwmExtendFrameIntoClientArea, DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE,
    DWMWCP_ROUND,
};
use windows_sys::Win32::UI::Controls::MARGINS;

/// 去装饰 + 补圆角/阴影。1px 客户区内框是 borderless 窗口恢复 DWM 阴影的
/// 标准做法；圆角偏好仅 Win11 生效，Win10 上调用被忽略（无害）。
pub fn strip_decorations(window: &WebviewWindow) {
    if let Err(error) = window.set_decorations(false) {
        eprintln!("去除窗口装饰失败: {error}");
        return;
    }
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = hwnd.0 as windows_sys::Win32::Foundation::HWND;
    unsafe {
        let corner_preference = DWMWCP_ROUND;
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            &corner_preference as *const _ as *const c_void,
            size_of::<i32>() as u32,
        );
        let margins = MARGINS {
            cxLeftWidth: 1,
            cxRightWidth: 1,
            cyTopHeight: 1,
            cyBottomHeight: 1,
        };
        DwmExtendFrameIntoClientArea(hwnd, &margins);
    }
}
