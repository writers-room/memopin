//! 전역 단축키. 눌리면 트레이의 "새 메모"와 똑같이 동작한다.

use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::settings::Settings;

/// 설정에 맞춰 다시 등록한다. 실패해도 앱은 계속 돌아가고, 에러 문자열만 돌려준다
/// (`update_settings`가 그 문자열을 사용자에게 보여 주되 나머지 설정은 저장한다).
pub fn apply(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let manager = app.global_shortcut();
    let _ = manager.unregister_all();

    if !settings.shortcut_enabled {
        return Ok(());
    }
    let shortcut = settings.shortcut.trim().to_string();
    if shortcut.is_empty() {
        return Err("단축키가 비어 있습니다.".to_string());
    }

    manager
        .on_shortcut(shortcut.as_str(), move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                crate::new_note_from_system(app);
            }
        })
        .map_err(|e| {
            format!(
                "단축키 {shortcut} 을(를) 등록하지 못했습니다. 다른 프로그램이 쓰고 있을 수 있습니다. ({e})"
            )
        })
}
