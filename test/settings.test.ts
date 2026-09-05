import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Settings } from '../src/types.ts';

const api = vi.hoisted(() => ({
  appVersion: vi.fn(),
  getSettings: vi.fn(),
  onSettingsChanged: vi.fn(),
  pickDataDir: vi.fn(),
  setDataDir: vi.fn(),
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
  shortcut_enabled: true,
  shortcut: 'CommandOrControl+Shift+N',
  autostart: false,
  theme: 'dark',
  default_color: '#FFF4A3',
  default_font_size: 15,
  box_font_size: 14,
  data_dir: 'D:\\Drive\\memopin',
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
    expect(displayShortcut('CommandOrControl+Shift+N', true)).toBe('Cmd+Shift+N');
  });
});

describe('mountSettings', () => {
  let root: HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    api.getSettings.mockResolvedValue(SETTINGS);
    api.updateSettings.mockImplementation((patch: Partial<Settings>) =>
      Promise.resolve({ ...SETTINGS, ...patch }),
    );
    api.appVersion.mockResolvedValue('1.0.0');
    api.onSettingsChanged.mockResolvedValue(() => {});
    root = document.createElement('div');
    document.body.append(root);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('설정값을 행에 채운다', async () => {
    mountSettings(root);
    await flush();
    expect(root.querySelector<HTMLInputElement>('input[type=text]')!.value).toBe(
      displayShortcut('CommandOrControl+Shift+N'),
    );
    expect(root.querySelector<HTMLElement>('.sw2')!.classList.contains('on')).toBe(true);
    expect(root.querySelector<HTMLSelectElement>('select[aria-label="메모함 테마"]')!.value).toBe('dark');
    expect(root.querySelector<HTMLElement>('.path')!.textContent).toBe('D:\\Drive\\memopin');
    expect(root.textContent).toContain('메모핀 1.0.0');
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
    api.updateSettings.mockRejectedValueOnce('단축키를 등록하지 못했습니다.');
    root.querySelector<HTMLButtonElement>('.sw2[aria-label="단축키 사용"]')!.click();
    await flush();
    const msg = root.querySelector<HTMLElement>('.msg.bad')!;
    expect(msg.textContent).toBe('단축키를 등록하지 못했습니다.');
    expect(root.querySelector<HTMLElement>('.sw2[aria-label="단축키 사용"]')!.classList.contains('on')).toBe(true);
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

  it('단축키 입력칸은 수식키 없는 키를 거절한다', async () => {
    mountSettings(root);
    await flush();
    const input = root.querySelector<HTMLInputElement>('input[type=text]')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
    expect(api.updateSettings).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, altKey: true, bubbles: true }));
    await flush();
    expect(api.updateSettings).toHaveBeenCalledWith({ shortcut: 'CommandOrControl+Alt+J' });
  });
});
