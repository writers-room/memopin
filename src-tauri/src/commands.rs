//! 프런트가 부르는 커맨드 전부. 이름·인자·반환은 `docs/contract.md`가 원본이다.
//! 모든 에러 문자열은 사용자에게 그대로 보여 줄 수 있는 한국어다.

use tauri::{AppHandle, Manager, State, Window};

use crate::settings::{self, Settings, SettingsPatch};
use crate::store::{Category, CreateNoteInput, Note, NotePatch, Store};
use crate::{emit_settings_changed, emit_store_changed, windows, AppState};

type Res<T> = Result<T, String>;

fn lock_store<'a>(state: &'a State<'_, AppState>) -> Res<std::sync::MutexGuard<'a, Store>> {
    state
        .store
        .lock()
        .map_err(|_| "저장소를 열지 못했습니다.".to_string())
}

fn lock_settings<'a>(state: &'a State<'_, AppState>) -> Res<std::sync::MutexGuard<'a, Settings>> {
    state
        .settings
        .lock()
        .map_err(|_| "설정을 열지 못했습니다.".to_string())
}

// ── 메모 ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_notes(state: State<'_, AppState>) -> Res<Vec<Note>> {
    Ok(lock_store(&state)?.list_notes())
}

#[tauri::command]
pub fn get_note(id: String, state: State<'_, AppState>) -> Res<Note> {
    lock_store(&state)?.get_note(&id)
}

#[tauri::command]
pub fn create_note(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    input: Option<CreateNoteInput>,
) -> Res<Note> {
    let (color, font_size) = {
        let s = lock_settings(&state)?;
        (s.default_color.clone(), s.default_font_size)
    };
    let note = lock_store(&state)?.create_note(input.unwrap_or_default(), &color, font_size)?;
    emit_store_changed(&app, "notes", vec![note.id.clone()], window.label());
    Ok(note)
}

#[tauri::command]
pub fn update_note(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    id: String,
    patch: NotePatch,
) -> Res<Note> {
    let always_on_top = patch.always_on_top;
    let note = lock_store(&state)?.update_note(&id, patch)?;
    if let Some(value) = always_on_top {
        windows::apply_always_on_top(&app, &id, value);
    }
    emit_store_changed(&app, "notes", vec![id], window.label());
    Ok(note)
}

/// 휴지통으로. 창이 열려 있으면 닫는다. 창을 파괴해야 해서 async다(windows.rs 주석 참고).
#[tauri::command]
pub async fn delete_note(app: AppHandle, window: Window, id: String) -> Res<()> {
    windows::close_note(&app, &id)?;
    {
        let state = app.state::<AppState>();
        lock_store(&state)?.delete_note(&id)?;
    }
    emit_store_changed(&app, "notes", vec![id], window.label());
    Ok(())
}

#[tauri::command]
pub fn restore_note(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    id: String,
) -> Res<()> {
    lock_store(&state)?.restore_note(&id)?;
    emit_store_changed(&app, "notes", vec![id], window.label());
    Ok(())
}

#[tauri::command]
pub async fn purge_note(app: AppHandle, window: Window, id: String) -> Res<()> {
    windows::close_note(&app, &id)?;
    {
        let state = app.state::<AppState>();
        lock_store(&state)?.purge_note(&id)?;
    }
    emit_store_changed(&app, "notes", vec![id], window.label());
    Ok(())
}

#[tauri::command]
pub async fn empty_trash(app: AppHandle, window: Window) -> Res<()> {
    let trashed: Vec<String> = {
        let state = app.state::<AppState>();
        let store = lock_store(&state)?;
        store
            .list_notes()
            .into_iter()
            .filter(|n| n.deleted_at.is_some())
            .map(|n| n.id)
            .collect()
    };
    for id in &trashed {
        windows::close_note(&app, id)?;
    }
    let ids = {
        let state = app.state::<AppState>();
        let mut store = lock_store(&state)?;
        store.empty_trash()?
    };
    if !ids.is_empty() {
        emit_store_changed(&app, "notes", ids, window.label());
    }
    Ok(())
}

// ── 카테고리 ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_categories(state: State<'_, AppState>) -> Res<Vec<Category>> {
    Ok(lock_store(&state)?.list_categories())
}

#[tauri::command]
pub fn create_category(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    name: String,
) -> Res<Category> {
    let category = lock_store(&state)?.create_category(&name)?;
    emit_store_changed(
        &app,
        "categories",
        vec![category.id.clone()],
        window.label(),
    );
    Ok(category)
}

#[tauri::command]
pub fn rename_category(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Res<Category> {
    let category = lock_store(&state)?.rename_category(&id, &name)?;
    emit_store_changed(&app, "categories", vec![id], window.label());
    Ok(category)
}

/// 카테고리를 지우면 거기 속한 메모의 `category_id`도 null이 되므로 kind는 "all"이다.
#[tauri::command]
pub fn delete_category(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    id: String,
) -> Res<()> {
    let affected = lock_store(&state)?.delete_category(&id)?;
    let mut ids = vec![id];
    ids.extend(affected);
    emit_store_changed(&app, "all", ids, window.label());
    Ok(())
}

// ── 창 ──────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn open_note_window(app: AppHandle, id: String) -> Res<()> {
    windows::open_note(&app, &id)
}

#[tauri::command]
pub async fn close_note_window(app: AppHandle, id: String) -> Res<()> {
    windows::close_note(&app, &id)
}

#[tauri::command]
pub async fn show_box(app: AppHandle) -> Res<()> {
    windows::show_box(&app);
    Ok(())
}

#[tauri::command]
pub async fn show_settings(app: AppHandle) -> Res<()> {
    windows::show_settings(&app)
}

// ── 설정 ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Res<Settings> {
    Ok(lock_settings(&state)?.clone())
}

/// shortcut / shortcut_enabled / autostart는 저장한 뒤 곧바로 적용한다.
/// 적용에 실패해도 나머지 값은 저장하고, 에러 문자열만 돌려준다(계약).
#[tauri::command]
pub fn update_settings(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    patch: SettingsPatch,
) -> Res<Settings> {
    // data_dir은 폴더를 옮기거나 읽어 들이는 일까지 해야 해서 set_data_dir과 같은 길을 탄다.
    if let Some(dir) = patch.data_dir.clone() {
        crate::apply_data_dir(&app, dir, window.label())?;
    }

    let touched_shortcut = patch.shortcut_enabled.is_some() || patch.shortcut.is_some();
    let touched_autostart = patch.autostart.is_some();
    {
        let mut s = lock_settings(&state)?;
        if let Some(v) = patch.shortcut_enabled {
            s.shortcut_enabled = v;
        }
        if let Some(v) = patch.shortcut {
            s.shortcut = v;
        }
        if let Some(v) = patch.autostart {
            s.autostart = v;
        }
        if let Some(v) = patch.theme {
            s.theme = v;
        }
        if let Some(v) = patch.default_color {
            s.default_color = v;
        }
        if let Some(v) = patch.default_font_size {
            s.default_font_size = v;
        }
        if let Some(v) = patch.box_font_size {
            s.box_font_size = v;
        }
        settings::save(&app, &s)?;
    }

    let current = lock_settings(&state)?.clone();
    emit_settings_changed(&app, &current);

    let mut failure: Option<String> = None;
    if touched_shortcut {
        if let Err(e) = crate::shortcut::apply(&app, &current) {
            failure = Some(e);
        }
    }
    if touched_autostart {
        if let Err(e) = crate::apply_autostart(&app, current.autostart) {
            failure = Some(failure.map_or(e.clone(), |prev| format!("{prev}\n{e}")));
        }
    }
    match failure {
        Some(e) => Err(e),
        None => Ok(current),
    }
}

#[tauri::command]
pub async fn pick_data_dir(app: AppHandle) -> Res<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    // async 커맨드라 메인 스레드가 아니다 — blocking 버전을 써도 안전하다.
    let picked = app.dialog().file().blocking_pick_folder();
    match picked {
        Some(file) => {
            let path = file
                .into_path()
                .map_err(|e| format!("폴더 경로를 읽지 못했습니다: {e}"))?;
            Ok(Some(path.to_string_lossy().to_string()))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub fn set_data_dir(app: AppHandle, window: Window, path: Option<String>) -> Res<Settings> {
    crate::apply_data_dir(&app, path, window.label())
}

// ── 기타 ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn app_version(app: AppHandle) -> Res<String> {
    Ok(app.package_info().version.to_string())
}
