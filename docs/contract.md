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
type ShortcutId = 'new_note' | 'show_all' | 'hide_all' | 'toggle_box' | 'clip_text' | 'clip_image';
interface ShortcutBinding { enabled: boolean; keys: string }  // keys는 tauri global-shortcut 표기, ""이면 지정 안 함
interface Settings {
  shortcuts: Record<ShortcutId, ShortcutBinding>;  // 전역 단축키. 기본값은 아래 "## 전역 단축키". 옛 파일의 shortcut/shortcut_enabled는 new_note로 옮겨 읽는다
  autostart: boolean;          // 기본 false. 켜면 "--hidden" 인자로 등록
  theme: 'system' | 'light' | 'dark';  // 기본 'system'. 메모함·설정 창만 해당
  default_color: string;       // 기본 "#FFF4A3"
  default_font_size: number;   // 기본 15. 새 메모(= 메모 창)의 글자 크기
  box_font_size: number;       // 기본 14, 11..28. 메모함 편집 칸 전용. 메모의 font_size와 무관하다
  recent_colors: string[];     // 최근 쓴 색. 최신이 앞, 중복 없음, 최대 10. 기본 팔레트 14색은 넣지 않는다
  favorite_colors: string[];   // 즐겨찾는 색. 최대 10. 우클릭 메뉴 팔레트의 ☆로 넣고 뺀다
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
- `update_settings(patch: Partial<Settings>) -> Settings` — shortcuts/autostart는 즉시 적용(단축키 전부 재등록, autostart 등록/해제). 단축키 등록 실패는 **에러가 아니라** 저장 후 `shortcut_errors`에 남긴다(autostart 실패만 에러)
- `shortcut_errors() -> Partial<Record<ShortcutId, string>>` — 등록에 실패한 단축키와 한국어 이유. 없으면 빈 객체
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
- 닫기: `box`·`settings`는 숨김(prevent_close + hide). 메모 창은 파괴 + `is_open=false`. **아무것도 안 적은 텍스트 메모(text가 공백뿐)를 닫으면 휴지통에도 남기지 않고 바로 지운다**(Rust `mark_closed`). 종료는 트레이 "종료"뿐
- 시작: 인자에 `--hidden`이 있으면 메모함을 띄우지 않는다. `is_open`인 메모는 전부 복원
- 단일 인스턴스: 두 번째 실행은 메모함을 보여 주고 끝
- 트레이: 왼쪽 클릭 → 메모함, 메뉴 → 새 메모 / 메모함 열기 / 설정 / (구분선) / 종료. "새 메모"는 `create_note` + `open_note_window`
- 전역 단축키: 설정값으로 등록. 눌리면 트레이 "새 메모"와 같은 동작

## 이미지 메모

메모는 `kind`로 갈린다. 텍스트 메모는 지금까지와 같고, 이미지 메모는 이미지 파일 하나를 창으로 띄우며 본문(html/text)은 "곁들인 텍스트"로 메모함에서만 보인다.

```ts
interface Note {
  // …기존 필드 그대로…
  kind: 'text' | 'image';        // serde default 'text' — 옛 파일 호환
  image: {
    file: string;                // 데이터 폴더 기준 상대 경로. 항상 "images/<id>.png"
    name: string;                // 원본 파일명(붙여넣기면 "붙여넣은 이미지 2026-09-05 14-03.png"). 메모함 목록의 제목
    w: number; h: number;        // 저장된(자른) 이미지의 픽셀 크기. 창 비율의 기준
  } | null;                      // 텍스트 메모면 null
}
```

- 이미지 파일은 데이터 폴더 `images/<id>.png`. 동기화 폴더에 같이 실린다. 크롭은 불러올 때 프런트가 canvas로 잘라 **자른 결과만** 저장한다(원본은 남기지 않는다).
- 제목: 이미지 메모는 `image.name`. 검색은 `image.name` + `text`.
- 이미지 메모 창: `note.window`가 null이면 가로 320(논리)·세로 `320 * h / w`. 이후 크기 변경은 프런트가 비율을 고정해 `setSize`하고 Rust가 평소처럼 `window`에 저장한다.
- `purge_note`/`empty_trash`는 `images/<id>.png`도 지운다. 휴지통에 있는 동안은 남긴다.
- 폴더 감시는 `images/`를 무시한다(메모 JSON이 곧 진실이고, 파일은 그 뒤에 따라온다).

커맨드
- `create_image_note(input: { png_base64: string; name: string; w: number; h: number; category_id?: string | null; favorite?: boolean }) -> Note` — 디코드해서 `images/<id>.png`에 쓰고 `kind:'image'` 메모를 만든다(창은 열지 않는다). base64는 data URL 접두사 없이.
- `read_image_file(path: string) -> { data_url: string; name: string }` — 파일 선택 대화상자로 고른 원본을 읽어 data URL로 돌려준다(크롭 화면용). png/jpg/jpeg/gif/webp/bmp만. 20MB 초과면 에러.
- 표시는 커스텀 프로토콜 **`memopin://image/<id>`** (Rust `register_uri_scheme_protocol("memopin")`). 현재 데이터 폴더의 `images/<id>.png`를 `image/png`으로 돌려준다. 없으면 404. Windows에서는 `http://memopin.localhost/image/<id>` 형태가 되므로 프런트는 `@tauri-apps/api/core`의 `convertFileSrc` 대신 **자체 헬퍼 `imageUrl(id)`** 로 플랫폼별 주소를 만든다(Windows: `http://memopin.localhost/image/<id>`, macOS: `memopin://image/<id>`). 캐시 무효화가 필요 없다(파일은 만들어진 뒤 바뀌지 않는다).
- `tauri.conf.json` CSP는 null이라 프로토콜 주소가 막히지 않는다.

## 첫 실행 안내 메모

- 설정 `guide_seeded: boolean`(기본 false). 시작할 때 `guide_seeded`가 false이고 **살아 있는 메모가 하나도 없으면** 안내 메모 두 개를 만들고(`is_open: true`, 창 위치 null → OS 기본) `guide_seeded = true`로 저장한다. 지워도 다시 만들지 않는다.
- 내용은 `src-tauri/src/guide.rs`에 상수로 둔다(html + text 둘 다). 색: 첫 번째 노랑 `#FFF4A3`, 두 번째 하늘 `#D6F0FA`.

## 전역 단축키

| id | 기본 조합 | 동작 |
|---|---|---|
| `new_note` | CommandOrControl+Shift+N | 새 메모(설정 기본색) 만들고 창 열기 |
| `show_all` | CommandOrControl+Shift+Up | `is_open`인 메모 창을 전부 보이고(hidden이면 show) 앞으로 |
| `hide_all` | CommandOrControl+Shift+Down | `is_open`인 메모 창을 전부 `hide()`. `is_open`은 그대로(재시작·show_all 때 돌아온다) |
| `toggle_box` | CommandOrControl+Shift+M | 메모함이 보이고 포커스면 hide, 아니면 show + focus |
| `clip_text` | CommandOrControl+Shift+V | 클립보드의 글로 새 메모(줄마다 `<p>`, HTML 이스케이프) + 창 열기. 글이 없으면 아무 일도 없음 |
| `clip_image` | CommandOrControl+Shift+I | 클립보드의 그림으로 이미지 메모(크롭 없이 그대로, 이름 "붙여넣은 이미지 YYYY-MM-DD HH-mm.png") + 창 열기. 그림이 없으면 아무 일도 없음 |

- Rust `shortcut.rs`가 설정의 enabled이고 keys가 비어 있지 않은 것을 전부 등록한다. 하나가 실패해도 나머지는 등록하고, 실패는 `shortcut_errors`로 조회한다.
- 같은 조합을 두 id가 쓰면 앞의 것(표 순서)만 등록되고 뒤의 것은 "다른 동작과 같은 조합입니다"로 실패한다.
- 창 안 단축키(전역 아님)는 프런트 고정: 메모 창 Ctrl+N 새 메모 / Ctrl+W 닫기 / Ctrl+T 항상 위 / Ctrl+D 즐겨찾기 / Ctrl+E 메모함에서 보기 / Ctrl+1~7 팔레트 첫 줄 색. 메모함 Ctrl+N 새 메모 / Ctrl+F 검색 / Esc 선택 해제·검색 지우기 / Ctrl+, 설정. 맥은 Ctrl 대신 Cmd.
