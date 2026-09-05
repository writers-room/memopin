//! 창 만들기·닫기·위치 저장. 창 라벨이 곧 역할이다(`box` / `settings` / `note-<id>`).
//!
//! 창 생성이 왜 이렇게 번거로운지는 아래 `run_on_main` 주석에 적어 두었다.
//! 서재(`D:\dev\storyseed-tauri\src-tauri\src\main.rs`)에서 값을 치른 방법을 그대로 옮겼다.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::{
    utils::config::WindowConfig, AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use crate::store::{Note, NoteKind, WindowRect};
use crate::{emit_store_changed, AppState};

// ── Windows 전용: 창 이동/리사이즈 시 한글(IME) "문자열 마무리" 팝업 회피 ──
//
// 배경: wry는 Windows에서 창이 움직이거나 크기가 바뀌기 "시작"하는 순간
// (WM_ENTERSIZEMOVE)에 드롭다운 위치 버그를 막기 위해 웹뷰에 포커스를 강제로
// 다시 준다. 이 강제 재포커스가 한글 조합 중이던 IME 세션을 끊어버려서
// "문자열 마무리" 팝업으로 이어진다. 순수하게 창 위치만 옮기는 경우(크기 변화
// 없음)에도 재현되는 것으로 확인됐다 — 즉 프런트 JS는 전혀 관련이 없고,
// 100% 이 네이티브 동작이 원인이다.
//
// 서재에서 두 번은 "지금 한글을 조합 중인지"를 IMM32 레거시 API
// (ImmGetCompositionStringW)로 판단한 뒤 조합 중일 때만 이 메시지를 막으려
// 했는데, 효과가 없었다. WebView2 안의 Chromium은 조합 상태를 레거시 IMM32가
// 아니라 최신 TSF(Text Services Framework)로 관리하기 때문에, 그 IMM32 API로는
// 애초에 조합 여부를 제대로 읽어낼 수 없었던 것으로 보인다.
//
// 그래서 조합 여부를 판단하려 하지 않고, WM_ENTERSIZEMOVE 메시지를 무조건
// wry의 서브클래스로 넘기지 않는다(=강제 재포커스 자체가 아예 일어나지 않는다).
// 대가로 창을 드래그하는 바로 그 순간에 한해 드롭다운 메뉴 위치가 살짝 어긋날 수
// 있지만(이 앱은 네이티브 드롭다운을 쓰지 않는다), 훨씬 자주 겪는 한글 입력
// 끊김을 막는 쪽이 낫다. 메모 창은 제목 표시줄 없이 드래그로만 옮기므로 더 그렇다.
#[cfg(target_os = "windows")]
mod win_ime_fix {
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::WM_ENTERSIZEMOVE;

    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _uidsubclass: usize,
        _dwrefdata: usize,
    ) -> LRESULT {
        if msg == WM_ENTERSIZEMOVE {
            return LRESULT(0);
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    /// 창 핸들에 서브클래스 프로시저를 설치한다. 앱이 실행되는 동안 계속 유지되며,
    /// 별도로 해제(RemoveWindowSubclass)하지 않아도 창이 파괴되면 자동으로 정리된다.
    pub fn install(hwnd: HWND) {
        unsafe {
            let _ = SetWindowSubclass(hwnd, Some(subclass_proc), 1, 0);
        }
    }
}

/// 우리가 만드는 모든 창(box·settings·note-*)에 설치한다.
pub fn install_ime_fix(window: &WebviewWindow) {
    #[cfg(target_os = "windows")]
    {
        if let Ok(hwnd) = window.hwnd() {
            win_ime_fix::install(hwnd);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
    }
}

/// 창/웹뷰 생성은 반드시 메인 스레드에서 해야 한다. 그런데 Tauri의 **동기** 커맨드는
/// 이미 메인 스레드 위에서 실행되므로, 거기서 `run_on_main_thread` + 결과 대기를 하면
/// 자기 자신을 기다리는 데드락이 된다(서재에서 앱 전체가 멈춘 적이 있다).
/// 그래서 창을 만드는 커맨드는 전부 `async fn`이고 — Tauri가 async 커맨드는 별도
/// 스레드에서 돌린다 — 그 안에서 이 함수를 부른다.
fn run_on_main<F>(app: &AppHandle, f: F) -> Result<(), String>
where
    F: FnOnce(&AppHandle) -> Result<(), String> + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let app_main = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(f(&app_main));
    })
    .map_err(|e| format!("창을 만들지 못했습니다: {e}"))?;
    rx.recv()
        .map_err(|e| format!("창을 만들지 못했습니다: {e}"))?
}

/// 메인 스레드가 아닌 곳에서 창을 건드리되 결과를 기다리지 않을 때(트레이 메뉴,
/// 전역 단축키 등 — 이미 메인 스레드일 수도 있어서 기다리면 데드락이다).
pub fn spawn_on_main<F>(app: &AppHandle, f: F)
where
    F: FnOnce(&AppHandle) + Send + 'static,
{
    let app_main = app.clone();
    let _ = app.run_on_main_thread(move || f(&app_main));
}

pub fn note_label(id: &str) -> String {
    format!("note-{id}")
}

// ── 위치 보정 ───────────────────────────────────────────────────────────────

/// 저장해 둔 위치가 어떤 모니터의 작업 영역과도 겹치지 않으면(모니터를 뽑았거나
/// 해상도가 바뀐 경우) 주 모니터 안으로 당긴다. 값은 전부 논리 픽셀이다.
fn clamp_to_monitors(app: &AppHandle, rect: WindowRect) -> WindowRect {
    let monitors = app.available_monitors().unwrap_or_default();
    let to_logical = |m: &tauri::Monitor| {
        let s = m.scale_factor();
        let wa = m.work_area();
        (
            wa.position.x as f64 / s,
            wa.position.y as f64 / s,
            wa.size.width as f64 / s,
            wa.size.height as f64 / s,
        )
    };

    // 창의 어느 한 귀퉁이라도 작업 영역에 걸쳐 있으면 그대로 둔다.
    let visible = monitors.iter().any(|m| {
        let (mx, my, mw, mh) = to_logical(m);
        rect.x < mx + mw && rect.x + rect.w > mx && rect.y < my + mh && rect.y + rect.h > my
    });
    if visible {
        return rect;
    }

    let primary = app
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.into_iter().next());
    let Some(primary) = primary else {
        return rect;
    };
    let (mx, my, mw, mh) = to_logical(&primary);
    let w = rect.w.min(mw);
    let h = rect.h.min(mh);
    WindowRect {
        x: (mx + (mw - w) / 2.0).round(),
        y: (my + (mh - h) / 2.0).round(),
        w,
        h,
    }
}

fn apply_rect(app: &AppHandle, window: &WebviewWindow, rect: WindowRect) {
    let rect = clamp_to_monitors(app, rect);
    let _ = window.set_size(LogicalSize::new(rect.w, rect.h));
    let _ = window.set_position(LogicalPosition::new(rect.x, rect.y));
}

// ── 창 만들기 ───────────────────────────────────────────────────────────────

/// 이미지 메모 창의 첫 크기(논리 픽셀). 가로를 320으로 두고 그림 비율대로 세로를 정한다.
/// 아주 납작한 그림이라도 손잡이와 가장자리를 잡을 수 있어야 해서 세로는 80 아래로
/// 내려가지 않는다. 이후 크기는 프런트가 비율을 지키며 바꾸고 Rust가 저장한다.
const IMAGE_WINDOW_WIDTH: f64 = 320.0;
const IMAGE_WINDOW_MIN_HEIGHT: f64 = 80.0;

pub fn image_window_size(w: u32, h: u32) -> (f64, f64) {
    if w == 0 || h == 0 {
        return (IMAGE_WINDOW_WIDTH, IMAGE_WINDOW_WIDTH);
    }
    let height = (IMAGE_WINDOW_WIDTH * h as f64 / w as f64).round();
    (IMAGE_WINDOW_WIDTH, height.max(IMAGE_WINDOW_MIN_HEIGHT))
}

/// 메모 창을 실제로 만든다. **메인 스레드에서만** 부를 것.
pub fn build_note_window(app: &AppHandle, note: &Note) -> Result<WebviewWindow, String> {
    // 빌더에 `.drag_and_drop(false)`를 체이닝하는 방식은 Tauri 쪽 버그
    // (tauri-apps/tauri#13761)로 간헐적으로 안 먹는다. 서재와 같이 WindowConfig를
    // 통째로 채워 from_config로 만든다.
    let mut config = WindowConfig {
        label: note_label(&note.id),
        url: WebviewUrl::App("index.html".into()),
        title: "메모핀".into(),
        width: 320.0,
        height: 320.0,
        min_width: Some(200.0),
        min_height: Some(140.0),
        resizable: true,
        decorations: false,
        shadow: true,
        skip_taskbar: true,
        always_on_top: note.always_on_top,
        drag_drop_enabled: false,
        ..Default::default()
    };
    // 이미지 메모는 그림 비율이 창 비율이다. 최소 높이도 함께 낮춰야 납작한 그림이
    // 140에 걸려 늘어나지 않는다.
    let image = match (note.kind, note.image.as_ref()) {
        (NoteKind::Image, Some(image)) => Some(image),
        _ => None,
    };
    if let Some(image) = image {
        config.min_height = Some(IMAGE_WINDOW_MIN_HEIGHT);
        let (w, h) = image_window_size(image.w, image.h);
        config.width = w;
        config.height = h;
    }
    // 크기는 만든 뒤에도 다시 맞추지만, 첫 프레임이 320×320으로 떴다가 줄어드는
    // 깜빡임을 줄이려고 설정에도 넣어 둔다.
    if let Some(rect) = note.window {
        config.width = rect.w;
        config.height = rect.h;
    }

    let window = WebviewWindowBuilder::from_config(app, &config)
        .map_err(|e| format!("메모 창을 만들지 못했습니다: {e}"))?
        .build()
        .map_err(|e| format!("메모 창을 만들지 못했습니다: {e}"))?;

    if let Some(rect) = note.window {
        apply_rect(app, &window, rect);
    }
    install_ime_fix(&window);
    attach_note_events(app, &window, &note.id);
    Ok(window)
}

/// 설정 창을 만든다. **메인 스레드에서만** 부를 것.
fn build_settings_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    let config = WindowConfig {
        label: "settings".into(),
        url: WebviewUrl::App("index.html".into()),
        title: "설정".into(),
        width: 520.0,
        height: 560.0,
        resizable: false,
        maximizable: false,
        drag_drop_enabled: false,
        ..Default::default()
    };
    let window = WebviewWindowBuilder::from_config(app, &config)
        .map_err(|e| format!("설정 창을 만들지 못했습니다: {e}"))?
        .build()
        .map_err(|e| format!("설정 창을 만들지 못했습니다: {e}"))?;
    install_ime_fix(&window);
    attach_hide_on_close(&window);
    Ok(window)
}

/// `box`·`settings`는 닫아도 숨기기만 한다. 종료는 트레이 "종료"뿐이다.
pub fn attach_hide_on_close(window: &WebviewWindow) {
    let w = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = w.hide();
        }
    });
}

// ── 메모 창 이벤트 ──────────────────────────────────────────────────────────

/// 메모 id → 위치 저장 예정 시각. 드래그 한 번에 이벤트가 수십 번 오므로
/// 마지막 이벤트로부터 500ms 조용해진 뒤 한 번만 저장한다.
static PENDING_SAVE: LazyLock<Mutex<HashMap<String, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn attach_note_events(app: &AppHandle, window: &WebviewWindow, id: &str) {
    let app_ev = app.clone();
    let id_ev = id.to_string();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            schedule_window_save(&app_ev, &id_ev);
        }
        WindowEvent::CloseRequested { .. } => {
            // 닫기 직전 500ms 안에 옮긴 위치가 디바운스에 걸려 버려지지 않게, 창이 아직 있을 때 바로 저장한다.
            save_window_rect(&app_ev, &id_ev);
            mark_closed(&app_ev, &id_ev);
        }
        WindowEvent::Destroyed => {
            // 트레이 "종료"로 앱이 내려가는 중이면 창 파괴는 사용자가 닫은 게 아니다.
            // 여기서 is_open을 내리면 다음 시작 때 아무 메모도 복원되지 않는다.
            if !QUITTING.load(Ordering::SeqCst) {
                mark_closed(&app_ev, &id_ev);
            }
        }
        _ => {}
    });
}

/// 앱 종료 절차가 시작됐는지. 트레이 "종료"가 올리고, 창 파괴 이벤트가 본다.
pub static QUITTING: AtomicBool = AtomicBool::new(false);

fn schedule_window_save(app: &AppHandle, id: &str) {
    let deadline = Instant::now() + Duration::from_millis(500);
    let already = {
        let Ok(mut map) = PENDING_SAVE.lock() else {
            return;
        };
        let already = map.contains_key(id);
        map.insert(id.to_string(), deadline);
        already
    };
    if already {
        return;
    }

    let app = app.clone();
    let id = id.to_string();
    std::thread::spawn(move || loop {
        let deadline = {
            let Ok(map) = PENDING_SAVE.lock() else {
                return;
            };
            match map.get(&id) {
                Some(d) => *d,
                None => return,
            }
        };
        let now = Instant::now();
        if deadline > now {
            std::thread::sleep(deadline - now);
            continue;
        }
        if let Ok(mut map) = PENDING_SAVE.lock() {
            map.remove(&id);
        }
        save_window_rect(&app, &id);
        return;
    });
}

/// 지금 창의 바깥 위치·크기를 논리 픽셀로 바꿔 저장한다. `updated_at`은 건드리지 않는다.
fn save_window_rect(app: &AppHandle, id: &str) {
    let Some(window) = app.get_webview_window(&note_label(id)) else {
        return;
    };
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let (Ok(position), Ok(size), Ok(scale)) = (
        window.outer_position(),
        window.outer_size(),
        window.scale_factor(),
    ) else {
        return;
    };
    if scale <= 0.0 {
        return;
    }
    let rect = WindowRect {
        x: (position.x as f64 / scale).round(),
        y: (position.y as f64 / scale).round(),
        w: (size.width as f64 / scale).round(),
        h: (size.height as f64 / scale).round(),
    };
    let state = app.state::<AppState>();
    let Ok(mut store) = state.store.lock() else {
        return;
    };
    if let Err(e) = store.set_window(id, rect) {
        eprintln!("메모 창 위치를 저장하지 못했습니다 ({id}): {e}");
    }
}

/// 창이 닫혔다. `is_open`을 내리고 알린다(source는 "system" — 사람이 누른 커맨드가 아니다).
fn mark_closed(app: &AppHandle, id: &str) {
    if let Ok(mut map) = PENDING_SAVE.lock() {
        map.remove(id);
    }
    let state = app.state::<AppState>();
    let changed = {
        let Ok(mut store) = state.store.lock() else {
            return;
        };
        // 아무것도 안 적은 텍스트 메모를 그냥 닫으면 메모함(휴지통 포함)에 남기지 않는다.
        // 새 메모를 열었다가 마음이 바뀌어 닫는 흔한 경우다. 프런트는 ✕를 누를 때 미저장분을
        // 먼저 flush하므로 여기서 보는 text는 최신이다.
        let empty = store
            .get_note(id)
            .map(|n| n.kind == NoteKind::Text && n.text.trim().is_empty())
            .unwrap_or(false);
        if empty {
            match store.purge_note(id) {
                Ok(()) => true,
                Err(e) => {
                    eprintln!("빈 메모를 지우지 못했습니다 ({id}): {e}");
                    false
                }
            }
        } else {
            match store.set_open(id, false) {
                Ok(changed) => changed,
                Err(_) => false,
            }
        }
    };
    if changed {
        emit_store_changed(app, "notes", vec![id.to_string()], "system");
    }
}

// ── 밖에서 부르는 것들 ──────────────────────────────────────────────────────

/// 메모 창을 연다(없으면 만들고, 있으면 앞으로). `is_open`을 올린다.
/// 메인 스레드가 아닌 곳(async 커맨드)에서 부를 것.
pub fn open_note(app: &AppHandle, id: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let note = {
        let store = state
            .store
            .lock()
            .map_err(|_| "저장소를 열지 못했습니다.".to_string())?;
        store.get_note(id)?
    };
    if note.deleted_at.is_some() {
        return Err("휴지통에 있는 메모입니다.".to_string());
    }

    let note_for_build = note.clone();
    run_on_main(app, move |app| {
        if let Some(window) = app.get_webview_window(&note_label(&note_for_build.id)) {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            return Ok(());
        }
        build_note_window(app, &note_for_build).map(|_| ())
    })?;

    let changed = {
        let mut store = state
            .store
            .lock()
            .map_err(|_| "저장소를 열지 못했습니다.".to_string())?;
        store.set_open(id, true)?
    };
    if changed {
        emit_store_changed(app, "notes", vec![id.to_string()], "system");
    }
    Ok(())
}

/// 메모 창을 파괴한다. `is_open`은 창 이벤트 쪽에서 내려간다.
pub fn close_note(app: &AppHandle, id: &str) -> Result<(), String> {
    let label = note_label(id);
    run_on_main(app, move |app| {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.destroy();
        }
        Ok(())
    })?;
    // 창이 아예 없던 경우에도 상태는 맞춰 둔다.
    mark_closed(app, id);
    Ok(())
}

/// 메모함을 보여 준다. 메인 스레드에서 불러도 안전하다(기다리지 않는다).
pub fn show_box(app: &AppHandle) {
    let Some(window) = app.get_webview_window("box") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// 설정 창을 보여 준다(없으면 만든다). 메인 스레드가 아닌 곳에서 부를 것.
pub fn show_settings(app: &AppHandle) -> Result<(), String> {
    run_on_main(app, |app| {
        if let Some(window) = app.get_webview_window("settings") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            return Ok(());
        }
        build_settings_window(app).map(|_| ())
    })
}

/// 트레이·단축키처럼 메인 스레드일 수도 있는 곳에서 쓰는 설정 창 열기.
pub fn show_settings_async(app: &AppHandle) {
    spawn_on_main(app, |app| {
        if let Some(window) = app.get_webview_window("settings") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            return;
        }
        if let Err(e) = build_settings_window(app) {
            eprintln!("{e}");
        }
    });
}

/// 앱을 켤 때 `is_open`인 메모를 전부 되살린다. setup(메인 스레드)에서 부른다.
pub fn restore_open_notes(app: &AppHandle) {
    let state = app.state::<AppState>();
    let notes: Vec<Note> = {
        let Ok(store) = state.store.lock() else {
            return;
        };
        store
            .list_notes()
            .into_iter()
            .filter(|n| n.is_open && n.deleted_at.is_none())
            .collect()
    };
    for note in notes {
        if let Err(e) = build_note_window(app, &note) {
            eprintln!("메모 창을 복원하지 못했습니다 ({}): {e}", note.id);
        }
    }
}

/// `always_on_top`이 바뀌면 열려 있는 창에 즉시 적용한다.
pub fn apply_always_on_top(app: &AppHandle, id: &str, value: bool) {
    if let Some(window) = app.get_webview_window(&note_label(id)) {
        let _ = window.set_always_on_top(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_window_keeps_the_picture_ratio() {
        assert_eq!(image_window_size(640, 480), (320.0, 240.0));
        assert_eq!(image_window_size(300, 300), (320.0, 320.0));
        // 세로로 긴 그림도 가로 320 기준이다.
        assert_eq!(image_window_size(900, 1600), (320.0, 569.0));
        // 아주 납작하면 최소 높이에서 멈춘다.
        assert_eq!(image_window_size(1000, 100), (320.0, 80.0));
        // 크기를 모르면 정사각형(텍스트 메모와 같은 320×320).
        assert_eq!(image_window_size(0, 0), (320.0, 320.0));
    }
}
