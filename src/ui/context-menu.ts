/**
 * 메모 우클릭 메뉴. 메모 창과 메모함 목록·편집 칸이 같은 것을 쓴다(design/mockup.html의 #menu / #trashMenu).
 * 문서에 하나만 있고, 열 때마다 내용을 다시 그린다. 결정은 onAction 콜백으로 돌려주고 저장은 호출자 몫이다.
 */
import type { Category, Note } from '../types.ts';
import { PALETTE } from './colors.ts';
import './context-menu.css';

export type MenuMode = 'note' | 'list' | 'trash';

export type MenuAction =
  | { type: 'color'; color: string }
  | { type: 'always_on_top' }
  | { type: 'favorite' }
  | { type: 'list_pinned' }
  | { type: 'category'; category_id: string | null }
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

let root: HTMLDivElement | null = null;
let currentOnAction: ((a: MenuAction) => void) | null = null;

function ensureRoot(): HTMLDivElement {
  if (root) return root;
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

export function openContextMenu(req: MenuRequest): void {
  const el = ensureRoot();
  const { note, categories, mode } = req;
  currentOnAction = req.onAction;

  if (mode === 'trash') {
    el.innerHTML = item('복원', 'restore') + item('완전히 삭제', 'purge', false, 'danger');
  } else {
    const isPreset = PALETTE.some(([hex]) => hex.toLowerCase() === note.color.toLowerCase());
    const swatches = PALETTE.map(
      ([hex, label]) =>
        `<button class="sw ${hex.toLowerCase() === note.color.toLowerCase() ? 'on' : ''}" data-color="${hex}" title="${label}" style="--c:${hex}" role="menuitem"></button>`,
    ).join('');
    const custom = `<label class="sw custom ${isPreset ? '' : 'on'}" title="직접 고르기"><input type="color" value="${esc(note.color)}" aria-label="직접 고르기"></label>`;
    const toggleLabel = mode === 'note' ? '메모함에서 보기' : note.is_open ? '창 닫기' : '바탕화면에 펼치기';
    const cats = [['미분류', null] as const, ...categories.map((c) => [c.name, c.id] as const)]
      .map(([label, id]) => `<button class="cmi" data-category="${id ?? ''}" role="menuitem"><span class="chk">${(note.category_id ?? null) === id ? '✓' : ''}</span>${esc(label)}</button>`)
      .join('');
    el.innerHTML =
      `<div class="swatches">${swatches}${custom}</div><div class="sep"></div>` +
      item('항상 위에 고정', 'always_on_top', note.always_on_top) +
      item('즐겨찾기', 'favorite', note.favorite) +
      item('목록 상단에 고정', 'list_pinned', note.list_pinned) +
      `<div class="sub"><button class="cmi" role="menuitem"><span class="chk"></span>카테고리 이동<span class="arrow">›</span></button><div class="submenu">${cats}</div></div>` +
      item(toggleLabel, 'toggle') +
      `<div class="sep"></div>` +
      item('삭제', 'delete', false, 'danger');

    el.querySelectorAll<HTMLButtonElement>('.sw[data-color]').forEach((b) => {
      b.onclick = () => fire({ type: 'color', color: b.dataset['color']! });
    });
    const picker = el.querySelector<HTMLInputElement>('input[type=color]');
    if (picker) {
      // 색 대화상자에서 고르는 동안 실시간 반영. 메뉴는 닫지 않는다(input을 닫으면 대화상자도 죽는다).
      picker.oninput = () => currentOnAction?.({ type: 'color', color: picker.value });
      picker.onpointerdown = (e) => e.stopPropagation();
    }
    el.querySelectorAll<HTMLButtonElement>('[data-category]').forEach((b) => {
      b.onclick = () => fire({ type: 'category', category_id: b.dataset['category'] || null });
    });
  }

  el.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((b) => {
    b.onclick = () => fire({ type: b.dataset['action'] } as MenuAction);
  });

  el.hidden = false;
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(req.x, window.innerWidth - r.width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(req.y, window.innerHeight - r.height - 4))}px`;
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
}
