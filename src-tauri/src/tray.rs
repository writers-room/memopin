//! 트레이 아이콘. 아이콘 자체는 `tauri.conf.json`의 `app.trayIcon`이 만들어 두므로
//! (id는 "main") 여기서는 그것을 찾아 메뉴와 동작만 붙인다. 새로 만들면 아이콘이
//! 두 개 뜬다.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
use tauri::AppHandle;

use crate::windows;

pub fn setup(app: &AppHandle) -> Result<(), String> {
    let new_note = MenuItem::with_id(app, "new_note", "새 메모", true, None::<&str>)
        .map_err(|e| format!("트레이 메뉴를 만들지 못했습니다: {e}"))?;
    let open_box = MenuItem::with_id(app, "open_box", "메모함 열기", true, None::<&str>)
        .map_err(|e| format!("트레이 메뉴를 만들지 못했습니다: {e}"))?;
    let open_settings = MenuItem::with_id(app, "open_settings", "설정", true, None::<&str>)
        .map_err(|e| format!("트레이 메뉴를 만들지 못했습니다: {e}"))?;
    let separator = PredefinedMenuItem::separator(app)
        .map_err(|e| format!("트레이 메뉴를 만들지 못했습니다: {e}"))?;
    let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)
        .map_err(|e| format!("트레이 메뉴를 만들지 못했습니다: {e}"))?;
    let menu = Menu::with_items(
        app,
        &[&new_note, &open_box, &open_settings, &separator, &quit],
    )
    .map_err(|e| format!("트레이 메뉴를 만들지 못했습니다: {e}"))?;

    let tray = app
        .tray_by_id("main")
        .ok_or_else(|| "트레이 아이콘을 찾지 못했습니다.".to_string())?;
    tray.set_menu(Some(menu))
        .map_err(|e| format!("트레이 메뉴를 붙이지 못했습니다: {e}"))?;
    // 왼쪽 클릭은 메모함을 여는 데 쓴다. 메뉴는 오른쪽 클릭에만.
    let _ = tray.set_show_menu_on_left_click(false);

    tray.on_menu_event(|app, event| match event.id.as_ref() {
        "new_note" => crate::new_note_from_system(app),
        "open_box" => windows::show_box(app),
        "open_settings" => windows::show_settings_async(app),
        "quit" => {
            crate::windows::QUITTING.store(true, std::sync::atomic::Ordering::SeqCst);
            app.exit(0)
        }
        _ => {}
    });

    tray.on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            windows::show_box(tray.app_handle());
        }
    });

    Ok(())
}
