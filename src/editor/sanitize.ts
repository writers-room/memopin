/**
 * 본문 HTML 정제와 평문 추출.
 *
 * 계약(docs/contract.md)이 허용하는 태그는 p br ul ol li b i u s 뿐이고, class는 li의
 * "task" / "task done"만 남는다. 저장 직전에 여기를 반드시 통과시킨다 — 붙여넣기로 들어온
 * 스타일·글꼴·색이 파일에 섞이면 다른 기기에서 그대로 되살아난다.
 *
 * 체크박스 표시용 `span.cb`는 화면 전용이라 정제하면서 지운다. 데이터는 li의 class뿐이고
 * 표시는 편집기(normalize)가 다시 만든다.
 *
 * 정규식으로 HTML을 다루지 않는다. 파싱은 DOMParser가 한다.
 */

const ALLOWED = new Set(['P', 'BR', 'UL', 'OL', 'LI', 'B', 'I', 'U', 'S']);
const RENAME = new Map([
  ['STRONG', 'B'],
  ['EM', 'I'],
  ['STRIKE', 'S'],
  ['DEL', 'S'],
]);
/** 태그도 내용도 버리는 것 */
const DROP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT']);
/** 최상위에 그대로 놓일 수 있는 블록 */
const TOP_BLOCK = new Set(['P', 'UL', 'OL']);

/** 빈 본문. 정제 결과가 비면 항상 이 값이다. */
export const EMPTY_HTML = '<p><br></p>';

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

function parseBody(html: string): HTMLElement {
  return new DOMParser().parseFromString(html, 'text/html').body;
}

function isElement(node: Node, tag: string): boolean {
  return node.nodeType === ELEMENT_NODE && (node as Element).tagName.toUpperCase() === tag;
}

function isBlank(node: Node): boolean {
  return node.nodeType === TEXT_NODE && !(node.nodeValue ?? '').trim();
}

/** li의 class를 "task" / "task done" 둘 중 하나로 정규화한다. 그 밖에는 class 없음. */
function normalizeLiClass(el: Element): string {
  const tokens = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  const done = tokens.includes('done');
  if (tokens.includes('task')) return done ? 'task done' : 'task';
  return done ? 'task done' : '';
}

function cleanChildren(src: Node, doc: Document): Node[] {
  const out: Node[] = [];
  src.childNodes.forEach((child) => cleanNode(child, out, doc));
  return out;
}

function cleanNode(node: Node, out: Node[], doc: Document): void {
  if (node.nodeType === TEXT_NODE) {
    const text = node.nodeValue ?? '';
    if (text) out.push(doc.createTextNode(text));
    return;
  }
  if (node.nodeType !== ELEMENT_NODE) return;

  const el = node as Element;
  const tag = el.tagName.toUpperCase();
  if (DROP.has(tag)) return;
  // 체크박스 표시용 span은 데이터가 아니다.
  if (tag === 'SPAN' && el.classList.contains('cb')) return;

  const mapped = RENAME.get(tag) ?? tag;

  if (mapped === 'DIV') {
    const kids = cleanChildren(el, doc);
    // div 안에 이미 블록이 있으면 그것을 올리고, 없으면 내용을 p로 감싼다.
    if (kids.some((k) => k.nodeType === ELEMENT_NODE && TOP_BLOCK.has((k as Element).tagName))) {
      out.push(...kids);
      return;
    }
    if (!kids.length || kids.every(isBlank)) return;
    const p = doc.createElement('p');
    kids.forEach((k) => p.appendChild(k));
    out.push(p);
    return;
  }

  if (!ALLOWED.has(mapped)) {
    // 그 밖의 요소는 태그만 벗기고 자식은 남긴다.
    out.push(...cleanChildren(el, doc));
    return;
  }

  const made = doc.createElement(mapped.toLowerCase());
  if (mapped === 'BR') {
    out.push(made);
    return;
  }
  if (mapped === 'LI') {
    const cls = normalizeLiClass(el);
    if (cls) made.setAttribute('class', cls);
  }

  const kids = cleanChildren(el, doc);
  if (mapped === 'UL' || mapped === 'OL') {
    // 목록의 직계 자식은 li여야 한다. 떠도는 내용은 li로 감싼다.
    let loose: Node[] = [];
    const flush = (): void => {
      if (!loose.length) return;
      const li = doc.createElement('li');
      loose.forEach((k) => li.appendChild(k));
      made.appendChild(li);
      loose = [];
    };
    for (const kid of kids) {
      if (isElement(kid, 'LI')) {
        flush();
        made.appendChild(kid);
      } else if (isBlank(kid)) {
        continue;
      } else {
        loose.push(kid);
      }
    }
    flush();
  } else {
    kids.forEach((k) => made.appendChild(k));
  }
  out.push(made);
}

/** 허용 태그만 남긴 본문 HTML. 저장·전송 전에 반드시 통과시킨다. */
export function sanitizeHtml(html: string): string {
  const body = parseBody(html);
  const doc = body.ownerDocument;
  const cleaned = cleanChildren(body, doc);

  const root = doc.createElement('div');
  let loose: Node[] = [];
  const flush = (): void => {
    if (!loose.length) return;
    if (loose.every(isBlank)) {
      loose = [];
      return;
    }
    const p = doc.createElement('p');
    loose.forEach((k) => p.appendChild(k));
    root.appendChild(p);
    loose = [];
  };

  for (const node of cleaned) {
    if (node.nodeType === ELEMENT_NODE && TOP_BLOCK.has((node as Element).tagName)) {
      flush();
      root.appendChild(node);
    } else if (isElement(node, 'LI')) {
      // 목록 밖에 떨어진 li는 껍데기를 벗겨 문단으로 흘려보낸다.
      flush();
      loose.push(...Array.from(node.childNodes));
    } else {
      loose.push(node);
    }
  }
  flush();

  return root.innerHTML || EMPTY_HTML;
}

/**
 * 제목·미리보기·검색에 쓰는 평문. 블록(p, li)마다 한 줄, br도 줄바꿈,
 * 연속 공백은 하나로 줄이고 줄마다 trim. li.task는 "[ ] " / "[x] "를 앞에 붙인다.
 * 목록 기호("- ")는 붙이지 않는다 — 마크다운이 아니라 평문이다.
 */
export function toPlainText(html: string): string {
  const body = parseBody(html);
  const lines: string[] = [];
  let cur = '';
  let prefix = '';

  const flush = (): void => {
    const raw = cur;
    const pre = prefix;
    cur = '';
    prefix = '';
    const parts = raw.split('\n').map((s) => s.replace(/\s+/g, ' ').trim());
    // 줄 끝의 <br>이 만든 빈 조각은 버린다.
    while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
    parts.forEach((s, i) => lines.push(i === 0 ? (pre + s).trim() : s));
  };

  const walk = (node: Node): void => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === TEXT_NODE) {
        cur += child.nodeValue ?? '';
        return;
      }
      if (child.nodeType !== ELEMENT_NODE) return;
      const el = child as Element;
      const tag = el.tagName.toUpperCase();
      if (DROP.has(tag)) return;
      if (tag === 'BR') {
        cur += '\n';
        return;
      }
      if (tag === 'UL' || tag === 'OL') {
        if (cur.trim()) flush();
        else {
          cur = '';
          prefix = '';
        }
        walk(el);
        return;
      }
      if (tag === 'P' || tag === 'DIV' || tag === 'LI') {
        if (cur.trim()) flush();
        else {
          cur = '';
          prefix = '';
        }
        if (tag === 'LI' && el.classList.contains('task')) {
          prefix = el.classList.contains('done') ? '[x] ' : '[ ] ';
        }
        const before = lines.length;
        walk(el);
        // 안에서 다른 블록이 줄을 만들었고 남은 글자가 없으면 빈 줄을 더하지 않는다.
        if (cur !== '' || lines.length === before) flush();
        else prefix = '';
        return;
      }
      walk(el);
    });
  };

  walk(body);
  if (cur.trim()) flush();
  return lines.join('\n');
}

/** 첫 비어 있지 않은 줄. 체크박스 접두사는 뗀다. */
export function titleOf(text: string): string {
  for (const line of text.split('\n')) {
    const s = line.replace(/^\[[ xX]\]\s*/, '').trim();
    if (s) return s;
  }
  return '';
}

/** 첫 줄을 뺀 나머지 비어 있지 않은 줄. */
export function previewOf(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.slice(1).join(' · ');
}
