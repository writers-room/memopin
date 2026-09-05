import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, Note, Settings, StoreChanged } from '../src/types.ts';

/** api.ts는 전부 invoke라 통째로 막는다. 창 라벨도 마찬가지. */
const api = vi.hoisted(() => ({
  listNotes: vi.fn(),
  listCategories: vi.fn(),
  getSettings: vi.fn(),
  updateNote: vi.fn(),
  updateSettings: vi.fn(),
  createNote: vi.fn(),
  deleteNote: vi.fn(),
  restoreNote: vi.fn(),
  purgeNote: vi.fn(),
  emptyTrash: vi.fn(),
  createCategory: vi.fn(),
  renameCategory: vi.fn(),
  deleteCategory: vi.fn(),
  openNoteWindow: vi.fn(),
  closeNoteWindow: vi.fn(),
  onStoreChanged: vi.fn(),
  onSettingsChanged: vi.fn(),
}));
vi.mock('../src/api.ts', () => api);
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'box' }) }));

const {
  clickSelection,
  countFor,
  matchesQuery,
  matchesView,
  mountBox,
  pruneSelection,
  sortNotes,
  visibleNotes,
} = await import('../src/ui/box.ts');
const { relativeTime } = await import('../src/ui/time.ts');

function note(over: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    html: '<p>가</p>',
    text: '가',
    color: '#FFF4A3',
    category_id: null,
    favorite: false,
    list_pinned: false,
    always_on_top: false,
    font_size: 15,
    window: null,
    is_open: false,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    deleted_at: null,
    ...over,
  };
}

const SETTINGS: Settings = {
  shortcut_enabled: true,
  shortcut: 'CommandOrControl+Shift+N',
  autostart: false,
  theme: 'light',
  default_color: '#FFF4A3',
  default_font_size: 15,
  box_font_size: 14,
  data_dir: null,
};

const CATS: Category[] = [
  { id: 'c1', name: '집필', sort: 0, created_at: '2026-08-01T00:00:00Z' },
  { id: 'c2', name: '펀딩', sort: 1, created_at: '2026-08-01T00:00:00Z' },
];

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('보기 필터', () => {
  const alive = note({ id: 'a' });
  const fav = note({ id: 'b', favorite: true, category_id: 'c1' });
  const filed = note({ id: 'c', category_id: 'c1' });
  const trashed = note({ id: 'd', deleted_at: '2026-09-02T00:00:00Z', favorite: true });
  const all = [alive, fav, filed, trashed];

  it('전체는 살아 있는 것만', () => {
    expect(all.filter((n) => matchesView(n, 'all')).map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });
  it('즐겨찾기는 휴지통 것을 빼고 favorite만', () => {
    expect(all.filter((n) => matchesView(n, 'favorite')).map((n) => n.id)).toEqual(['b']);
  });
  it('미분류는 category_id가 null인 것', () => {
    expect(all.filter((n) => matchesView(n, 'unfiled')).map((n) => n.id)).toEqual(['a']);
  });
  it('카테고리는 그 id를 가진 것', () => {
    expect(all.filter((n) => matchesView(n, 'cat:c1')).map((n) => n.id)).toEqual(['b', 'c']);
  });
  it('휴지통은 deleted_at이 있는 것뿐', () => {
    expect(all.filter((n) => matchesView(n, 'trash')).map((n) => n.id)).toEqual(['d']);
  });
  it('개수는 보기별로 센다', () => {
    expect(countFor(all, 'all')).toBe(3);
    expect(countFor(all, 'trash')).toBe(1);
    expect(countFor(all, 'cat:c2')).toBe(0);
  });
});

describe('검색', () => {
  const n = note({ text: '회귀 재벌물 3화 수정\n강태준 첫 대사 Cold' });
  it('빈 검색어는 전부 통과', () => {
    expect(matchesQuery(n, '')).toBe(true);
    expect(matchesQuery(n, '   ')).toBe(true);
  });
  it('평문 부분 일치, 대소문자 무시', () => {
    expect(matchesQuery(n, '강태준')).toBe(true);
    expect(matchesQuery(n, 'cold')).toBe(true);
    expect(matchesQuery(n, '리워드')).toBe(false);
  });
  it('html이 아니라 text를 본다', () => {
    expect(matchesQuery(note({ html: '<p>숨은글</p>', text: '보이는글' }), '숨은글')).toBe(false);
  });
});

describe('정렬', () => {
  it('상단 고정이 먼저, 그다음 updated_at 내림차순', () => {
    const rows = [
      note({ id: 'old', updated_at: '2026-09-01T00:00:00Z' }),
      note({ id: 'new', updated_at: '2026-09-03T00:00:00Z' }),
      note({ id: 'pin-old', list_pinned: true, updated_at: '2026-08-01T00:00:00Z' }),
      note({ id: 'pin-new', list_pinned: true, updated_at: '2026-09-02T00:00:00Z' }),
    ];
    expect(sortNotes(rows).map((n) => n.id)).toEqual(['pin-new', 'pin-old', 'new', 'old']);
  });
  it('visibleNotes는 거르고 나서 정렬한다', () => {
    const rows = [
      note({ id: 'a', text: '가', updated_at: '2026-09-01T00:00:00Z' }),
      note({ id: 'b', text: '가나', updated_at: '2026-09-02T00:00:00Z' }),
      note({ id: 'c', text: '다', updated_at: '2026-09-03T00:00:00Z' }),
    ];
    expect(visibleNotes(rows, 'all', '가').map((n) => n.id)).toEqual(['b', 'a']);
  });
});

describe('선택 상태 전이', () => {
  const rows = ['a', 'b', 'c', 'd'];
  const none = { ids: [] as string[], anchor: null };

  it('그냥 누르면 그것 하나', () => {
    expect(clickSelection(none, rows, 'b')).toEqual({ ids: ['b'], anchor: 'b' });
    expect(clickSelection({ ids: ['a', 'b'], anchor: 'b' }, rows, 'c')).toEqual({
      ids: ['c'],
      anchor: 'c',
    });
  });

  it('Ctrl은 더하고 빼며 기준을 옮긴다', () => {
    const one = clickSelection(none, rows, 'b');
    const two = clickSelection(one, rows, 'd', { ctrl: true });
    expect(two).toEqual({ ids: ['b', 'd'], anchor: 'd' });
    expect(clickSelection(two, rows, 'b', { ctrl: true })).toEqual({ ids: ['d'], anchor: 'b' });
  });

  it('Ctrl로 하나 남은 것을 빼면 선택이 빈다', () => {
    expect(clickSelection({ ids: ['a'], anchor: 'a' }, rows, 'a', { ctrl: true }).ids).toEqual([]);
  });

  it('Shift는 기준부터 지금 항목까지 목록 순서대로', () => {
    expect(clickSelection({ ids: ['b'], anchor: 'b' }, rows, 'd', { shift: true })).toEqual({
      ids: ['b', 'c', 'd'],
      anchor: 'b',
    });
    // 거꾸로 눌러도 목록 순서다. 기준은 그대로 남아 범위를 다시 잡을 수 있다.
    expect(clickSelection({ ids: ['c'], anchor: 'c' }, rows, 'a', { shift: true })).toEqual({
      ids: ['a', 'b', 'c'],
      anchor: 'c',
    });
  });

  it('기준이 없거나 목록에서 사라졌으면 지금 항목이 기준이 된다', () => {
    expect(clickSelection(none, rows, 'c', { shift: true })).toEqual({ ids: ['c'], anchor: 'c' });
    expect(clickSelection({ ids: [], anchor: 'zz' }, rows, 'c', { shift: true })).toEqual({
      ids: ['c'],
      anchor: 'c',
    });
  });

  it('사라진 메모는 선택과 기준에서 빠진다', () => {
    const alive = new Set(['a', 'c']);
    expect(pruneSelection({ ids: ['a', 'b', 'c'], anchor: 'b' }, alive)).toEqual({
      ids: ['a', 'c'],
      anchor: null,
    });
    const kept = { ids: ['a'], anchor: 'a' };
    expect(pruneSelection(kept, alive)).toBe(kept);
  });
});

describe('상대 시각', () => {
  const now = new Date('2026-09-05T12:00:00Z');
  const ago = (ms: number): string => new Date(now.getTime() - ms).toISOString();
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it('1분 안쪽은 방금', () => {
    expect(relativeTime(ago(0), now)).toBe('방금');
    expect(relativeTime(ago(59_000), now)).toBe('방금');
  });
  it('분·시간', () => {
    expect(relativeTime(ago(MIN), now)).toBe('1분 전');
    expect(relativeTime(ago(59 * MIN), now)).toBe('59분 전');
    expect(relativeTime(ago(HOUR), now)).toBe('1시간 전');
    expect(relativeTime(ago(23 * HOUR), now)).toBe('23시간 전');
  });
  it('하루가 지나면 어제, 이틀부터 n일 전', () => {
    expect(relativeTime(ago(DAY), now)).toBe('어제');
    expect(relativeTime(ago(2 * DAY - 1), now)).toBe('어제');
    expect(relativeTime(ago(2 * DAY), now)).toBe('2일 전');
    expect(relativeTime(ago(6 * DAY), now)).toBe('6일 전');
  });
  it('7일부터는 날짜', () => {
    expect(relativeTime('2026-08-29T12:00:00Z', now)).toBe('8월 29일');
  });
  it('시각이 아니면 빈 문자열', () => {
    expect(relativeTime('', now)).toBe('');
  });
});

describe('mountBox', () => {
  let notes: Note[] = [];
  let storeCb: ((p: StoreChanged) => void) | null = null;
  let root: HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    storeCb = null;
    notes = [
      note({ id: 'n1', text: '첫째', html: '<p>첫째</p>', updated_at: '2026-09-04T00:00:00Z' }),
      note({ id: 'n2', text: '둘째', html: '<p>둘째</p>', category_id: 'c1', favorite: true, updated_at: '2026-09-03T00:00:00Z' }),
      note({ id: 'n3', text: '버린것', html: '<p>버린것</p>', deleted_at: '2026-09-02T00:00:00Z' }),
    ];
    api.listNotes.mockImplementation(() => Promise.resolve(notes.map((n) => ({ ...n }))));
    api.listCategories.mockResolvedValue(CATS);
    api.getSettings.mockResolvedValue(SETTINGS);
    api.updateNote.mockImplementation((id: string) => Promise.resolve(notes.find((n) => n.id === id)));
    api.openNoteWindow.mockResolvedValue(undefined);
    api.deleteNote.mockResolvedValue(undefined);
    api.restoreNote.mockResolvedValue(undefined);
    api.purgeNote.mockResolvedValue(undefined);
    api.updateSettings.mockImplementation((patch: Partial<Settings>) =>
      Promise.resolve({ ...SETTINGS, ...patch }),
    );
    api.onSettingsChanged.mockResolvedValue(() => {});
    api.onStoreChanged.mockImplementation((cb: (p: StoreChanged) => void) => {
      storeCb = cb;
      return Promise.resolve(() => {});
    });

    root = document.createElement('div');
    document.body.append(root);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('사이드바에 기본 항목 넷과 카테고리를 개수와 함께 그린다', async () => {
    mountBox(root);
    await flush();

    const rows = [...root.querySelectorAll('.side .cat[data-view]')].map((el) => ({
      view: (el as HTMLElement).dataset['view'],
      name: el.querySelector('.name')?.textContent,
      n: el.querySelector('.n')?.textContent,
    }));
    expect(rows).toEqual([
      { view: 'all', name: '전체', n: '2' },
      { view: 'favorite', name: '즐겨찾기', n: '1' },
      { view: 'unfiled', name: '미분류', n: '1' },
      { view: 'cat:c1', name: '집필', n: '1' },
      { view: 'cat:c2', name: '펀딩', n: '0' },
      { view: 'trash', name: '휴지통', n: '1' },
    ]);
    expect(root.querySelector('.side .cat.add')?.textContent).toBe('＋ 새 카테고리');
  });

  it('목록은 살아 있는 메모만 최신 순으로 그린다', async () => {
    mountBox(root);
    await flush();
    const ids = [...root.querySelectorAll('.list .item')].map((el) => (el as HTMLElement).dataset['id']);
    expect(ids).toEqual(['n1', 'n2']);
  });

  it('★ 버튼은 선택하지 않고 favorite만 뒤집는다', async () => {
    mountBox(root);
    await flush();
    const star = root.querySelector<HTMLElement>('.list .item[data-id=n1] .star')!;
    star.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(api.updateNote).toHaveBeenCalledWith('n1', { favorite: true });
    expect(root.querySelector('.list .item.sel')).toBeNull();
  });

  it('항목을 고르면 편집 칸이 열리고 더블클릭은 창을 연다', async () => {
    mountBox(root);
    await flush();
    const item = root.querySelector<HTMLElement>('.list .item[data-id=n1]')!;
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(root.querySelector('.ed-head')?.hasAttribute('hidden')).toBe(false);
    expect(root.querySelector('.ed-head .title')?.textContent).toBe('첫째');
    expect(root.querySelector<HTMLElement>('.editor')?.innerHTML).toBe('<p>첫째</p>');

    // 선택하면 목록을 다시 그리므로 항목을 다시 찾는다.
    root.querySelector<HTMLElement>('.list .item[data-id=n1]')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(api.openNoteWindow).toHaveBeenCalledWith('n1');
  });

  it('store:changed의 source가 내 라벨이면 편집기 본문을 건드리지 않는다', async () => {
    mountBox(root);
    await flush();
    root.querySelector<HTMLElement>('.list .item[data-id=n1]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const editor = root.querySelector<HTMLElement>('.editor')!;
    expect(editor.innerHTML).toBe('<p>첫째</p>');

    notes[0]!.html = '<p>딴 창이 고친 글</p>';
    notes[0]!.text = '딴 창이 고친 글';

    storeCb!({ kind: 'notes', ids: ['n1'], source: 'box' });
    await flush();
    expect(editor.innerHTML).toBe('<p>첫째</p>');

    storeCb!({ kind: 'notes', ids: ['n1'], source: 'fs' });
    await flush();
    expect(editor.innerHTML).toBe('<p>딴 창이 고친 글</p>');
  });

  it('검색어와 선택은 다시 그려도 남는다', async () => {
    mountBox(root);
    await flush();
    root.querySelector<HTMLElement>('.list .item[data-id=n2]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const search = root.querySelector<HTMLInputElement>('.search input')!;
    search.value = '둘째';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect([...root.querySelectorAll('.list .item')].length).toBe(1);

    storeCb!({ kind: 'all', ids: [], source: 'fs' });
    await flush();
    expect(search.value).toBe('둘째');
    expect([...root.querySelectorAll('.list .item')].map((e) => (e as HTMLElement).dataset['id'])).toEqual(['n2']);
    expect(root.querySelector('.list .item.sel')?.getAttribute('data-id')).toBe('n2');
  });

  it('휴지통 보기에는 비우기 버튼과 안내가 나온다', async () => {
    mountBox(root);
    await flush();
    root.querySelector<HTMLElement>('.side .cat[data-view=trash]')!.click();
    expect(root.querySelector('.trashbar')?.hasAttribute('hidden')).toBe(false);
    expect(root.querySelector('.hint')?.textContent).toBe('우클릭으로 복원하거나 완전히 삭제합니다.');
    expect([...root.querySelectorAll('.list .item')].map((e) => (e as HTMLElement).dataset['id'])).toEqual(['n3']);
  });

  it('＋ 새 카테고리는 prompt가 아니라 인라인 입력칸을 띄운다', async () => {
    mountBox(root);
    await flush();
    const promptSpy = vi.spyOn(window, 'prompt');
    api.createCategory.mockResolvedValue(CATS[0]);
    root.querySelector<HTMLElement>('.side .cat.add')!.click();
    const input = root.querySelector<HTMLInputElement>('.side .catinput')!;
    expect(input).toBeTruthy();
    input.value = '메모';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(api.createCategory).toHaveBeenCalledWith('메모');
    expect(promptSpy).not.toHaveBeenCalled();
  });

  const click = (root: HTMLElement, id: string, mods: Partial<MouseEventInit> = {}): void => {
    root
      .querySelector<HTMLElement>(`.list .item[data-id=${id}]`)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, ...mods }));
  };

  it('Ctrl+클릭은 선택에 더하고 빼며 요약 화면을 보여 준다', async () => {
    mountBox(root);
    await flush();
    click(root, 'n1');
    click(root, 'n2', { ctrlKey: true });

    expect([...root.querySelectorAll('.list .item.sel')].map((e) => (e as HTMLElement).dataset['id'])).toEqual([
      'n1',
      'n2',
    ]);
    expect(root.querySelector('.ed-multi')?.hasAttribute('hidden')).toBe(false);
    expect(root.querySelector('.ed-multi .n')?.textContent).toBe('2개 선택됨');
    expect(root.querySelector('.ed-head')?.hasAttribute('hidden')).toBe(true);
    expect(root.querySelector<HTMLElement>('.editor')?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('.act-trash')!.hasAttribute('hidden')).toBe(false);
    expect(root.querySelector<HTMLElement>('.act-purge')!.hasAttribute('hidden')).toBe(true);

    // 다시 Ctrl+클릭하면 빠지고 하나짜리 선택으로 돌아온다.
    click(root, 'n2', { ctrlKey: true });
    expect(root.querySelector('.ed-multi')?.hasAttribute('hidden')).toBe(true);
    expect(root.querySelector('.ed-head .title')?.textContent).toBe('첫째');
  });

  it('Shift+클릭은 기준부터 범위로 고른다', async () => {
    mountBox(root);
    await flush();
    click(root, 'n1');
    click(root, 'n2', { shiftKey: true });
    expect(root.querySelector('.ed-multi .n')?.textContent).toBe('2개 선택됨');
  });

  it('선택 요약의 [휴지통으로 보내기]는 고른 수만큼 deleteNote를 부르고 선택을 푼다', async () => {
    mountBox(root);
    await flush();
    click(root, 'n1');
    click(root, 'n2', { ctrlKey: true });
    root.querySelector<HTMLButtonElement>('.act-trash')!.click();
    await flush();

    expect(api.deleteNote.mock.calls.map((c) => c[0])).toEqual(['n1', 'n2']);
    expect(root.querySelector('.list .item.sel')).toBeNull();
    expect(root.querySelector('.ed-multi')?.hasAttribute('hidden')).toBe(true);
    expect(root.querySelector('.ed-empty')?.hasAttribute('hidden')).toBe(false);
  });

  it('목록에서 Delete를 누르면 고른 것을 모두 휴지통으로 보낸다', async () => {
    mountBox(root);
    await flush();
    click(root, 'n1');
    click(root, 'n2', { ctrlKey: true });
    root
      .querySelector<HTMLElement>('.list .item[data-id=n2]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await flush();
    expect(api.deleteNote.mock.calls.map((c) => c[0])).toEqual(['n1', 'n2']);
  });

  it('휴지통 보기에서는 Delete가 확인을 받고 완전히 삭제한다', async () => {
    mountBox(root);
    await flush();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    root.querySelector<HTMLElement>('.side .cat[data-view=trash]')!.click();
    click(root, 'n3');
    expect(root.querySelector<HTMLElement>('.act-restore')).toBeTruthy();

    root
      .querySelector<HTMLElement>('.list .item[data-id=n3]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await flush();
    expect(confirmSpy).toHaveBeenCalled();
    expect(api.purgeNote.mock.calls.map((c) => c[0])).toEqual(['n3']);
    expect(api.deleteNote).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('휴지통에서 여럿을 고르면 복원·완전 삭제 버튼이 나온다', async () => {
    notes.push(note({ id: 'n4', text: '버린것2', deleted_at: '2026-09-02T00:00:00Z' }));
    mountBox(root);
    await flush();
    root.querySelector<HTMLElement>('.side .cat[data-view=trash]')!.click();
    click(root, 'n3');
    click(root, 'n4', { ctrlKey: true });
    expect(root.querySelector<HTMLElement>('.act-restore')!.hasAttribute('hidden')).toBe(false);
    expect(root.querySelector<HTMLElement>('.act-purge')!.hasAttribute('hidden')).toBe(false);
    expect(root.querySelector<HTMLElement>('.act-trash')!.hasAttribute('hidden')).toBe(true);

    root.querySelector<HTMLButtonElement>('.act-restore')!.click();
    await flush();
    expect(api.restoreNote.mock.calls.map((c) => c[0])).toEqual(['n3', 'n4']);
  });

  it('여럿 고른 채 보기를 옮기면 선택이 풀린다', async () => {
    mountBox(root);
    await flush();
    click(root, 'n1');
    click(root, 'n2', { ctrlKey: true });
    root.querySelector<HTMLElement>('.side .cat[data-view=trash]')!.click();
    expect(root.querySelector('.ed-multi')?.hasAttribute('hidden')).toBe(true);
    expect(root.querySelector('.ed-empty')?.hasAttribute('hidden')).toBe(false);
  });

  it('사라진 메모는 선택에서 빠진다', async () => {
    mountBox(root);
    await flush();
    click(root, 'n1');
    click(root, 'n2', { ctrlKey: true });
    notes = notes.filter((n) => n.id !== 'n2');
    storeCb!({ kind: 'notes', ids: ['n2'], source: 'fs' });
    await flush();
    expect(root.querySelector('.ed-multi')?.hasAttribute('hidden')).toBe(true);
    expect(root.querySelector('.ed-head .title')?.textContent).toBe('첫째');
  });

  it('편집 칸은 메모의 font_size가 아니라 설정의 box_font_size를 쓴다', async () => {
    api.getSettings.mockResolvedValue({ ...SETTINGS, box_font_size: 12 });
    mountBox(root);
    await flush();
    click(root, 'n1'); // 이 메모의 font_size는 15다
    expect(root.querySelector<HTMLElement>('.editor')!.style.getPropertyValue('--fs')).toBe('12px');
    expect(root.querySelector('.fsnote .fs')?.textContent).toBe('메모함 글자 12px');
  });

  it('Ctrl+휠은 설정만 바꾸고 메모의 font_size는 건드리지 않는다', async () => {
    mountBox(root);
    await flush();
    click(root, 'n1');
    const editor = root.querySelector<HTMLElement>('.editor')!;
    editor.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -1, bubbles: true, cancelable: true }));
    expect(editor.style.getPropertyValue('--fs')).toBe('15px');
    expect(root.querySelector('.fsnote .fs')?.textContent).toBe('메모함 글자 15px');

    await new Promise((r) => setTimeout(r, 350)); // 저장 디바운스 300ms
    expect(api.updateSettings).toHaveBeenCalledWith({ box_font_size: 15 });
    expect(api.updateNote).not.toHaveBeenCalled();

    // Ctrl+0은 메모함 기본값 14로.
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(editor.style.getPropertyValue('--fs')).toBe('14px');
    await new Promise((r) => setTimeout(r, 350));
    expect(api.updateSettings).toHaveBeenLastCalledWith({ box_font_size: 14 });
    expect(api.updateNote).not.toHaveBeenCalled();
  });

  it('새 메모는 지금 보기의 카테고리를 물려받고 창을 연다', async () => {
    mountBox(root);
    await flush();
    const made = note({ id: 'n9', category_id: 'c1', text: '', html: '<p><br></p>' });
    api.createNote.mockResolvedValue(made);
    notes.push(made);

    root.querySelector<HTMLElement>('.side .cat[data-view="cat:c1"]')!.click();
    root.querySelector<HTMLElement>('.btn.new')!.click();
    await flush();
    expect(api.createNote).toHaveBeenCalledWith({ category_id: 'c1' });
    expect(api.openNoteWindow).toHaveBeenCalledWith('n9');
    expect(root.querySelector('.list .item.sel')?.getAttribute('data-id')).toBe('n9');
  });
});
