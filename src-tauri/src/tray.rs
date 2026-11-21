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

// ── 트레이 아이콘 늘 표시(윈도우 11) ─────────────────────────────────────────
//
// 윈도우에는 "이 아이콘을 작업 표시줄에 늘 보이게" 하는 공식 API가 없다. 윈도우 11은
// 아이콘마다 `HKCU\Control Panel\NotifyIconSettings\<숫자>` 키를 두고 `ExecutablePath`
// (실행 파일 경로)와 `IsPromoted`(1이면 늘 보임)를 적는다. 설정 → 개인 설정 → 작업 표시줄 →
// "기타 시스템 트레이 아이콘"의 스위치가 바로 이 값이다. 문서에 없는 자리라 판이 바뀌면
// 사라질 수 있고, 윈도우 10에는 없으며, 사용자가 윈도우 설정에서 다시 끄면 그쪽이 이긴다.
// 키는 아이콘이 한 번이라도 등록된 뒤에 탐색기가 만든다.

/// `ExecutablePath`가 경로 앞을 알려진 폴더 GUID로 적을 때가 있다
/// (예: `{F1B32785-…}\memopin\memopin.exe`). GUID와 그 폴더를 가리키는 환경 변수.
const KNOWN_FOLDERS: [(&str, &str); 3] = [
    ("{6D809377-6AF0-444B-8957-A3773F02200E}", "ProgramFiles"),
    ("{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}", "ProgramFiles(x86)"),
    ("{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}", "LOCALAPPDATA"),
];

/// 앞의 알려진 폴더 GUID를 실제 경로로 푼다. 모르는 GUID거나 변수가 없으면 그대로 둔다.
/// `env`는 환경 변수 읽기(테스트가 바꿔 끼운다).
fn expand_known_folder(raw: &str, env: &dyn Fn(&str) -> Option<String>) -> String {
    for (guid, var) in KNOWN_FOLDERS {
        let Some(head) = raw.get(..guid.len()) else {
            continue;
        };
        if head.eq_ignore_ascii_case(guid) {
            if let Some(dir) = env(var) {
                return format!("{}{}", dir.trim_end_matches(['\\', '/']), &raw[guid.len()..]);
            }
        }
    }
    raw.to_string()
}

/// 윈도우 경로 비교용: 대소문자와 구분자 모양을 무시한다.
fn normalize_path(p: &str) -> String {
    p.trim().replace('/', "\\").to_lowercase()
}

fn file_name_of(p: &str) -> &str {
    p.rsplit(['\\', '/']).next().unwrap_or(p)
}

/// `(하위 키 이름, ExecutablePath)` 목록에서 지금 실행 파일에 해당하는 하위 키들.
/// 경로가 정확히 맞는 것을 먼저 찾고, 없으면 파일 이름만 맞는 것이 딱 하나일 때 그것을 쓴다
/// (경로 표기가 예상과 다를 때를 위한 것이다. 둘 이상이면 남의 아이콘일 수 있어 건드리지 않는다).
/// 윈도우가 아니면 테스트만 부른다.
#[cfg_attr(not(windows), allow(dead_code))]
fn pick_entries(
    entries: &[(String, String)],
    exe: &str,
    env: &dyn Fn(&str) -> Option<String>,
) -> Vec<String> {
    let want = normalize_path(exe);
    let exact: Vec<String> = entries
        .iter()
        .filter(|(_, path)| normalize_path(&expand_known_folder(path, env)) == want)
        .map(|(name, _)| name.clone())
        .collect();
    if !exact.is_empty() {
        return exact;
    }
    let want_name = file_name_of(&want).to_string();
    let by_name: Vec<String> = entries
        .iter()
        .filter(|(_, path)| file_name_of(&normalize_path(path)) == want_name)
        .map(|(name, _)| name.clone())
        .collect();
    if by_name.len() == 1 {
        by_name
    } else {
        Vec::new()
    }
}

/// 이 앱의 항목에 `IsPromoted`를 쓴다. None = 항목을 못 찾음,
/// Some(true) = 값을 바꿨음, Some(false) = 이미 그 값이었음.
#[cfg(windows)]
fn set_promoted(on: bool) -> Option<bool> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
    use winreg::RegKey;

    let exe = std::env::current_exe().ok()?;
    let root = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Control Panel\NotifyIconSettings")
        .ok()?;
    let entries: Vec<(String, String)> = root
        .enum_keys()
        .flatten()
        .filter_map(|name| {
            let path: String = root.open_subkey(&name).ok()?.get_value("ExecutablePath").ok()?;
            Some((name, path))
        })
        .collect();
    let names = pick_entries(&entries, &exe.to_string_lossy(), &|var| std::env::var(var).ok());
    if names.is_empty() {
        return None;
    }
    let want = u32::from(on);
    let mut changed = false;
    for name in names {
        let Ok(key) = root.open_subkey_with_flags(&name, KEY_READ | KEY_SET_VALUE) else {
            continue;
        };
        if key.get_value::<u32, _>("IsPromoted").ok() == Some(want) {
            continue;
        }
        match key.set_value("IsPromoted", &want) {
            Ok(()) => changed = true,
            Err(e) => eprintln!("트레이 아이콘 표시 설정을 쓰지 못했습니다: {e}"),
        }
    }
    Some(changed)
}

#[cfg(not(windows))]
fn set_promoted(_on: bool) -> Option<bool> {
    None
}

/// "트레이 아이콘 늘 표시"를 적용한다. 항목을 찾았으면 true.
/// 값을 바꿨으면 아이콘을 내렸다 다시 올린다 — 탐색기가 바뀐 값을 곧바로 읽지 않을 때
/// 다시 등록하게 하는 방법이다. 메인 스레드에서 불릴 수 있어 기다리지 않는 쪽으로 보낸다.
pub fn apply_always_visible(app: &AppHandle, on: bool) -> bool {
    match set_promoted(on) {
        None => false,
        Some(changed) => {
            if changed {
                windows::spawn_on_main(app, |app| {
                    if let Some(tray) = app.tray_by_id("main") {
                        let _ = tray.set_visible(false);
                        let _ = tray.set_visible(true);
                    }
                });
            }
            true
        }
    }
}

/// 시작할 때 설정이 켜져 있으면 적용한다. 레지스트리 키는 아이콘이 등록된 뒤 탐색기가
/// 만들기 때문에 처음 켠 날에는 아직 없을 수 있다 — 별도 스레드에서 10초쯤 몇 번 더 본다
/// (시작을 막지 않는다).
pub fn apply_always_visible_on_startup(app: &AppHandle) {
    if !cfg!(windows) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        for attempt in 0..6 {
            if attempt > 0 {
                std::thread::sleep(std::time::Duration::from_secs(2));
            }
            if apply_always_visible(&app, true) {
                return;
            }
        }
        eprintln!("트레이 아이콘 표시 설정에서 메모핀 항목을 찾지 못했습니다.");
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(var: &str) -> Option<String> {
        match var {
            "LOCALAPPDATA" => Some(r"C:\Users\me\AppData\Local".to_string()),
            "ProgramFiles" => Some(r"C:\Program Files\".to_string()),
            _ => None,
        }
    }

    #[test]
    fn expands_known_folder_guid() {
        assert_eq!(
            expand_known_folder(r"{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}\memopin\memopin.exe", &env),
            r"C:\Users\me\AppData\Local\memopin\memopin.exe"
        );
        // 대소문자가 달라도, 폴더 끝에 \가 붙어 있어도 같은 경로가 된다.
        assert_eq!(
            expand_known_folder(r"{6d809377-6af0-444b-8957-a3773f02200e}\memopin\memopin.exe", &env),
            r"C:\Program Files\memopin\memopin.exe"
        );
        // 변수가 없거나 모르는 GUID, 평범한 경로는 그대로.
        let x86 = r"{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}\memopin\memopin.exe";
        assert_eq!(expand_known_folder(x86, &env), x86);
        assert_eq!(expand_known_folder(r"D:\apps\memopin.exe", &env), r"D:\apps\memopin.exe");
        assert_eq!(expand_known_folder("", &env), "");
    }

    #[test]
    fn picks_entry_by_full_path_ignoring_case() {
        let entries = vec![
            ("111".to_string(), r"C:\Windows\explorer.exe".to_string()),
            (
                "222".to_string(),
                r"{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}\MemoPin\MemoPin.exe".to_string(),
            ),
            ("333".to_string(), r"D:\old\memopin.exe".to_string()),
        ];
        let exe = r"C:\Users\me\AppData\Local\memopin\memopin.exe";
        // 경로가 맞는 것이 있으면 파일 이름만 같은 다른 항목(333)은 건드리지 않는다.
        assert_eq!(pick_entries(&entries, exe, &env), vec!["222".to_string()]);
    }

    #[test]
    fn falls_back_to_file_name_only_when_unique() {
        let one = vec![
            ("111".to_string(), r"C:\Windows\explorer.exe".to_string()),
            ("222".to_string(), r"E:\elsewhere\memopin.exe".to_string()),
        ];
        let exe = r"C:\Users\me\AppData\Local\memopin\memopin.exe";
        assert_eq!(pick_entries(&one, exe, &env), vec!["222".to_string()]);

        let two = vec![
            ("222".to_string(), r"D:\a\memopin.exe".to_string()),
            ("333".to_string(), r"D:\b\memopin.exe".to_string()),
        ];
        assert!(pick_entries(&two, exe, &env).is_empty());
        assert!(pick_entries(&[], exe, &env).is_empty());
    }
}
