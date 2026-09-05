# 프런트엔드 ↔ Rust 계약

이 문서가 두 쪽의 유일한 약속이다. Rust(`src-tauri/`)와 TS(`src/api.ts`, `src/types.ts`)가 모두 여기에 맞춘다. 바꿀 때는 이 문서를 먼저 고친다.

## 저장 위치

- **데이터 폴더**(동기화 대상): 기본 `app_data_dir()/data`. 설정 `data_dir`로 바꿀 수 있다(구글 드라이브·Dropbox 폴더 등).
  - `notes/<id>.json` — 메모 하나에 파일 하나
  - `categories.json` — `Category[]`
- **설정 파일**(동기화 안 함, 기기별): `app_config_dir()/settings.json`
- 쓰기는 항상 원자적으로: 같은 폴더에 임시 파일을 쓴 뒤 rename.
- 데이터 폴더의 외부 변경(동기화 클라이언트가 내려받은 파일)은 Rust가 감시(notify)하다가 300ms 디바운스 후 해당 파일만 다시 읽고 `store:changed`(source `"fs"`)를 뿌린다. 파일의 `updated_at`이 메모리 것보다 오래됐으면 무시한다(최신 것이 이긴다).

## 타입 (JSON 그대로, snake_case)

```ts
interface Note {
  id: string;              // uuid v4
  html: string;            // 제한된 HTML. 허용: p br ul ol li b i u s, li에만 class "task" / "task done". 프런트가 정제해서 보낸다.
  text: string;            // html에서 파생한 평문. 블록마다 "\n". 제목 = 첫 비어 있지 않은 줄. 프런트가 계산해서 보낸다.
  color: string;           // "#RRGGBB"
  category_id: string | null;
  favorite: boolean;       // ★ 즐겨찾기
  list_pinned: boolean;    // 메모함 목록 상단 고정
  always_on_top: boolean;  // 창 always-on-top
  font_size: number;       // 11..28 (px)
  window: { x: number; y: number; w: number; h: number } | null;  // 논리 픽셀. null이면 OS 기본 위치, 320×320
  is_open: boolean;        // 바탕화면에 펼쳐져 있는지. 앱 재시작 때 복원 기준
  created_at: string;      // RFC3339 UTC
  updated_at: string;      // 내용·메타 변경 때만 갱신. window / is_open 변경은 갱신하지 않는다(동기화 잡음 방지)
  deleted_at: string | null; // 휴지통. null이면 살아 있음
}
interface Category { id: string; name: string; sort: number; created_at: string }
interface Settings {
  shortcut_enabled: boolean;   // 기본 true
  shortcut: string;            // 기본 "CommandOrControl+Shift+N" (tauri global-shortcut 표기)
  autostart: boolean;          // 기본 false. 켜면 "--hidden" 인자로 등록
  theme: 'system' | 'light' | 'dark';  // 기본 'system'. 메모함·설정 창만 해당
  default_color: string;       // 기본 "#FFF4A3"
  default_font_size: number;   // 기본 15. 새 메모(= 메모 창)의 글자 크기
  box_font_size: number;       // 기본 14, 11..28. 메모함 편집 칸 전용. 메모의 font_size와 무관하다
  data_dir: string | null;     // null = 기본 폴더
}
```

## 커맨드 (모두 `Result<T, String>`; 에러 문자열은 사용자에게 그대로 보여 줄 수 있는 한국어)

메모
- `list_notes() -> Note[]` — 휴지통 포함 전부
- `get_note(id) -> Note`
- `create_note(input: { color?, category_id?, favorite?, html?, text?, window? }) -> Note` — 창은 열지 않는다. 빠진 값은 설정 기본값
- `update_note(id, patch: Partial<Pick<Note, 'html'|'text'|'color'|'category_id'|'favorite'|'list_pinned'|'always_on_top'|'font_size'|'window'>>) -> Note`
  - `always_on_top`이 오면 열려 있는 창에 즉시 적용
  - html/text/color/category_id/favorite/list_pinned/always_on_top/font_size 중 하나라도 오면 `updated_at` 갱신, `window`만 오면 갱신하지 않음
- `delete_note(id)` — `deleted_at` 기록, 창이 열려 있으면 닫음(is_open false)
- `restore_note(id)`, `purge_note(id)`(파일 삭제), `empty_trash()`

카테고리
- `list_categories() -> Category[]`(sort 순)
- `create_category(name) -> Category`, `rename_category(id, name) -> Category`
- `delete_category(id)` — 속한 메모의 category_id를 null로

창
- `open_note_window(id)` — 없으면 만들고, 있으면 앞으로. `is_open = true`. `note.window`가 있으면 그 위치·크기(화면 밖이면 보이는 모니터 안으로 당김)
- `close_note_window(id)` — 창 파괴, `is_open = false`
- `show_box()`, `show_settings()` — 숨겨져 있으면 보이고 앞으로
- 메모 창의 이동·크기 변경은 Rust가 window 이벤트(Moved/Resized)로 받아 500ms 디바운스 후 `note.window`에 저장한다. 프런트는 신경 쓰지 않는다.

설정
- `get_settings() -> Settings`
- `update_settings(patch: Partial<Settings>) -> Settings` — shortcut/shortcut_enabled/autostart는 즉시 적용(단축키 재등록, autostart 등록/해제). 실패하면 에러를 돌려주되 나머지 값은 저장
- `pick_data_dir() -> string | null` — 폴더 선택 대화상자
- `set_data_dir(path: string | null) -> Settings` — 대상 폴더에 `notes/`가 없고 비어 있으면 현재 데이터를 복사, 이미 메모가 있으면 그것을 읽어 들인다(합치지 않는다). 그 뒤 store를 다시 로드하고 `store:changed`(kind all) 방송

기타
- `app_version() -> string`
- 업데이트 확인·설치는 프런트가 `@tauri-apps/plugin-updater`로 직접 한다

## 이벤트 (`app.emit`, 모든 창에)

- `store:changed` — `{ kind: 'notes' | 'categories' | 'all', ids: string[], source: string }`
  - `source`는 변경을 일으킨 창 라벨, 파일 감시면 `"fs"`, 트레이·단축키·시작 복원 등이면 `"system"`
  - 편집기는 자기 라벨이 source인 `notes` 이벤트를 무시한다(커서 튐 방지). 다른 창의 변경은 포커스가 없을 때만 innerHTML을 갈아 끼운다
- `settings:changed` — `Settings`

## 창 라벨과 생명주기

- `box`(메모함, 창 제목은 "메모핀" — 사용자가 가장 많이 보는 창이라 앱 이름을 쓴다, 940×600, 최소 640×420, 일반 창), `settings`(520×auto, 크기 고정), `note-<id>`(320×320, 최소 200×140, `decorations:false`, `shadow:true`, `skip_taskbar:true`, `always_on_top` = note 값, 제목 "메모핀")
- 프런트는 `getCurrentWindow().label`로 자기 역할을 안다. URL 쿼리는 쓰지 않는다
- 창 생성은 `async` 커맨드 안에서 `run_on_main_thread` + 채널로 한다(동기 커맨드에서 하면 데드락). `WebviewWindowBuilder::from_config`로 만들고, 위치·크기는 만든 뒤 논리 픽셀로 적용
- Windows에서는 만든 모든 창에 WM_ENTERSIZEMOVE 서브클래스를 설치한다(한글 조합 중 창 드래그 시 IME 끊김 방지, 서재에서 검증된 방법)
- 닫기: `box`·`settings`는 숨김(prevent_close + hide). 메모 창은 파괴 + `is_open=false`. 종료는 트레이 "종료"뿐
- 시작: 인자에 `--hidden`이 있으면 메모함을 띄우지 않는다. `is_open`인 메모는 전부 복원
- 단일 인스턴스: 두 번째 실행은 메모함을 보여 주고 끝
- 트레이: 왼쪽 클릭 → 메모함, 메뉴 → 새 메모 / 메모함 열기 / 설정 / (구분선) / 종료. "새 메모"는 `create_note` + `open_note_window`
- 전역 단축키: 설정값으로 등록. 눌리면 트레이 "새 메모"와 같은 동작
