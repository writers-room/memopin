/**
 * contenteditable 편집기. 메모 창과 메모함이 같은 것을 쓴다.
 *
 * 원칙 셋:
 *  1. 화면에 있는 DOM과 저장하는 HTML은 다르다. 화면에는 체크박스 표시용 span.cb가 있고
 *     저장본에는 없다(sanitize.ts). 그래서 getHtml()은 언제나 정제본을 돌려준다.
 *  2. 서식은 execCommand로 건다. 낡았지만 실행 취소 스택이 브라우저 것과 이어지는 유일한
 *     길이고, 우리가 쓰는 명령은 전부 살아 있다. jsdom에는 없으므로 없으면 조용히 건너뛴다
 *     (테스트는 detectTrigger 같은 순수 함수와 DOM 변환 결과만 본다).
 *  3. 저장은 호출자 몫이다. 여기서는 입력마다 onChange(정제 html, 평문)를 부를 뿐 디바운스도
 *     하지 않는다.
 */
import { EMPTY_HTML, sanitizeHtml, toPlainText } from './sanitize.ts';
import './editor.css';

const DEFAULT_PLACEHOLDER = '메모를 적으세요. 첫 줄이 제목이 됩니다.';

export interface EditorOptions {
  placeholder?: string;
  /** 입력마다. html은 정제본, text는 그 평문. 디바운스는 호출자가 한다. */
  onChange?: (html: string, text: string) => void;
  /** Ctrl+휠. 실제 크기는 호출자가 정하고 setFontSize로 되돌려 준다. */
  onFontSizeDelta?: (delta: 1 | -1) => void;
  /** Ctrl+0. 기본 글자 크기로. */
  onFontSizeReset?: () => void;
}

export interface Editor {
  /** contenteditable 루트. 호출자가 원하는 곳에 넣는다. */
  el: HTMLDivElement;
  /** 외부 변경 반영. 편집 중(포커스가 안에 있음)이면 덮어쓰지 않고 false. */
  setHtml(html: string): boolean;
  /** 정제된 저장용 html. */
  getHtml(): string;
  setFontSize(px: number): void;
  focus(): void;
  destroy(): void;
}

type ExecFn = (commandId: string, showUI?: boolean, value?: string) => boolean;

/** execCommand가 없는 환경(jsdom)에서는 조용히 실패한다. */
function exec(command: string, value?: string): boolean {
  const fn = (document as Document & { execCommand?: ExecFn }).execCommand;
  if (typeof fn !== 'function') return false;
  try {
    return fn.call(document, command, false, value);
  } catch {
    return false;
  }
}

// 새 문단은 div가 아니라 p로. 모듈을 읽을 때 한 번만 부른다.
exec('defaultParagraphSeparator', 'p');

/** 캐럿이 들어 있는 블록. 편집기 밖이거나 루트 자신이면 null. */
function caretBlock(root: HTMLElement, selector: string): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const anchor = sel.anchorNode;
  if (!anchor) return null;
  const start = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : (anchor as Element);
  if (!start) return null;
  const found = start.closest(selector);
  if (!found || found === root || !root.contains(found)) return null;
  return found as HTMLElement;
}

function setCaretAfter(node: Node): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * 줄 첫머리의 자동 서식 트리거. 순수 함수라 테스트가 여기를 본다.
 * "- " / "* " → 글머리, "1. " → 숫자, "[] " / "[ ] " → 체크박스.
 */
export function detectTrigger(text: string): { kind: 'ul' | 'ol' | 'task'; len: number } | null {
  // contenteditable은 줄 끝의 공백을 U+00A0(nbsp)로 넣는다. 그대로 두면 "- "를 친 순간에는
  // 안 걸리고 다음 글자를 친 뒤에야 걸려서, 그 글자가 캐럿 뒤에 남는 사고가 난다.
  const m = /^(?:- |\* |1\. |\[ ?\] )/.exec(text.replace(/ /g, ' '));
  if (!m) return null;
  const t = m[0];
  const kind = t.startsWith('[') ? 'task' : t.startsWith('1') ? 'ol' : 'ul';
  return { kind, len: t.length };
}

/**
 * 블록(p/div)을 목록 항목으로 바꾼다. execCommand('insertUnorderedList')는 Chromium에서
 * <p> 안에 <ul>을 끼워 넣는 등 결과가 들쭉날쭉해서 DOM을 직접 옮긴다. 바로 앞이 같은 종류의
 * 목록이면 거기에 항목을 이어 붙인다. 돌려주는 값은 새 li.
 */
export function convertBlockToListItem(block: HTMLElement, kind: 'ul' | 'ol' | 'task'): HTMLLIElement {
  const listTag = kind === 'ol' ? 'OL' : 'UL';
  const li = document.createElement('li');
  if (kind === 'task') li.className = 'task';
  while (block.firstChild) li.appendChild(block.firstChild);
  if (!li.textContent && !li.querySelector('br')) li.appendChild(document.createElement('br'));

  const prev = block.previousElementSibling;
  if (prev && prev.tagName === listTag) {
    prev.appendChild(li);
    block.remove();
  } else {
    const list = document.createElement(listTag.toLowerCase());
    list.appendChild(li);
    block.replaceWith(list);
  }
  return li;
}

/**
 * 목록 항목을 목록 밖의 문단으로 뺀다(convertBlockToListItem의 반대). 체크박스 표시(.cb)는 버린다.
 * 항목이 목록의 처음·끝이면 목록 앞·뒤에 놓고, 가운데면 목록을 둘로 가른다. 돌려주는 값은 새 p.
 */
export function convertListItemToBlock(li: HTMLElement): HTMLParagraphElement {
  const list = li.parentElement;
  const p = document.createElement('p');
  li.querySelectorAll('.cb').forEach((cb) => cb.remove());
  while (li.firstChild) p.appendChild(li.firstChild);
  if (!p.textContent && !p.querySelector('br')) p.appendChild(document.createElement('br'));

  if (!list || (list.tagName !== 'UL' && list.tagName !== 'OL')) {
    li.replaceWith(p);
    return p;
  }
  const items = Array.from(list.children);
  const index = items.indexOf(li);
  if (items.length === 1) {
    list.replaceWith(p);
  } else if (index === 0) {
    li.remove();
    list.before(p);
  } else if (index === items.length - 1) {
    li.remove();
    list.after(p);
  } else {
    const rest = document.createElement(list.tagName.toLowerCase());
    for (const item of items.slice(index + 1)) rest.appendChild(item);
    li.remove();
    list.after(p, rest);
  }
  return p;
}

/** 트리거 글자를 지우고 목록으로 바꾼다. 이미 li 안이면 아무 일도 하지 않는다. */
function autoformat(root: HTMLElement): void {
  const block = caretBlock(root, 'p,div,li');
  if (!block || block.tagName === 'LI') return;
  const trigger = detectTrigger(block.textContent ?? '');
  if (!trigger) return;

  let len = trigger.len;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (len > 0 && node) {
    const text = node as Text;
    const cut = Math.min(len, text.data.length);
    text.data = text.data.slice(cut);
    len -= cut;
    node = walker.nextNode();
  }

  const li = convertBlockToListItem(block, trigger.kind);
  // 캐럿은 항목 맨 끝. 트리거는 공백을 친 순간에 걸리므로 보통 항목은 비어 있다.
  const sel = window.getSelection();
  if (sel) {
    const range = document.createRange();
    if (li.childNodes.length === 1 && li.firstChild instanceof HTMLBRElement) {
      range.setStart(li, 0);
    } else {
      range.selectNodeContents(li);
    }
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

/**
 * 화면용 보정: li.task마다 맨 앞에 체크박스 span을 하나씩 둔다.
 * 시안과 달리 여기서 done을 지우지 않는다 — 저장본에는 cb가 없으므로 불러오기 직후에도
 * "cb 없는 task"가 되고, 그때 done을 지우면 완료 표시가 통째로 날아간다.
 */
export function normalize(root: HTMLElement): void {
  root.querySelectorAll('li.task').forEach((li) => {
    const marks = Array.from(li.children).filter((c) => c.classList.contains('cb'));
    marks.slice(1).forEach((extra) => extra.remove());
    let cb = marks[0] ?? null;
    const created = !cb;
    if (!cb) {
      cb = document.createElement('span');
      cb.className = 'cb';
      cb.setAttribute('contenteditable', 'false');
    }
    if (li.firstChild !== cb) li.insertBefore(cb, li.firstChild);
    if (created && caretBlock(root, 'li') === li) setCaretAfter(cb);
  });
  root.querySelectorAll('.cb').forEach((cb) => {
    const li = cb.parentElement;
    if (!li || !li.classList.contains('task')) cb.remove();
  });
}

function isEmptyTask(li: HTMLElement): boolean {
  return !(li.textContent ?? '').trim();
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 평문 붙여넣기: 줄마다 문단 하나. */
function plainToHtml(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return lines.map((line) => `<p>${escapeText(line) || '<br>'}</p>`).join('');
}

export function createEditor(opts: EditorOptions = {}): Editor {
  const el = document.createElement('div');
  el.className = 'editor';
  // 프로퍼티가 아니라 속성으로 건다. jsdom은 contentEditable 프로퍼티를 반영하지 않는다.
  el.setAttribute('contenteditable', 'true');
  el.setAttribute('spellcheck', 'false');
  el.dataset['ph'] = opts.placeholder ?? DEFAULT_PLACEHOLDER;

  const getHtml = (): string => sanitizeHtml(el.innerHTML);
  const emit = (): void => {
    if (!opts.onChange) return;
    const html = getHtml();
    opts.onChange(html, toPlainText(html));
  };

  /** Enter로 항목이 쪼개진 직후인지. 새 항목의 done을 떼기 위해 input에서 확인한다. */
  let splitting = false;

  // 빈 체크박스 항목에서 Enter·Backspace: 항목을 목록 밖의 문단으로 뺀다.
  // execCommand('outdent')는 Chromium에서 li를 그대로 둔 채 class만 사라져 동그라미 글머리로
  // 변해 버렸다. 그래서 DOM으로 직접 뺀다.
  const leaveTask = (li: HTMLElement): void => {
    const p = convertListItemToBlock(li);
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.setStart(p, 0);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  };

  const onInput = (): void => {
    if (splitting) {
      splitting = false;
      const li = caretBlock(el, 'li');
      if (li?.classList.contains('task')) li.classList.remove('done');
    }
    autoformat(el);
    normalize(el);
    emit();
  };

  const onClick = (e: MouseEvent): void => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const cb = target.closest('.cb');
    const li = cb?.parentElement;
    if (!li || !li.classList.contains('task')) return;
    li.classList.toggle('done');
    emit();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === '0') {
      e.preventDefault();
      opts.onFontSizeReset?.();
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      exec('strikeThrough');
      emit();
      return;
    }
    if (mod && e.key === '\\') {
      e.preventDefault();
      exec('removeFormat');
      emit();
      return;
    }
    if (e.key === 'Tab') {
      // 목록 밖에서도 막는다. 편집 중 Tab으로 포커스가 튀면 안 된다.
      e.preventDefault();
      if (caretBlock(el, 'li')) {
        exec(e.shiftKey ? 'outdent' : 'indent');
        emit();
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      const li = caretBlock(el, 'li');
      if (!li?.classList.contains('task')) return;
      if (isEmptyTask(li)) {
        e.preventDefault();
        leaveTask(li);
        emit();
      } else {
        splitting = true;
      }
      return;
    }
    if (e.key === 'Backspace') {
      const sel = window.getSelection();
      if (!sel || !sel.isCollapsed) return;
      const li = caretBlock(el, 'li');
      if (!li?.classList.contains('task') || !isEmptyTask(li)) return;
      e.preventDefault();
      leaveTask(li);
      emit();
    }
  };

  const onPaste = (e: ClipboardEvent): void => {
    const data = e.clipboardData;
    if (!data) return;
    e.preventDefault();
    const html = data.getData('text/html');
    const fragment = html ? sanitizeHtml(html) : plainToHtml(data.getData('text/plain'));
    exec('insertHTML', fragment);
    // execCommand가 있으면 input이 뒤따라 오지만, 없는 환경에서도 상태는 맞춰 둔다.
    normalize(el);
    emit();
  };

  const onWheel = (e: WheelEvent): void => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    opts.onFontSizeDelta?.(e.deltaY < 0 ? 1 : -1);
  };

  // 빈 편집기에 첫 글자를 치면 브라우저가 p 없이 텍스트를 루트에 바로 넣어 첫 줄의
  // 자동 서식("- " 등)이 걸리지 않는다. 포커스가 올 때 빈 문단을 깔고 캐럿을 그 안에 두고,
  // 포커스가 나갈 때 여전히 비어 있으면 다시 비워 placeholder가 보이게 한다.
  const onFocus = (): void => {
    if (el.childNodes.length > 0) return;
    el.innerHTML = EMPTY_HTML;
    const p = el.firstElementChild;
    const sel = window.getSelection();
    if (!p || !sel) return;
    const range = document.createRange();
    range.setStart(p, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  };
  const onBlur = (): void => {
    if (getHtml() === EMPTY_HTML) el.innerHTML = '';
  };

  el.addEventListener('focus', onFocus);
  el.addEventListener('blur', onBlur);
  el.addEventListener('input', onInput);
  el.addEventListener('click', onClick);
  el.addEventListener('keydown', onKeyDown);
  el.addEventListener('paste', onPaste);
  el.addEventListener('wheel', onWheel, { passive: false });

  return {
    el,
    setHtml(html: string): boolean {
      // 창이 OS 포커스를 잃어도 document.activeElement는 편집기에 남는다. 그것만 보면
      // 다른 창(메모함↔메모 창)에서 온 변경을 영영 받지 못하므로 문서가 실제로 포커스를
      // 가진 때에만 "편집 중"으로 본다.
      const active = document.activeElement;
      if (document.hasFocus() && active && el.contains(active)) return false;
      const clean = sanitizeHtml(html);
      // 빈 본문일 때만 정말로 비워 둔다. 그래야 :empty::before placeholder가 보인다.
      el.innerHTML = clean === EMPTY_HTML ? '' : clean;
      normalize(el);
      return true;
    },
    getHtml,
    setFontSize(px: number): void {
      el.style.setProperty('--fs', `${px}px`);
    },
    focus(): void {
      el.focus();
    },
    destroy(): void {
      el.removeEventListener('focus', onFocus);
      el.removeEventListener('blur', onBlur);
      el.removeEventListener('input', onInput);
      el.removeEventListener('click', onClick);
      el.removeEventListener('keydown', onKeyDown);
      el.removeEventListener('paste', onPaste);
      el.removeEventListener('wheel', onWheel);
      el.remove();
    },
  };
}
