/**
 * 메모 우클릭 메뉴. 메모 창과 메모함 목록·편집 칸이 같은 것을 쓴다(design/mockup.html의 #menu / #trashMenu).
 * 문서에 하나만 있고, 열 때마다 내용을 다시 그린다. 결정은 onAction 콜백으로 돌려주고 저장은 호출자 몫이다.
 *
 * 여기서 지킨 것 셋:
 *  1. `'note'` 모드(메모 창)는 짧게 간다. 즐겨찾기는 창 손잡이의 별이, 목록 상단 고정은 메모함이 맡는다.
 *  2. 하위 메뉴는 CSS `:hover`가 아니라 JS로 연다. 320px 메모 창에서는 `left:100%`가 창 밖이라
 *     아예 보이지 않았다. 열 때 재 보고 오른쪽에 자리가 없으면 왼쪽, 아래가 모자라면 위로 붙인다.
 *  3. 최근·즐겨찾는 색은 설정에 있고 설정 읽기는 비동기다. 그래서 먼저 기본 팔레트로 그리고
 *     값이 오면 팔레트 부분만 다시 그린다(메뉴를 늦게 여는 쪽이 더 나쁘다).
 */
import { getSettings, onSettingsChanged, updateSettings } from '../api.ts';
import type { Category, Note, Settings, SettingsPatch } from '../types.ts';
import { PALETTE, isValidHex } from './colors.ts';
import './context-menu.css';

export type MenuMode = 'note' | 'list' | 'trash';

export type MenuAction =
  | { type: 'color'; color: string }
  | { type: 'always_on_top' }
  | { type: 'favorite' }
  | { type: 'list_pinned' }
  | { type: 'category'; category_id: string | null }
  | { type: 'duplicate' }  // list 모드: 같은 내용의 메모를 하나 더 만든다
  | { type: 'toggle' }   // note 모드: 메모함에서 보기 / list 모드: 펼치기 또는 창 닫기
  | { type: 'delete' }
  | { type: 'restore' }
  | { type: 'purge' };

export interface MenuRequest {
  x: number;
  y: number;
  note: Note;
  categories: Category[];
  mode: MenuMode;
  onAction: (action: MenuAction) => void;
}

// ── 색 목록(순수 함수. 테스트가 여기를 본다) ────────────────────────────────

export const MAX_RECENT_COLORS = 10;
export const MAX_FAVORITE_COLORS = 10;

const PRESET_COLORS = new Set(PALETTE.map(([hex]) => hex.toLowerCase()));

/** 기본 팔레트 14색인지. 이미 팔레트에 있으니 최근 목록에는 넣지 않는다. */
export function isPresetColor(color: string): boolean {
  return PRESET_COLORS.has(color.trim().toLowerCase());
}

function norm(color: string): string | null {
  const hex = color.trim().toLowerCase();
  return isValidHex(hex) ? hex : null;
}

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * 최근 쓴 색을 앞에 넣는다. 중복은 빼고 최대 `limit`개.
 * 기본 팔레트 색과 hex가 아닌 값은 그냥 넘긴다(목록이 그대로 돌아온다).
 */
export function pushRecent(
  list: readonly string[],
  color: string,
  limit = MAX_RECENT_COLORS,
): string[] {
  const hex = norm(color);
  if (hex === null || isPresetColor(hex)) return [...list];
  return [hex, ...list.filter((c) => !same(c, hex))].slice(0, limit);
}

/** 즐겨찾는 색 토글. 이미 있으면 빼고, 없으면 앞에 넣는다(최대 `limit`개). */
export function toggleFavoriteColor(
  list: readonly string[],
  color: string,
  limit = MAX_FAVORITE_COLORS,
): string[] {
  const hex = norm(color);
  if (hex === null) return [...list];
  if (list.some((c) => same(c, hex))) return list.filter((c) => !same(c, hex));
  return [hex, ...list].slice(0, limit);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ── 설정 캐시 ───────────────────────────────────────────────────────────────
// 메뉴는 동기로 그려야 해서 캐시를 두고, 열 때마다 다시 읽어 팔레트만 갱신한다.

let settings: Settings | null = null;
let watching = false;

function refreshSettings(): Promise<void> {
  return Promise.resolve()
    .then(() => getSettings())
    .then((s) => {
      if (s) settings = s;
    })
    .catch(() => {
      // 설정을 못 읽어도 기본 팔레트는 나와야 한다.
    });
}

function watchSettings(): void {
  if (watching) return;
  watching = true;
  void Promise.resolve()
    .then(() =>
      onSettingsChanged((s) => {
        settings = s;
      }),
    )
    .catch(() => {});
}

function saveSettings(patch: SettingsPatch): void {
  void Promise.resolve()
    .then(() => updateSettings(patch))
    .catch((e) => console.error(e));
}

// ── 메뉴 본체 ───────────────────────────────────────────────────────────────

let root: HTMLDivElement | null = null;
let currentOnAction: ((a: MenuAction) => void) | null = null;
let current: MenuRequest | null = null;
/** 열 때마다 올린다. 늦게 도착한 설정이 이미 닫힌(또는 다시 연) 메뉴를 건드리지 않게. */
let generation = 0;

function ensureRoot(): HTMLDivElement {
  if (root) {
    // 테스트나 다시 그리기로 body가 비워졌으면 다시 붙인다.
    if (!root.isConnected) document.body.appendChild(root);
    return root;
  }
  root = document.createElement('div');
  root.className = 'cmenu';
  root.hidden = true;
  root.setAttribute('role', 'menu');
  document.body.appendChild(root);
  document.addEventListener('pointerdown', (e) => {
    if (root && !root.hidden && !(e.target instanceof Node && root.contains(e.target))) closeContextMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeContextMenu();
  });
  window.addEventListener('blur', closeContextMenu);
  return root;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

function item(label: string, action: string, checked = false, extra = ''): string {
  return `<button class="cmi ${extra}" data-action="${action}" role="menuitem"><span class="chk">${checked ? '✓' : ''}</span>${esc(label)}</button>`;
}

function swatch(hex: string, label: string, currentColor: string): string {
  const on = same(hex, currentColor) ? 'on' : '';
  return `<button class="sw ${on}" data-color="${esc(hex)}" title="${esc(label)}" style="--c:${esc(hex)}" role="menuitem"></button>`;
}

/** 기본 14색 + 직접 고르기 / 최근 / 즐겨찾기. 비어 있는 줄은 라벨째 빠진다. */
function paletteHtml(color: string): string {
  const presets = PALETTE.map(([hex, label]) => swatch(hex, label, color)).join('');
  const custom = `<label class="sw custom ${isPresetColor(color) ? '' : 'on'}" title="직접 고르기"><input type="color" value="${esc(color)}" aria-label="직접 고르기"></label>`;

  const recent = (settings?.recent_colors ?? []).slice(0, MAX_RECENT_COLORS);
  const favorites = (settings?.favorite_colors ?? []).slice(0, MAX_FAVORITE_COLORS);
  const chips = (list: readonly string[]): string => list.map((hex) => swatch(hex, hex, color)).join('');

  const recentRow =
    recent.length === 0
      ? ''
      : `<div class="crow"><span class="clabel">최근</span><span class="chips">${chips(recent)}</span></div>`;

  // 즐겨찾기 줄은 비어 있어도 남긴다. ☆ 버튼이 여기 말고는 갈 데가 없다.
  const starred = favorites.some((c) => same(c, color));
  const favRow =
    `<div class="crow"><span class="clabel">즐겨찾기</span><span class="chips">${chips(favorites)}` +
    `<button class="favtoggle ${starred ? 'on' : ''}" data-favcolor="1" role="menuitem" title="${starred ? '즐겨찾기에서 빼기' : '지금 색을 즐겨찾기에 추가'}">${starred ? '★' : '☆'}</button>` +
    `</span></div>`;

  return `<div class="swatches">${presets}${custom}</div>${recentRow}${favRow}`;
}

function menuHtml(req: MenuRequest): string {
  const { note, categories, mode } = req;
  if (mode === 'trash') {
    return item('복원', 'restore') + item('완전히 삭제', 'purge', false, 'danger');
  }

  const toggleLabel = mode === 'note' ? '메모함에서 보기' : note.is_open ? '창 닫기' : '바탕화면에 펼치기';
  const cats = [['미분류', null] as const, ...categories.map((c) => [c.name, c.id] as const)]
    .map(
      ([label, id]) =>
        `<button class="cmi" data-category="${id ?? ''}" role="menuitem"><span class="chk">${(note.category_id ?? null) === id ? '✓' : ''}</span>${esc(label)}</button>`,
    )
    .join('');
  const sub = `<div class="sub"><button class="cmi subbtn" role="menuitem"><span class="chk"></span>카테고리 이동<span class="arrow">›</span></button><div class="submenu">${cats}</div></div>`;
  const palette = `<div class="palette">${paletteHtml(note.color)}</div><div class="sep"></div>`;

  if (mode === 'note') {
    return (
      palette +
      item('항상 위에 고정', 'always_on_top', note.always_on_top) +
      sub +
      `<div class="sep"></div>` +
      item(toggleLabel, 'toggle') +
      `<div class="sep"></div>` +
      item('삭제', 'delete', false, 'danger')
    );
  }
  return (
    palette +
    item('항상 위에 고정', 'always_on_top', note.always_on_top) +
    item('즐겨찾기', 'favorite', note.favorite) +
    item('목록 상단에 고정', 'list_pinned', note.list_pinned) +
    sub +
    item('복제', 'duplicate') +
    item(toggleLabel, 'toggle') +
    `<div class="sep"></div>` +
    item('삭제', 'delete', false, 'danger')
  );
}

function applyColor(color: string): void {
  recordRecent(color);
  fire({ type: 'color', color });
}

function recordRecent(color: string): void {
  if (!settings) return;
  const prev = settings.recent_colors ?? [];
  const next = pushRecent(prev, color);
  if (sameList(prev, next)) return;
  settings = { ...settings, recent_colors: next };
  saveSettings({ recent_colors: next });
}

function toggleFavorite(color: string): void {
  if (!settings) return;
  const next = toggleFavoriteColor(settings.favorite_colors ?? [], color);
  settings = { ...settings, favorite_colors: next };
  saveSettings({ favorite_colors: next });
  redrawPalette();
}

/** 팔레트만 다시 그린다. 메뉴는 열어 둔 채다(즐겨찾기 별을 누른 뒤 계속 고를 수 있게). */
function redrawPalette(): void {
  const el = root;
  if (!el || el.hidden || !current || current.mode === 'trash') return;
  const host = el.querySelector<HTMLElement>('.palette');
  if (!host) return;
  host.innerHTML = paletteHtml(current.note.color);
  bindPalette(el);
  place(el, current.x, current.y);
}

function bindPalette(el: HTMLDivElement): void {
  el.querySelectorAll<HTMLButtonElement>('.sw[data-color]').forEach((b) => {
    b.onclick = () => applyColor(b.dataset['color']!);
  });
  const picker = el.querySelector<HTMLInputElement>('input[type=color]');
  if (picker) {
    // 색 대화상자에서 고르는 동안 실시간 반영. 메뉴는 닫지 않는다(input을 닫으면 대화상자도 죽는다).
    picker.oninput = () => currentOnAction?.({ type: 'color', color: picker.value });
    // 기록은 대화상자를 닫을 때 한 번만. input마다 기록하면 드래그 중 수십 개가 쌓인다.
    picker.onchange = () => {
      currentOnAction?.({ type: 'color', color: picker.value });
      if (current) current.note.color = picker.value;
      recordRecent(picker.value);
      redrawPalette();
    };
    picker.onpointerdown = (e) => e.stopPropagation();
  }
  const fav = el.querySelector<HTMLButtonElement>('[data-favcolor]');
  if (fav) {
    fav.onclick = () => {
      if (current) toggleFavorite(current.note.color);
    };
  }
}

/**
 * 하위 메뉴 열기. 메인 메뉴 오른쪽에 붙이되 자리가 없으면 왼쪽으로, 아래가 모자라면 위로 올린다.
 * `position: fixed`라 메뉴의 `overflow: auto`에 잘리지 않는다.
 */
function bindSubmenu(el: HTMLDivElement): void {
  const sub = el.querySelector<HTMLElement>('.sub');
  const btn = el.querySelector<HTMLElement>('.sub .subbtn');
  const menu = el.querySelector<HTMLElement>('.sub .submenu');
  if (!sub || !btn || !menu) return;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const close = (): void => {
    cancel();
    sub.classList.remove('open');
  };
  const open = (): void => {
    cancel();
    sub.classList.add('open');
    // 재기 전에 좌상단으로 보내 둔다. 화면 끝에 붙어 있으면 폭이 줄어든 채로 재진다.
    menu.style.left = '0px';
    menu.style.top = '0px';
    const box = el.getBoundingClientRect();
    const anchor = btn.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = box.right;
    if (left + m.width > vw - 4) left = box.left - m.width;
    if (left < 4) left = 4;
    let top = anchor.top - 6;
    if (top + m.height > vh - 4) top = vh - m.height - 4;
    if (top < 4) top = 4;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  };

  sub.addEventListener('pointerenter', open);
  sub.addEventListener('pointerleave', () => {
    cancel();
    // 버튼과 하위 메뉴 사이를 지날 때 깜빡이지 않게 조금 기다린다.
    timer = setTimeout(close, 160);
  });
  // 클릭은 열기만 한다. 마우스가 올라오며 이미 열렸는데 클릭이 닫아 버리면 "눌렀는데 사라진" 것처럼 보인다.
  btn.addEventListener('click', open);
}

function place(el: HTMLElement, x: number, y: number): void {
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
}

export function openContextMenu(req: MenuRequest): void {
  const el = ensureRoot();
  currentOnAction = req.onAction;
  current = req;
  generation += 1;
  const gen = generation;
  watchSettings();

  el.innerHTML = menuHtml(req);
  if (req.mode !== 'trash') {
    bindPalette(el);
    bindSubmenu(el);
    el.querySelectorAll<HTMLButtonElement>('[data-category]').forEach((b) => {
      b.onclick = () => fire({ type: 'category', category_id: b.dataset['category'] || null });
    });
  }
  el.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((b) => {
    b.onclick = () => fire({ type: b.dataset['action'] } as MenuAction);
  });

  el.hidden = false;
  place(el, req.x, req.y);

  if (req.mode !== 'trash') {
    // 설정이 늦게 와도 팔레트만 갈아 끼우면 된다. 그 사이 메뉴가 닫혔거나 다시 열렸으면 그만둔다.
    void refreshSettings().then(() => {
      if (gen === generation) redrawPalette();
    });
  }
}

function fire(action: MenuAction): void {
  const cb = currentOnAction;
  closeContextMenu();
  cb?.(action);
}

export function closeContextMenu(): void {
  if (!root) return;
  root.hidden = true;
  currentOnAction = null;
  current = null;
}
