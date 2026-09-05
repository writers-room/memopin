/**
 * 우클릭 메뉴. 항목 구성과 색 목록 계산만 본다.
 * 하위 메뉴 자리 계산은 getBoundingClientRect가 전부 0인 jsdom에서 의미가 없어 다루지 않는다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, Note, Settings } from '../src/types.ts';
import { DEFAULT_SHORTCUTS } from '../src/types.ts';

const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  onSettingsChanged: vi.fn(),
}));
vi.mock('../src/api.ts', () => api);

const {
  MAX_FAVORITE_COLORS,
  MAX_RECENT_COLORS,
  closeContextMenu,
  isPresetColor,
  openContextMenu,
  pushRecent,
  toggleFavoriteColor,
} = await import('../src/ui/context-menu.ts');

const SETTINGS: Settings = {
  shortcuts: structuredClone(DEFAULT_SHORTCUTS),
  autostart: false,
  theme: 'light',
  default_color: '#FFF4A3',
  default_font_size: 15,
  box_font_size: 14,
  recent_colors: [],
  favorite_colors: [],
  data_dir: null,
  guide_seeded: false,
};

const CATS: Category[] = [{ id: 'c1', name: '집필', sort: 0, created_at: '2026-09-01T00:00:00Z' }];

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
    is_open: true,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    deleted_at: null,
    kind: 'text',
    image: null,
    ...over,
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function open(mode: 'note' | 'list' | 'trash', over: Partial<Note> = {}): HTMLElement {
  openContextMenu({
    x: 10,
    y: 10,
    note: note(over),
    categories: CATS,
    mode,
    onAction: () => {},
  });
  return document.querySelector<HTMLElement>('.cmenu')!;
}

/** 메인 메뉴의 항목 이름만. 체크(✓)와 화살표(›)는 떼고 하위 메뉴 항목은 뺀다. */
function labels(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll<HTMLElement>('.cmi')]
    .filter((b) => b.closest('.submenu') === null)
    .map((b) => (b.textContent ?? '').replace(/[✓›]/g, '').trim());
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getSettings.mockResolvedValue(SETTINGS);
  api.updateSettings.mockImplementation((patch: Partial<Settings>) =>
    Promise.resolve({ ...SETTINGS, ...patch }),
  );
  api.onSettingsChanged.mockResolvedValue(() => {});
  closeContextMenu();
});

describe('메뉴 항목', () => {
  it("'note' 모드는 고정 · 카테고리 이동 · 메모함에서 보기 · 삭제 넷이다", () => {
    expect(labels(open('note'))).toEqual([
      '항상 위에 고정',
      '카테고리 이동',
      '메모함에서 보기',
      '삭제',
    ]);
  });

  it("'note' 모드에는 즐겨찾기와 목록 상단 고정이 없다", () => {
    const menu = open('note');
    expect(menu.querySelector('[data-action="favorite"]')).toBeNull();
    expect(menu.querySelector('[data-action="list_pinned"]')).toBeNull();
  });

  it("복제는 'list' 모드에만 있고 '펼치기' 바로 위다", () => {
    expect(open('note').querySelector('[data-action="duplicate"]')).toBeNull();

    const menu = open('list', { is_open: false });
    expect(menu.querySelector('[data-action="duplicate"]')).not.toBeNull();
    const names = labels(menu);
    expect(names).toEqual([
      '항상 위에 고정',
      '즐겨찾기',
      '목록 상단에 고정',
      '카테고리 이동',
      '복제',
      '바탕화면에 펼치기',
      '삭제',
    ]);
  });

  it('휴지통 모드는 복원과 완전히 삭제뿐이다', () => {
    expect(labels(open('trash', { deleted_at: '2026-09-02T00:00:00Z' }))).toEqual([
      '복원',
      '완전히 삭제',
    ]);
  });

  it('하위 메뉴는 열기 전에는 닫혀 있고 pointerenter로 열린다', () => {
    const menu = open('note');
    const sub = menu.querySelector<HTMLElement>('.sub')!;
    expect(sub.classList.contains('open')).toBe(false);
    sub.dispatchEvent(new Event('pointerenter'));
    expect(sub.classList.contains('open')).toBe(true);
  });
});

describe('팔레트의 최근 · 즐겨찾는 색', () => {
  it('설정이 오면 칩을 그린다. 최근이 비면 그 줄째 없다', async () => {
    api.getSettings.mockResolvedValue({
      ...SETTINGS,
      recent_colors: ['#123456'],
      favorite_colors: ['#abcdef'],
    });
    const menu = open('note');
    await flush();

    expect(menu.querySelector('.sw[data-color="#123456"]')).not.toBeNull();
    expect(menu.querySelector('.sw[data-color="#abcdef"]')).not.toBeNull();
    expect(menu.querySelectorAll('.crow').length).toBe(2);

    api.getSettings.mockResolvedValue(SETTINGS);
    const empty = open('note');
    await flush();
    // 즐겨찾기 줄만 남는다(☆ 버튼이 거기 있다).
    expect(empty.querySelectorAll('.crow').length).toBe(1);
    expect(empty.querySelector('[data-favcolor]')).not.toBeNull();
  });

  it('☆를 누르면 지금 색을 즐겨찾기에 넣고 다시 누르면 뺀다', async () => {
    const menu = open('note', { color: '#123456' });
    await flush();

    menu.querySelector<HTMLElement>('[data-favcolor]')!.dispatchEvent(new MouseEvent('click'));
    await flush();
    expect(api.updateSettings).toHaveBeenCalledWith({ favorite_colors: ['#123456'] });

    // 팔레트만 다시 그린다. 별은 ★이 되고 메뉴는 열린 채다.
    const star = menu.querySelector<HTMLElement>('[data-favcolor]')!;
    expect(star.classList.contains('on')).toBe(true);
    expect(menu.hidden).toBe(false);
    star.dispatchEvent(new MouseEvent('click'));
    await flush();
    expect(api.updateSettings).toHaveBeenLastCalledWith({ favorite_colors: [] });
  });

  it('기본 팔레트 색을 골라도 최근에는 쌓이지 않는다', async () => {
    const menu = open('note');
    await flush();
    menu.querySelector<HTMLElement>('.sw[data-color="#DDF5B0"]')!.dispatchEvent(new MouseEvent('click'));
    await flush();
    expect(api.updateSettings).not.toHaveBeenCalled();
  });
});

describe('pushRecent', () => {
  it('앞에 넣는다', () => {
    expect(pushRecent(['#111111'], '#222222')).toEqual(['#222222', '#111111']);
  });

  it('중복은 빼고 다시 앞으로', () => {
    expect(pushRecent(['#111111', '#222222', '#333333'], '#333333')).toEqual([
      '#333333',
      '#111111',
      '#222222',
    ]);
    // 대소문자는 같은 색으로 본다.
    expect(pushRecent(['#AABBCC'], '#aabbcc')).toEqual(['#aabbcc']);
  });

  it('10개로 자른다', () => {
    let list: string[] = [];
    for (let i = 0; i < 14; i += 1) list = pushRecent(list, `#0000${String(i).padStart(2, '0')}`);
    expect(list.length).toBe(MAX_RECENT_COLORS);
    expect(list[0]).toBe('#000013');
    expect(list.at(-1)).toBe('#000004');
  });

  it('기본 14색과 hex가 아닌 값은 넣지 않는다', () => {
    expect(isPresetColor('#fff4a3')).toBe(true);
    expect(pushRecent(['#111111'], '#FFF4A3')).toEqual(['#111111']);
    expect(pushRecent(['#111111'], '초록')).toEqual(['#111111']);
    // 원본은 그대로 두고 새 배열을 돌려준다.
    const src = ['#111111'];
    expect(pushRecent(src, '#FFF4A3')).not.toBe(src);
  });
});

describe('toggleFavoriteColor', () => {
  it('없으면 앞에 넣고 있으면 뺀다', () => {
    expect(toggleFavoriteColor([], '#123456')).toEqual(['#123456']);
    expect(toggleFavoriteColor(['#123456', '#111111'], '#123456')).toEqual(['#111111']);
    expect(toggleFavoriteColor(['#ABCDEF'], '#abcdef')).toEqual([]);
  });

  it('기본 팔레트 색도 즐겨찾기에는 넣을 수 있다', () => {
    expect(toggleFavoriteColor([], '#FFF4A3')).toEqual(['#fff4a3']);
  });

  it('10개까지만', () => {
    const ten = Array.from({ length: MAX_FAVORITE_COLORS }, (_, i) => `#0000${String(i).padStart(2, '0')}`);
    const next = toggleFavoriteColor(ten, '#ffffff');
    expect(next.length).toBe(MAX_FAVORITE_COLORS);
    expect(next[0]).toBe('#ffffff');
    expect(next).not.toContain('#000009');
  });

  it('hex가 아니면 그대로', () => {
    expect(toggleFavoriteColor(['#111111'], 'red')).toEqual(['#111111']);
  });
});
