/**
 * Rust와 주고받는 값의 모양. 계약의 원본은 `docs/contract.md`이고 이 파일은 그것을
 * TypeScript로 옮긴 것이다. 바꿀 때는 계약 문서를 먼저 고친다.
 *
 * JSON은 그대로 snake_case다(파일에 저장되는 모양과 같다).
 */

export interface WindowRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Note {
  id: string;
  /** 제한된 HTML. 허용: p br ul ol li b i u s, li에만 class "task" / "task done". 프런트가 정제해서 보낸다. */
  html: string;
  /** html에서 파생한 평문. 블록마다 "\n". 제목은 첫 비어 있지 않은 줄. 프런트가 계산해서 보낸다. */
  text: string;
  /** "#RRGGBB" */
  color: string;
  category_id: string | null;
  favorite: boolean;
  /** 메모함 목록 상단 고정 */
  list_pinned: boolean;
  always_on_top: boolean;
  /** 11..28 (px) */
  font_size: number;
  /** 논리 픽셀. null이면 OS 기본 위치, 320×320 */
  window: WindowRect | null;
  /** 바탕화면에 펼쳐져 있는지. 앱 재시작 때 복원 기준 */
  is_open: boolean;
  /** RFC3339 UTC */
  created_at: string;
  /** 내용·메타 변경 때만 갱신. window / is_open 변경은 갱신하지 않는다 */
  updated_at: string;
  /** 휴지통. null이면 살아 있음 */
  deleted_at: string | null;
  /** 텍스트 메모 / 이미지 메모. 옛 파일에는 없으니 Rust가 'text'로 채운다 */
  kind: 'text' | 'image';
  /** 이미지 메모의 그림. 텍스트 메모면 null */
  image: NoteImage | null;
}

export interface NoteImage {
  /** 데이터 폴더 기준 상대 경로. 항상 "images/<id>.png" */
  file: string;
  /** 원본 파일명. 메모함 목록의 제목 */
  name: string;
  /** 저장된(자른) 이미지의 픽셀 크기. 창 비율의 기준 */
  w: number;
  h: number;
}

/** `create_image_note`의 입력. png_base64는 data URL 접두사 없이. */
export interface CreateImageNoteInput {
  png_base64: string;
  name: string;
  w: number;
  h: number;
  category_id?: string | null;
  favorite?: boolean;
}

export interface Category {
  id: string;
  name: string;
  sort: number;
  created_at: string;
}

export type Theme = 'system' | 'light' | 'dark';

export interface Settings {
  shortcut_enabled: boolean;
  /** tauri global-shortcut 표기. 기본 "CommandOrControl+Shift+N" */
  shortcut: string;
  /** 켜면 "--hidden" 인자로 등록된다 */
  autostart: boolean;
  /** 메모함·설정 창만 해당 */
  theme: Theme;
  default_color: string;
  /** 새 메모(= 메모 창)의 글자 크기 */
  default_font_size: number;
  /** 메모함 편집 칸 전용 글자 크기. 11..28, 기본 14. 메모의 font_size와 무관하다 */
  box_font_size: number;
  /** 최근 쓴 색. 최신이 앞, 중복 없음, 최대 10. 기본 팔레트 14색은 넣지 않는다 */
  recent_colors: string[];
  /** 즐겨찾는 색. 최대 10. 우클릭 메뉴 팔레트의 ☆로 넣고 뺀다 */
  favorite_colors: string[];
  /** null = 기본 폴더 */
  data_dir: string | null;
  /** 첫 실행 안내 메모를 만들었는지. 지워도 다시 만들지 않는다 */
  guide_seeded: boolean;
}

/** `create_note`의 입력. 빠진 값은 설정 기본값으로 채워진다. */
export interface CreateNoteInput {
  color?: string;
  category_id?: string | null;
  favorite?: boolean;
  html?: string;
  text?: string;
  window?: WindowRect | null;
}

/**
 * `update_note`의 patch. 온 칸만 바뀐다.
 * `window`만 보내면 `updated_at`은 갱신되지 않는다(동기화 잡음 방지).
 */
export type NotePatch = Partial<
  Pick<
    Note,
    | 'html'
    | 'text'
    | 'color'
    | 'category_id'
    | 'favorite'
    | 'list_pinned'
    | 'always_on_top'
    | 'font_size'
    | 'window'
  >
>;

export type SettingsPatch = Partial<Settings>;

/** `store:changed` 이벤트의 페이로드. */
export interface StoreChanged {
  kind: 'notes' | 'categories' | 'all';
  ids: string[];
  /**
   * 변경을 일으킨 창 라벨. 파일 감시면 "fs", 트레이·단축키·시작 복원 등이면 "system".
   * 편집기는 자기 라벨이 source인 notes 이벤트를 무시한다(커서 튐 방지).
   */
  source: string;
}
