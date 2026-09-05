/**
 * 메모 창(창 라벨 `note-<id>`)의 안쪽. 창 자체가 메모라 여기서는 위치·크기를 다루지 않는다
 * (테두리 없는 320×320 창은 Rust가 만들고, 이동·크기 저장도 Rust가 한다 — docs/contract.md).
 *
 * 세 가지만 기억하면 된다.
 *  1. 화면은 낙관적으로 먼저 바꾸고 저장은 디바운스로 뒤따른다. 본문 400ms, 글자 크기 300ms,
 *     색 200ms(색 대화상자의 input이 연속으로 오기 때문). 창을 닫기 전에는 기다리지 않고 즉시 flush한다.
 *  2. `store:changed`의 source가 내 창 라벨이면 본문은 건드리지 않는다. 내가 방금 보낸 값이
 *     되돌아온 것이라 innerHTML을 갈아 끼우면 캐럿이 튄다. 색·고정·글자 크기만 반영한다.
 *  3. 편집 중(포커스가 편집기 안)에는 setHtml이 false를 돌려준다. 그때는 pendingHtml에 두고
 *     blur 뒤에 반영한다.
 *
 * 이미지 메모(`kind === 'image'`)는 편집기 대신 그림 하나를 창에 꽉 채운다. 다른 것은 같다 —
 * 띠·우클릭 메뉴·색은 그대로고, 색은 이제 그림 뒤 여백에만 보인다. 다만 크기는 비율을 지켜야
 * 해서 여기서만 `setSize`를 부른다(그 결과를 Rust가 평소처럼 `window`에 저장한다).
 */
import { LogicalSize, getCurrentWindow } from '@tauri-apps/api/window';

import {
  closeNoteWindow,
  createNote,
  deleteNote,
  getNote,
  imageUrl,
  listCategories,
  onStoreChanged,
  openNoteWindow,
  showBox,
  updateNote,
  getSettings,
} from '../api.ts';
import { attachFormatToolbar, createEditor, type Editor } from '../editor/index.ts';
import type { Category, Note, NotePatch, StoreChanged } from '../types.ts';
import { applyNoteColor } from './colors.ts';
import { openContextMenu, type MenuAction } from './context-menu.ts';
import './note.css';

/** 계약의 font_size 범위. */
export const MIN_FONT_SIZE = 11;
export const MAX_FONT_SIZE = 28;

/** 이미지 메모 창의 최소 가로(논리 픽셀). 이보다 좁으면 띠 버튼도 들어가지 않는다. */
export const MIN_IMAGE_W = 120;
/** 화면 폭을 읽지 못할 때 쓰는 최대 가로. */
const FALLBACK_MAX_W = 4000;
/** Ctrl+0으로 되돌아가는 가로. 계약의 기본 창 크기와 같다. */
const IMAGE_RESET_W = 320;
/** Ctrl+휠 한 칸. */
const ZOOM_STEP = 1.1;
/** 손잡이로 끈 뒤 비율을 다시 맞추기까지. */
const RESIZE_MS = 200;
/** 내가 setSize한 직후에 오는 Resized는 무시한다. */
const SELF_SIZE_MS = 500;

const SAVE_MS = 400;
const FONT_SAVE_MS = 300;
const COLOR_SAVE_MS = 200;
const CHIP_MS = 900;

const PIN_SVG =
  '<svg viewBox="0 0 24 24"><path class="fill" d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/><path d="M12 14v7"/></svg>';
const STAR_SVG =
  '<svg viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg>';

/** font_size는 정수로 저장한다(계약: 11..28). */
export function clampFontSize(px: number): number {
  if (!Number.isFinite(px)) return MIN_FONT_SIZE;
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(px)));
}

/**
 * 이미지 메모 창 크기. 원본 비율(w0:h0)을 지키면서 가로를 `newW`로 맞춘다.
 * 가로는 `MIN_IMAGE_W`와 `maxW` 사이로 자른다. 논리 픽셀 정수.
 */
export function fitSize(w0: number, h0: number, newW: number, maxW = FALLBACK_MAX_W): {
  w: number;
  h: number;
} {
  const ratio = w0 > 0 && h0 > 0 ? h0 / w0 : 1;
  const top = Math.max(MIN_IMAGE_W, Number.isFinite(maxW) ? maxW : FALLBACK_MAX_W);
  const wanted = Number.isFinite(newW) ? newW : MIN_IMAGE_W;
  const w = Math.round(Math.min(Math.max(wanted, MIN_IMAGE_W), top));
  return { w, h: Math.max(1, Math.round(w * ratio)) };
}

/** 이 이벤트가 내 메모를 다시 읽어야 할 만한 것인지. */
export function affectsNote(p: StoreChanged, id: string): boolean {
  if (p.kind === 'all') return true;
  if (p.kind === 'categories') return false;
  return p.ids.includes(id);
}

/** 내가 일으킨 변경인지. 참이면 본문을 덮어쓰지 않는다(커서 튐 방지). */
export function isOwnChange(p: StoreChanged, label: string): boolean {
  return p.source === label;
}

function fail(e: unknown): void {
  console.error(e);
}

interface Debouncer<T> {
  push(value: T): void;
  /** 대기 중인 것을 지금 보낸다. 없으면 아무 일도 하지 않는다. */
  flush(): Promise<void>;
}

function debouncer<T>(ms: number, run: (value: T) => Promise<unknown>): Debouncer<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { value: T } | null = null;

  const fire = async (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const held = pending;
    pending = null;
    if (!held) return;
    try {
      await run(held.value);
    } catch (e) {
      fail(e);
    }
  };

  return {
    push(value: T): void {
      pending = { value };
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => void fire(), ms);
    },
    flush: fire,
  };
}

export function mountNote(root: HTMLElement, id: string): void {
  void start(root, id);
}

async function start(root: HTMLElement, id: string): Promise<void> {
  const win = getCurrentWindow();
  const label = win.label;

  let note: Note;
  try {
    note = await getNote(id);
  } catch (e) {
    root.textContent = typeof e === 'string' ? e : '메모를 열 수 없습니다.';
    return;
  }

  let categories: Category[] = [];
  const refreshCategories = async (): Promise<void> => {
    try {
      categories = await listCategories();
    } catch (e) {
      fail(e);
    }
  };
  await refreshCategories();

  const isImage = note.kind === 'image';
  let fontSize = clampFontSize(note.font_size);

  // ── 저장 ──────────────────────────────────────────────────────────────────
  const saveBody = debouncer<{ html: string; text: string }>(SAVE_MS, (v) =>
    updateNote(id, { html: v.html, text: v.text }),
  );
  const saveFont = debouncer<number>(FONT_SAVE_MS, (px) => updateNote(id, { font_size: px }));
  const saveColor = debouncer<string>(COLOR_SAVE_MS, (c) => updateNote(id, { color: c }));

  const flushAll = async (): Promise<void> => {
    await saveBody.flush();
    await saveFont.flush();
    await saveColor.flush();
  };

  // ── 뼈대 ──────────────────────────────────────────────────────────────────
  root.className = isImage ? 'note image' : 'note';
  root.innerHTML =
    // 왼쪽부터 핀·별·새 메모(+), 맨 오른쪽에 닫기. 쉼에서는 걸려 있는 핀과 즐겨찾기 별만
    // 보이고 나머지는 자리째 접힌다(note.css). 그래서 핀 없이 즐겨찾기만 한 메모는 별이
    // 왼쪽 맨 끝에 온다. 순서는 DOM 그대로고 CSS가 display로만 여닫는다.
    // 이미지 메모에서는 이 띠가 그림 위에 겹쳐 뜬다(note.css의 .note.image).
    '<div class="note-bar" data-tauri-drag-region>' +
    `<button class="nb pin" type="button" title="항상 위에 고정">${PIN_SVG}</button>` +
    `<button class="nb star" type="button" title="즐겨찾기">${STAR_SVG}</button>` +
    '<button class="nb new" type="button" title="새 메모">＋</button>' +
    '<div class="nb-spacer" data-tauri-drag-region></div>' +
    '<button class="nb close" type="button" title="닫기 (메모함에 남음)">✕</button>' +
    '</div>' +
    // 글자 크기 칩은 편집기가 있을 때만. 이미지 메모에는 글자 크기가 없다.
    (isImage ? '' : '<div class="fschip" aria-hidden="true"></div>') +
    '<div class="note-resize" aria-hidden="true"></div>';

  const bar = root.querySelector<HTMLElement>('.note-bar')!;
  const chip = root.querySelector<HTMLElement>('.fschip');
  const handle = root.querySelector<HTMLElement>('.note-resize')!;

  /** 이미지 메모에는 편집기가 없다. 본문(곁들인 텍스트)은 메모함에서만 고친다. */
  let editor: Editor | null = null;

  if (isImage) {
    const img = document.createElement('img');
    img.className = 'note-img';
    img.draggable = false;
    img.alt = note.image?.name ?? '';
    img.src = imageUrl(id);
    root.insertBefore(img, handle);
  } else {
    editor = createEditor({
      onChange: (html, text) => {
        note.html = html;
        note.text = text;
        saveBody.push({ html, text });
      },
      onFontSizeDelta: (delta) => applyFontSize(clampFontSize(fontSize + delta)),
      onFontSizeReset: () => {
        void getSettings()
          .then((s) => applyFontSize(clampFontSize(s.default_font_size)))
          .catch((err) => console.error(err));
      },
    });
    root.insertBefore(editor.el, chip ?? handle);
    editor.setFontSize(fontSize);
    editor.setHtml(note.html);
    const el = editor.el;
    attachFormatToolbar(() => [el]);
  }

  function applyFontSize(next: number): void {
    if (!editor || next === fontSize) return;
    fontSize = next;
    editor.setFontSize(next);
    showChip(next);
    saveFont.push(next);
  }

  let chipTimer: ReturnType<typeof setTimeout> | null = null;
  function showChip(px: number): void {
    if (!chip) return;
    chip.textContent = `글자 ${px}px`;
    chip.classList.add('show');
    if (chipTimer !== null) clearTimeout(chipTimer);
    chipTimer = setTimeout(() => chip.classList.remove('show'), CHIP_MS);
  }

  // ── 색·고정 반영 ──────────────────────────────────────────────────────────
  // --n-* 는 documentElement에 건다. body와 body에 붙는 서식 위젯까지 함께 물려받는다.
  function paint(): void {
    applyNoteColor(document.documentElement, note.color);
    root.classList.toggle('pinned', note.always_on_top);
    root.classList.toggle('favorite', note.favorite);
  }
  paint();

  async function applyPatch(patch: NotePatch): Promise<void> {
    Object.assign(note, patch);
    paint();
    try {
      await updateNote(id, patch);
    } catch (e) {
      fail(e);
    }
  }

  function setColor(color: string): void {
    note.color = color;
    paint();
    saveColor.push(color);
  }

  // ── 띠 버튼 ───────────────────────────────────────────────────────────────
  bar.querySelector<HTMLButtonElement>('.nb.new')!.addEventListener('click', () => {
    void (async () => {
      try {
        const made = await createNote({ color: note.color, category_id: note.category_id });
        await openNoteWindow(made.id);
      } catch (e) {
        fail(e);
      }
    })();
  });

  bar.querySelector<HTMLButtonElement>('.nb.pin')!.addEventListener('click', () => {
    void applyPatch({ always_on_top: !note.always_on_top });
  });

  bar.querySelector<HTMLButtonElement>('.nb.star')!.addEventListener('click', () => {
    void applyPatch({ favorite: !note.favorite });
  });

  bar.querySelector<HTMLButtonElement>('.nb.close')!.addEventListener('click', () => {
    void (async () => {
      await flushAll();
      try {
        await closeNoteWindow(id);
      } catch (e) {
        fail(e);
      }
    })();
  });

  // 창이 사라지기 직전. 여기서는 기다릴 수 없으니 보내 두기만 한다.
  window.addEventListener('beforeunload', () => {
    void flushAll();
  });

  // ── 크기 조절 손잡이 ──────────────────────────────────────────────────────
  // 윈도우는 테두리 없는 창도 가장자리를 끌 수 있지만 macOS는 이 손잡이가 유일한 길이다.
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    void win.startResizeDragging('SouthEast').catch(fail);
  });

  // ── 이미지 메모: 비율 고정 ────────────────────────────────────────────────
  // 창을 어떻게 늘리든 그림 비율을 지킨다. Ctrl+휠은 10%씩, 손잡이로 끈 뒤에는 가로를 기준으로
  // 세로를 다시 맞춘다. 저장은 Rust가 Moved/Resized로 알아서 하므로 여기서는 크기만 정한다.
  if (isImage) {
    const src = note.image ?? { w: 1, h: 1 };
    /** 내가 setSize를 부른 시각. 그 직후에 오는 Resized는 내 것이라 다시 맞추지 않는다. */
    let selfSizedAt = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

    const maxW = (): number => {
      const avail = window.screen?.availWidth ?? 0;
      return avail > MIN_IMAGE_W ? avail : FALLBACK_MAX_W;
    };

    /** 지금 창의 논리 가로. innerSize는 물리 픽셀이라 scaleFactor로 나눈다. */
    const logicalWidth = async (): Promise<number> => {
      const [size, scale] = await Promise.all([win.innerSize(), win.scaleFactor()]);
      return scale > 0 ? size.width / scale : size.width;
    };

    const applyWidth = async (w: number): Promise<void> => {
      const next = fitSize(src.w, src.h, w, maxW());
      selfSizedAt = Date.now();
      await win.setSize(new LogicalSize(next.w, next.h));
      selfSizedAt = Date.now();
    };

    root.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        void (async () => {
          const now = await logicalWidth();
          await applyWidth(e.deltaY < 0 ? now * ZOOM_STEP : now / ZOOM_STEP);
        })().catch(fail);
      },
      { passive: false },
    );

    // 편집기가 없으니 Ctrl+0은 문서에서 직접 받는다.
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== '0') return;
      e.preventDefault();
      void applyWidth(IMAGE_RESET_W).catch(fail);
    });

    try {
      await win.onResized(() => {
        if (Date.now() - selfSizedAt < SELF_SIZE_MS) return;
        if (resizeTimer !== null) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          resizeTimer = null;
          void logicalWidth()
            .then((w) => applyWidth(w))
            .catch(fail);
        }, RESIZE_MS);
      });
    } catch (e) {
      fail(e);
    }
  }

  // ── 우클릭 메뉴 ───────────────────────────────────────────────────────────
  root.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openContextMenu({
      x: e.clientX,
      y: e.clientY,
      note,
      categories,
      mode: 'note',
      onAction: handleAction,
    });
  });

  function handleAction(a: MenuAction): void {
    switch (a.type) {
      case 'color':
        setColor(a.color);
        break;
      case 'always_on_top':
        void applyPatch({ always_on_top: !note.always_on_top });
        break;
      case 'favorite':
        void applyPatch({ favorite: !note.favorite });
        break;
      case 'list_pinned':
        void applyPatch({ list_pinned: !note.list_pinned });
        break;
      case 'category':
        void applyPatch({ category_id: a.category_id });
        break;
      case 'toggle':
        void showBox().catch(fail);
        break;
      case 'delete':
        // 창은 Rust가 닫는다(계약).
        void deleteNote(id).catch(fail);
        break;
      case 'duplicate':
      case 'restore':
      case 'purge':
        // note 모드 메뉴에는 없다(복제·복원·완전 삭제는 메모함 쪽 항목이다).
        break;
    }
  }

  // ── 다른 창·파일 감시에서 온 변경 ─────────────────────────────────────────
  let pendingHtml: string | null = null;

  function applyPendingHtml(): void {
    if (pendingHtml === null || !editor) return;
    if (editor.setHtml(pendingHtml)) pendingHtml = null;
  }

  // blur 시점에는 activeElement가 아직 편집기일 수 있어 한 박자 뒤에 시도한다.
  editor?.el.addEventListener('blur', () => {
    setTimeout(applyPendingHtml, 0);
  });

  const onChanged = async (p: StoreChanged): Promise<void> => {
    if (p.kind === 'categories' || p.kind === 'all') await refreshCategories();
    if (!affectsNote(p, id)) return;

    let fresh: Note;
    try {
      fresh = await getNote(id);
    } catch {
      // 완전 삭제되어 파일이 없다. 창은 Rust가 닫는다.
      return;
    }
    if (fresh.deleted_at) return;

    const remoteHtml = fresh.html;
    const own = isOwnChange(p, label);
    // 내가 보낸 값이 되돌아온 것이면 본문은 내 것이 최신이다.
    // getNote가 준 객체는 고치지 않고 새로 만든다.
    note = own ? { ...fresh, html: note.html } : { ...fresh };

    paint();
    if (!editor) return;
    const px = clampFontSize(fresh.font_size);
    if (px !== fontSize) {
      fontSize = px;
      editor.setFontSize(px);
    }

    if (own) return;
    pendingHtml = editor.setHtml(remoteHtml) ? null : remoteHtml;
  };

  try {
    await onStoreChanged((p) => void onChanged(p));
  } catch (e) {
    fail(e);
  }

  if (editor && !note.text.trim()) editor.focus();
}
