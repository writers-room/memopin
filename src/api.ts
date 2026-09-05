/**
 * Rust 커맨드를 감싼 얇은 층. 커맨드 이름·인자·반환은 `docs/contract.md`가 원본이고
 * 여기서는 이름만 camelCase로 바꾼다. UI는 `invoke`를 직접 부르지 말고 이 파일을 쓴다.
 *
 * 커맨드는 모두 `Result<T, String>`이라 실패하면 reject된다. reject된 값은 사용자에게
 * 그대로 보여 줄 수 있는 한국어 문자열이다.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type {
  Category,
  CreateImageNoteInput,
  CreateNoteInput,
  Note,
  NotePatch,
  Settings,
  SettingsPatch,
  StoreChanged,
} from './types.ts';

// ── 메모 ────────────────────────────────────────────────────────────────────

/** 휴지통 포함 전부. */
export function listNotes(): Promise<Note[]> {
  return invoke('list_notes');
}

export function getNote(id: string): Promise<Note> {
  return invoke('get_note', { id });
}

/** 창은 열지 않는다. 빠진 값은 설정 기본값. */
export function createNote(input: CreateNoteInput = {}): Promise<Note> {
  return invoke('create_note', { input });
}

export function updateNote(id: string, patch: NotePatch): Promise<Note> {
  return invoke('update_note', { id, patch });
}

/** 휴지통으로 보낸다. 창이 열려 있으면 닫는다. */
export function deleteNote(id: string): Promise<void> {
  return invoke('delete_note', { id });
}

export function restoreNote(id: string): Promise<void> {
  return invoke('restore_note', { id });
}

/** 파일까지 지운다. 되돌릴 수 없다. */
export function purgeNote(id: string): Promise<void> {
  return invoke('purge_note', { id });
}

export function emptyTrash(): Promise<void> {
  return invoke('empty_trash');
}

// ── 이미지 메모 ─────────────────────────────────────────────────────────────

/** 자른 PNG를 images/<id>.png에 쓰고 kind:'image' 메모를 만든다. 창은 열지 않는다. */
export function createImageNote(input: CreateImageNoteInput): Promise<Note> {
  return invoke('create_image_note', { input });
}

/** 파일 선택 대화상자로 고른 원본을 data URL로 읽는다(크롭 화면용). 20MB 초과·지원 밖 형식이면 reject. */
export function readImageFile(path: string): Promise<{ data_url: string; name: string }> {
  return invoke('read_image_file', { path });
}

/**
 * 이미지 메모의 그림 주소. Rust가 `memopin` 커스텀 프로토콜로 현재 데이터 폴더의 images/<id>.png를 준다.
 * Windows의 WebView2는 커스텀 스킴을 http://<scheme>.localhost/ 로 바꿔 부른다(Tauri 규칙).
 */
export function imageUrl(id: string): string {
  const win = navigator.userAgent.includes('Windows');
  return win ? `http://memopin.localhost/image/${encodeURIComponent(id)}` : `memopin://image/${encodeURIComponent(id)}`;
}

// ── 카테고리 ────────────────────────────────────────────────────────────────

/** sort 순. */
export function listCategories(): Promise<Category[]> {
  return invoke('list_categories');
}

export function createCategory(name: string): Promise<Category> {
  return invoke('create_category', { name });
}

export function renameCategory(id: string, name: string): Promise<Category> {
  return invoke('rename_category', { id, name });
}

/** 속한 메모의 category_id는 null이 된다. */
export function deleteCategory(id: string): Promise<void> {
  return invoke('delete_category', { id });
}

// ── 창 ──────────────────────────────────────────────────────────────────────

/** 없으면 만들고, 있으면 앞으로. 이동·크기 저장은 Rust가 알아서 한다. */
export function openNoteWindow(id: string): Promise<void> {
  return invoke('open_note_window', { id });
}

export function closeNoteWindow(id: string): Promise<void> {
  return invoke('close_note_window', { id });
}

export function showBox(): Promise<void> {
  return invoke('show_box');
}

export function showSettings(): Promise<void> {
  return invoke('show_settings');
}

// ── 설정 ────────────────────────────────────────────────────────────────────

export function getSettings(): Promise<Settings> {
  return invoke('get_settings');
}

/**
 * shortcut / shortcut_enabled / autostart는 즉시 적용된다.
 * 적용에 실패하면 reject되지만 나머지 값은 이미 저장된 뒤다(계약).
 */
export function updateSettings(patch: SettingsPatch): Promise<Settings> {
  return invoke('update_settings', { patch });
}

/** 폴더 선택 대화상자. 취소하면 null. */
export function pickDataDir(): Promise<string | null> {
  return invoke('pick_data_dir');
}

/**
 * 대상 폴더가 비어 있으면 지금 데이터를 복사하고, 이미 메모가 있으면 그것을 읽어 들인다
 * (합치지 않는다). null이면 기본 폴더로 되돌린다.
 */
export function setDataDir(path: string | null): Promise<Settings> {
  return invoke('set_data_dir', { path });
}

// ── 기타 ────────────────────────────────────────────────────────────────────

export function appVersion(): Promise<string> {
  return invoke('app_version');
}

// ── 이벤트 ──────────────────────────────────────────────────────────────────

/** 메모·카테고리가 바뀔 때마다 모든 창에 온다. 자기 자신이 일으킨 변경도 온다. */
export function onStoreChanged(cb: (payload: StoreChanged) => void): Promise<UnlistenFn> {
  return listen<StoreChanged>('store:changed', (event) => cb(event.payload));
}

export function onSettingsChanged(cb: (settings: Settings) => void): Promise<UnlistenFn> {
  return listen<Settings>('settings:changed', (event) => cb(event.payload));
}
