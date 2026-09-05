/**
 * 설정 창(라벨 `settings`). 시안 design/mockup.html의 .settings 행 그대로다.
 * 커스텀 제목줄은 없다 — 설정도 OS 장식이 있는 창이다.
 *
 * 모든 변경은 그 자리에서 `update_settings`로 간다. 저장 버튼은 없다.
 * 자동 실행처럼 즉시 적용되는 값은 실패할 수 있어서 reject되면 그 행 아래에 빨간 글씨로
 * 알리고 값은 서버 것으로 되돌린다.
 *
 * 단축키는 다르다(계약): 등록 실패는 에러가 아니라 저장이 끝난 뒤 `shortcut_errors`에 남는다.
 * 그래서 저장이 resolve된 뒤 한 번 더 물어서 행마다 이유를 칠한다.
 */
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

import {
  appVersion,
  getSettings,
  onSettingsChanged,
  pickDataDir,
  setDataDir,
  shortcutErrors,
  updateSettings,
} from '../api.ts';
import type { Settings, SettingsPatch, ShortcutBinding, ShortcutId, Theme } from '../types.ts';
import { DEFAULT_SHORTCUTS, SHORTCUT_IDS } from '../types.ts';
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

/**
 * tauri global-shortcut이 아는 키 이름. 모르는 키면 null.
 *
 * `code`가 오면 그쪽을 먼저 본다. Shift와 같이 누르면 `key`가 배열에 따라 기호로 바뀌기
 * 때문이다(US 배열에서 Shift+1은 key '!'). 전역 단축키는 배열과 무관해야 한다.
 */
export function normalizeKey(key: string, code?: string): string | null {
  if (code) {
    const letter = /^Key([A-Z])$/.exec(code);
    if (letter) return letter[1]!;
    const digit = /^Digit([0-9])$/.exec(code);
    if (digit) return digit[1]!;
  }
  if (key === ' ' || key === 'Spacebar') return 'Space';
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key;
  const named = NAMED_KEYS.get(key);
  if (named) return named;
  if (/^[A-Za-z0-9]$/.test(key)) return key.toUpperCase();
  return null;
}

/**
 * 키 이벤트를 tauri 표기로. 수식키 없는 단독 키는 전역 단축키가 될 수 없으므로 null이다.
 * Ctrl과 Cmd는 둘 다 CommandOrControl로 적는다 — 같은 설정 파일이 두 OS를 오간다.
 */
export function shortcutFromEvent(e: {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const key = normalizeKey(e.key, e.code);
  if (!key) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (parts.length === 0) return null;
  parts.push(key);
  return parts.join('+');
}

/** 맥은 수식키를 기호로 쓰고 구분자를 두지 않는다(⌘⇧N). 윈도우·리눅스는 Ctrl+Shift+N. */
const MAC_TOKENS = new Map<string, string>([
  ['CommandOrControl', '⌘'],
  ['CmdOrCtrl', '⌘'],
  ['Command', '⌘'],
  ['Cmd', '⌘'],
  ['Super', '⌘'],
  ['Meta', '⌘'],
  ['Control', '⌃'],
  ['Ctrl', '⌃'],
  ['Shift', '⇧'],
  ['Alt', '⌥'],
  ['Option', '⌥'],
]);
const PC_TOKENS = new Map<string, string>([
  ['CommandOrControl', 'Ctrl'],
  ['CmdOrCtrl', 'Ctrl'],
  ['Command', 'Win'],
  ['Cmd', 'Win'],
  ['Super', 'Win'],
  ['Meta', 'Win'],
  ['Control', 'Ctrl'],
  ['Ctrl', 'Ctrl'],
  ['Shift', 'Shift'],
  ['Alt', 'Alt'],
  ['Option', 'Alt'],
]);
const ARROW_GLYPHS = new Map<string, string>([
  ['Up', '↑'],
  ['Down', '↓'],
  ['Left', '←'],
  ['Right', '→'],
]);

/** 화면에 보여 줄 표기. CommandOrControl은 이 기기의 이름으로, 화살표는 글리프로. */
export function displayShortcut(shortcut: string, mac = isMac()): string {
  if (!shortcut) return '';
  const tokens = shortcut.split('+');
  const table = mac ? MAC_TOKENS : PC_TOKENS;
  return tokens.map((p) => table.get(p) ?? ARROW_GLYPHS.get(p) ?? p).join(mac ? '' : '+');
}

function isMac(): boolean {
  return /mac/i.test(navigator.platform || navigator.userAgent || '');
}

/** 아직 키를 누르지 않았을 때 보여 줄 "누르는 중" 조각. shortcutFromEvent와 순서가 같다. */
function modifierPreview(
  e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  mac: boolean,
): string {
  const table = mac ? MAC_TOKENS : PC_TOKENS;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push(table.get('CommandOrControl')!);
  if (e.altKey) parts.push(table.get('Alt')!);
  if (e.shiftKey) parts.push(table.get('Shift')!);
  if (parts.length === 0) return '';
  parts.push('…');
  return parts.join(mac ? '' : '+');
}

// ── 단축키 행의 말 ───────────────────────────────────────────────────────────

const SHORTCUT_META: Record<ShortcutId, { name: string; desc: string }> = {
  new_note: { name: '새 메모', desc: '어떤 프로그램을 쓰는 중에도 새 메모를 띄웁니다' },
  show_all: { name: '펼친 메모 모두 보이기', desc: '숨겨 둔 메모 창을 다시 앞으로' },
  hide_all: { name: '펼친 메모 모두 숨기기', desc: '창만 잠시 치웁니다. 메모는 펼친 상태로 남습니다' },
  toggle_box: { name: '메모함 열기/숨기기', desc: '' },
  clip_text: { name: '클립보드 글로 새 메모', desc: '복사해 둔 글이 그대로 메모가 됩니다' },
  clip_image: { name: '클립보드 그림으로 이미지 메모', desc: '스크린샷을 찍고 바로' },
};

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
/** 메모함 편집 칸 전용. 메모 창보다 작게 보는 쪽이라 아래가 더 촘촘하다. */
const BOX_FONT_SIZES = [12, 13, 14, 15, 16, 18] as const;

function cloneShortcuts(src: Record<ShortcutId, ShortcutBinding>): Record<ShortcutId, ShortcutBinding> {
  return {
    new_note: { ...src.new_note },
    show_all: { ...src.show_all },
    hide_all: { ...src.hide_all },
    toggle_box: { ...src.toggle_box },
    clip_text: { ...src.clip_text },
    clip_image: { ...src.clip_image },
  };
}

// ── 마운트 ───────────────────────────────────────────────────────────────────

export function mountSettings(root: HTMLElement): void {
  let settings: Settings | null = null;
  /** 화면이 그리는 값. 캡처 직후에는 서버 응답보다 먼저 여기가 바뀐다(깜빡임 방지). */
  let shortcuts = cloneShortcuts(DEFAULT_SHORTCUTS);
  const mac = isMac();

  root.className = 'set-body';
  root.innerHTML = '';

  const section = (title: string, extra?: HTMLElement): void => {
    const h = document.createElement('h5');
    const span = document.createElement('span');
    span.textContent = title;
    h.append(span);
    if (extra) h.append(extra);
    root.append(h);
  };

  // ── 일반 ──
  section('일반');

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

  const boxSizeRow = makeRow(root, '메모함 글자 크기', '메모함 편집 칸에만 씁니다. 메모 창 크기는 그대로입니다');
  const boxSizeSelect = makeSelect(
    '메모함 글자 크기',
    BOX_FONT_SIZES.map((n) => [String(n), `${n}px`] as const),
  );
  boxSizeRow.el.append(boxSizeSelect);

  // ── 단축키 ──
  const resetShortcutsBtn = makeButton('기본값으로');
  section('단축키', resetShortcutsBtn);

  interface KeyRow {
    row: Row;
    input: HTMLInputElement;
    sw: HTMLButtonElement;
    /** 등록 실패 이유. 안내 말이 잠깐 덮었다가 이 값으로 돌아온다 */
    error: string;
    hintTimer: number;
  }
  const keyRows = new Map<ShortcutId, KeyRow>();

  for (const id of SHORTCUT_IDS) {
    const meta = SHORTCUT_META[id];
    const row = makeRow(root, meta.name, meta.desc || undefined);
    row.el.dataset.shortcut = id;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'keycap';
    input.readOnly = true;
    input.spellcheck = false;
    input.placeholder = '지정 안 함';
    input.setAttribute('aria-label', `${meta.name} 단축키`);
    const sw = makeSwitch(`${meta.name} 단축키 사용`);
    row.el.append(input, sw);
    keyRows.set(id, { row, input, sw, error: '', hintTimer: 0 });
  }

  /** 행 아래 글씨를 등록 실패 이유(있으면)로 되돌린다. */
  function paint(id: ShortcutId): void {
    const kr = keyRows.get(id)!;
    kr.row.say(kr.error, Boolean(kr.error));
  }

  /** 잠깐 보여 주는 안내. 시간이 지나면 등록 실패 이유로 돌아간다. */
  function hint(id: ShortcutId, text: string): void {
    const kr = keyRows.get(id)!;
    window.clearTimeout(kr.hintTimer);
    kr.row.say(text, true);
    kr.hintTimer = window.setTimeout(() => paint(id), 3000);
  }

  function renderShortcut(id: ShortcutId): void {
    const kr = keyRows.get(id)!;
    const b = shortcuts[id];
    if (kr.input.classList.contains('listening')) return; // 캡처 중에는 건드리지 않는다
    kr.input.value = displayShortcut(b.keys, mac);
    kr.input.classList.toggle('off', !b.enabled || !b.keys);
    setSwitch(kr.sw, b.enabled);
  }

  function renderShortcuts(): void {
    for (const id of SHORTCUT_IDS) renderShortcut(id);
  }

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
    shortcuts = cloneShortcuts(settings.shortcuts);
    renderShortcuts();
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
    boxSizeSelect.value = String(settings.box_font_size);
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

  /** 등록 실패 목록을 다시 읽어 행마다 칠한다. 성공한 행의 글씨는 지워진다. */
  async function refreshErrors(): Promise<void> {
    let errs: Partial<Record<ShortcutId, string>>;
    try {
      errs = await shortcutErrors();
    } catch {
      return; // 못 읽으면 지금 화면을 그대로 둔다
    }
    for (const id of SHORTCUT_IDS) {
      const kr = keyRows.get(id)!;
      kr.error = errs[id] ?? '';
      window.clearTimeout(kr.hintTimer);
      paint(id);
    }
  }

  /**
   * 단축키는 전체 맵으로 보낸다(계약의 patch 단위가 `shortcuts`다).
   * 등록 실패는 reject가 아니므로 resolve된 뒤 shortcut_errors를 한 번 더 묻는다.
   */
  async function saveShortcuts(next: Record<ShortcutId, ShortcutBinding>, row: Row): Promise<void> {
    shortcuts = next;
    renderShortcuts();
    try {
      settings = await updateSettings({ shortcuts: next });
      sync();
    } catch (e) {
      row.say(typeof e === 'string' ? e : e instanceof Error ? e.message : '단축키를 바꾸지 못했습니다.', true);
      try {
        settings = await getSettings();
        sync();
      } catch {
        /* 되돌릴 값을 못 읽으면 화면은 그대로 둔다 */
      }
      return;
    }
    await refreshErrors();
  }

  /** 같은 조합을 이미 쓰는 다른 행. 있으면 그 이름. */
  function conflictName(id: ShortcutId, keys: string): string | null {
    for (const other of SHORTCUT_IDS) {
      if (other === id) continue;
      if (shortcuts[other].keys === keys) return SHORTCUT_META[other].name;
    }
    return null;
  }

  for (const id of SHORTCUT_IDS) {
    const kr = keyRows.get(id)!;
    const { input, sw } = kr;

    input.addEventListener('focus', () => {
      input.classList.add('listening');
      input.value = '';
      input.placeholder = '키를 누르세요…';
    });
    input.addEventListener('blur', () => {
      input.classList.remove('listening');
      input.placeholder = '지정 안 함';
      renderShortcut(id); // 취소 = 원래 값
    });
    input.addEventListener('keyup', (e) => {
      if (!input.classList.contains('listening')) return;
      input.value = modifierPreview(e, mac);
    });
    input.addEventListener('keydown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        input.blur();
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        // 지정 해제. 조합이 없는 단축키를 켜 둘 이유가 없으니 토글도 끈다.
        const next = cloneShortcuts(shortcuts);
        next[id] = { enabled: false, keys: '' };
        input.classList.remove('listening');
        void saveShortcuts(next, kr.row);
        input.blur();
        return;
      }
      if (MODIFIER_KEYS.has(e.key)) {
        input.value = modifierPreview(e, mac); // 누르는 중인 수식키를 그대로 보여 준다
        return;
      }
      const combo = shortcutFromEvent(e);
      if (!combo) {
        input.value = modifierPreview(e, mac);
        hint(id, 'Ctrl·Alt·Shift 중 하나와 같이 눌러 주세요.');
        return;
      }
      const clash = conflictName(id, combo);
      if (clash) {
        hint(id, `'${clash}'과 같은 조합입니다.`);
        return;
      }
      const next = cloneShortcuts(shortcuts);
      // 비어 있던 자리에 조합을 넣으면 켠다 — 그러려고 누른 것이다.
      next[id] = { enabled: shortcuts[id].keys ? shortcuts[id].enabled : true, keys: combo };
      input.classList.remove('listening');
      void saveShortcuts(next, kr.row);
      input.blur();
    });

    sw.addEventListener('click', () => {
      const cur = shortcuts[id];
      if (!cur.enabled && !cur.keys) {
        hint(id, '조합을 먼저 지정해 주세요.');
        input.focus();
        return;
      }
      const next = cloneShortcuts(shortcuts);
      next[id] = { ...cur, enabled: !cur.enabled };
      void saveShortcuts(next, kr.row);
    });
  }

  resetShortcutsBtn.addEventListener('click', () => {
    void saveShortcuts(cloneShortcuts(DEFAULT_SHORTCUTS), keyRows.get('new_note')!.row);
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
  boxSizeSelect.addEventListener('change', () => {
    void save({ box_font_size: Number(boxSizeSelect.value) }, boxSizeRow);
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
  renderShortcuts();
  void (async () => {
    try {
      settings = await getSettings();
      sync();
      await refreshErrors();
    } catch (e) {
      autostartRow.say(typeof e === 'string' ? e : '설정을 읽지 못했습니다.', true);
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
    void refreshErrors();
  });
}
