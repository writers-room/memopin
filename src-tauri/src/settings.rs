//! 기기별 설정. 동기화 대상이 아니라서 데이터 폴더가 아니라
//! `app_config_dir()/settings.json`에 둔다(계약: docs/contract.md "저장 위치").

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::store::{write_atomic, DEFAULT_COLOR, DEFAULT_FONT_SIZE};

pub const DEFAULT_SHORTCUT: &str = "CommandOrControl+Shift+N";
/// 메모함 편집 칸 글자 크기. 메모 창(`Note::font_size`)과 별개다 — 메모함은 목록을 훑는
/// 창이라 더 작게 보고 싶다는 요청에서 나왔다.
pub const DEFAULT_BOX_FONT_SIZE: u32 = 14;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    System,
    Light,
    Dark,
}

fn default_shortcut_enabled() -> bool {
    true
}
fn default_shortcut() -> String {
    DEFAULT_SHORTCUT.to_string()
}
fn default_theme() -> Theme {
    Theme::System
}
fn default_color() -> String {
    DEFAULT_COLOR.to_string()
}
fn default_font_size() -> u32 {
    DEFAULT_FONT_SIZE
}
fn default_box_font_size() -> u32 {
    DEFAULT_BOX_FONT_SIZE
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "default_shortcut_enabled")]
    pub shortcut_enabled: bool,
    #[serde(default = "default_shortcut")]
    pub shortcut: String,
    #[serde(default)]
    pub autostart: bool,
    #[serde(default = "default_theme")]
    pub theme: Theme,
    #[serde(default = "default_color")]
    pub default_color: String,
    #[serde(default = "default_font_size")]
    pub default_font_size: u32,
    /// 메모함 편집 칸 전용. 옛 settings.json에는 없으므로 serde default로 채운다.
    #[serde(default = "default_box_font_size")]
    pub box_font_size: u32,
    /// 최근 쓴 색(최신이 앞, 최대 10). 목록 관리는 프런트가 한다 — 여기서는 그대로 담아 둔다.
    #[serde(default)]
    pub recent_colors: Vec<String>,
    /// 즐겨찾는 색(최대 10). 마찬가지로 프런트가 관리한다.
    #[serde(default)]
    pub favorite_colors: Vec<String>,
    #[serde(default)]
    pub data_dir: Option<String>,
    /// 첫 실행 안내 메모를 만들었는지. 한 번 true가 되면 지워도 다시 만들지 않는다.
    #[serde(default)]
    pub guide_seeded: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            shortcut_enabled: true,
            shortcut: DEFAULT_SHORTCUT.to_string(),
            autostart: false,
            theme: Theme::System,
            default_color: DEFAULT_COLOR.to_string(),
            default_font_size: DEFAULT_FONT_SIZE,
            box_font_size: DEFAULT_BOX_FONT_SIZE,
            recent_colors: Vec::new(),
            favorite_colors: Vec::new(),
            data_dir: None,
            guide_seeded: false,
        }
    }
}

/// `update_settings`의 patch. `data_dir`은 "없음"과 "null"(기본 폴더로 되돌리기)을
/// 구분해야 해서 이중 Option이다.
#[derive(Debug, Default, Deserialize)]
pub struct SettingsPatch {
    #[serde(default)]
    pub shortcut_enabled: Option<bool>,
    #[serde(default)]
    pub shortcut: Option<String>,
    #[serde(default)]
    pub autostart: Option<bool>,
    #[serde(default)]
    pub theme: Option<Theme>,
    #[serde(default)]
    pub default_color: Option<String>,
    #[serde(default)]
    pub default_font_size: Option<u32>,
    #[serde(default)]
    pub box_font_size: Option<u32>,
    #[serde(default)]
    pub recent_colors: Option<Vec<String>>,
    #[serde(default)]
    pub favorite_colors: Option<Vec<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub data_dir: Option<Option<String>>,
    #[serde(default)]
    pub guide_seeded: Option<bool>,
}

fn double_option<'de, T, D>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(de).map(Some)
}

pub fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("설정 폴더를 찾지 못했습니다: {e}"))?;
    Ok(dir.join("settings.json"))
}

/// 없거나 깨졌으면 기본값으로 시작한다(설정 때문에 앱이 안 열리는 쪽이 더 나쁘다).
pub fn load<R: Runtime>(app: &AppHandle<R>) -> Settings {
    let path = match settings_path(app) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("{e}");
            return Settings::default();
        }
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Settings>(&text) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("설정 파일을 읽지 못해 기본값으로 시작합니다: {e}");
                Settings::default()
            }
        },
        Err(_) => Settings::default(),
    }
}

pub fn save<R: Runtime>(app: &AppHandle<R>, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    let text = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("설정을 저장하지 못했습니다: {e}"))?;
    write_atomic(&path, &text)
}

/// 설정의 `data_dir`이 null이면 기본 폴더(`app_data_dir()/data`).
pub fn resolve_data_dir<R: Runtime>(
    app: &AppHandle<R>,
    settings: &Settings,
) -> Result<PathBuf, String> {
    match settings.data_dir.as_deref() {
        Some(p) if !p.trim().is_empty() => Ok(Path::new(p).to_path_buf()),
        _ => default_data_dir(app),
    }
}

pub fn default_data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("데이터 폴더를 찾지 못했습니다: {e}"))?;
    Ok(dir.join("data"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// box_font_size가 없던 시절의 settings.json도 그대로 읽혀야 한다.
    #[test]
    fn old_settings_file_gets_default_box_font_size() {
        // "#FFF4A3"의 #이 r#"..."#을 끊어 버려서 울타리를 하나 더 둘렀다.
        let old = r##"{
            "shortcut_enabled": true,
            "shortcut": "CommandOrControl+Shift+N",
            "autostart": false,
            "theme": "dark",
            "default_color": "#FFF4A3",
            "default_font_size": 17,
            "data_dir": null
        }"##;
        let s: Settings = serde_json::from_str(old).unwrap();
        assert_eq!(s.box_font_size, DEFAULT_BOX_FONT_SIZE);
        assert_eq!(s.default_font_size, 17);
    }

    /// recent_colors / favorite_colors가 없던 시절의 settings.json은 빈 배열로 시작한다.
    #[test]
    fn old_settings_file_gets_empty_color_lists() {
        let old = r##"{
            "shortcut_enabled": true,
            "shortcut": "CommandOrControl+Shift+N",
            "autostart": false,
            "theme": "light",
            "default_color": "#FFF4A3",
            "default_font_size": 15,
            "box_font_size": 14,
            "data_dir": null
        }"##;
        let s: Settings = serde_json::from_str(old).unwrap();
        assert!(s.recent_colors.is_empty());
        assert!(s.favorite_colors.is_empty());
        // guide_seeded가 없던 시절의 파일은 false로 읽히지만, 그 사람은 이미 메모가
        // 있으므로 시작 절차가 안내 메모를 만들지 않고 표시만 해 둔다(lib.rs).
        assert!(!s.guide_seeded);

        let p: SettingsPatch = serde_json::from_str(r##"{"recent_colors": ["#123456"]}"##).unwrap();
        assert_eq!(p.recent_colors.as_deref(), Some(&["#123456".to_string()][..]));
        assert!(p.favorite_colors.is_none());
    }

    #[test]
    fn box_font_size_round_trips() {
        let s: Settings = serde_json::from_str(r#"{"box_font_size": 12}"#).unwrap();
        assert_eq!(s.box_font_size, 12);
        assert_eq!(s.default_font_size, DEFAULT_FONT_SIZE);
        let text = serde_json::to_string(&s).unwrap();
        assert!(text.contains("\"box_font_size\":12"), "{text}");
    }

    #[test]
    fn patch_carries_box_font_size_alone() {
        let p: SettingsPatch = serde_json::from_str(r#"{"box_font_size": 18}"#).unwrap();
        assert_eq!(p.box_font_size, Some(18));
        assert_eq!(p.default_font_size, None);
        assert!(p.data_dir.is_none());
    }
}
