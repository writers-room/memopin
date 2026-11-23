import { beforeEach, describe, expect, it, vi } from 'vitest';

const plugins = vi.hoisted(() => ({ check: vi.fn(), relaunch: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: plugins.check }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: plugins.relaunch }));

import { autoUpdate } from '../src/updater.ts';

describe('autoUpdate', () => {
  beforeEach(() => {
    plugins.check.mockReset();
    plugins.relaunch.mockReset();
  });

  it('새 버전이 없으면 아무것도 하지 않는다', async () => {
    plugins.check.mockResolvedValue(null);
    await autoUpdate();
    expect(plugins.relaunch).not.toHaveBeenCalled();
  });

  it('새 버전이 있으면 묻지 않고 설치한 뒤 다시 띄운다', async () => {
    const order: string[] = [];
    const downloadAndInstall = vi.fn(async () => {
      order.push('install');
    });
    plugins.check.mockResolvedValue({ version: '9.9.9', downloadAndInstall });
    plugins.relaunch.mockImplementation(async () => {
      order.push('relaunch');
    });
    const confirm = vi.spyOn(window, 'confirm');

    await autoUpdate();

    expect(order).toEqual(['install', 'relaunch']);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('확인이나 설치가 실패해도 던지지 않고 다시 띄우지 않는다', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    plugins.check.mockRejectedValue(new Error('offline'));
    await expect(autoUpdate()).resolves.toBeUndefined();

    plugins.check.mockResolvedValue({ version: '9.9.9', downloadAndInstall: vi.fn().mockRejectedValue('bad signature') });
    await expect(autoUpdate()).resolves.toBeUndefined();
    expect(plugins.relaunch).not.toHaveBeenCalled();
  });
});
