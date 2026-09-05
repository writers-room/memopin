/**
 * 글자를 끌어 고르면 그 위에 뜨는 서식 위젯. 시안의 .fmt 그대로다.
 *
 * 문서에 하나만 둔다. 창 하나가 편집기를 여럿(메모함 목록·편집칸 같은) 가질 수 있어서
 * attach를 여러 번 부를 수 있으므로, DOM은 한 벌만 만들고 등록된 편집기 묶음만 늘린다.
 * 마지막 등록이 destroy되면 DOM과 리스너를 걷는다.
 */
import './editor.css';

type EditorSource = () => Iterable<HTMLElement>;

interface Widget {
  root: HTMLDivElement;
  sources: Set<EditorSource>;
  onSelectionChange: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
}

const BUTTONS: Array<{ cls: string; cmd: string; label: string; title: string }> = [
  { cls: 'b', cmd: 'bold', label: 'B', title: '굵게 (Ctrl+B)' },
  { cls: 'i', cmd: 'italic', label: 'I', title: '기울임 (Ctrl+I)' },
  { cls: 'u', cmd: 'underline', label: 'U', title: '밑줄 (Ctrl+U)' },
  { cls: 's', cmd: 'strikeThrough', label: 'S', title: '취소선 (Ctrl+Shift+S)' },
];

type ExecFn = (commandId: string, showUI?: boolean, value?: string) => boolean;

function exec(command: string): void {
  const fn = (document as Document & { execCommand?: ExecFn }).execCommand;
  if (typeof fn !== 'function') return;
  try {
    fn.call(document, command, false, undefined);
  } catch {
    /* 없는 환경에서는 조용히 넘어간다 */
  }
}

let widget: Widget | null = null;

function build(): Widget {
  const root = document.createElement('div');
  root.className = 'fmt';
  root.hidden = true;
  root.setAttribute('role', 'toolbar');
  root.setAttribute('aria-label', '서식');

  const add = (cls: string, cmd: string, label: string, title: string): void => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.title = title;
    // mousedown을 막아야 선택이 풀리지 않는다.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => exec(cmd));
    root.appendChild(b);
  };

  BUTTONS.forEach((b) => add(b.cls, b.cmd, b.label, b.title));
  const div = document.createElement('span');
  div.className = 'div';
  root.appendChild(div);
  add('clear', 'removeFormat', '지우기', '서식 지우기 (Ctrl+\\)');

  const w: Widget = {
    root,
    sources: new Set<EditorSource>(),
    onSelectionChange: () => place(w),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Escape') root.hidden = true;
    },
  };
  document.body.appendChild(root);
  document.addEventListener('selectionchange', w.onSelectionChange);
  document.addEventListener('keydown', w.onKeyDown);
  return w;
}

function inRegisteredEditor(w: Widget, node: Node): boolean {
  for (const source of w.sources) {
    for (const editor of source()) {
      if (editor === node || editor.contains(node)) return true;
    }
  }
  return false;
}

function place(w: Widget): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    w.root.hidden = true;
    return;
  }
  const anchor = sel.anchorNode;
  if (!anchor || !inRegisteredEditor(w, anchor)) {
    w.root.hidden = true;
    return;
  }
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  w.root.hidden = false;
  const width = w.root.offsetWidth;
  const height = w.root.offsetHeight;
  const maxLeft = Math.max(8, window.innerWidth - width - 8);
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), maxLeft);
  // 위가 좁으면 선택 아래로 내린다.
  const above = rect.top - height - 8;
  const top = above >= 8 ? above : Math.min(rect.bottom + 8, Math.max(8, window.innerHeight - height - 8));
  w.root.style.left = `${Math.round(left)}px`;
  w.root.style.top = `${Math.round(top)}px`;
}

/**
 * 서식 위젯을 문서에 붙인다. `editors`는 그때그때 살아 있는 편집기 루트를 돌려주는 함수다
 * (편집기가 다시 만들어져도 위젯은 그대로 두기 위해서다).
 */
export function attachFormatToolbar(editors: EditorSource): { destroy(): void } {
  const w = widget ?? (widget = build());
  w.sources.add(editors);
  let live = true;
  return {
    destroy(): void {
      if (!live) return;
      live = false;
      w.sources.delete(editors);
      if (w.sources.size === 0) {
        document.removeEventListener('selectionchange', w.onSelectionChange);
        document.removeEventListener('keydown', w.onKeyDown);
        w.root.remove();
        if (widget === w) widget = null;
      }
    },
  };
}
