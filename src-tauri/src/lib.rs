//! 메모핀. Rust가 유일한 저장소이고 창은 전부 커맨드로 읽고 쓴다.
//! 프런트와의 약속은 `docs/contract.md`가 원본이다.

pub mod commands;
pub mod guide;
pub mod protocol;
pub mod settings;
pub mod shortcut;
pub mod store;
pub mod tray;
pub mod watcher;
pub mod windows;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::settings::Settings;
use crate::store::{CreateNoteInput, Store};
use crate::watcher::DataWatcher;

pub struct AppState {
    pub store: Mutex<Store>,
    pub settings: Mutex<Settings>,
    /// 데이터 폴더가 바뀌면 통째로 갈아 끼운다(옛 감시자는 떨어지면서 정리된다).
    pub watcher: Mutex<Option<DataWatcher>>,
    /// 등록에 실패한 전역 단축키(id → 한국어 이유). `shortcut::apply`가 매번 통째로 채운다.
    pub shortcut_errors: Mutex<BTreeMap<String, String>>,
}

#[derive(Clone, Serialize)]
pub struct StoreChanged {
    pub kind: String,
    pub ids: Vec<String>,
    pub source: String,
}

/// `source`는 변경을 일으킨 창 라벨. 파일 감시면 "fs", 트레이·단축키·시작 복원이면 "system".
pub fn emit_store_changed(app: &AppHandle, kind: &str, ids: Vec<String>, source: &str) {
    let _ = app.emit(
        "store:changed",
        StoreChanged {
            kind: kind.to_string(),
            ids,
            source: source.to_string(),
        },
    );
}

pub fn emit_settings_changed(app: &AppHandle, settings: &Settings) {
    let _ = app.emit("settings:changed", settings.clone());
}

/// 트레이 "새 메모"와 전역 단축키 `new_note`가 함께 쓰는 동작.
pub fn new_note_from_system(app: &AppHandle) {
    open_new_note(app, CreateNoteInput::default());
}

/// 메모를 만들고 곧바로 창까지 연다(트레이·전역 단축키 공용).
/// 이 함수는 메인 스레드에서 불릴 수도 있으므로 창 생성 결과를 기다리지 않는다.
pub fn open_new_note(app: &AppHandle, input: CreateNoteInput) {
    let state = app.state::<AppState>();
    let (color, font_size) = match state.settings.lock() {
        Ok(s) => (s.default_color.clone(), s.default_font_size),
        Err(_) => (store::DEFAULT_COLOR.to_string(), store::DEFAULT_FONT_SIZE),
    };

    let note = {
        let Ok(mut store) = state.store.lock() else {
            eprintln!("저장소를 열지 못해 새 메모를 만들지 못했습니다.");
            return;
        };
        // 창 위치는 지정하지 않는다(null) — OS가 알아서 놓는다.
        match store.create_note(input, &color, font_size) {
            Ok(note) => {
                let _ = store.set_open(&note.id, true);
                match store.get_note(&note.id) {
                    Ok(n) => n,
                    Err(_) => note,
                }
            }
            Err(e) => {
                eprintln!("새 메모를 만들지 못했습니다: {e}");
                return;
            }
        }
    };

    emit_store_changed(app, "notes", vec![note.id.clone()], "system");
    windows::spawn_on_main(app, move |app| {
        if let Err(e) = windows::build_note_window(app, &note) {
            eprintln!("{e}");
        }
    });
}

/// 데이터 폴더를 바꾼다(`set_data_dir`, 그리고 `update_settings`의 data_dir).
/// 대상 폴더가 비어 있으면 지금 데이터를 복사하고, 이미 메모가 있으면 그것을 읽어 들인다.
pub fn apply_data_dir(
    app: &AppHandle,
    path: Option<String>,
    source: &str,
) -> Result<Settings, String> {
    let state = app.state::<AppState>();
    let normalized = path
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty());
    let new_dir: PathBuf = match &normalized {
        Some(p) => PathBuf::from(p),
        None => settings::default_data_dir(app)?,
    };
    std::fs::create_dir_all(&new_dir).map_err(|e| format!("데이터 폴더를 만들지 못했습니다: {e}"))?;

    {
        let mut store = state
            .store
            .lock()
            .map_err(|_| "저장소를 열지 못했습니다.".to_string())?;
        let current_dir = store.dir().to_path_buf();
        if current_dir != new_dir && !store::dir_has_data(&new_dir) {
            store::copy_data(&current_dir, &new_dir)?;
        }
        *store = Store::load(&new_dir)?;
    }

    {
        let mut s = state
            .settings
            .lock()
            .map_err(|_| "설정을 열지 못했습니다.".to_string())?;
        s.data_dir = normalized;
        settings::save(app, &s)?;
    }

    match watcher::start(app, &new_dir) {
        Ok(w) => {
            if let Ok(mut slot) = state.watcher.lock() {
                *slot = Some(w);
            }
        }
        Err(e) => {
            // 감시가 안 되더라도 앱은 쓸 수 있어야 한다. 바깥 변경만 못 따라올 뿐이다.
            eprintln!("{e}");
            if let Ok(mut slot) = state.watcher.lock() {
                *slot = None;
            }
        }
    }

    emit_store_changed(app, "all", Vec::new(), source);
    let current = state
        .settings
        .lock()
        .map_err(|_| "설정을 열지 못했습니다.".to_string())?
        .clone();
    emit_settings_changed(app, &current);
    Ok(current)
}

pub fn apply_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|e| format!("시작 프로그램 등록을 바꾸지 못했습니다: {e}"))
}

pub fn run() {
    // 단일 인스턴스는 반드시 다른 어떤 플러그인보다 먼저 등록해야 한다(공식 문서).
    // 두 번째 실행은 메모함만 보여 주고 끝난다.
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            windows::show_box(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        // 이미지 메모의 그림. 데이터 폴더가 언제든 바뀌므로 요청마다 지금 폴더에서 읽는다.
        .register_uri_scheme_protocol(protocol::SCHEME, protocol::handle);

    builder
        .invoke_handler(tauri::generate_handler![
            commands::list_notes,
            commands::get_note,
            commands::create_note,
            commands::update_note,
            commands::delete_note,
            commands::restore_note,
            commands::purge_note,
            commands::empty_trash,
            commands::create_image_note,
            commands::read_image_file,
            commands::list_categories,
            commands::create_category,
            commands::rename_category,
            commands::delete_category,
            commands::open_note_window,
            commands::close_note_window,
            commands::show_box,
            commands::show_settings,
            commands::get_settings,
            commands::update_settings,
            commands::shortcut_errors,
            commands::pick_data_dir,
            commands::set_data_dir,
            commands::app_version,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            let mut loaded = settings::load(&handle);
            let data_dir = settings::resolve_data_dir(&handle, &loaded)?;
            let mut store = Store::load(&data_dir)?;

            // 첫 실행 안내 메모. 처음 켠 사람에게만 두 장을 만들어 두고, 이미 메모가
            // 있는 사람에게는 만들지 않되 다시 묻지 않도록 표시만 해 둔다.
            // 아래 restore_open_notes가 이 메모들의 창을 자연히 띄운다.
            if !loaded.guide_seeded {
                let seeded = if guide::needs_seed(loaded.guide_seeded, &store.list_notes()) {
                    match guide::seed(&mut store, loaded.default_font_size) {
                        Ok(_) => true,
                        Err(e) => {
                            eprintln!("안내 메모를 만들지 못했습니다: {e}");
                            false
                        }
                    }
                } else {
                    true
                };
                if seeded {
                    loaded.guide_seeded = true;
                    if let Err(e) = settings::save(&handle, &loaded) {
                        eprintln!("{e}");
                    }
                }
            }

            let autostart_wanted = loaded.autostart;
            let settings_for_shortcut = loaded.clone();

            app.manage(AppState {
                store: Mutex::new(store),
                settings: Mutex::new(loaded),
                watcher: Mutex::new(None),
                shortcut_errors: Mutex::new(BTreeMap::new()),
            });

            match watcher::start(&handle, &data_dir) {
                Ok(w) => {
                    if let Ok(mut slot) = handle.state::<AppState>().watcher.lock() {
                        *slot = Some(w);
                    }
                }
                Err(e) => eprintln!("{e}"),
            }

            if let Err(e) = tray::setup(&handle) {
                eprintln!("{e}");
            }
            // 실패한 것은 `shortcut_errors` 커맨드로 설정 화면이 읽어 간다.
            shortcut::apply(&handle, &settings_for_shortcut);

            // 설정과 실제 등록 상태가 어긋나 있으면(재설치 등) 설정 쪽으로 맞춘다.
            {
                use tauri_plugin_autostart::ManagerExt;
                match handle.autolaunch().is_enabled() {
                    Ok(actual) if actual != autostart_wanted => {
                        if let Err(e) = apply_autostart(&handle, autostart_wanted) {
                            eprintln!("{e}");
                        }
                    }
                    Ok(_) => {}
                    Err(e) => eprintln!("시작 프로그램 상태를 읽지 못했습니다: {e}"),
                }
            }

            // 메모함 창은 tauri.conf.json에 visible:false로 선언돼 있다.
            if let Some(window) = handle.get_webview_window("box") {
                windows::install_ime_fix(&window);
                windows::attach_hide_on_close(&window);
                if !std::env::args().any(|a| a == "--hidden") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }

            windows::restore_open_notes(&handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("메모핀을 실행하지 못했습니다");
}
