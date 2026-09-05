//! 첫 실행 안내 메모. 처음 켠 사람이 빈 화면 대신 쓰는 법을 보게 하는 메모 두 장이다.
//!
//! 본문은 `docs/guide-notes.md`의 확정본 그대로다(문구를 고칠 일이 생기면 그 문서를
//! 먼저 고친다). 마크다운 문서에서는 읽기 좋으라고 태그마다 줄을 바꿔 두었지만,
//! 편집기(contenteditable)에 태그 사이 공백 텍스트 노드가 생기지 않도록 여기서는
//! 한 줄로 잇는다. text 쪽 줄바꿈은 계약대로 `\n`이다.
//!
//! 만드는 조건은 `docs/contract.md` "첫 실행 안내 메모": 아직 만든 적이 없고
//! (`settings.guide_seeded == false`) 살아 있는 메모가 하나도 없을 때만. 지웠다고
//! 다시 만들지 않으며, 이미 메모가 있는 사람에게는 만들지 않고 표시만 해 둔다.

use crate::store::{CreateNoteInput, Note, Store};

pub const GUIDE_1_COLOR: &str = "#FFF4A3";
pub const GUIDE_2_COLOR: &str = "#D6F0FA";

pub const GUIDE_1_HTML: &str = concat!(
    "<p><b>메모핀에 오신 걸 환영합니다</b></p>",
    "<p>이 메모는 마음껏 고치거나 지워도 됩니다.</p>",
    "<ul>",
    "<li>위쪽 가장자리에 마우스를 올리면 손잡이가 나옵니다. 끌어서 옮기고, 📌로 항상 위에 두고, ★로 즐겨찾기합니다.</li>",
    "<li>우클릭으로 색을 바꾸고 카테고리를 정합니다.</li>",
    "<li>Ctrl+휠로 글자 크기, Ctrl+0으로 원래대로.</li>",
    "</ul>",
    "<p>줄 첫머리에 이렇게 치면 서식이 됩니다.</p>",
    "<ul>",
    "<li>\"- \" 글머리, \"1. \" 숫자, \"[] \" 체크박스</li>",
    "<li class=\"task\">글자를 끌어 고르면 굵게·기울임·밑줄·취소선</li>",
    "</ul>",
    "<p>어디서든 <b>Ctrl+Shift+N</b>으로 새 메모를 띄웁니다.</p>",
);

pub const GUIDE_1_TEXT: &str = concat!(
    "메모핀에 오신 걸 환영합니다\n",
    "이 메모는 마음껏 고치거나 지워도 됩니다.\n",
    "위쪽 가장자리에 마우스를 올리면 손잡이가 나옵니다. 끌어서 옮기고, 📌로 항상 위에 두고, ★로 즐겨찾기합니다.\n",
    "우클릭으로 색을 바꾸고 카테고리를 정합니다.\n",
    "Ctrl+휠로 글자 크기, Ctrl+0으로 원래대로.\n",
    "줄 첫머리에 이렇게 치면 서식이 됩니다.\n",
    "\"- \" 글머리, \"1. \" 숫자, \"[] \" 체크박스\n",
    "[ ] 글자를 끌어 고르면 굵게·기울임·밑줄·취소선\n",
    "어디서든 Ctrl+Shift+N으로 새 메모를 띄웁니다.",
);

pub const GUIDE_2_HTML: &str = concat!(
    "<p><b>메모함과 동기화</b></p>",
    "<p>작업표시줄의 메모핀 창이 메모함입니다. 창을 닫아도 메모는 거기 남습니다.</p>",
    "<ul>",
    "<li>목록을 더블클릭하면 바탕화면에 펼쳐지고, 한 번 클릭하면 오른쪽에서 바로 고칩니다.</li>",
    "<li>Ctrl·Shift+클릭으로 여러 개를 골라 한꺼번에 휴지통으로 보냅니다.</li>",
    "<li>왼쪽에서 카테고리를 만들고, 즐겨찾기와 휴지통도 거기 있습니다.</li>",
    "</ul>",
    "<p>다른 컴퓨터와 같이 쓰려면 트레이 → 설정에서 <b>메모 저장 폴더</b>를 구글 드라이브·Dropbox·OneDrive 폴더로 바꾸세요. 그 서비스가 동기화를 맡습니다.</p>",
    "<p>종료는 트레이 아이콘 우클릭 → 종료입니다.</p>",
);

pub const GUIDE_2_TEXT: &str = concat!(
    "메모함과 동기화\n",
    "작업표시줄의 메모핀 창이 메모함입니다. 창을 닫아도 메모는 거기 남습니다.\n",
    "목록을 더블클릭하면 바탕화면에 펼쳐지고, 한 번 클릭하면 오른쪽에서 바로 고칩니다.\n",
    "Ctrl·Shift+클릭으로 여러 개를 골라 한꺼번에 휴지통으로 보냅니다.\n",
    "왼쪽에서 카테고리를 만들고, 즐겨찾기와 휴지통도 거기 있습니다.\n",
    "다른 컴퓨터와 같이 쓰려면 트레이 → 설정에서 메모 저장 폴더를 구글 드라이브·Dropbox·OneDrive 폴더로 바꾸세요. 그 서비스가 동기화를 맡습니다.\n",
    "종료는 트레이 아이콘 우클릭 → 종료입니다.",
);

/// 안내 메모를 만들어야 하는가. 휴지통에 있는 메모는 "있는" 것으로 치지 않는다
/// (전부 지워 본 사람에게 다시 만들어 주지 않는 것은 `guide_seeded`가 맡는다).
pub fn needs_seed(guide_seeded: bool, notes: &[Note]) -> bool {
    !guide_seeded && !notes.iter().any(|n| n.deleted_at.is_none())
}

/// 두 장을 만들고 `is_open`을 올린다(창은 시작 절차의 `restore_open_notes`가 띄운다).
/// 만든 id를 순서대로 돌려준다.
pub fn seed(store: &mut Store, font_size: u32) -> Result<Vec<String>, String> {
    let mut ids = Vec::new();
    for (i, (color, html, text)) in [
        (GUIDE_1_COLOR, GUIDE_1_HTML, GUIDE_1_TEXT),
        (GUIDE_2_COLOR, GUIDE_2_HTML, GUIDE_2_TEXT),
    ]
    .into_iter()
    .enumerate()
    {
        if i > 0 {
            // 목록은 created_at 순이다. 같은 밀리초에 만들면 둘의 순서가 uuid에 좌우돼
            // 실행할 때마다 뒤바뀔 수 있어서, 두 번째를 아주 조금 늦춘다.
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let note = store.create_note(
            CreateNoteInput {
                color: Some(color.to_string()),
                html: Some(html.to_string()),
                text: Some(text.to_string()),
                ..Default::default()
            },
            color,
            font_size,
        )?;
        store.set_open(&note.id, true)?;
        ids.push(note.id);
    }
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{DEFAULT_COLOR, DEFAULT_FONT_SIZE};
    use std::path::PathBuf;

    fn temp_store() -> (PathBuf, Store) {
        let dir = std::env::temp_dir().join(format!("memopin-guide-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::load(&dir).unwrap();
        (dir, store)
    }

    #[test]
    fn seeds_only_into_an_empty_store() {
        let (_dir, mut store) = temp_store();
        assert!(needs_seed(false, &store.list_notes()));

        // 이미 만든 적이 있으면 비어 있어도 만들지 않는다(지운 사람에게 다시 안 준다).
        assert!(!needs_seed(true, &store.list_notes()));

        // 살아 있는 메모가 하나라도 있으면 만들지 않는다.
        let note = store
            .create_note(
                CreateNoteInput::default(),
                DEFAULT_COLOR,
                DEFAULT_FONT_SIZE,
            )
            .unwrap();
        assert!(!needs_seed(false, &store.list_notes()));

        // 휴지통에만 있는 메모는 "있는" 것이 아니다.
        store.delete_note(&note.id).unwrap();
        assert!(needs_seed(false, &store.list_notes()));
    }

    #[test]
    fn seed_makes_two_open_notes_in_order() {
        let (dir, mut store) = temp_store();
        let ids = seed(&mut store, 17).unwrap();
        assert_eq!(ids.len(), 2);

        let notes = store.list_notes();
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].id, ids[0]);
        assert_eq!(notes[1].id, ids[1]);
        assert_eq!(notes[0].color, GUIDE_1_COLOR);
        assert_eq!(notes[1].color, GUIDE_2_COLOR);
        assert_eq!(notes[0].html, GUIDE_1_HTML);
        assert_eq!(notes[1].text, GUIDE_2_TEXT);
        assert!(notes.iter().all(|n| n.is_open), "펼친 상태로 만든다");
        assert!(notes.iter().all(|n| n.window.is_none()), "위치는 OS에 맡긴다");
        assert!(notes.iter().all(|n| n.font_size == 17), "설정 기본 글자 크기");

        // 파일로도 남는다.
        let reloaded = Store::load(&dir).unwrap();
        assert_eq!(reloaded.list_notes().len(), 2);

        // 한 번 만든 뒤에는 조건이 닫힌다(두 번째 시작에서 또 만들지 않는다).
        assert!(!needs_seed(false, &reloaded.list_notes()));
        assert!(!needs_seed(true, &reloaded.list_notes()));
    }

    /// 본문이 계약대로인지: 제목이 될 첫 줄, 체크박스 li, 금지된 태그 없음.
    #[test]
    fn guide_text_starts_with_the_title_line() {
        assert_eq!(
            GUIDE_1_TEXT.lines().next(),
            Some("메모핀에 오신 걸 환영합니다")
        );
        assert_eq!(GUIDE_2_TEXT.lines().next(), Some("메모함과 동기화"));
        assert!(GUIDE_1_HTML.contains("<li class=\"task\">"));
        assert!(!GUIDE_1_HTML.contains('\n'));
        assert!(!GUIDE_2_HTML.contains('\n'));
    }
}
