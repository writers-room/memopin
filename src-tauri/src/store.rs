//! 메모·카테고리 저장소. 계약은 `docs/contract.md`가 원본이다.
//!
//! - 메모 하나에 파일 하나: `<데이터 폴더>/notes/<id>.json`
//! - 카테고리: `<데이터 폴더>/categories.json`
//! - 쓰기는 항상 원자적(같은 폴더에 임시 파일 → rename)
//! - `updated_at`은 내용·메타가 바뀔 때만 갱신한다. `window` / `is_open` 변경은
//!   동기화 잡음을 만들지 않도록 갱신하지 않는다.
//! - 파일 감시가 우리 자신이 방금 쓴 파일까지 다시 읽지 않도록, 쓴 내용의 해시를
//!   경로별로 기억해 두고 같은 내용이면 건너뛴다.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const DEFAULT_COLOR: &str = "#FFF4A3";
pub const DEFAULT_FONT_SIZE: u32 = 15;

/// RFC3339 UTC. 밀리초까지만 남겨 파일이 사람 눈에도 읽히게 한다.
pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn parse_time(s: &str) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    chrono::DateTime::parse_from_rfc3339(s).ok()
}

fn default_color() -> String {
    DEFAULT_COLOR.to_string()
}
fn default_font_size() -> u32 {
    DEFAULT_FONT_SIZE
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct WindowRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 파일에 그대로 들어가는 모양. 손으로 고친 파일이나 옛 파일도 최대한 살려 읽으려고
/// 꼭 있어야 하는 세 칸(id, created_at, updated_at) 말고는 기본값을 둔다.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    #[serde(default)]
    pub html: String,
    #[serde(default)]
    pub text: String,
    #[serde(default = "default_color")]
    pub color: String,
    #[serde(default)]
    pub category_id: Option<String>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub list_pinned: bool,
    #[serde(default)]
    pub always_on_top: bool,
    #[serde(default = "default_font_size")]
    pub font_size: u32,
    #[serde(default)]
    pub window: Option<WindowRect>,
    #[serde(default)]
    pub is_open: bool,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Category {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub sort: i32,
    pub created_at: String,
}

/// `create_note`의 입력. 빠진 값은 설정 기본값으로 채운다.
#[derive(Debug, Default, Deserialize)]
pub struct CreateNoteInput {
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub category_id: Option<String>,
    #[serde(default)]
    pub favorite: Option<bool>,
    #[serde(default)]
    pub html: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub window: Option<WindowRect>,
}

/// `update_note`의 patch. `window`만 "없음"과 "null"을 구분해야 해서 이중 Option이다
/// (없으면 그대로 두고, null이면 위치를 지운다).
#[derive(Debug, Default, Deserialize)]
pub struct NotePatch {
    #[serde(default)]
    pub html: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub category_id: Option<Option<String>>,
    #[serde(default)]
    pub favorite: Option<bool>,
    #[serde(default)]
    pub list_pinned: Option<bool>,
    #[serde(default)]
    pub always_on_top: Option<bool>,
    #[serde(default)]
    pub font_size: Option<u32>,
    #[serde(default, deserialize_with = "double_option")]
    pub window: Option<Option<WindowRect>>,
}

/// 키가 아예 없으면 `None`, `null`이면 `Some(None)`, 값이 있으면 `Some(Some(v))`.
fn double_option<'de, T, D>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(de).map(Some)
}

impl NotePatch {
    /// `window` 말고 하나라도 왔으면 내용·메타가 바뀐 것이므로 `updated_at`을 갱신한다.
    fn touches_content(&self) -> bool {
        self.html.is_some()
            || self.text.is_some()
            || self.color.is_some()
            || self.category_id.is_some()
            || self.favorite.is_some()
            || self.list_pinned.is_some()
            || self.always_on_top.is_some()
            || self.font_size.is_some()
    }
}

/// 파일 감시가 알려 온 변화 한 건을 store가 어떻게 받아들였는지.
#[derive(Debug, PartialEq)]
pub enum FsChange {
    Note(String),
    NoteRemoved(String),
    Categories,
    None,
}

pub struct Store {
    dir: PathBuf,
    notes: HashMap<String, Note>,
    categories: Vec<Category>,
    /// 경로 → 우리가 마지막으로 쓴 내용의 해시. 파일 감시가 우리 자신의 쓰기를
    /// 외부 변경으로 착각하지 않게 하는 장치다.
    written: HashMap<PathBuf, u64>,
}

fn hash_of(s: &str) -> u64 {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

/// 같은 폴더에 임시 파일을 쓴 뒤 rename. 중간에 죽어도 반쪽 파일이 남지 않는다.
pub fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("경로가 올바르지 않습니다: {}", path.display()))?;
    fs::create_dir_all(dir).map_err(|e| format!("폴더를 만들지 못했습니다: {e}"))?;
    let tmp = dir.join(format!(".memopin-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&tmp, contents).map_err(|e| format!("파일을 쓰지 못했습니다: {e}"))?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("파일을 저장하지 못했습니다: {e}"));
    }
    Ok(())
}

/// 데이터 폴더 통째로 옮길 때 쓴다(`set_data_dir`). 메모와 카테고리만 옮긴다.
pub fn copy_data(from: &Path, to: &Path) -> Result<(), String> {
    let from_notes = from.join("notes");
    let to_notes = to.join("notes");
    fs::create_dir_all(&to_notes).map_err(|e| format!("폴더를 만들지 못했습니다: {e}"))?;
    if from_notes.is_dir() {
        let entries =
            fs::read_dir(&from_notes).map_err(|e| format!("폴더를 읽지 못했습니다: {e}"))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Some(name) = path.file_name() {
                    fs::copy(&path, to_notes.join(name))
                        .map_err(|e| format!("메모를 복사하지 못했습니다: {e}"))?;
                }
            }
        }
    }
    let from_cats = from.join("categories.json");
    if from_cats.is_file() {
        fs::copy(&from_cats, to.join("categories.json"))
            .map_err(|e| format!("카테고리를 복사하지 못했습니다: {e}"))?;
    }
    Ok(())
}

/// 대상 폴더가 "비어 있는가"(메모를 가지고 있지 않은가). `set_data_dir`이 복사할지
/// 읽어 들일지 정하는 기준이다.
pub fn dir_has_data(dir: &Path) -> bool {
    let notes = dir.join("notes");
    if notes.is_dir() {
        if let Ok(entries) = fs::read_dir(&notes) {
            for entry in entries.flatten() {
                if entry.path().extension().and_then(|e| e.to_str()) == Some("json") {
                    return true;
                }
            }
        }
    }
    dir.join("categories.json").is_file()
}

impl Store {
    /// 폴더를 만들고 있는 것을 전부 읽어 들인다. 깨진 파일은 건너뛰고 로그만 남긴다
    /// (한 장이 깨졌다고 앱 전체가 열리지 않는 쪽이 더 나쁘다).
    pub fn load(dir: &Path) -> Result<Store, String> {
        let notes_dir = dir.join("notes");
        fs::create_dir_all(&notes_dir)
            .map_err(|e| format!("데이터 폴더를 만들지 못했습니다: {e}"))?;

        let mut notes = HashMap::new();
        let entries =
            fs::read_dir(&notes_dir).map_err(|e| format!("데이터 폴더를 읽지 못했습니다: {e}"))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            match fs::read_to_string(&path) {
                Ok(text) => match serde_json::from_str::<Note>(&text) {
                    Ok(note) => {
                        notes.insert(note.id.clone(), note);
                    }
                    Err(e) => eprintln!("메모 파일을 읽지 못했습니다 ({}): {e}", path.display()),
                },
                Err(e) => eprintln!("메모 파일을 열지 못했습니다 ({}): {e}", path.display()),
            }
        }

        let categories = match fs::read_to_string(dir.join("categories.json")) {
            Ok(text) => match serde_json::from_str::<Vec<Category>>(&text) {
                Ok(list) => list,
                Err(e) => {
                    eprintln!("카테고리 파일을 읽지 못했습니다: {e}");
                    Vec::new()
                }
            },
            Err(_) => Vec::new(),
        };

        Ok(Store {
            dir: dir.to_path_buf(),
            notes,
            categories,
            written: HashMap::new(),
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn notes_dir(&self) -> PathBuf {
        self.dir.join("notes")
    }

    fn note_path(&self, id: &str) -> PathBuf {
        self.notes_dir().join(format!("{id}.json"))
    }

    fn categories_path(&self) -> PathBuf {
        self.dir.join("categories.json")
    }

    fn save_note(&mut self, id: &str) -> Result<(), String> {
        let note = self
            .notes
            .get(id)
            .ok_or_else(|| "메모를 찾을 수 없습니다.".to_string())?;
        let text = serde_json::to_string_pretty(note)
            .map_err(|e| format!("메모를 저장하지 못했습니다: {e}"))?;
        let path = self.note_path(id);
        write_atomic(&path, &text)?;
        self.written.insert(path, hash_of(&text));
        Ok(())
    }

    fn save_categories(&mut self) -> Result<(), String> {
        let text = serde_json::to_string_pretty(&self.categories)
            .map_err(|e| format!("카테고리를 저장하지 못했습니다: {e}"))?;
        let path = self.categories_path();
        write_atomic(&path, &text)?;
        self.written.insert(path, hash_of(&text));
        Ok(())
    }

    // ── 메모 ────────────────────────────────────────────────────────────────

    /// 휴지통 포함 전부. 만든 순서대로 준다(같으면 id 순 — 목록이 흔들리지 않게).
    pub fn list_notes(&self) -> Vec<Note> {
        let mut list: Vec<Note> = self.notes.values().cloned().collect();
        list.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        list
    }

    pub fn get_note(&self, id: &str) -> Result<Note, String> {
        self.notes
            .get(id)
            .cloned()
            .ok_or_else(|| "메모를 찾을 수 없습니다.".to_string())
    }

    pub fn create_note(
        &mut self,
        input: CreateNoteInput,
        default_color: &str,
        default_font_size: u32,
    ) -> Result<Note, String> {
        let now = now_rfc3339();
        let note = Note {
            id: uuid::Uuid::new_v4().to_string(),
            html: input.html.unwrap_or_default(),
            text: input.text.unwrap_or_default(),
            color: input.color.unwrap_or_else(|| default_color.to_string()),
            category_id: input.category_id,
            favorite: input.favorite.unwrap_or(false),
            list_pinned: false,
            always_on_top: false,
            font_size: default_font_size,
            window: input.window,
            is_open: false,
            created_at: now.clone(),
            updated_at: now,
            deleted_at: None,
        };
        let id = note.id.clone();
        self.notes.insert(id.clone(), note);
        self.save_note(&id)?;
        self.get_note(&id)
    }

    pub fn update_note(&mut self, id: &str, patch: NotePatch) -> Result<Note, String> {
        let touched = patch.touches_content();
        {
            let note = self
                .notes
                .get_mut(id)
                .ok_or_else(|| "메모를 찾을 수 없습니다.".to_string())?;
            if let Some(v) = patch.html {
                note.html = v;
            }
            if let Some(v) = patch.text {
                note.text = v;
            }
            if let Some(v) = patch.color {
                note.color = v;
            }
            if let Some(v) = patch.category_id {
                note.category_id = v;
            }
            if let Some(v) = patch.favorite {
                note.favorite = v;
            }
            if let Some(v) = patch.list_pinned {
                note.list_pinned = v;
            }
            if let Some(v) = patch.always_on_top {
                note.always_on_top = v;
            }
            if let Some(v) = patch.font_size {
                note.font_size = v;
            }
            if let Some(v) = patch.window {
                note.window = v;
            }
            // window만 온 저장(창을 옮겼을 뿐)은 updated_at을 건드리지 않는다.
            if touched {
                note.updated_at = now_rfc3339();
            }
        }
        self.save_note(id)?;
        self.get_note(id)
    }

    /// 창을 옮기거나 크기를 바꿨을 때. `updated_at`은 갱신하지 않는다.
    pub fn set_window(&mut self, id: &str, rect: WindowRect) -> Result<(), String> {
        {
            let note = self
                .notes
                .get_mut(id)
                .ok_or_else(|| "메모를 찾을 수 없습니다.".to_string())?;
            if note.window == Some(rect) {
                return Ok(());
            }
            note.window = Some(rect);
        }
        self.save_note(id)
    }

    /// 창이 열렸는지. 역시 `updated_at`은 갱신하지 않는다.
    pub fn set_open(&mut self, id: &str, open: bool) -> Result<bool, String> {
        {
            let note = self
                .notes
                .get_mut(id)
                .ok_or_else(|| "메모를 찾을 수 없습니다.".to_string())?;
            if note.is_open == open {
                return Ok(false);
            }
            note.is_open = open;
        }
        self.save_note(id)?;
        Ok(true)
    }

    pub fn delete_note(&mut self, id: &str) -> Result<Note, String> {
        {
            let note = self
                .notes
                .get_mut(id)
                .ok_or_else(|| "메모를 찾을 수 없습니다.".to_string())?;
            note.deleted_at = Some(now_rfc3339());
            note.is_open = false;
            note.updated_at = now_rfc3339();
        }
        self.save_note(id)?;
        self.get_note(id)
    }

    pub fn restore_note(&mut self, id: &str) -> Result<Note, String> {
        {
            let note = self
                .notes
                .get_mut(id)
                .ok_or_else(|| "메모를 찾을 수 없습니다.".to_string())?;
            note.deleted_at = None;
            note.updated_at = now_rfc3339();
        }
        self.save_note(id)?;
        self.get_note(id)
    }

    pub fn purge_note(&mut self, id: &str) -> Result<(), String> {
        if self.notes.remove(id).is_none() {
            return Err("메모를 찾을 수 없습니다.".to_string());
        }
        let path = self.note_path(id);
        self.written.remove(&path);
        if path.exists() {
            fs::remove_file(&path).map_err(|e| format!("메모 파일을 지우지 못했습니다: {e}"))?;
        }
        Ok(())
    }

    /// 휴지통을 비운다. 지운 메모의 id를 돌려준다.
    pub fn empty_trash(&mut self) -> Result<Vec<String>, String> {
        let ids: Vec<String> = self
            .notes
            .values()
            .filter(|n| n.deleted_at.is_some())
            .map(|n| n.id.clone())
            .collect();
        for id in &ids {
            self.purge_note(id)?;
        }
        Ok(ids)
    }

    // ── 카테고리 ────────────────────────────────────────────────────────────

    pub fn list_categories(&self) -> Vec<Category> {
        let mut list = self.categories.clone();
        list.sort_by(|a, b| a.sort.cmp(&b.sort).then(a.created_at.cmp(&b.created_at)));
        list
    }

    pub fn create_category(&mut self, name: &str) -> Result<Category, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("카테고리 이름을 입력해 주세요.".to_string());
        }
        let sort = self.categories.iter().map(|c| c.sort).max().unwrap_or(-1) + 1;
        let category = Category {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            sort,
            created_at: now_rfc3339(),
        };
        self.categories.push(category.clone());
        self.save_categories()?;
        Ok(category)
    }

    pub fn rename_category(&mut self, id: &str, name: &str) -> Result<Category, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("카테고리 이름을 입력해 주세요.".to_string());
        }
        let category = self
            .categories
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or_else(|| "카테고리를 찾을 수 없습니다.".to_string())?;
        category.name = name.to_string();
        let category = category.clone();
        self.save_categories()?;
        Ok(category)
    }

    /// 카테고리를 지우고, 거기 속해 있던 메모의 `category_id`를 null로 만든다.
    /// 영향을 받은 메모의 id를 돌려준다.
    pub fn delete_category(&mut self, id: &str) -> Result<Vec<String>, String> {
        let before = self.categories.len();
        self.categories.retain(|c| c.id != id);
        if self.categories.len() == before {
            return Err("카테고리를 찾을 수 없습니다.".to_string());
        }
        self.save_categories()?;

        let affected: Vec<String> = self
            .notes
            .values()
            .filter(|n| n.category_id.as_deref() == Some(id))
            .map(|n| n.id.clone())
            .collect();
        for note_id in &affected {
            if let Some(note) = self.notes.get_mut(note_id) {
                note.category_id = None;
                note.updated_at = now_rfc3339();
            }
            self.save_note(note_id)?;
        }
        Ok(affected)
    }

    // ── 파일 감시 ───────────────────────────────────────────────────────────

    /// 바깥에서 바뀐 파일 하나를 받아들인다. 우리가 방금 쓴 내용이면 아무 일도
    /// 하지 않고, 파일 쪽 `updated_at`이 메모리보다 오래됐으면 무시한다(최신이 이긴다).
    pub fn absorb_path(&mut self, path: &Path) -> FsChange {
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => return FsChange::None,
        };

        if name == "categories.json" && path.parent() == Some(self.dir.as_path()) {
            let text = match fs::read_to_string(path) {
                Ok(t) => t,
                Err(_) => return FsChange::None,
            };
            if self.written.get(path) == Some(&hash_of(&text)) {
                return FsChange::None;
            }
            match serde_json::from_str::<Vec<Category>>(&text) {
                Ok(list) => {
                    self.categories = list;
                    self.written.insert(path.to_path_buf(), hash_of(&text));
                    FsChange::Categories
                }
                Err(e) => {
                    eprintln!("바깥에서 바뀐 카테고리 파일을 읽지 못했습니다: {e}");
                    FsChange::None
                }
            }
        } else if path.parent() == Some(self.notes_dir().as_path())
            && path.extension().and_then(|e| e.to_str()) == Some("json")
        {
            let id = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => return FsChange::None,
            };
            if !path.is_file() {
                self.written.remove(path);
                return if self.notes.remove(&id).is_some() {
                    FsChange::NoteRemoved(id)
                } else {
                    FsChange::None
                };
            }
            let text = match fs::read_to_string(path) {
                Ok(t) => t,
                Err(_) => return FsChange::None,
            };
            if self.written.get(path) == Some(&hash_of(&text)) {
                return FsChange::None;
            }
            let incoming: Note = match serde_json::from_str(&text) {
                Ok(n) => n,
                Err(e) => {
                    eprintln!("바깥에서 바뀐 메모 파일을 읽지 못했습니다 ({id}): {e}");
                    return FsChange::None;
                }
            };
            if let Some(current) = self.notes.get(&id) {
                let (a, b) = (
                    parse_time(&incoming.updated_at),
                    parse_time(&current.updated_at),
                );
                if let (Some(a), Some(b)) = (a, b) {
                    if a < b {
                        return FsChange::None;
                    }
                }
            }
            self.notes.insert(id.clone(), incoming);
            self.written.insert(path.to_path_buf(), hash_of(&text));
            FsChange::Note(id)
        } else {
            FsChange::None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("memopin-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn new_store() -> (PathBuf, Store) {
        let dir = temp_dir();
        let store = Store::load(&dir).unwrap();
        (dir, store)
    }

    fn make_note(store: &mut Store, text: &str) -> Note {
        store
            .create_note(
                CreateNoteInput {
                    text: Some(text.to_string()),
                    html: Some(format!("<p>{text}</p>")),
                    ..Default::default()
                },
                DEFAULT_COLOR,
                DEFAULT_FONT_SIZE,
            )
            .unwrap()
    }

    #[test]
    fn saves_and_reloads_notes() {
        let (dir, mut store) = new_store();
        let a = make_note(&mut store, "첫 줄");
        store
            .create_category("장보기")
            .and_then(|c| store.rename_category(&c.id, "장보기 목록"))
            .unwrap();

        let reloaded = Store::load(&dir).unwrap();
        let notes = reloaded.list_notes();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].id, a.id);
        assert_eq!(notes[0].text, "첫 줄");
        assert_eq!(notes[0].color, DEFAULT_COLOR);
        assert_eq!(notes[0].font_size, DEFAULT_FONT_SIZE);
        assert!(!notes[0].is_open);
        let cats = reloaded.list_categories();
        assert_eq!(cats.len(), 1);
        assert_eq!(cats[0].name, "장보기 목록");
    }

    #[test]
    fn writes_atomically_without_leftovers() {
        let (dir, mut store) = new_store();
        let note = make_note(&mut store, "원자적");
        let path = dir.join("notes").join(format!("{}.json", note.id));
        assert!(path.is_file());
        // 임시 파일이 남지 않는다.
        let leftovers: Vec<_> = fs::read_dir(dir.join("notes"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "임시 파일이 남았습니다: {leftovers:?}");
        // 덮어써도 완전한 JSON이다.
        store
            .update_note(
                &note.id,
                NotePatch {
                    text: Some("고쳐 씀".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        let parsed: Note = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed.text, "고쳐 씀");
    }

    #[test]
    fn updated_at_only_moves_for_content() {
        let (_dir, mut store) = new_store();
        let note = make_note(&mut store, "시각 규칙");

        // window만 바꾸면 updated_at은 그대로.
        let moved = store
            .update_note(
                &note.id,
                NotePatch {
                    window: Some(Some(WindowRect {
                        x: 10.0,
                        y: 20.0,
                        w: 320.0,
                        h: 320.0,
                    })),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(moved.updated_at, note.updated_at);
        assert_eq!(moved.window.unwrap().x, 10.0);

        // set_window / set_open도 마찬가지.
        store
            .set_window(
                &note.id,
                WindowRect {
                    x: 30.0,
                    y: 40.0,
                    w: 300.0,
                    h: 300.0,
                },
            )
            .unwrap();
        store.set_open(&note.id, true).unwrap();
        assert_eq!(store.get_note(&note.id).unwrap().updated_at, note.updated_at);

        // 내용이 오면 갱신한다.
        std::thread::sleep(std::time::Duration::from_millis(5));
        let edited = store
            .update_note(
                &note.id,
                NotePatch {
                    html: Some("<p>바뀜</p>".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_ne!(edited.updated_at, note.updated_at);
    }

    #[test]
    fn deleting_category_clears_it_from_notes() {
        let (dir, mut store) = new_store();
        let category = store.create_category("설정").unwrap();
        let note = make_note(&mut store, "분류된 메모");
        store
            .update_note(
                &note.id,
                NotePatch {
                    category_id: Some(Some(category.id.clone())),
                    ..Default::default()
                },
            )
            .unwrap();

        let affected = store.delete_category(&category.id).unwrap();
        assert_eq!(affected, vec![note.id.clone()]);
        assert!(store.get_note(&note.id).unwrap().category_id.is_none());
        assert!(store.list_categories().is_empty());

        // 파일에도 반영돼 있다.
        let reloaded = Store::load(&dir).unwrap();
        assert!(reloaded.get_note(&note.id).unwrap().category_id.is_none());
    }

    #[test]
    fn trash_restore_and_purge() {
        let (dir, mut store) = new_store();
        let note = make_note(&mut store, "휴지통");
        store.set_open(&note.id, true).unwrap();

        let deleted = store.delete_note(&note.id).unwrap();
        assert!(deleted.deleted_at.is_some());
        assert!(!deleted.is_open, "휴지통에 넣으면 창도 닫힌 것으로 본다");

        let restored = store.restore_note(&note.id).unwrap();
        assert!(restored.deleted_at.is_none());

        store.delete_note(&note.id).unwrap();
        let purged = store.empty_trash().unwrap();
        assert_eq!(purged, vec![note.id.clone()]);
        assert!(store.get_note(&note.id).is_err());
        assert!(!dir
            .join("notes")
            .join(format!("{}.json", note.id))
            .exists());

        // purge_note 단독 경로도 파일을 지운다.
        let other = make_note(&mut store, "완전 삭제");
        store.purge_note(&other.id).unwrap();
        assert!(store.purge_note(&other.id).is_err());
        assert!(Store::load(&dir).unwrap().list_notes().is_empty());
    }

    #[test]
    fn external_change_is_ignored_when_older() {
        let (dir, mut store) = new_store();
        let note = make_note(&mut store, "최신이 이긴다");
        let path = dir.join("notes").join(format!("{}.json", note.id));

        // 우리가 방금 쓴 그대로면 아무 일도 없다.
        assert_eq!(store.absorb_path(&path), FsChange::None);

        // 더 오래된 updated_at을 가진 파일은 무시한다.
        let mut old = note.clone();
        old.text = "옛날 것".into();
        old.updated_at = "2000-01-01T00:00:00.000Z".into();
        fs::write(&path, serde_json::to_string_pretty(&old).unwrap()).unwrap();
        assert_eq!(store.absorb_path(&path), FsChange::None);
        assert_eq!(store.get_note(&note.id).unwrap().text, "최신이 이긴다");

        // 더 새로운 것은 받아들인다.
        let mut fresh = note.clone();
        fresh.text = "동기화로 들어온 것".into();
        fresh.updated_at = "2999-01-01T00:00:00.000Z".into();
        fs::write(&path, serde_json::to_string_pretty(&fresh).unwrap()).unwrap();
        assert_eq!(store.absorb_path(&path), FsChange::Note(note.id.clone()));
        assert_eq!(
            store.get_note(&note.id).unwrap().text,
            "동기화로 들어온 것"
        );

        // 파일이 사라지면 메모리에서도 지운다.
        fs::remove_file(&path).unwrap();
        assert_eq!(
            store.absorb_path(&path),
            FsChange::NoteRemoved(note.id.clone())
        );
        assert!(store.get_note(&note.id).is_err());
        assert_eq!(store.absorb_path(&path), FsChange::None);
    }

    #[test]
    fn broken_files_are_skipped() {
        let (dir, mut store) = new_store();
        make_note(&mut store, "멀쩡한 메모");
        fs::write(dir.join("notes").join("broken.json"), "{ 이건 JSON이 아니다").unwrap();
        let reloaded = Store::load(&dir).unwrap();
        assert_eq!(reloaded.list_notes().len(), 1);
    }

    #[test]
    fn copies_data_to_a_new_folder() {
        let (dir, mut store) = new_store();
        let note = make_note(&mut store, "옮겨 갈 메모");
        store.create_category("옮길 카테고리").unwrap();

        let target = temp_dir();
        assert!(!dir_has_data(&target));
        copy_data(&dir, &target).unwrap();
        assert!(dir_has_data(&target));

        let moved = Store::load(&target).unwrap();
        assert_eq!(moved.list_notes()[0].id, note.id);
        assert_eq!(moved.list_categories().len(), 1);
    }
}
