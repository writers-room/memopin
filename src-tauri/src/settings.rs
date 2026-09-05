//! 기기별 설정. 동기화 대상이 아니라서 데이터 폴더가 아니라
//! `app_config_dir()/settings.json`에 둔다(계약: docs/contract.md "저장 위치").

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::store::{write_atomic, DEFAULT_COLOR, DEFAULT_FONT_SIZE};

/// 전역 단축키의 종류와 **등록 순서**(계약 문서 "## 전역 단축키"의 표 순서).
/// 같은 조합을 둘이 쓰면 이 순서에서 앞선 쪽만 등록된다.
pub const SHORTCUT_IDS: [&str; 6] = [
    "new_note",
    "show_all",
    "hide_all",
    "toggle_box",
    "clip_text",
    "clip_image",
];

/// id별 기본 조합. `src/types.ts`의 `DEFAULT_SHORTCUTS`와 글자 그대로 같아야 한다.
pub fn default_shortcut_keys(id: &str) -> &'static str {
    match id {
        "new_note" => "CommandOrControl+Shift+N",
        "show_all" => "CommandOrControl+Shift+Up",
        "hide_all" => "CommandOrControl+Shift+Down",
        "toggle_box" => "CommandOrControl+Shift+M",
        "clip_text" => "CommandOrControl+Shift+V",
        "clip_image" => "CommandOrControl+Shift+I",
        _ => "",
    }
}

/// 메모함 편집 칸 글자 크기. 메모 창(`Note::font_size`)과 별개다 — 메모함은 목록을 훑는
/// 창이라 더 작게 보고 싶다는 요청에서 나왔다.
pub const DEFAULT_BOX_FONT_SIZE: u32 = 14;

/// 단축키 하나. `keys`가 빈 문자열이면 "지정 안 함"이라 등록하지 않는다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShortcutBinding {
    pub enabled: bool,
    pub keys: String,
}

pub type Shortcuts = BTreeMap<String, ShortcutBinding>;

pub fn default_shortcuts() -> Shortcuts {
    let mut map = Shortcuts::new();
    fill_missing_shortcuts(&mut map);
    map
}

/// 빠진 id를 기본값으로 채운다. 모르는 id는 건드리지 않는다(다음 판에서 늘어난 것일 수 있다).
pub fn fill_missing_shortcuts(map: &mut Shortcuts) {
    for id in SHORTCUT_IDS {
        map.entry(id.to_string()).or_insert_with(|| ShortcutBinding {
            enabled: true,
            keys: default_shortcut_keys(id).to_string(),
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    System,
    Light,
    Dark,
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

/// 읽기는 `RawSettings`를 거친다(아래 `From`이 옛 파일을 새 모양으로 옮긴다).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(from = "RawSettings")]
pub struct Settings {
    /// 전역 단축키 여섯. 파일에 없거나 빠진 id는 기본값으로 채워진다.
    pub shortcuts: Shortcuts,
    pub autostart: bool,
    pub theme: Theme,
    pub default_color: String,
    pub default_font_size: u32,
    /// 메모함 편집 칸 전용.
    pub box_font_size: u32,
    /// 최근 쓴 색(최신이 앞, 최대 10). 목록 관리는 프런트가 한다 — 여기서는 그대로 담아 둔다.
    pub recent_colors: Vec<String>,
    /// 즐겨찾는 색(최대 10). 마찬가지로 프런트가 관리한다.
    pub favorite_colors: Vec<String>,
    pub data_dir: Option<String>,
    /// 첫 실행 안내 메모를 만들었는지. 한 번 true가 되면 지워도 다시 만들지 않는다.
    pub guide_seeded: bool,
}

/// 파일에서 읽히는 모양. 빠진 칸은 serde default로, 옛 칸(`shortcut`·`shortcut_enabled`)은
/// 여기서만 받아 `From`이 `shortcuts.new_note`로 옮긴다(저장할 때는 다시 쓰지 않는다).
#[derive(Debug, Deserialize)]
struct RawSettings {
    #[serde(default)]
    shortcuts: Option<Shortcuts>,
    /// 옛 파일 전용. 단축키가 하나뿐이던 시절의 조합.
    #[serde(default)]
    shortcut: Option<String>,
    /// 옛 파일 전용.
    #[serde(default)]
    shortcut_enabled: Option<bool>,
    #[serde(default)]
    autostart: bool,
    #[serde(default = "default_theme")]
    theme: Theme,
    #[serde(default = "default_color")]
    default_color: String,
    #[serde(default = "default_font_size")]
    default_font_size: u32,
    #[serde(default = "default_box_font_size")]
    box_font_size: u32,
    #[serde(default)]
    recent_colors: Vec<String>,
    #[serde(default)]
    favorite_colors: Vec<String>,
    #[serde(default)]
    data_dir: Option<String>,
    #[serde(default)]
    guide_seeded: bool,
}

impl From<RawSettings> for Settings {
    fn from(raw: RawSettings) -> Self {
        let mut shortcuts = match raw.shortcuts {
            Some(map) => map,
            None => {
                // 단축키가 "새 메모" 하나뿐이던 시절의 파일. 그 값만 옮기고 나머지는 기본값.
                let mut map = Shortcuts::new();
                if raw.shortcut.is_some() || raw.shortcut_enabled.is_some() {
                    map.insert(
                        "new_note".to_string(),
                        ShortcutBinding {
                            enabled: raw.shortcut_enabled.unwrap_or(true),
                            keys: raw
                                .shortcut
                                .unwrap_or_else(|| default_shortcut_keys("new_note").to_string()),
                        },
                    );
                }
                map
            }
        };
        fill_missing_shortcuts(&mut shortcuts);
        Settings {
            shortcuts,
            autostart: raw.autostart,
            theme: raw.theme,
            default_color: raw.default_color,
            default_font_size: raw.default_font_size,
            box_font_size: raw.box_font_size,
            recent_colors: raw.recent_colors,
            favorite_colors: raw.favorite_colors,
            data_dir: raw.data_dir,
            guide_seeded: raw.guide_seeded,
        }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            shortcuts: default_shortcuts(),
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
    /// 여섯 개를 통째로 받는다(한 줄만 바꿔도 프런트가 전부 보낸다).
    #[serde(default)]
    pub shortcuts: Option<Shortcuts>,
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

    /// 기본 조합은 `src/types.ts`의 `DEFAULT_SHORTCUTS`와 글자 그대로 같아야 한다.
    /// 한쪽만 고치면 설정 화면이 "기본값으로"를 눌렀을 때 서로 다른 값을 보게 된다.
    #[test]
    fn default_shortcuts_match_types_ts() {
        let s = Settings::default();
        let expect = [
            ("new_note", "CommandOrControl+Shift+N"),
            ("show_all", "CommandOrControl+Shift+Up"),
            ("hide_all", "CommandOrControl+Shift+Down"),
            ("toggle_box", "CommandOrControl+Shift+M"),
            ("clip_text", "CommandOrControl+Shift+V"),
            ("clip_image", "CommandOrControl+Shift+I"),
        ];
        assert_eq!(s.shortcuts.len(), expect.len());
        for (id, keys) in expect {
            let binding = s.shortcuts.get(id).unwrap_or_else(|| panic!("{id}이 없다"));
            assert_eq!(binding.keys, keys, "{id}");
            assert!(binding.enabled, "{id}");
        }
        // 등록 순서(계약의 표 순서)도 같은 목록이다.
        let ids: Vec<&str> = expect.iter().map(|(id, _)| *id).collect();
        assert_eq!(SHORTCUT_IDS.to_vec(), ids);
    }

    /// 단축키가 하나뿐이던 시절의 settings.json은 그 값이 new_note로 옮겨지고
    /// 나머지 다섯은 기본값으로 채워진다.
    #[test]
    fn old_single_shortcut_moves_to_new_note() {
        let old = r##"{
            "shortcut_enabled": false,
            "shortcut": "CommandOrControl+Alt+K",
            "autostart": false,
            "theme": "dark",
            "default_color": "#FFF4A3",
            "default_font_size": 15,
            "data_dir": null
        }"##;
        let s: Settings = serde_json::from_str(old).unwrap();
        let new_note = s.shortcuts.get("new_note").unwrap();
        assert_eq!(new_note.keys, "CommandOrControl+Alt+K");
        assert!(!new_note.enabled);
        assert_eq!(
            s.shortcuts.get("clip_image").unwrap().keys,
            "CommandOrControl+Shift+I"
        );
        assert_eq!(s.shortcuts.len(), SHORTCUT_IDS.len());
        // 저장할 때는 옛 칸을 다시 쓰지 않는다.
        let text = serde_json::to_string(&s).unwrap();
        assert!(!text.contains("shortcut_enabled"), "{text}");
        assert!(text.contains("\"new_note\""), "{text}");
    }

    /// 새 파일에 shortcuts가 있으면 옛 칸은 무시한다. 빠진 id만 기본값으로 채운다.
    #[test]
    fn new_shortcuts_win_and_missing_ids_get_defaults() {
        let text = r##"{
            "shortcut": "CommandOrControl+Alt+K",
            "shortcuts": { "new_note": { "enabled": true, "keys": "Alt+1" } },
            "theme": "system",
            "default_color": "#FFF4A3"
        }"##;
        let s: Settings = serde_json::from_str(text).unwrap();
        assert_eq!(s.shortcuts.get("new_note").unwrap().keys, "Alt+1");
        assert_eq!(
            s.shortcuts.get("show_all").unwrap().keys,
            "CommandOrControl+Shift+Up"
        );
        assert_eq!(s.shortcuts.len(), SHORTCUT_IDS.len());
    }

    /// patch는 여섯 개를 통째로 받는다.
    #[test]
    fn patch_carries_shortcuts() {
        let p: SettingsPatch = serde_json::from_str(
            r#"{"shortcuts": {"new_note": {"enabled": false, "keys": ""}}}"#,
        )
        .unwrap();
        let map = p.shortcuts.unwrap();
        assert_eq!(map.len(), 1);
        assert_eq!(
            map.get("new_note"),
            Some(&ShortcutBinding {
                enabled: false,
                keys: String::new()
            })
        );
    }
}
