import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Settings, ShortcutId } from '../src/types.ts';
import { DEFAULT_SHORTCUTS, SHORTCUT_IDS } from '../src/types.ts';

const api = vi.hoisted(() => ({
  appVersion: vi.fn(),
  getSettings: vi.fn(),
  onSettingsChanged: vi.fn(),
  pickDataDir: vi.fn(),
  setDataDir: vi.fn(),
  shortcutErrors: vi.fn(),
  updateSettings: vi.fn(),
}));
const plugins = vi.hoisted(() => ({ check: vi.fn(), relaunch: vi.fn() }));

vi.mock('../src/api.ts', () => api);
vi.mock('@tauri-apps/plugin-updater', () => ({ check: plugins.check }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: plugins.relaunch }));

const { displayShortcut, mountSettings, normalizeKey, shortcutFromEvent } = await import(
  '../src/ui/settings.ts'
);

const SETTINGS: Settings = {
  shortcuts: structuredClone(DEFAULT_SHORTCUTS),
  autostart: false,
  theme: 'dark',
  default_color: '#FFF4A3',
  default_font_size: 15,
  box_font_size: 14,
  recent_colors: [],
  favorite_colors: [],
  data_dir: 'D:\\Drive\\memopin',
  guide_seeded: false,
};

const key = (over: Partial<KeyboardEventInit> & { key: string }) => ({
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('단축키 표기', () => {
  it('Ctrl·Cmd는 둘 다 CommandOrControl', () => {
    expect(shortcutFromEvent(key({ key: 'n', ctrlKey: true, shiftKey: true }))).toBe(
      'CommandOrControl+Shift+N',
    );
    expect(shortcutFromEvent(key({ key: 'n', metaKey: true, shiftKey: true }))).toBe(
      'CommandOrControl+Shift+N',
    );
  });

  it('수식키가 없으면 null', () => {
    expect(shortcutFromEvent(key({ key: 'n' }))).toBeNull();
    expect(shortcutFromEvent(key({ key: 'F5' }))).toBeNull();
  });

  it('수식키 자체는 조합이 되지 않는다', () => {
    expect(shortcutFromEvent(key({ key: 'Shift', shiftKey: true }))).toBeNull();
    expect(shortcutFromEvent(key({ key: 'Control', ctrlKey: true }))).toBeNull();
  });

  it('Alt·Shift만으로도 되고 순서는 늘 같다', () => {
    expect(shortcutFromEvent(key({ key: '1', altKey: true }))).toBe('Alt+1');
    expect(shortcutFromEvent(key({ key: 'Escape', ctrlKey: true, altKey: true, shiftKey: true }))).toBe(
      'CommandOrControl+Alt+Shift+Esc',
    );
  });

  it('화살표와 F키를 받는다', () => {
    expect(shortcutFromEvent(key({ key: 'ArrowUp', ctrlKey: true, shiftKey: true }))).toBe(
      'CommandOrControl+Shift+Up',
    );
    expect(shortcutFromEvent(key({ key: 'ArrowDown', ctrlKey: true }))).toBe('CommandOrControl+Down');
    expect(shortcutFromEvent(key({ key: 'ArrowLeft', altKey: true }))).toBe('Alt+Left');
    expect(shortcutFromEvent(key({ key: 'ArrowRight', altKey: true }))).toBe('Alt+Right');
    expect(shortcutFromEvent(key({ key: 'F12', ctrlKey: true }))).toBe('CommandOrControl+F12');
    expect(shortcutFromEvent(key({ key: 'PageDown', ctrlKey: true }))).toBe('CommandOrControl+PageDown');
    expect(shortcutFromEvent(key({ key: ' ', ctrlKey: true, altKey: true }))).toBe(
      'CommandOrControl+Alt+Space',
    );
  });

  it('Shift가 기호로 바꾼 숫자는 code로 되살린다', () => {
    // US 배열에서 Shift+1은 key '!'다. code가 있으면 배열과 무관하게 1로 읽는다.
    expect(shortcutFromEvent({ ...key({ key: '!', ctrlKey: true, shiftKey: true }), code: 'Digit1' })).toBe(
      'CommandOrControl+Shift+1',
    );
    expect(shortcutFromEvent(key({ key: '!', ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it('모르는 키 이름은 거른다', () => {
    expect(normalizeKey('ArrowUp')).toBe('Up');
    expect(normalizeKey(' ')).toBe('Space');
    expect(normalizeKey('F12')).toBe('F12');
    expect(normalizeKey('a')).toBe('A');
    expect(normalizeKey('Unidentified')).toBeNull();
    expect(shortcutFromEvent(key({ key: 'Unidentified', ctrlKey: true }))).toBeNull();
  });

  it('화면 표기는 기기에 맞춘다', () => {
    expect(displayShortcut('CommandOrControl+Shift+N', false)).toBe('Ctrl+Shift+N');
    expect(displayShortcut('CommandOrControl+Shift+Up', false)).toBe('Ctrl+Shift+↑');
    expect(displayShortcut('Alt+Down', false)).toBe('Alt+↓');
    expect(displayShortcut('Super+Left', false)).toBe('Win+←');
    expect(displayShortcut('', false)).toBe('');
  });

  it('맥은 기호로 붙여 쓴다', () => {
    expect(displayShortcut('CommandOrControl+Shift+N', true)).toBe('⌘⇧N');
    expect(displayShortcut('CommandOrControl+Alt+Shift+Up', true)).toBe('⌘⌥⇧↑');
    expect(displayShortcut('Control+Right', true)).toBe('⌃→');
  });
});

describe('mountSettings', () => {
  let root: HTMLElement;

  const rowOf = (id: ShortcutId): HTMLElement => root.querySelector<HTMLElement>(`.row[data-shortcut="${id}"]`)!;
  const capOf = (id: ShortcutId): HTMLInputElement => rowOf(id).querySelector<HTMLInputElement>('.keycap')!;
  const swOf = (id: ShortcutId): HTMLButtonElement => rowOf(id).querySelector<HTMLButtonElement>('.sw2')!;
  /** 행 바로 뒤에 붙는 .msg */
  const msgOf = (id: ShortcutId): HTMLElement => rowOf(id).nextElementSibling as HTMLElement;

  const press = (id: ShortcutId, init: KeyboardEventInit): void => {
    const cap = capOf(id);
    cap.focus(); // 포커스가 곧 캡처 모드다
    cap.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.getSettings.mockResolvedValue(SETTINGS);
    api.updateSettings.mockImplementation((patch: Partial<Settings>) =>
      Promise.resolve({ ...SETTINGS, ...patch }),
    );
    api.appVersion.mockResolvedValue('1.0.0');
    api.onSettingsChanged.mockResolvedValue(() => {});
    api.shortcutErrors.mockResolvedValue({});
    root = document.createElement('div');
    document.body.append(root);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('설정값을 행에 채운다', async () => {
    mountSettings(root);
    await flush();
    expect(root.querySelector<HTMLSelectElement>('select[aria-label="메모함 테마"]')!.value).toBe('dark');
    expect(root.querySelector<HTMLElement>('.path')!.textContent).toBe('D:\\Drive\\memopin');
    expect(root.textContent).toContain('메모핀 1.0.0');
  });

  it('단축키 여섯 행을 표 순서대로 그리고 기본 조합을 보여 준다', async () => {
    mountSettings(root);
    await flush();
    const rows = [...root.querySelectorAll<HTMLElement>('.row[data-shortcut]')];
    expect(rows.map((r) => r.dataset.shortcut)).toEqual([...SHORTCUT_IDS]);
    expect(capOf('new_note').value).toBe(displayShortcut('CommandOrControl+Shift+N', false));
    expect(capOf('show_all').value).toBe(displayShortcut('CommandOrControl+Shift+Up', false));
    expect(capOf('clip_image').value).toBe(displayShortcut('CommandOrControl+Shift+I', false));
    expect(swOf('hide_all').classList.contains('on')).toBe(true);
    expect(rowOf('new_note').textContent).toContain('어떤 프로그램을 쓰는 중에도');
    expect(api.shortcutErrors).toHaveBeenCalled();
  });

  it('단축키 절이 일반과 동기화 사이에 있다', async () => {
    mountSettings(root);
    await flush();
    const heads = [...root.querySelectorAll('h5')].map((h) => h.querySelector('span')!.textContent);
    expect(heads).toEqual(['일반', '단축키', '동기화', '정보']);
  });

  it('조합을 받으면 전체 맵으로 저장한다', async () => {
    mountSettings(root);
    await flush();
    press('toggle_box', { key: 'j', ctrlKey: true, altKey: true });
    await flush();
    expect(api.updateSettings).toHaveBeenCalledWith({
      shortcuts: { ...DEFAULT_SHORTCUTS, toggle_box: { enabled: true, keys: 'CommandOrControl+Alt+J' } },
    });
    expect(capOf('toggle_box').value).toBe('Ctrl+Alt+J');
    expect(api.shortcutErrors).toHaveBeenCalledTimes(2); // 마운트 + 저장 뒤
  });

  it('수식키 없는 키는 받지 않고 안내한다', async () => {
    mountSettings(root);
    await flush();
    press('new_note', { key: 'n' });
    await flush();
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(msgOf('new_note').textContent).toContain('Ctrl·Alt·Shift');
  });

  it('다른 행과 같은 조합은 저장하지 않고 어느 행인지 말한다', async () => {
    mountSettings(root);
    await flush();
    // hide_all에 new_note의 기본 조합(Ctrl+Shift+N)을 넣어 본다.
    press('hide_all', { key: 'n', ctrlKey: true, shiftKey: true });
    await flush();
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(msgOf('hide_all').textContent).toContain("'새 메모'과 같은 조합입니다.");
  });

  it('Backspace는 지정을 해제하고 토글도 끈다', async () => {
    mountSettings(root);
    await flush();
    press('clip_text', { key: 'Backspace' });
    await flush();
    expect(api.updateSettings).toHaveBeenCalledWith({
      shortcuts: { ...DEFAULT_SHORTCUTS, clip_text: { enabled: false, keys: '' } },
    });
  });

  it('Esc는 취소한다', async () => {
    mountSettings(root);
    await flush();
    press('show_all', { key: 'Escape' });
    await flush();
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(capOf('show_all').value).toBe(displayShortcut('CommandOrControl+Shift+Up', false));
  });

  it('토글은 그 행만 바꿔 전체 맵으로 보낸다', async () => {
    mountSettings(root);
    await flush();
    swOf('clip_image').click();
    await flush();
    expect(api.updateSettings).toHaveBeenCalledWith({
      shortcuts: {
        ...DEFAULT_SHORTCUTS,
        clip_image: { enabled: false, keys: 'CommandOrControl+Shift+I' },
      },
    });
    expect(swOf('clip_image').classList.contains('on')).toBe(false);
    expect(capOf('clip_image').classList.contains('off')).toBe(true);
  });

  it('등록 실패 이유를 그 행 아래에 보여 주고 성공한 행에서는 지운다', async () => {
    api.shortcutErrors.mockResolvedValueOnce({ show_all: '다른 프로그램이 이미 쓰는 조합입니다' });
    mountSettings(root);
    await flush();
    expect(msgOf('show_all').textContent).toBe('다른 프로그램이 이미 쓰는 조합입니다');
    expect(msgOf('show_all').classList.contains('bad')).toBe(true);
    expect(msgOf('new_note').hidden).toBe(true);

    api.shortcutErrors.mockResolvedValue({});
    press('show_all', { key: 'k', ctrlKey: true, altKey: true });
    await flush();
    expect(msgOf('show_all').hidden).toBe(true);
  });

  it('기본값으로 버튼은 여섯 개를 한꺼번에 되돌린다', async () => {
    api.getSettings.mockResolvedValue({
      ...SETTINGS,
      shortcuts: { ...DEFAULT_SHORTCUTS, new_note: { enabled: false, keys: '' } },
    });
    mountSettings(root);
    await flush();
    expect(capOf('new_note').value).toBe('');
    [...root.querySelectorAll('button')].find((b) => b.textContent === '기본값으로')!.click();
    await flush();
    expect(api.updateSettings).toHaveBeenCalledWith({ shortcuts: DEFAULT_SHORTCUTS });
    expect(capOf('new_note').value).toBe(displayShortcut('CommandOrControl+Shift+N', false));
  });

  it('토글은 곧바로 저장한다', async () => {
    mountSettings(root);
    await flush();
    root.querySelector<HTMLButtonElement>('.sw2[aria-label="자동 실행"]')!.click();
    await flush();
    expect(api.updateSettings).toHaveBeenCalledWith({ autostart: true });
    expect(root.querySelector<HTMLElement>('.sw2[aria-label="자동 실행"]')!.classList.contains('on')).toBe(true);
  });

  it('메모함 글자 크기는 새 메모 기본값과 따로 저장한다', async () => {
    mountSettings(root);
    await flush();
    const select = root.querySelector<HTMLSelectElement>('select[aria-label="메모함 글자 크기"]')!;
    expect(select.value).toBe('14');
    select.value = '12';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(api.updateSettings).toHaveBeenCalledWith({ box_font_size: 12 });
  });

  it('저장이 실패하면 행 아래에 알리고 값은 되돌린다', async () => {
    mountSettings(root);
    await flush();
    api.updateSettings.mockRejectedValueOnce('자동 실행을 등록하지 못했습니다.');
    root.querySelector<HTMLButtonElement>('.sw2[aria-label="자동 실행"]')!.click();
    await flush();
    const msg = root.querySelector<HTMLElement>('.msg.bad')!;
    expect(msg.textContent).toBe('자동 실행을 등록하지 못했습니다.');
    expect(root.querySelector<HTMLElement>('.sw2[aria-label="자동 실행"]')!.classList.contains('on')).toBe(false);
  });

  it('기본 폴더로 버튼은 data_dir이 null이면 숨는다', async () => {
    api.getSettings.mockResolvedValue({ ...SETTINGS, data_dir: null });
    mountSettings(root);
    await flush();
    expect(root.querySelector<HTMLElement>('.path')!.textContent).toBe('기본 폴더');
    const reset = [...root.querySelectorAll('button')].find((b) => b.textContent === '기본 폴더로')!;
    expect(reset.hasAttribute('hidden')).toBe(true);
  });

  it('폴더 선택을 취소하면 아무것도 바꾸지 않는다', async () => {
    mountSettings(root);
    await flush();
    api.pickDataDir.mockResolvedValue(null);
    [...root.querySelectorAll('button')].find((b) => b.textContent === '바꾸기…')!.click();
    await flush();
    expect(api.setDataDir).not.toHaveBeenCalled();
  });

  it('업데이트가 없으면 최신이라고 알린다', async () => {
    mountSettings(root);
    await flush();
    plugins.check.mockResolvedValue(null);
    [...root.querySelectorAll('button')].find((b) => b.textContent === '업데이트 확인')!.click();
    await flush();
    expect(root.textContent).toContain('최신 버전입니다.');
    expect(plugins.relaunch).not.toHaveBeenCalled();
  });
});
