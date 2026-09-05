/**
 * 설정 창(라벨 `settings`). 시안 design/mockup.html의 .settings 행 그대로다.
 * 커스텀 제목줄은 없다 — 설정도 OS 장식이 있는 창이다.
 *
 * 모든 변경은 그 자리에서 `update_settings`로 간다. 저장 버튼은 없다.
 * 단축키 등록·자동 실행처럼 즉시 적용되는 값은 실패할 수 있어서(다른 앱이 이미 그 조합을
 * 잡고 있는 경우 등) reject되면 그 행 아래에 빨간 글씨로 알리고 값은 서버 것으로 되돌린다.
 */
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

import {
  appVersion,
  getSettings,
  onSettingsChanged,
  pickDataDir,
  setDataDir,
  updateSettings,
} from '../api.ts';
import type { Settings, SettingsPatch, Theme } from '../types.ts';
import { PALETTE } from './colors.ts';
import { applyTheme } from './theme.ts';
import './settings.css';

// ── 단축키 표기(순수 함수. 테스트가 여기를 본다) ────────────────────────────

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS', 'CapsLock', 'Dead']);

const NAMED_KEYS = new Map<string, string>([
  ['ArrowUp', 'Up'],
  ['ArrowDown', 'Down'],
  ['ArrowLeft', 'Left'],
  ['ArrowRight', 'Right'],
  ['Escape', 'Esc'],
  ['Enter', 'Enter'],
  ['Tab', 'Tab'],
  ['Backspace', 'Backspace'],
  ['Delete', 'Delete'],
  ['Insert', 'Insert'],
  ['Home', 'Home'],
  ['End', 'End'],
  ['PageUp', 'PageUp'],
  ['PageDown', 'PageDown'],
]);

/** tauri global-shortcut이 아는 키 이름. 모르는 키면 null. */
export function normalizeKey(key: string): string | null {
  if (key === ' ' || key === 'Spacebar') return 'Space';
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key;
  const named = NAMED_KEYS.get(key);
  if (named) return named;
  if (key.length === 1) return key.toUpperCase();
  return null;
}

/**
 * 키 이벤트를 tauri 표기로. 수식키 없는 단독 키는 전역 단축키가 될 수 없으므로 null이다.
 * Ctrl과 Cmd는 둘 다 CommandOrControl로 적는다 — 같은 설정 파일이 두 OS를 오간다.
 */
export function shortcutFromEvent(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const key = normalizeKey(e.key);
  if (!key) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (parts.length === 0) return null;
  parts.push(key);
  return parts.join('+');
}

/** 화면에 보여 줄 표기. CommandOrControl은 이 기기의 이름으로 바꾼다. */
export function displayShortcut(shortcut: string, mac = isMac()): string {
  return shortcut
    .split('+')
    .map((p) => (p === 'CommandOrControl' || p === 'CmdOrCtrl' ? (mac ? 'Cmd' : 'Ctrl') : p))
    .join('+');
}

function isMac(): boolean {
  return /mac/i.test(navigator.platform || navigator.userAgent || '');
}

// ── 행 만들기 ────────────────────────────────────────────────────────────────

interface Row {
  el: HTMLDivElement;
  msg: HTMLDivElement;
  say(text: string, bad?: boolean): void;
}

function makeRow(parent: HTMLElement, label: string, sub?: string): Row {
  const el = document.createElement('div');
  el.className = 'row';
  const lbl = document.createElement('div');
  lbl.className = 'lbl';
  lbl.textContent = label;
  if (sub) {
    const small = document.createElement('small');
    small.textContent = sub;
    lbl.append(small);
  }
  el.append(lbl);
  const msg = document.createElement('div');
  msg.className = 'msg';
  msg.hidden = true;
  parent.append(el, msg);
  return {
    el,
    msg,
    say(text, bad = false) {
      msg.textContent = text;
      msg.classList.toggle('bad', bad);
      msg.hidden = !text;
    },
  };
}

function makeSwitch(label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sw2';
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-label', label);
  b.setAttribute('aria-checked', 'false');
  return b;
}

function setSwitch(b: HTMLButtonElement, on: boolean): void {
  b.classList.toggle('on', on);
  b.setAttribute('aria-checked', String(on));
}

function makeSelect(label: string, options: ReadonlyArray<readonly [string, string]>): HTMLSelectElement {
  const s = document.createElement('select');
  s.setAttribute('aria-label', label);
  for (const [value, text] of options) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    s.append(o);
  }
  return s;
}

function makeButton(text: string, cls = 'btn ghost sm'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  return b;
}

const FONT_SIZES = [13, 14, 15, 16, 18, 20] as const;

// ── 마운트 ───────────────────────────────────────────────────────────────────

export function mountSettings(root: HTMLElement): void {
  let settings: Settings | null = null;

  root.className = 'set-body';
  root.innerHTML = '';

  const section = (title: string): void => {
    const h = document.createElement('h5');
    h.textContent = title;
    root.append(h);
  };

  // ── 일반 ──
  section('일반');

  const shortcutRow = makeRow(root, '새 메모 전역 단축키', '다른 앱을 쓰는 중에도 새 메모를 띄웁니다');
  const shortcutInput = document.createElement('input');
  shortcutInput.type = 'text';
  shortcutInput.setAttribute('aria-label', '단축키');
  shortcutInput.readOnly = true;
  const shortcutSwitch = makeSwitch('단축키 사용');
  shortcutRow.el.append(shortcutInput, shortcutSwitch);

  const autostartRow = makeRow(root, '시작할 때 자동 실행', '로그인하면 트레이에 조용히 올라옵니다');
  const autostartSwitch = makeSwitch('자동 실행');
  autostartRow.el.append(autostartSwitch);

  const themeRow = makeRow(root, '메모함 테마');
  const themeSelect = makeSelect('메모함 테마', [
    ['system', '시스템 따라가기'],
    ['light', '라이트'],
    ['dark', '다크'],
  ]);
  themeRow.el.append(themeSelect);

  const defaultsRow = makeRow(root, '새 메모 기본값');
  const colorSelect = makeSelect('새 메모 색', PALETTE.map(([hex, label]) => [hex, label] as const));
  const sizeSelect = makeSelect(
    '새 메모 글자 크기',
    FONT_SIZES.map((n) => [String(n), `${n}px`] as const),
  );
  defaultsRow.el.append(colorSelect, sizeSelect);

  // ── 동기화 ──
  section('동기화');

  const dirRow = makeRow(
    root,
    '메모 저장 폴더',
    '구글 드라이브·Dropbox·OneDrive·iCloud 폴더를 고르면 그 서비스가 동기화합니다',
  );
  const pathEl = document.createElement('span');
  pathEl.className = 'path';
  const changeBtn = makeButton('바꾸기…');
  const resetBtn = makeButton('기본 폴더로');
  dirRow.el.append(pathEl, changeBtn, resetBtn);

  // ── 정보 ──
  section('정보');

  const aboutRow = makeRow(root, '메모핀', 'GitHub 릴리스에서 업데이트를 받습니다');
  const updateBtn = makeButton('업데이트 확인');
  aboutRow.el.append(updateBtn);
  const aboutLabel = aboutRow.el.querySelector<HTMLElement>('.lbl')!;

  // ── 값 반영 ──
  function sync(): void {
    if (!settings) return;
    shortcutInput.value = displayShortcut(settings.shortcut);
    setSwitch(shortcutSwitch, settings.shortcut_enabled);
    shortcutInput.disabled = !settings.shortcut_enabled;
    setSwitch(autostartSwitch, settings.autostart);
    themeSelect.value = settings.theme;
    colorSelect.value = settings.default_color;
    // 프리셋에 없는 색이 저장돼 있으면 select가 비어 버린다. 그때는 항목을 하나 더 만든다.
    if (colorSelect.value !== settings.default_color) {
      const o = document.createElement('option');
      o.value = settings.default_color;
      o.textContent = settings.default_color;
      colorSelect.append(o);
      colorSelect.value = settings.default_color;
    }
    sizeSelect.value = String(settings.default_font_size);
    pathEl.textContent = settings.data_dir ?? '기본 폴더';
    pathEl.title = settings.data_dir ?? '기본 폴더';
    resetBtn.hidden = settings.data_dir === null;
    applyTheme(settings.theme);
  }

  /** 즉시 저장. 실패하면 그 행 아래에 알리고 값은 서버 것으로 되돌린다. */
  async function save(patch: SettingsPatch, row: Row): Promise<void> {
    row.say('');
    try {
      settings = await updateSettings(patch);
      sync();
    } catch (e) {
      row.say(typeof e === 'string' ? e : e instanceof Error ? e.message : '설정을 바꾸지 못했습니다.', true);
      try {
        settings = await getSettings();
        sync();
      } catch {
        /* 되돌릴 값을 못 읽으면 화면은 그대로 둔다 */
      }
    }
  }

  // ── 단축키 ──
  shortcutInput.addEventListener('focus', () => {
    shortcutInput.classList.add('listening');
    shortcutRow.say('누를 조합을 입력하세요. 수식키(Ctrl·Alt·Shift)가 하나는 있어야 합니다.');
  });
  shortcutInput.addEventListener('blur', () => {
    shortcutInput.classList.remove('listening');
    shortcutRow.say('');
    if (settings) shortcutInput.value = displayShortcut(settings.shortcut);
  });
  shortcutInput.addEventListener('keydown', (e) => {
    e.preventDefault();
    if (e.key === 'Escape') {
      shortcutInput.blur();
      return;
    }
    if (MODIFIER_KEYS.has(e.key)) return;
    const combo = shortcutFromEvent(e);
    if (!combo) {
      shortcutRow.say('수식키(Ctrl·Alt·Shift)를 하나 이상 같이 눌러야 합니다.', true);
      return;
    }
    shortcutInput.value = displayShortcut(combo);
    void save({ shortcut: combo }, shortcutRow);
  });
  shortcutSwitch.addEventListener('click', () => {
    void save({ shortcut_enabled: !settings?.shortcut_enabled }, shortcutRow);
  });

  autostartSwitch.addEventListener('click', () => {
    void save({ autostart: !settings?.autostart }, autostartRow);
  });

  themeSelect.addEventListener('change', () => {
    void save({ theme: themeSelect.value as Theme }, themeRow);
  });
  colorSelect.addEventListener('change', () => {
    void save({ default_color: colorSelect.value }, defaultsRow);
  });
  sizeSelect.addEventListener('change', () => {
    void save({ default_font_size: Number(sizeSelect.value) }, defaultsRow);
  });

  // ── 저장 폴더 ──
  changeBtn.addEventListener('click', () => {
    void (async () => {
      dirRow.say('');
      try {
        const path = await pickDataDir();
        if (path === null) return; // 취소
        settings = await setDataDir(path);
        sync();
        dirRow.say('저장 폴더를 바꿨습니다.');
      } catch (e) {
        dirRow.say(typeof e === 'string' ? e : '폴더를 바꾸지 못했습니다.', true);
      }
    })();
  });
  resetBtn.addEventListener('click', () => {
    void (async () => {
      dirRow.say('');
      try {
        settings = await setDataDir(null);
        sync();
        dirRow.say('기본 폴더로 되돌렸습니다.');
      } catch (e) {
        dirRow.say(typeof e === 'string' ? e : '폴더를 바꾸지 못했습니다.', true);
      }
    })();
  });

  // ── 업데이트 ──
  updateBtn.addEventListener('click', () => {
    void (async () => {
      updateBtn.disabled = true;
      aboutRow.say('업데이트를 확인하는 중…');
      try {
        const update = await check();
        if (!update) {
          aboutRow.say('최신 버전입니다.');
          return;
        }
        if (!window.confirm(`${update.version} 버전이 있습니다. 지금 설치할까요?`)) {
          aboutRow.say('');
          return;
        }
        aboutRow.say('내려받아 설치하는 중…');
        await update.downloadAndInstall();
        await relaunch();
      } catch (e) {
        aboutRow.say(typeof e === 'string' ? e : e instanceof Error ? e.message : '업데이트를 확인하지 못했습니다.', true);
      } finally {
        updateBtn.disabled = false;
      }
    })();
  });

  // ── 첫 로드 ──
  void (async () => {
    try {
      settings = await getSettings();
      sync();
    } catch (e) {
      shortcutRow.say(typeof e === 'string' ? e : '설정을 읽지 못했습니다.', true);
    }
    try {
      const version = await appVersion();
      const small = aboutLabel.querySelector('small');
      aboutLabel.textContent = `메모핀 ${version}`;
      if (small) aboutLabel.append(small);
    } catch {
      /* 판 번호를 못 읽어도 나머지는 쓸 수 있다 */
    }
  })();

  void onSettingsChanged((s) => {
    settings = s;
    sync();
  });
}
