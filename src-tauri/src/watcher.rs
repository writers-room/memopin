//! 데이터 폴더 감시. 동기화 클라이언트(구글 드라이브·Dropbox 등)가 파일을 내려놓으면
//! 300ms 조용해진 뒤 바뀐 파일만 다시 읽고 `store:changed`(source "fs")를 뿌린다.
//! 우리 자신이 방금 쓴 파일은 store가 내용 해시로 걸러 낸다(store.rs `absorb_path`).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Manager};

use crate::store::FsChange;
use crate::{emit_store_changed, AppState};

const DEBOUNCE: Duration = Duration::from_millis(300);

/// 살아 있는 동안만 감시한다. 떨어뜨리면 감시자와 처리 스레드가 함께 정리된다
/// (`set_data_dir`이 폴더를 바꿀 때 이 값을 갈아 끼운다).
pub struct DataWatcher {
    _watcher: RecommendedWatcher,
}

/// 메모 JSON과 카테고리만 본다. `images/` 아래는 통째로 무시한다 — 메모 JSON이 곧
/// 진실이고 그림 파일은 그 뒤에 따라올 뿐이라, 그림이 늦게 도착했다고 다시 읽을 것이 없다.
fn is_interesting(root: &Path, path: &Path) -> bool {
    if let Ok(rel) = path.strip_prefix(root) {
        if rel
            .components()
            .next()
            .is_some_and(|c| c.as_os_str() == crate::store::IMAGES_DIR)
        {
            return false;
        }
    }
    path.extension().and_then(|e| e.to_str()) == Some("json")
}

pub fn start(app: &AppHandle, dir: &Path) -> Result<DataWatcher, String> {
    std::fs::create_dir_all(dir.join("notes"))
        .map_err(|e| format!("데이터 폴더를 만들지 못했습니다: {e}"))?;

    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .map_err(|e| format!("데이터 폴더를 감시하지 못했습니다: {e}"))?;
    watcher
        .watch(dir, RecursiveMode::Recursive)
        .map_err(|e| format!("데이터 폴더를 감시하지 못했습니다: {e}"))?;

    let app = app.clone();
    let root = dir.to_path_buf();
    std::thread::spawn(move || {
        let mut pending: HashSet<PathBuf> = HashSet::new();
        let mut deadline: Option<Instant> = None;
        loop {
            // 대기할 일이 없으면 길게 잠들었다가 새 이벤트나 연결 종료에 깨어난다.
            let timeout = match deadline {
                Some(d) => d.saturating_duration_since(Instant::now()),
                None => Duration::from_secs(3600),
            };
            match rx.recv_timeout(timeout) {
                Ok(Ok(event)) => {
                    for path in event.paths {
                        if is_interesting(&root, &path) {
                            pending.insert(path);
                        }
                    }
                    if !pending.is_empty() {
                        deadline = Some(Instant::now() + DEBOUNCE);
                    }
                }
                Ok(Err(e)) => eprintln!("데이터 폴더 감시 중 오류: {e}"),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            if let Some(d) = deadline {
                if Instant::now() >= d {
                    deadline = None;
                    let paths: Vec<PathBuf> = pending.drain().collect();
                    flush(&app, &paths);
                }
            }
        }
    });

    Ok(DataWatcher { _watcher: watcher })
}

fn flush(app: &AppHandle, paths: &[PathBuf]) {
    let state = app.state::<AppState>();
    let mut ids: Vec<String> = Vec::new();
    let mut categories_changed = false;
    {
        let Ok(mut store) = state.store.lock() else {
            return;
        };
        for path in paths {
            match store.absorb_path(path) {
                FsChange::Note(id) | FsChange::NoteRemoved(id) => ids.push(id),
                FsChange::Categories => categories_changed = true,
                FsChange::None => {}
            }
        }
    }

    let kind = match (ids.is_empty(), categories_changed) {
        (true, false) => return,
        (false, true) => "all",
        (false, false) => "notes",
        (true, true) => "categories",
    };
    emit_store_changed(app, kind, ids, "fs");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watches_notes_but_not_images() {
        let root = Path::new("/data");
        assert!(is_interesting(root, &root.join("notes").join("a.json")));
        assert!(is_interesting(root, &root.join("categories.json")));
        assert!(!is_interesting(root, &root.join("images").join("a.png")));
        assert!(!is_interesting(root, &root.join("images").join("a.json")));
        // 데이터 폴더 이름 자체에 images가 들어 있어도 상관없다(첫 조각만 본다).
        let odd = Path::new("/images/memo");
        assert!(is_interesting(odd, &odd.join("notes").join("a.json")));
    }
}
