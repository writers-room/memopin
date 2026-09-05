//! 전역 단축키 여섯 개(계약: docs/contract.md "## 전역 단축키").
//!
//! 등록은 표 순서대로 한다. 하나가 실패해도 나머지는 등록하고, 실패한 것만 id별로
//! `AppState::shortcut_errors`에 한국어로 남긴다(`shortcut_errors` 커맨드가 읽어 간다).
//! 단축키 등록 실패는 **에러가 아니다** — 설정은 저장되고 화면에 이유만 뜬다.
//!
//! 핸들러는 전부 메인 스레드에서 불릴 수 있으므로 창을 건드릴 때는 결과를 기다리지 않는
//! `windows::spawn_on_main`을 쓴다(기다리면 자기 자신을 기다리는 데드락이다).

use std::collections::BTreeMap;
use std::str::FromStr;

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::settings::{Settings, Shortcuts, SHORTCUT_IDS};
use crate::store::{CreateNoteInput, ImageNoteBytes, Note};
use crate::{emit_store_changed, windows, AppState};

/// 같은 조합을 두 동작이 쓸 때, 표에서 뒤에 오는 쪽.
pub const ERR_DUPLICATE: &str = "다른 동작과 같은 조합입니다";
/// 파서가 모르는 조합(사람이 settings.json을 손으로 고쳤거나 판이 달라진 경우).
pub const ERR_UNKNOWN: &str = "알 수 없는 조합입니다";
/// OS가 거절했다 — 거의 언제나 다른 프로그램이 선점한 경우다.
pub const ERR_TAKEN: &str = "다른 프로그램이 이미 쓰는 조합입니다";

/// 클립보드에서 가져오는 글의 최대 길이. 이보다 길면 앞부분만 담는다
/// (메모 하나에 소설 한 권이 들어오면 편집기가 버티지 못한다).
pub const MAX_CLIP_CHARS: usize = 80_000;

// ── 무엇을 등록할지 정하기 (순수 함수) ──────────────────────────────────────

/// 표 순서대로 훑어 "등록할 것"과 "왜 못 하는지"를 정한다.
/// 꺼져 있거나 조합이 비어 있는 id는 아예 목록에 넣지 않는다(실패가 아니라 지정 안 함).
/// 중복 판정은 문자열이 아니라 파싱된 조합으로 한다 — "Ctrl+Shift+N"과
/// "CommandOrControl+Shift+N"은 윈도우에서 같은 조합이다.
pub fn plan(shortcuts: &Shortcuts) -> Vec<(String, Result<Shortcut, String>)> {
    let mut taken: Vec<u32> = Vec::new();
    let mut planned: Vec<(String, Result<Shortcut, String>)> = Vec::new();

    for id in SHORTCUT_IDS {
        let Some(binding) = shortcuts.get(id) else {
            continue;
        };
        if !binding.enabled {
            continue;
        }
        let keys = binding.keys.trim();
        if keys.is_empty() {
            continue;
        }
        match Shortcut::from_str(keys) {
            Ok(parsed) if taken.contains(&parsed.id()) => {
                planned.push((id.to_string(), Err(ERR_DUPLICATE.to_string())));
            }
            Ok(parsed) => {
                taken.push(parsed.id());
                planned.push((id.to_string(), Ok(parsed)));
            }
            Err(_) => planned.push((id.to_string(), Err(ERR_UNKNOWN.to_string()))),
        }
    }
    planned
}

// ── 등록 ────────────────────────────────────────────────────────────────────

/// 기존 등록을 전부 해제하고 설정대로 다시 등록한다. 실패는 에러로 올리지 않고
/// `AppState::shortcut_errors`에 남긴다.
pub fn apply(app: &AppHandle, settings: &Settings) {
    let manager = app.global_shortcut();
    let _ = manager.unregister_all();

    let mut errors: BTreeMap<String, String> = BTreeMap::new();
    for (id, planned) in plan(&settings.shortcuts) {
        match planned {
            Err(reason) => {
                errors.insert(id, reason);
            }
            Ok(parsed) => {
                let action = id.clone();
                let result = manager.on_shortcut(parsed, move |app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        dispatch(app, &action);
                    }
                });
                if let Err(e) = result {
                    eprintln!("단축키를 등록하지 못했습니다 ({id}): {e}");
                    errors.insert(id, ERR_TAKEN.to_string());
                }
            }
        }
    }

    if let Ok(mut slot) = app.state::<AppState>().shortcut_errors.lock() {
        *slot = errors;
    }
}

fn dispatch(app: &AppHandle, id: &str) {
    match id {
        "new_note" => crate::new_note_from_system(app),
        "show_all" => show_all(app),
        "hide_all" => hide_all(app),
        "toggle_box" => toggle_box(app),
        "clip_text" => clip_text(app),
        "clip_image" => clip_image(app),
        _ => {}
    }
}

// ── 동작 ────────────────────────────────────────────────────────────────────

/// 지금 펼쳐져 있어야 할 메모(휴지통에 없고 `is_open`)들.
fn open_notes(app: &AppHandle) -> Vec<Note> {
    let state = app.state::<AppState>();
    let Ok(store) = state.store.lock() else {
        return Vec::new();
    };
    store
        .list_notes()
        .into_iter()
        .filter(|n| n.is_open && n.deleted_at.is_none())
        .collect()
}

/// 숨겨 둔 메모 창을 전부 다시 보인다. 창이 사라져 있으면 다시 만든다.
/// `is_open`은 이미 true이므로 저장소는 건드리지 않는다.
fn show_all(app: &AppHandle) {
    let notes = open_notes(app);
    windows::spawn_on_main(app, move |app| {
        for note in notes {
            match app.get_webview_window(&windows::note_label(&note.id)) {
                Some(window) => {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                None => {
                    if let Err(e) = windows::build_note_window(app, &note) {
                        eprintln!("메모 창을 다시 열지 못했습니다 ({}): {e}", note.id);
                    }
                }
            }
        }
    });
}

/// 메모 창을 전부 숨긴다. 닫는 게 아니므로 `is_open`은 그대로다
/// (재시작이나 show_all 때 그대로 돌아온다).
fn hide_all(app: &AppHandle) {
    let ids: Vec<String> = open_notes(app).into_iter().map(|n| n.id).collect();
    windows::spawn_on_main(app, move |app| {
        for id in ids {
            if let Some(window) = app.get_webview_window(&windows::note_label(&id)) {
                let _ = window.hide();
            }
        }
    });
}

/// 메모함이 보이면서 포커스까지 있으면 숨기고, 아니면 앞으로 가져온다.
/// (보이지만 뒤에 깔려 있을 때 누르면 앞으로 오는 쪽이 자연스럽다.)
fn toggle_box(app: &AppHandle) {
    windows::spawn_on_main(app, |app| {
        let Some(window) = app.get_webview_window("box") else {
            return;
        };
        let visible = window.is_visible().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = window.hide();
        } else {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    });
}

// ── 클립보드 ────────────────────────────────────────────────────────────────

/// 클립보드의 글로 메모를 만들고 창까지 연다. 글이 없으면 아무 일도 하지 않는다.
fn clip_text(app: &AppHandle) {
    let raw = match arboard::Clipboard::new().and_then(|mut c| c.get_text()) {
        Ok(text) => text,
        Err(arboard::Error::ContentNotAvailable) => return,
        Err(e) => {
            eprintln!("클립보드의 글을 읽지 못했습니다: {e}");
            return;
        }
    };
    if raw.trim().is_empty() {
        return;
    }
    let (html, text) = clip_body(&raw);
    crate::open_new_note(
        app,
        CreateNoteInput {
            html: Some(html),
            text: Some(text),
            ..Default::default()
        },
    );
}

/// 클립보드 글 → (본문 HTML, 평문). 줄마다 `<p>`, 빈 줄은 `<p><br></p>`.
/// 줄바꿈은 먼저 `\n`으로 맞춘다(윈도우 클립보드는 CRLF로 온다).
pub fn clip_body(raw: &str) -> (String, String) {
    let text: String = raw
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .take(MAX_CLIP_CHARS)
        .collect();
    let html = text
        .split('\n')
        .map(|line| {
            if line.is_empty() {
                "<p><br></p>".to_string()
            } else {
                format!("<p>{}</p>", escape_html(line))
            }
        })
        .collect::<String>();
    (html, text)
}

fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
    out
}

/// 클립보드의 그림으로 이미지 메모를 만들고 창까지 연다. 그림이 없으면 아무 일도 하지 않는다.
fn clip_image(app: &AppHandle) {
    let image = match arboard::Clipboard::new().and_then(|mut c| c.get_image()) {
        Ok(image) => image,
        Err(arboard::Error::ContentNotAvailable) => return,
        Err(e) => {
            eprintln!("클립보드의 그림을 읽지 못했습니다: {e}");
            return;
        }
    };
    let (w, h) = (image.width as u32, image.height as u32);
    if w == 0 || h == 0 {
        return;
    }
    let bytes = match encode_png(&image.bytes, w, h) {
        Ok(bytes) => bytes,
        Err(e) => {
            eprintln!("{e}");
            return;
        }
    };

    let state = app.state::<AppState>();
    let (color, font_size) = match state.settings.lock() {
        Ok(s) => (s.default_color.clone(), s.default_font_size),
        Err(_) => (
            crate::store::DEFAULT_COLOR.to_string(),
            crate::store::DEFAULT_FONT_SIZE,
        ),
    };
    let name = format!(
        "붙여넣은 이미지 {}.png",
        chrono::Local::now().format("%Y-%m-%d %H-%M")
    );

    let note = {
        let Ok(mut store) = state.store.lock() else {
            eprintln!("저장소를 열지 못해 이미지 메모를 만들지 못했습니다.");
            return;
        };
        let input = ImageNoteBytes {
            bytes,
            name,
            w,
            h,
            category_id: None,
            favorite: false,
        };
        match store.create_image_note_bytes(input, &color, font_size) {
            Ok(note) => {
                let _ = store.set_open(&note.id, true);
                store.get_note(&note.id).unwrap_or(note)
            }
            Err(e) => {
                eprintln!("이미지 메모를 만들지 못했습니다: {e}");
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

/// 클립보드에서 온 RGBA를 PNG로. 이미지 메모는 언제나 `images/<id>.png`다.
fn encode_png(rgba: &[u8], w: u32, h: u32) -> Result<Vec<u8>, String> {
    let expected = (w as usize) * (h as usize) * 4;
    if rgba.len() < expected {
        return Err("클립보드의 그림이 온전하지 않습니다.".to_string());
    }
    let mut out: Vec<u8> = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, w, h);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder
        .write_header()
        .map_err(|e| format!("그림을 저장하지 못했습니다: {e}"))?;
    writer
        .write_image_data(&rgba[..expected])
        .map_err(|e| format!("그림을 저장하지 못했습니다: {e}"))?;
    writer
        .finish()
        .map_err(|e| format!("그림을 저장하지 못했습니다: {e}"))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{default_shortcuts, ShortcutBinding};

    fn set(map: &mut Shortcuts, id: &str, enabled: bool, keys: &str) {
        map.insert(
            id.to_string(),
            ShortcutBinding {
                enabled,
                keys: keys.to_string(),
            },
        );
    }

    fn ids(planned: &[(String, Result<Shortcut, String>)]) -> Vec<&str> {
        planned.iter().map(|(id, _)| id.as_str()).collect()
    }

    /// 기본값은 여섯 개 모두 등록 대상이고 순서는 계약의 표 순서다.
    #[test]
    fn defaults_all_register_in_table_order() {
        let planned = plan(&default_shortcuts());
        assert_eq!(
            ids(&planned),
            vec![
                "new_note",
                "show_all",
                "hide_all",
                "toggle_box",
                "clip_text",
                "clip_image"
            ]
        );
        assert!(planned.iter().all(|(_, r)| r.is_ok()));
    }

    /// 꺼져 있거나 조합이 비어 있으면 목록에 아예 없다(실패가 아니다).
    #[test]
    fn disabled_and_empty_are_skipped() {
        let mut map = default_shortcuts();
        set(&mut map, "show_all", false, "CommandOrControl+Shift+Up");
        set(&mut map, "hide_all", true, "   ");
        let planned = plan(&map);
        assert_eq!(
            ids(&planned),
            vec!["new_note", "toggle_box", "clip_text", "clip_image"]
        );
    }

    /// 같은 조합이면 표에서 앞선 쪽만 등록되고 뒤가 실패한다. 표기가 달라도 같은 조합이다.
    #[test]
    fn later_duplicate_fails() {
        let mut map = default_shortcuts();
        set(&mut map, "hide_all", true, "Ctrl+Shift+N");
        let planned = plan(&map);
        let new_note = planned.iter().find(|(id, _)| id == "new_note").unwrap();
        let hide_all = planned.iter().find(|(id, _)| id == "hide_all").unwrap();
        assert!(new_note.1.is_ok());
        assert_eq!(hide_all.1.as_ref().unwrap_err(), ERR_DUPLICATE);
        // 앞의 것은 그대로 등록되고 나머지도 영향을 받지 않는다.
        assert_eq!(planned.iter().filter(|(_, r)| r.is_err()).count(), 1);
    }

    #[test]
    fn unparsable_keys_fail_alone() {
        let mut map = default_shortcuts();
        set(&mut map, "toggle_box", true, "Ctrl+Shift+없는키");
        let planned = plan(&map);
        let toggle = planned.iter().find(|(id, _)| id == "toggle_box").unwrap();
        assert_eq!(toggle.1.as_ref().unwrap_err(), ERR_UNKNOWN);
        assert_eq!(planned.iter().filter(|(_, r)| r.is_err()).count(), 1);
    }

    /// 프런트는 화살표를 `Up`/`Down`으로 보낸다. 파서가 `ArrowUp`/`ArrowDown`과
    /// 같은 것으로 받아 주는지 확인해 둔다(다르면 변환을 넣어야 한다).
    #[test]
    fn arrow_key_names_are_the_same_shortcut() {
        let up = Shortcut::from_str("CommandOrControl+Shift+Up").unwrap();
        let arrow_up = Shortcut::from_str("CommandOrControl+Shift+ArrowUp").unwrap();
        assert_eq!(up.id(), arrow_up.id());
        let down = Shortcut::from_str("CommandOrControl+Shift+Down").unwrap();
        let arrow_down = Shortcut::from_str("CommandOrControl+Shift+ArrowDown").unwrap();
        assert_eq!(down.id(), arrow_down.id());

        // 두 표기를 서로 다른 동작에 넣으면 중복으로 잡혀야 한다.
        let mut map = default_shortcuts();
        set(&mut map, "hide_all", true, "CommandOrControl+Shift+ArrowUp");
        let planned = plan(&map);
        let hide_all = planned.iter().find(|(id, _)| id == "hide_all").unwrap();
        assert_eq!(hide_all.1.as_ref().unwrap_err(), ERR_DUPLICATE);
    }

    #[test]
    fn clip_text_becomes_paragraphs() {
        let (html, text) = clip_body("첫 줄\r\n\r\n<b>둘</b> & 셋\r");
        assert_eq!(
            html,
            "<p>첫 줄</p><p><br></p><p>&lt;b&gt;둘&lt;/b&gt; &amp; 셋</p><p><br></p>"
        );
        assert_eq!(text, "첫 줄\n\n<b>둘</b> & 셋\n");
    }

    #[test]
    fn clip_text_stops_at_the_limit() {
        let raw = "가".repeat(MAX_CLIP_CHARS + 100);
        let (html, text) = clip_body(&raw);
        assert_eq!(text.chars().count(), MAX_CLIP_CHARS);
        assert_eq!(html.chars().count(), MAX_CLIP_CHARS + "<p></p>".len());
    }

    #[test]
    fn png_encoding_makes_a_real_png() {
        let rgba = vec![0u8; 2 * 2 * 4];
        let bytes = encode_png(&rgba, 2, 2).unwrap();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        // 크기가 모자라면 만들지 않는다.
        assert!(encode_png(&rgba, 4, 4).is_err());
    }
}
