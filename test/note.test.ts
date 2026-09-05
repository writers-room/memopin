/**
 * 메모 창 UI. `@tauri-apps/api`와 `src/api.ts`는 jsdom에서 동작하지 않으므로 통째로 막고,
 * 그 사이에 오가는 호출과 DOM만 본다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, Note, StoreChanged } from '../src/types.ts';

const tauri = vi.hoisted(() => ({
  label: 'note-n1',
  startResizeDragging: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => tauri,
}));

vi.mock('../src/api.ts', () => ({
  getNote: vi.fn(),
  updateNote: vi.fn(),
  createNote: vi.fn(),
  deleteNote: vi.fn(),
  openNoteWindow: vi.fn(),
  closeNoteWindow: vi.fn(),
  showBox: vi.fn(),
  listCategories: vi.fn(),
  onStoreChanged: vi.fn(),
}));

import * as api from '../src/api.ts';
import { affectsNote, clampFontSize, isOwnChange, mountNote } from '../src/ui/note.ts';

const ID = 'n1';

function makeNote(over: Partial<Note> = {}): Note {
  return {
    id: ID,
    html: '<p>처음</p>',
    text: '처음',
    color: '#FFF4A3',
    category_id: null,
    favorite: false,
    list_pinned: false,
    always_on_top: false,
    font_size: 15,
    window: null,
    is_open: true,
    created_at: '2026-09-05T00:00:00Z',
    updated_at: '2026-09-05T00:00:00Z',
    deleted_at: null,
    ...over,
  };
}

const CATS: Category[] = [{ id: 'c1', name: '집필', sort: 0, created_at: '2026-09-05T00:00:00Z' }];

/** mountNote는 void라 안쪽의 await 체인을 마이크로태스크로 흘려보낸다. */
async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

let root: HTMLElement;
let changed: ((p: StoreChanged) => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  changed = null;
  document.documentElement.removeAttribute('style');
  // 우클릭 메뉴·서식 위젯은 모듈 안에 하나만 두고 body에 붙여 둔다(창 하나 = 메모 하나).
  // body를 통째로 비우면 그 하나가 문서에서 떨어져 나가므로 #app만 갈아 끼운다.
  document.getElementById('app')?.remove();
  root = document.createElement('div');
  root.id = 'app';
  document.body.appendChild(root);

  vi.mocked(api.getNote).mockResolvedValue(makeNote());
  vi.mocked(api.listCategories).mockResolvedValue(CATS);
  vi.mocked(api.updateNote).mockImplementation(async () => makeNote());
  vi.mocked(api.createNote).mockImplementation(async () => makeNote({ id: 'n2' }));
  vi.mocked(api.openNoteWindow).mockResolvedValue(undefined);
  vi.mocked(api.closeNoteWindow).mockResolvedValue(undefined);
  vi.mocked(api.deleteNote).mockResolvedValue(undefined);
  vi.mocked(api.showBox).mockResolvedValue(undefined);
  vi.mocked(api.onStoreChanged).mockImplementation(async (cb) => {
    changed = cb;
    return () => {};
  });
});

afterEach(() => {
  vi.useRealTimers();
  document.getElementById('app')?.remove();
});

async function mount(): Promise<void> {
  mountNote(root, ID);
  await flush();
}

describe('clampFontSize', () => {
  it('11..28 정수로 자른다', () => {
    expect(clampFontSize(15)).toBe(15);
    expect(clampFontSize(10)).toBe(11);
    expect(clampFontSize(99)).toBe(28);
    expect(clampFontSize(15.6)).toBe(16);
    expect(clampFontSize(Number.NaN)).toBe(11);
  });
});

describe('affectsNote / isOwnChange', () => {
  const p = (over: Partial<StoreChanged>): StoreChanged => ({
    kind: 'notes',
    ids: [],
    source: 'box',
    ...over,
  });

  it('내 id가 들어 있거나 kind가 all이면 다시 읽는다', () => {
    expect(affectsNote(p({ ids: ['n1'] }), 'n1')).toBe(true);
    expect(affectsNote(p({ ids: ['n2'] }), 'n1')).toBe(false);
    expect(affectsNote(p({ kind: 'all', ids: [] }), 'n1')).toBe(true);
    expect(affectsNote(p({ kind: 'categories', ids: ['n1'] }), 'n1')).toBe(false);
  });

  it('source가 내 라벨이면 내 변경이다', () => {
    expect(isOwnChange(p({ source: 'note-n1' }), 'note-n1')).toBe(true);
    expect(isOwnChange(p({ source: 'fs' }), 'note-n1')).toBe(false);
  });
});

describe('mountNote', () => {
  it('띠에 드래그 영역과 버튼 셋을 둔다', async () => {
    await mount();
    const bar = root.querySelector('.note-bar');
    expect(bar).not.toBeNull();
    expect(bar?.hasAttribute('data-tauri-drag-region')).toBe(true);
    expect(root.querySelectorAll('.note-bar .nb').length).toBe(3);
    expect(root.querySelector('.nb.new')).not.toBeNull();
    expect(root.querySelector('.nb.pin')).not.toBeNull();
    expect(root.querySelector('.nb.close')).not.toBeNull();
    // 버튼에는 드래그 영역을 주지 않는다. 눌러도 창이 끌려가면 안 된다.
    root.querySelectorAll('.nb').forEach((b) => {
      expect(b.hasAttribute('data-tauri-drag-region')).toBe(false);
    });
    expect(root.className).toBe('note');
    expect(root.querySelector('.editor')).not.toBeNull();
    expect(root.querySelector('.note-resize')).not.toBeNull();
  });

  it('메모 색을 --n-bg에 건다', async () => {
    vi.mocked(api.getNote).mockResolvedValue(makeNote({ color: '#D2E7FF' }));
    await mount();
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--n-bg')).toBe('#d2e7ff');
    expect(style.getPropertyValue('--n-bar')).not.toBe('');
    expect(style.getPropertyValue('--n-ink')).not.toBe('');
  });

  it('본문과 글자 크기를 불러온다', async () => {
    vi.mocked(api.getNote).mockResolvedValue(makeNote({ font_size: 18 }));
    await mount();
    const ed = root.querySelector<HTMLElement>('.editor')!;
    expect(ed.innerHTML).toBe('<p>처음</p>');
    expect(ed.style.getPropertyValue('--fs')).toBe('18px');
  });

  it('📌를 누르면 always_on_top을 뒤집어 저장하고 pinned 클래스를 건다', async () => {
    await mount();
    root.querySelector<HTMLElement>('.nb.pin')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(api.updateNote).toHaveBeenCalledWith(ID, { always_on_top: true });
    expect(root.classList.contains('pinned')).toBe(true);
  });

  it('＋는 같은 색·같은 카테고리로 새 메모를 만들고 창을 연다', async () => {
    vi.mocked(api.getNote).mockResolvedValue(makeNote({ color: '#DDF5B0', category_id: 'c1' }));
    await mount();
    root.querySelector<HTMLElement>('.nb.new')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(api.createNote).toHaveBeenCalledWith({ color: '#DDF5B0', category_id: 'c1' });
    expect(api.openNoteWindow).toHaveBeenCalledWith('n2');
  });

  it('손잡이를 누르면 SouthEast 리사이즈를 시작한다', async () => {
    await mount();
    const handle = root.querySelector<HTMLElement>('.note-resize')!;
    const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
    handle.dispatchEvent(down);
    expect(tauri.startResizeDragging).toHaveBeenCalledWith('SouthEast');
    expect(down.defaultPrevented).toBe(true);
  });

  it('본문 저장은 400ms 디바운스로 한 번만 간다', async () => {
    vi.useFakeTimers();
    await mount();
    vi.mocked(api.updateNote).mockClear();

    const ed = root.querySelector<HTMLElement>('.editor')!;
    ed.innerHTML = '<p>고친 첫 줄</p>';
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(100);
    ed.innerHTML = '<p>고친 첫 줄 더</p>';
    ed.dispatchEvent(new Event('input', { bubbles: true }));

    expect(api.updateNote).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(api.updateNote).toHaveBeenCalledTimes(1);
    expect(api.updateNote).toHaveBeenCalledWith(ID, {
      html: '<p>고친 첫 줄 더</p>',
      text: '고친 첫 줄 더',
    });
  });

  it('✕는 디바운스를 기다리지 않고 저장한 뒤 창을 닫는다', async () => {
    vi.useFakeTimers();
    await mount();
    vi.mocked(api.updateNote).mockClear();

    const ed = root.querySelector<HTMLElement>('.editor')!;
    ed.innerHTML = '<p>아직 저장 전</p>';
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    expect(api.updateNote).not.toHaveBeenCalled();

    root.querySelector<HTMLElement>('.nb.close')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(api.updateNote).toHaveBeenCalledWith(ID, {
      html: '<p>아직 저장 전</p>',
      text: '아직 저장 전',
    });
    expect(api.closeNoteWindow).toHaveBeenCalledWith(ID);
  });

  it('Ctrl+휠은 즉시 반영하고 300ms 뒤에 정수로 저장한다', async () => {
    vi.useFakeTimers();
    await mount();
    vi.mocked(api.updateNote).mockClear();

    const ed = root.querySelector<HTMLElement>('.editor')!;
    ed.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, ctrlKey: true, cancelable: true, bubbles: true }));
    expect(ed.style.getPropertyValue('--fs')).toBe('16px');
    expect(root.querySelector('.fschip')?.textContent).toBe('글자 16px');
    expect(root.querySelector('.fschip')?.classList.contains('show')).toBe(true);

    expect(api.updateNote).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(api.updateNote).toHaveBeenCalledExactlyOnceWith(ID, { font_size: 16 });
  });

  it('11 아래·28 위로는 내려가지도 올라가지도 않는다', async () => {
    vi.useFakeTimers();
    vi.mocked(api.getNote).mockResolvedValue(makeNote({ font_size: 11 }));
    await mount();
    vi.mocked(api.updateNote).mockClear();
    const ed = root.querySelector<HTMLElement>('.editor')!;
    ed.dispatchEvent(new WheelEvent('wheel', { deltaY: 3, ctrlKey: true, cancelable: true, bubbles: true }));
    vi.advanceTimersByTime(300);
    expect(ed.style.getPropertyValue('--fs')).toBe('11px');
    expect(api.updateNote).not.toHaveBeenCalled();
  });

  it('내 라벨이 source면 본문을 덮어쓰지 않고, 다른 source면 갈아 끼운다', async () => {
    await mount();
    const ed = root.querySelector<HTMLElement>('.editor')!;
    expect(changed).not.toBeNull();

    vi.mocked(api.getNote).mockResolvedValue(makeNote({ html: '<p>바깥에서 온 값</p>' }));
    changed!({ kind: 'notes', ids: [ID], source: 'note-n1' });
    await flush();
    expect(ed.innerHTML).toBe('<p>처음</p>');

    changed!({ kind: 'notes', ids: [ID], source: 'fs' });
    await flush();
    expect(ed.innerHTML).toBe('<p>바깥에서 온 값</p>');
  });

  it('내 변경이어도 색·고정·글자 크기는 반영한다', async () => {
    await mount();
    const ed = root.querySelector<HTMLElement>('.editor')!;
    vi.mocked(api.getNote).mockResolvedValue(
      makeNote({ color: '#4A4A4E', always_on_top: true, font_size: 20, html: '<p>무시될 본문</p>' }),
    );
    changed!({ kind: 'notes', ids: [ID], source: 'note-n1' });
    await flush();
    expect(document.documentElement.style.getPropertyValue('--n-bg')).toBe('#4a4a4e');
    expect(root.classList.contains('pinned')).toBe(true);
    expect(ed.style.getPropertyValue('--fs')).toBe('20px');
    expect(ed.innerHTML).toBe('<p>처음</p>');
  });

  it('내 메모가 아닌 이벤트와 삭제·읽기 실패는 흘려보낸다', async () => {
    await mount();
    vi.mocked(api.getNote).mockClear();
    changed!({ kind: 'notes', ids: ['other'], source: 'fs' });
    await flush();
    expect(api.getNote).not.toHaveBeenCalled();

    const ed = root.querySelector<HTMLElement>('.editor')!;
    vi.mocked(api.getNote).mockResolvedValue(
      makeNote({ html: '<p>휴지통</p>', deleted_at: '2026-09-05T01:00:00Z' }),
    );
    changed!({ kind: 'notes', ids: [ID], source: 'fs' });
    await flush();
    expect(ed.innerHTML).toBe('<p>처음</p>');

    vi.mocked(api.getNote).mockRejectedValue('메모를 찾을 수 없습니다.');
    changed!({ kind: 'notes', ids: [ID], source: 'fs' });
    await flush();
    expect(ed.innerHTML).toBe('<p>처음</p>');
  });

  it('카테고리 이벤트가 오면 목록을 다시 받는다', async () => {
    await mount();
    vi.mocked(api.listCategories).mockClear();
    changed!({ kind: 'categories', ids: [], source: 'box' });
    await flush();
    expect(api.listCategories).toHaveBeenCalledTimes(1);
  });

  it('빈 메모면 편집기에 포커스를 준다', async () => {
    vi.mocked(api.getNote).mockResolvedValue(makeNote({ html: '<p><br></p>', text: '' }));
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    await mount();
    expect(focus).toHaveBeenCalled();
    focus.mockRestore();
  });
});

describe('우클릭 메뉴', () => {
  it('색은 200ms 디바운스로 저장하되 화면은 즉시 바꾼다', async () => {
    vi.useFakeTimers();
    await mount();
    root.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const menu = document.querySelector('.cmenu')!;
    const green = menu.querySelector<HTMLElement>('.sw[data-color="#DDF5B0"]')!;
    green.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(document.documentElement.style.getPropertyValue('--n-bg')).toBe('#ddf5b0');
    expect(api.updateNote).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(api.updateNote).toHaveBeenCalledExactlyOnceWith(ID, { color: '#DDF5B0' });
  });

  it('즐겨찾기·카테고리·메모함 보기·삭제를 각각 넘긴다', async () => {
    await mount();
    const open = (): Element => {
      root.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      return document.querySelector('.cmenu')!;
    };
    const click = (sel: string): void => {
      open().querySelector<HTMLElement>(sel)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    };

    click('[data-action="favorite"]');
    expect(api.updateNote).toHaveBeenCalledWith(ID, { favorite: true });

    click('[data-action="list_pinned"]');
    expect(api.updateNote).toHaveBeenCalledWith(ID, { list_pinned: true });

    click('[data-category="c1"]');
    expect(api.updateNote).toHaveBeenCalledWith(ID, { category_id: 'c1' });

    click('[data-action="toggle"]');
    expect(api.showBox).toHaveBeenCalledTimes(1);

    click('[data-action="delete"]');
    expect(api.deleteNote).toHaveBeenCalledWith(ID);
  });
});
