/**
 * 메모함 창(라벨 `box`). 시안 design/mockup.html의 3단 그대로다 — 사이드바 · 목록 · 편집 칸.
 * 시안에 있는 커스텀 제목줄(.win-bar)은 없다. 메모함은 OS 장식이 있는 일반 창이라 제목줄은 OS 것이다.
 *
 * 여기서 지킨 것 셋:
 *  1. 편집기는 창이 살아 있는 동안 하나다. 선택이 바뀌어도 다시 만들지 않고 setHtml/setFontSize로
 *     갈아 끼운다. 다시 만들면 포커스·실행 취소 스택이 날아간다.
 *  2. 저장은 전부 디바운스다(본문 400ms, 글자 크기 300ms, 색 200ms). 선택을 바꾸거나 창이 닫히기
 *     전에 flush 한다. 색은 색 대화상자를 끄는 동안 input이 쉼 없이 오기 때문에 디바운스가 필요하다.
 *  3. `store:changed`의 source가 내 라벨이면 편집기 본문을 건드리지 않는다(커서 튐 방지).
 *     다른 창·파일 감시가 일으킨 변경만 반영하고, 그때도 포커스가 편집기에 있으면 blur까지 미룬다.
 */
import { getCurrentWindow } from '@tauri-apps/api/window';

import {
  closeNoteWindow,
  createCategory,
  createNote,
  deleteCategory,
  deleteNote,
  emptyTrash,
  getSettings,
  listCategories,
  listNotes,
  onSettingsChanged,
  onStoreChanged,
  openNoteWindow,
  purgeNote,
  renameCategory,
  restoreNote,
  updateNote,
  showSettings,
} from '../api.ts';
import { attachFormatToolbar, createEditor, previewOf, titleOf } from '../editor/index.ts';
import type { Category, Note, NotePatch } from '../types.ts';
import { DEFAULT_COLOR, applyNoteColor, isValidHex } from './colors.ts';
import { openContextMenu, type MenuAction } from './context-menu.ts';
import { applyTheme } from './theme.ts';
import { relativeTime } from './time.ts';
import './box.css';

// ── 보기와 목록 계산(순수 함수. 테스트가 여기를 본다) ────────────────────────

/** 사이드바가 고르는 보기. 카테고리는 `cat:<id>`로 적어 그대로 data 속성이 된다. */
export type View = 'all' | 'favorite' | 'unfiled' | 'trash' | `cat:${string}`;

export function parseView(raw: string): View {
  if (raw === 'all' || raw === 'favorite' || raw === 'unfiled' || raw === 'trash') return raw;
  return raw.startsWith('cat:') ? (raw as View) : 'all';
}

export function matchesView(note: Note, view: View): boolean {
  if (view === 'trash') return note.deleted_at !== null;
  if (note.deleted_at !== null) return false;
  if (view === 'all') return true;
  if (view === 'favorite') return note.favorite;
  if (view === 'unfiled') return note.category_id === null;
  return note.category_id === view.slice('cat:'.length);
}

/** 평문 부분 일치, 대소문자 무시. 빈 검색어는 전부 통과. */
export function matchesQuery(note: Note, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return note.text.toLowerCase().includes(q);
}

/** 상단 고정이 먼저, 그다음 최근에 고친 것부터. */
export function sortNotes(notes: readonly Note[]): Note[] {
  return [...notes].sort((a, b) => {
    if (a.list_pinned !== b.list_pinned) return a.list_pinned ? -1 : 1;
    return b.updated_at.localeCompare(a.updated_at);
  });
}

export function visibleNotes(notes: readonly Note[], view: View, query: string): Note[] {
  return sortNotes(notes.filter((n) => matchesView(n, view) && matchesQuery(n, query)));
}

export function countFor(notes: readonly Note[], view: View): number {
  return notes.reduce((n, note) => n + (matchesView(note, view) ? 1 : 0), 0);
}

// ── 자잘한 도구 ──────────────────────────────────────────────────────────────

const STAR_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg>';
const PIN_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="fill" d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/><path d="M12 14v7"/></svg>';
const SEARCH_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
const EMPTY_TEXT = '왼쪽 목록에서 메모를 고르면 여기서 바로 편집합니다.<br>더블클릭하면 바탕화면에도 펼칩니다.';

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

function stripe(note: Note): string {
  return isValidHex(note.color) ? note.color : DEFAULT_COLOR;
}

interface Debounced {
  schedule(fn: () => void): void;
  flush(): void;
}

function debounced(ms: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: (() => void) | null = null;
  return {
    schedule(fn) {
      pending = fn;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const run = pending;
        pending = null;
        run?.();
      }, ms);
    },
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const run = pending;
      pending = null;
      run?.();
    },
  };
}

// ── 마운트 ───────────────────────────────────────────────────────────────────

type CatEdit = { kind: 'new'; value: string } | { kind: 'rename'; id: string; value: string };

export function mountBox(root: HTMLElement): void {
  const myLabel = getCurrentWindow().label;

  let notes: Note[] = [];
  let cats: Category[] = [];
  let view: View = 'all';
  let query = '';
  let selectedId: string | null = null;
  let catEdit: CatEdit | null = null;
  /** 포커스 때문에 미뤄 둔 외부 변경 본문. blur 때 넣는다. */
  let pendingHtml: string | null = null;

  const saveText = debounced(400);
  const saveFont = debounced(300);
  const saveColor = debounced(200);

  // ── 뼈대 ──
  root.className = 'box-body';
  // Ctrl+, → 설정. 트레이 메뉴 말고도 메모함 안에서 바로 열 수 있게(흔한 관례).
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      void showSettings().catch((err) => console.error(err));
    }
  });
  root.innerHTML =
    '<nav class="side" aria-label="분류"></nav>' +
    '<div class="listpane">' +
    '<div class="tools">' +
    `<label class="search">${SEARCH_SVG}<input type="search" placeholder="메모 검색" aria-label="메모 검색"></label>` +
    '<button class="btn new" type="button" title="새 메모">＋</button>' +
    '</div>' +
    '<div class="trashbar" hidden><button class="btn ghost sm empty-trash" type="button">휴지통 비우기</button></div>' +
    '<div class="hint" hidden></div><div class="err" hidden></div>' +
    '<div class="list" role="listbox" aria-label="메모 목록"></div>' +
    '</div>' +
    '<div class="editpane">' +
    `<div class="ed-empty empty">${EMPTY_TEXT}</div>` +
    '<div class="ed-head" hidden><span class="dot"></span><span class="title"></span>' +
    `<button class="ib star" type="button" title="즐겨찾기">${STAR_SVG}</button>` +
    `<button class="ib top" type="button" title="목록 상단에 고정">${PIN_SVG}</button>` +
    '<button class="btn ghost sm open" type="button"></button></div>' +
    '<div class="fsnote" hidden><span>Ctrl+휠로 이 메모의 글자 크기를 바꾸고, Ctrl+0으로 기본 크기로 돌아갑니다</span><span class="fs"></span></div>' +
    '</div>';

  const pick = <T extends HTMLElement>(sel: string): T => root.querySelector<T>(sel)!;
  const side = pick<HTMLElement>('.side');
  const listEl = pick<HTMLElement>('.list');
  const hintEl = pick<HTMLElement>('.hint');
  const errEl = pick<HTMLElement>('.err');
  const trashBar = pick<HTMLElement>('.trashbar');
  const searchInput = pick<HTMLInputElement>('.search input');
  const editpane = pick<HTMLElement>('.editpane');
  const edEmpty = pick<HTMLElement>('.ed-empty');
  const edHead = pick<HTMLElement>('.ed-head');
  const fsNote = pick<HTMLElement>('.fsnote');

  const editor = createEditor({
    onChange: (html, text) => {
      const id = selectedId;
      if (id === null) return;
      const note = byId(id);
      if (note) {
        // 목록의 제목·미리보기가 바로 따라오도록 손안의 값도 같이 고친다.
        note.html = html;
        note.text = text;
        note.updated_at = new Date().toISOString();
        renderList();
        renderHeadText(note);
      }
      saveText.schedule(() => void patch(id, { html, text }));
    },
    onFontSizeDelta: (delta) => bumpFontSize(delta),
    onFontSizeReset: () => resetFontSize(),
  });
  editpane.insertBefore(editor.el, fsNote);
  editor.el.hidden = true;
  editor.el.addEventListener('blur', () => {
    if (pendingHtml === null) return;
    const html = pendingHtml;
    pendingHtml = null;
    editor.setHtml(html);
  });
  const toolbar = attachFormatToolbar(() => [editor.el]);
  editpane.addEventListener('contextmenu', (e) => {
    const note = selected();
    if (!note || !(e.target instanceof Element) || !editor.el.contains(e.target)) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, note);
  });

  // ── 도우미 ──
  const byId = (id: string): Note | undefined => notes.find((n) => n.id === id);
  const selected = (): Note | null => (selectedId === null ? null : (byId(selectedId) ?? null));

  let errTimer: ReturnType<typeof setTimeout> | null = null;
  function fail(e: unknown): void {
    errEl.textContent = typeof e === 'string' ? e : e instanceof Error ? e.message : '작업에 실패했습니다.';
    errEl.hidden = false;
    if (errTimer !== null) clearTimeout(errTimer);
    errTimer = setTimeout(() => {
      errEl.hidden = true;
    }, 5000);
  }

  async function patch(id: string, p: NotePatch): Promise<void> {
    try {
      await updateNote(id, p);
    } catch (e) {
      fail(e);
    }
  }

  async function reload(kind: 'notes' | 'categories' | 'all' = 'all'): Promise<void> {
    try {
      const [freshNotes, freshCats] = await Promise.all([
        listNotes(),
        kind === 'notes' ? Promise.resolve(cats) : listCategories(),
      ]);
      notes = freshNotes;
      cats = freshCats;
    } catch (e) {
      fail(e);
    }
  }

  // ── 사이드바 ──
  function catRow(v: View, label: string, cls = ''): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `cat ${cls} ${view === v ? 'on' : ''}`.trim();
    b.dataset['view'] = v;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = label;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = String(countFor(notes, v));
    b.append(name, n);
    b.addEventListener('click', () => {
      view = v;
      renderAll();
    });
    return b;
  }

  function catInput(value: string, commit: (name: string) => void): HTMLInputElement {
    const input = document.createElement('input');
    input.className = 'catinput';
    input.type = 'text';
    input.value = value;
    input.setAttribute('aria-label', '카테고리 이름');
    input.addEventListener('input', () => {
      if (catEdit) catEdit.value = input.value;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const name = input.value.trim();
        catEdit = null;
        if (name) commit(name);
        renderSide();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        catEdit = null;
        renderSide();
      }
    });
    input.addEventListener('blur', () => {
      if (!catEdit) return;
      catEdit = null;
      renderSide();
    });
    return input;
  }

  function renderSide(): void {
    side.innerHTML = '';
    side.append(catRow('all', '전체'), catRow('favorite', '즐겨찾기'), catRow('unfiled', '미분류'));

    const h = document.createElement('h6');
    h.textContent = '카테고리';
    side.append(h);

    for (const c of cats) {
      if (catEdit?.kind === 'rename' && catEdit.id === c.id) {
        side.append(
          catInput(catEdit.value, (name) => {
            renameCategory(c.id, name).catch(fail);
          }),
        );
        continue;
      }
      const row = catRow(`cat:${c.id}`, c.name);
      row.addEventListener('dblclick', () => {
        catEdit = { kind: 'rename', id: c.id, value: c.name };
        renderSide();
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openCatMenu(e.clientX, e.clientY, c);
      });
      side.append(row);
    }

    if (catEdit?.kind === 'new') {
      side.append(
        catInput(catEdit.value, (name) => {
          createCategory(name).catch(fail);
        }),
      );
    } else {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'cat add';
      add.textContent = '＋ 새 카테고리';
      add.addEventListener('click', () => {
        // window.prompt는 WebView2에서 동작하지 않는다. 사이드바 안에서 직접 받는다.
        catEdit = { kind: 'new', value: '' };
        renderSide();
      });
      side.append(add);
    }

    const grow = document.createElement('div');
    grow.className = 'grow';
    side.append(grow, catRow('trash', '휴지통'));

    if (catEdit) {
      const input = side.querySelector<HTMLInputElement>('.catinput');
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }
  }

  // ── 카테고리 우클릭 메뉴(작아서 context-menu.ts를 쓰지 않는다) ──
  let catMenu: HTMLDivElement | null = null;
  function closeCatMenu(): void {
    if (catMenu) catMenu.hidden = true;
  }
  function openCatMenu(x: number, y: number, c: Category): void {
    if (!catMenu) {
      catMenu = document.createElement('div');
      catMenu.className = 'catmenu';
      catMenu.hidden = true;
      catMenu.setAttribute('role', 'menu');
      document.body.append(catMenu);
      document.addEventListener('pointerdown', (e) => {
        if (catMenu && !catMenu.hidden && !(e.target instanceof Node && catMenu.contains(e.target))) closeCatMenu();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeCatMenu();
      });
    }
    catMenu.innerHTML =
      '<button type="button" role="menuitem" data-act="rename">이름 바꾸기</button>' +
      '<button type="button" role="menuitem" class="danger" data-act="delete">삭제</button>';
    catMenu.querySelector<HTMLButtonElement>('[data-act=rename]')!.onclick = () => {
      closeCatMenu();
      catEdit = { kind: 'rename', id: c.id, value: c.name };
      renderSide();
    };
    catMenu.querySelector<HTMLButtonElement>('[data-act=delete]')!.onclick = () => {
      closeCatMenu();
      if (!window.confirm(`"${c.name}" 카테고리를 지울까요?\n안에 있던 메모는 지워지지 않고 미분류가 됩니다.`)) return;
      if (view === `cat:${c.id}`) view = 'all';
      deleteCategory(c.id).catch(fail);
    };
    catMenu.hidden = false;
    const r = catMenu.getBoundingClientRect();
    catMenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
    catMenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  }

  // ── 목록 ──
  function renderList(): void {
    const rows = visibleNotes(notes, view, query);
    trashBar.hidden = view !== 'trash';
    const hint =
      view === 'trash'
        ? '우클릭으로 복원하거나 완전히 삭제합니다.'
        : view === 'favorite'
          ? '별을 눌러 즐겨찾기에 넣고 뺍니다.'
          : '';
    hintEl.textContent = hint;
    hintEl.hidden = !hint;

    const top = listEl.scrollTop;
    if (rows.length === 0) {
      const what = query
        ? '검색 결과가 없습니다'
        : view === 'trash'
          ? '휴지통이 비어 있습니다'
          : '메모가 없습니다.';
      listEl.innerHTML = `<div class="empty">${what}</div>`;
      return;
    }
    listEl.innerHTML = rows
      .map((n) => {
        const title = titleOf(n.text) || '(빈 메모)';
        const preview = previewOf(n.text);
        return (
          `<div class="item ${n.id === selectedId ? 'sel' : ''}" data-id="${esc(n.id)}" tabindex="0" role="option"` +
          ` aria-selected="${n.id === selectedId}" style="--stripe:${stripe(n)}">` +
          `<div class="t">${n.list_pinned ? '<span class="glyph" title="목록 상단에 고정">📌</span>' : ''}` +
          `<span>${esc(title)}</span>${n.is_open ? '<span class="open">펼침</span>' : ''}</div>` +
          `<div class="meta">${esc(relativeTime(n.updated_at))}` +
          `<button class="star ${n.favorite ? 'on' : ''}" type="button" title="즐겨찾기">${STAR_SVG}</button></div>` +
          `<div class="p">${esc(preview) || '&nbsp;'}</div></div>`
        );
      })
      .join('');
    listEl.scrollTop = top;
  }

  function itemNote(e: Event): Note | null {
    const el = e.target instanceof Element ? e.target.closest<HTMLElement>('.item') : null;
    const id = el?.dataset['id'];
    return id ? (byId(id) ?? null) : null;
  }

  listEl.addEventListener('click', (e) => {
    const note = itemNote(e);
    if (!note) return;
    if (e.target instanceof Element && e.target.closest('.star')) {
      void patch(note.id, { favorite: !note.favorite });
      return;
    }
    select(note.id);
  });
  listEl.addEventListener('dblclick', (e) => {
    const note = itemNote(e);
    if (note && note.deleted_at === null) openNoteWindow(note.id).catch(fail);
  });
  listEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const note = itemNote(e);
    if (note && note.deleted_at === null) openNoteWindow(note.id).catch(fail);
  });
  listEl.addEventListener('contextmenu', (e) => {
    const note = itemNote(e);
    if (!note) return;
    e.preventDefault();
    select(note.id);
    showMenu(e.clientX, e.clientY, note);
  });

  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    renderList();
  });

  pick<HTMLButtonElement>('.btn.new').addEventListener('click', () => {
    void newNote();
  });
  pick<HTMLButtonElement>('.empty-trash').addEventListener('click', () => {
    if (!window.confirm('휴지통의 메모를 전부 완전히 삭제할까요?\n되돌릴 수 없습니다.')) return;
    emptyTrash().catch(fail);
  });

  async function newNote(): Promise<void> {
    try {
      const note = await createNote({
        ...(view.startsWith('cat:') ? { category_id: view.slice('cat:'.length) } : {}),
        ...(view === 'favorite' ? { favorite: true } : {}),
      });
      notes = [...notes, note];
      await openNoteWindow(note.id);
      select(note.id);
    } catch (e) {
      fail(e);
    }
  }

  // ── 편집 칸 ──
  function select(id: string | null): void {
    if (id === selectedId) return;
    saveText.flush();
    saveFont.flush();
    saveColor.flush();
    pendingHtml = null;
    selectedId = id;
    if (document.activeElement === editor.el) editor.el.blur();
    renderList();
    renderEditor(true);
  }

  function renderHeadText(note: Note): void {
    pick<HTMLElement>('.ed-head .title').textContent = titleOf(note.text) || '(빈 메모)';
  }

  function renderEditor(loadHtml: boolean): void {
    const note = selected();
    if (!note) {
      selectedId = null;
      edEmpty.hidden = false;
      edHead.hidden = true;
      fsNote.hidden = true;
      editor.el.hidden = true;
      return;
    }
    edEmpty.hidden = true;
    edHead.hidden = false;
    fsNote.hidden = false;
    editor.el.hidden = false;

    editpane.style.setProperty('--stripe', stripe(note));
    applyNoteColor(editpane, stripe(note));
    // 편집 칸의 바탕은 메모 색이 아니라 창 색이다. 체크표시가 파내는 색만 창 색으로 되돌린다.
    editpane.style.setProperty('--n-bg', 'var(--surface)');

    renderHeadText(note);
    pick<HTMLElement>('.ed-head .star').classList.toggle('on', note.favorite);
    pick<HTMLElement>('.ed-head .top').classList.toggle('on', note.list_pinned);
    const openBtn = pick<HTMLButtonElement>('.ed-head .open');
    openBtn.textContent = note.is_open ? '창 닫기' : '바탕화면에 펼치기';
    openBtn.hidden = note.deleted_at !== null;
    pick<HTMLElement>('.fsnote .fs').textContent = `글자 ${note.font_size}px`;
    editor.setFontSize(note.font_size);

    if (loadHtml) {
      if (editor.setHtml(note.html)) pendingHtml = null;
      else pendingHtml = note.html;
    }
  }

  pick<HTMLButtonElement>('.ed-head .star').addEventListener('click', () => {
    const note = selected();
    if (note) void patch(note.id, { favorite: !note.favorite });
  });
  pick<HTMLButtonElement>('.ed-head .top').addEventListener('click', () => {
    const note = selected();
    if (note) void patch(note.id, { list_pinned: !note.list_pinned });
  });
  pick<HTMLButtonElement>('.ed-head .open').addEventListener('click', () => {
    const note = selected();
    if (!note) return;
    (note.is_open ? closeNoteWindow(note.id) : openNoteWindow(note.id)).catch(fail);
  });

  function bumpFontSize(delta: 1 | -1): void {
    const note = selected();
    if (!note) return;
    applyFontSize(Math.max(11, Math.min(28, note.font_size + delta)));
  }

  /** Ctrl+0: 설정의 기본 글자 크기로. */
  function resetFontSize(): void {
    void getSettings()
      .then((s) => applyFontSize(Math.max(11, Math.min(28, s.default_font_size))))
      .catch((err) => console.error(err));
  }

  function applyFontSize(size: number): void {
    const note = selected();
    if (!note) return;
    if (size === note.font_size) return;
    note.font_size = size;
    editor.setFontSize(size);
    pick<HTMLElement>('.fsnote .fs').textContent = `글자 ${size}px`;
    const id = note.id;
    saveFont.schedule(() => void patch(id, { font_size: size }));
  }

  // ── 우클릭 메뉴 ──
  function showMenu(x: number, y: number, note: Note): void {
    openContextMenu({
      x,
      y,
      note,
      categories: cats,
      mode: note.deleted_at !== null ? 'trash' : 'list',
      onAction: (action) => void runAction(action, note),
    });
  }

  async function runAction(action: MenuAction, note: Note): Promise<void> {
    switch (action.type) {
      case 'color': {
        note.color = action.color;
        renderList();
        if (note.id === selectedId) renderEditor(false);
        saveColor.schedule(() => void patch(note.id, { color: action.color }));
        return;
      }
      case 'always_on_top':
        return patch(note.id, { always_on_top: !note.always_on_top });
      case 'favorite':
        return patch(note.id, { favorite: !note.favorite });
      case 'list_pinned':
        return patch(note.id, { list_pinned: !note.list_pinned });
      case 'category':
        return patch(note.id, { category_id: action.category_id });
      case 'toggle':
        try {
          await (note.is_open ? closeNoteWindow(note.id) : openNoteWindow(note.id));
        } catch (e) {
          fail(e);
        }
        return;
      case 'delete':
        try {
          await deleteNote(note.id);
        } catch (e) {
          fail(e);
        }
        return;
      case 'restore':
        try {
          await restoreNote(note.id);
        } catch (e) {
          fail(e);
        }
        return;
      case 'purge':
        if (!window.confirm('이 메모를 완전히 삭제할까요?\n되돌릴 수 없습니다.')) return;
        try {
          await purgeNote(note.id);
        } catch (e) {
          fail(e);
        }
        return;
    }
  }

  // ── 전체 그리기와 동기화 ──
  function renderAll(loadHtml = false): void {
    renderSide();
    renderList();
    renderEditor(loadHtml);
  }

  function flushAll(): void {
    saveText.flush();
    saveFont.flush();
    saveColor.flush();
  }
  window.addEventListener('beforeunload', () => {
    flushAll();
    toolbar.destroy();
  });

  void (async () => {
    try {
      applyTheme((await getSettings()).theme);
    } catch (e) {
      fail(e);
    }
    await reload('all');
    renderAll(true);
  })();

  void onSettingsChanged((s) => applyTheme(s.theme));
  void onStoreChanged((p) => {
    void (async () => {
      const mine = p.source === myLabel;
      await reload(p.kind === 'notes' ? 'notes' : 'all');
      // 내가 일으킨 변경이면 편집기 본문은 그대로 둔다. 커서가 튄다.
      renderAll(!mine);
    })();
  });
}
