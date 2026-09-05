import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_HTML,
  previewOf,
  sanitizeHtml,
  titleOf,
  toPlainText,
} from '../src/editor/sanitize.ts';
import { createEditor, detectTrigger, normalize } from '../src/editor/editor.ts';
import { attachFormatToolbar } from '../src/editor/toolbar.ts';

/** 시안(design/mockup.html)의 샘플 메모. 기대값을 여기에 고정한다. */
const NOTE_PLOT =
  '<p>회귀 재벌물 3화 수정</p><ul><li>도입부 회상 장면 반 페이지로 줄이기</li>' +
  '<li>강태준 첫 대사 <b>더 차갑게</b></li><li>마지막 컷 <u>그 서류</u> 복선 다시 심기</li></ul>' +
  '<p>편집자 피드백: 2화 끝 클리프 약함</p>';
const NOTE_TASKS =
  '<p>텀블벅 리워드 발송</p><ul>' +
  '<li class="task"><span class="cb" contenteditable="false"></span>후원자 명단 엑셀 정리</li>' +
  '<li class="task"><span class="cb" contenteditable="false"></span>코드 16자 생성해서 메일 발송</li>' +
  '<li class="task done"><span class="cb" contenteditable="false"></span>리워드 안내 이미지</li></ul>';
const NOTE_CHARS =
  '<p>BL 신작 인물 메모</p><p><b>서윤재</b> — 소리에 예민, 비 오는 날 못 견딤</p>' +
  '<p><s>둘의 첫 만남은 장례식장</s> → 도서관으로 바꿈</p>';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('sanitizeHtml', () => {
  it('허용 밖 태그는 벗기고 자식은 남긴다', () => {
    expect(sanitizeHtml('<p>안녕 <span style="color:red">빨강</span>!</p>')).toBe('<p>안녕 빨강!</p>');
    expect(sanitizeHtml('<p><a href="https://x.test">링크</a></p>')).toBe('<p>링크</p>');
    expect(sanitizeHtml('<h1>제목</h1>')).toBe('<p>제목</p>');
  });

  it('속성은 전부 지우고 li의 class만 정규화해 남긴다', () => {
    expect(sanitizeHtml('<p class="x" data-id="3" style="font-size:40px">글</p>')).toBe('<p>글</p>');
    expect(sanitizeHtml('<ul><li class="task">할 일</li></ul>')).toBe(
      '<ul><li class="task">할 일</li></ul>',
    );
    expect(sanitizeHtml('<ul><li class="done">끝</li></ul>')).toBe(
      '<ul><li class="task done">끝</li></ul>',
    );
    expect(sanitizeHtml('<ul><li class="task done extra">끝</li></ul>')).toBe(
      '<ul><li class="task done">끝</li></ul>',
    );
    expect(sanitizeHtml('<ul><li class="foo">그냥</li></ul>')).toBe('<ul><li>그냥</li></ul>');
  });

  it('strong/em/strike/del을 b/i/s로 바꾼다', () => {
    expect(sanitizeHtml('<p><strong>굵게</strong><em>기울임</em></p>')).toBe(
      '<p><b>굵게</b><i>기울임</i></p>',
    );
    expect(sanitizeHtml('<p><strike>가</strike><del>나</del></p>')).toBe('<p><s>가</s><s>나</s></p>');
  });

  it('체크박스 표시 span은 저장본에서 뺀다', () => {
    expect(sanitizeHtml(NOTE_TASKS)).toBe(
      '<p>텀블벅 리워드 발송</p><ul><li class="task">후원자 명단 엑셀 정리</li>' +
        '<li class="task">코드 16자 생성해서 메일 발송</li>' +
        '<li class="task done">리워드 안내 이미지</li></ul>',
    );
  });

  it('div는 문단이 되고 최상위 텍스트는 p로 감싼다', () => {
    expect(sanitizeHtml('<div>가</div><div>나</div>')).toBe('<p>가</p><p>나</p>');
    expect(sanitizeHtml('<div><br></div>')).toBe('<p><br></p>');
    expect(sanitizeHtml('맨 텍스트')).toBe('<p>맨 텍스트</p>');
    expect(sanitizeHtml('<b>굵은</b> 시작')).toBe('<p><b>굵은</b> 시작</p>');
    expect(sanitizeHtml('<div><p>안</p></div>')).toBe('<p>안</p>');
  });

  it('script와 style은 내용까지 버린다', () => {
    expect(sanitizeHtml('<p>가</p><script>alert(1)</script>')).toBe('<p>가</p>');
    expect(sanitizeHtml('<style>p{color:red}</style><p>나</p>')).toBe('<p>나</p>');
    expect(sanitizeHtml('<script>alert(1)</script>')).toBe(EMPTY_HTML);
  });

  it('빈 입력은 빈 문단 하나', () => {
    expect(sanitizeHtml('')).toBe(EMPTY_HTML);
    expect(sanitizeHtml('   ')).toBe(EMPTY_HTML);
    expect(sanitizeHtml('<span></span>')).toBe(EMPTY_HTML);
    expect(sanitizeHtml(EMPTY_HTML)).toBe(EMPTY_HTML);
  });

  it('이미 정제된 것은 그대로다 (멱등)', () => {
    for (const html of [NOTE_PLOT, NOTE_CHARS, sanitizeHtml(NOTE_TASKS)]) {
      expect(sanitizeHtml(html)).toBe(html);
      expect(sanitizeHtml(sanitizeHtml(html))).toBe(sanitizeHtml(html));
    }
  });

  it('목록 밖으로 새어 나온 내용을 감싼다', () => {
    expect(sanitizeHtml('<ul>떠도는 글<li>항목</li></ul>')).toBe(
      '<ul><li>떠도는 글</li><li>항목</li></ul>',
    );
    expect(sanitizeHtml('<li>홀로 남은 항목</li>')).toBe('<p>홀로 남은 항목</p>');
  });

  it('중첩 목록과 서식은 살린다', () => {
    const html = '<ul><li>가<ul><li><b>나</b></li></ul></li></ul>';
    expect(sanitizeHtml(html)).toBe(html);
  });
});

describe('toPlainText', () => {
  it('블록마다 한 줄', () => {
    expect(toPlainText(NOTE_PLOT)).toBe(
      [
        '회귀 재벌물 3화 수정',
        '도입부 회상 장면 반 페이지로 줄이기',
        '강태준 첫 대사 더 차갑게',
        '마지막 컷 그 서류 복선 다시 심기',
        '편집자 피드백: 2화 끝 클리프 약함',
      ].join('\n'),
    );
  });

  it('체크박스 항목에는 접두사를 붙이고 목록 기호는 붙이지 않는다', () => {
    expect(toPlainText(NOTE_TASKS)).toBe(
      [
        '텀블벅 리워드 발송',
        '[ ] 후원자 명단 엑셀 정리',
        '[ ] 코드 16자 생성해서 메일 발송',
        '[x] 리워드 안내 이미지',
      ].join('\n'),
    );
  });

  it('br은 줄바꿈, 연속 공백은 하나, 줄마다 trim', () => {
    expect(toPlainText('<p>  가   나  <br>  다  </p>')).toBe('가 나\n다');
    expect(toPlainText('<p>한 줄<br></p>')).toBe('한 줄');
  });

  it('빈 메모는 빈 문자열', () => {
    expect(toPlainText(EMPTY_HTML)).toBe('');
    expect(toPlainText('')).toBe('');
  });

  it('서식 태그는 글자만 남는다', () => {
    expect(toPlainText(NOTE_CHARS)).toBe(
      ['BL 신작 인물 메모', '서윤재 — 소리에 예민, 비 오는 날 못 견딤', '둘의 첫 만남은 장례식장 → 도서관으로 바꿈'].join(
        '\n',
      ),
    );
  });
});

describe('titleOf / previewOf', () => {
  it('첫 줄이 제목, 나머지가 미리보기', () => {
    const text = toPlainText(NOTE_PLOT);
    expect(titleOf(text)).toBe('회귀 재벌물 3화 수정');
    expect(previewOf(text)).toBe(
      '도입부 회상 장면 반 페이지로 줄이기 · 강태준 첫 대사 더 차갑게 · 마지막 컷 그 서류 복선 다시 심기 · 편집자 피드백: 2화 끝 클리프 약함',
    );
  });

  it('굵은 글자가 섞인 첫 줄도 평문으로 뽑는다', () => {
    const text = toPlainText(NOTE_CHARS);
    expect(titleOf(text)).toBe('BL 신작 인물 메모');
    expect(previewOf(text)).toBe(
      '서윤재 — 소리에 예민, 비 오는 날 못 견딤 · 둘의 첫 만남은 장례식장 → 도서관으로 바꿈',
    );
  });

  it('체크박스 접두사는 제목에서 뗀다', () => {
    const text = toPlainText(
      '<ul><li class="task done">손목 스트레칭</li><li class="task">안과 예약 전화</li></ul>',
    );
    expect(titleOf(text)).toBe('손목 스트레칭');
    expect(previewOf(text)).toBe('[ ] 안과 예약 전화');
  });

  it('빈 메모는 제목도 미리보기도 없다', () => {
    const text = toPlainText(EMPTY_HTML);
    expect(titleOf(text)).toBe('');
    expect(previewOf(text)).toBe('');
  });

  it('앞의 빈 줄은 건너뛴다', () => {
    const text = toPlainText('<p><br></p><p>진짜 제목</p><p><br></p><p>본문</p>');
    expect(titleOf(text)).toBe('진짜 제목');
    expect(previewOf(text)).toBe('본문');
  });
});

describe('detectTrigger', () => {
  it('줄 첫머리의 트리거를 알아본다', () => {
    expect(detectTrigger('- 할 일')).toEqual({ kind: 'ul', len: 2 });
    expect(detectTrigger('* 할 일')).toEqual({ kind: 'ul', len: 2 });
    expect(detectTrigger('1. 첫째')).toEqual({ kind: 'ol', len: 3 });
    expect(detectTrigger('[] 사기')).toEqual({ kind: 'task', len: 3 });
    expect(detectTrigger('[ ] 사기')).toEqual({ kind: 'task', len: 4 });
  });

  it('그 밖에는 null', () => {
    expect(detectTrigger('')).toBeNull();
    expect(detectTrigger('-없는 공백')).toBeNull();
    expect(detectTrigger('가 - 나')).toBeNull();
    expect(detectTrigger('2. 둘째')).toBeNull();
    expect(detectTrigger('[x] 이미 체크')).toBeNull();
  });
});

describe('createEditor', () => {
  it('편집기 루트를 만든다', () => {
    const ed = createEditor();
    expect(ed.el.className).toBe('editor');
    expect(ed.el.getAttribute('contenteditable')).toBe('true');
    expect(ed.el.dataset['ph']).toBe('메모를 적으세요. 첫 줄이 제목이 됩니다.');
    const custom = createEditor({ placeholder: '여기에' });
    expect(custom.el.dataset['ph']).toBe('여기에');
  });

  it('setHtml은 정제하고 getHtml은 저장본을 돌려준다', () => {
    const ed = createEditor();
    document.body.appendChild(ed.el);
    expect(ed.setHtml('<p class="x">가<script>bad()</script></p><div>나</div>')).toBe(true);
    expect(ed.getHtml()).toBe('<p>가</p><p>나</p>');
  });

  it('setHtml이 li.task에 체크박스를 붙이지만 저장본에는 없다', () => {
    const ed = createEditor();
    document.body.appendChild(ed.el);
    ed.setHtml(sanitizeHtml(NOTE_TASKS));
    const items = ed.el.querySelectorAll('li.task');
    expect(items.length).toBe(3);
    items.forEach((li) => {
      const cb = li.firstElementChild;
      expect(cb?.className).toBe('cb');
      expect(cb?.getAttribute('contenteditable')).toBe('false');
    });
    // 불러오기가 완료 표시를 지우지 않는다.
    expect(ed.el.querySelectorAll('li.task.done').length).toBe(1);
    expect(ed.getHtml()).toBe(sanitizeHtml(NOTE_TASKS));
    expect(ed.getHtml()).not.toContain('cb');
  });

  it('normalize는 체크박스를 하나만, 맨 앞에 둔다', () => {
    const host = document.createElement('div');
    host.innerHTML =
      '<ul><li class="task"><span class="cb"></span>둘<span class="cb"></span></li>' +
      '<li>일반<span class="cb"></span></li></ul>';
    document.body.appendChild(host);
    normalize(host);
    const first = host.querySelector('li.task');
    expect(first?.querySelectorAll('.cb').length).toBe(1);
    expect(first?.firstElementChild?.className).toBe('cb');
    expect(host.querySelectorAll('li:not(.task) .cb').length).toBe(0);
  });

  it('체크박스를 누르면 done이 토글되고 onChange가 온다', () => {
    const onChange = vi.fn();
    const ed = createEditor({ onChange });
    document.body.appendChild(ed.el);
    ed.setHtml('<ul><li class="task">안과 예약 전화</li></ul>');
    const cb = ed.el.querySelector<HTMLElement>('.cb');
    expect(cb).not.toBeNull();
    cb?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(ed.el.querySelector('li')?.className).toBe('task done');
    expect(onChange).toHaveBeenCalledWith(
      '<ul><li class="task done">안과 예약 전화</li></ul>',
      '[x] 안과 예약 전화',
    );
    cb?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(ed.el.querySelector('li')?.className).toBe('task');
  });

  it('빈 본문이면 placeholder가 보이도록 비워 둔다', () => {
    const ed = createEditor();
    document.body.appendChild(ed.el);
    ed.setHtml('');
    expect(ed.el.innerHTML).toBe('');
    expect(ed.getHtml()).toBe(EMPTY_HTML);
  });

  it('setFontSize는 --fs를 세운다', () => {
    const ed = createEditor();
    ed.setFontSize(18);
    expect(ed.el.style.getPropertyValue('--fs')).toBe('18px');
  });

  it('Ctrl+휠은 기본 동작을 막고 델타를 알린다', () => {
    const onFontSizeDelta = vi.fn();
    const ed = createEditor({ onFontSizeDelta });
    document.body.appendChild(ed.el);
    const up = new WheelEvent('wheel', { deltaY: -1, ctrlKey: true, cancelable: true, bubbles: true });
    ed.el.dispatchEvent(up);
    expect(up.defaultPrevented).toBe(true);
    expect(onFontSizeDelta).toHaveBeenLastCalledWith(1);
    ed.el.dispatchEvent(new WheelEvent('wheel', { deltaY: 3, ctrlKey: true, cancelable: true }));
    expect(onFontSizeDelta).toHaveBeenLastCalledWith(-1);
    // Ctrl 없이는 손대지 않는다.
    const plain = new WheelEvent('wheel', { deltaY: 3, cancelable: true });
    ed.el.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    expect(onFontSizeDelta).toHaveBeenCalledTimes(2);
  });

  it('포커스가 안에 있으면 setHtml은 덮어쓰지 않는다', () => {
    const ed = createEditor();
    document.body.appendChild(ed.el);
    ed.setHtml('<p>편집 중</p>');
    // jsdom은 contenteditable div에 포커스를 주지 못하므로 activeElement를 흉내 낸다.
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement');
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => ed.el });
    // 창이 OS 포커스를 잃으면 activeElement가 남아 있어도 편집 중이 아니다(다른 창의 변경을 받아야 한다).
    const hasFocus = vi.spyOn(document, 'hasFocus');
    try {
      hasFocus.mockReturnValue(true);
      expect(ed.setHtml('<p>바깥에서 온 값</p>')).toBe(false);
      expect(ed.el.innerHTML).toBe('<p>편집 중</p>');
      hasFocus.mockReturnValue(false);
      expect(ed.setHtml('<p>바깥에서 온 값</p>')).toBe(true);
      expect(ed.el.innerHTML).toBe('<p>바깥에서 온 값</p>');
    } finally {
      hasFocus.mockRestore();
      delete (document as unknown as Record<string, unknown>)['activeElement'];
      expect(desc).toBeDefined();
      expect(document.activeElement).toBe(document.body);
    }
    expect(ed.setHtml('<p>이제 된다</p>')).toBe(true);
    expect(ed.el.innerHTML).toBe('<p>이제 된다</p>');
  });

  it('Tab은 포커스를 넘기지 않는다', () => {
    const ed = createEditor();
    document.body.appendChild(ed.el);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true });
    ed.el.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
  });

  it('destroy는 엘리먼트를 떼고 이벤트를 끊는다', () => {
    const onFontSizeDelta = vi.fn();
    const ed = createEditor({ onFontSizeDelta });
    document.body.appendChild(ed.el);
    const el = ed.el;
    ed.destroy();
    expect(el.isConnected).toBe(false);
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, ctrlKey: true, cancelable: true }));
    expect(onFontSizeDelta).not.toHaveBeenCalled();
  });
});

describe('attachFormatToolbar', () => {
  it('문서에 위젯 하나를 감춘 채로 붙이고 destroy로 걷는다', () => {
    const ed = createEditor();
    document.body.appendChild(ed.el);
    const a = attachFormatToolbar(() => [ed.el]);
    const fmt = document.querySelector<HTMLElement>('.fmt');
    expect(fmt).not.toBeNull();
    expect(fmt?.hidden).toBe(true);
    expect(fmt?.querySelectorAll('button').length).toBe(5);

    // 두 번 붙여도 위젯은 하나뿐이고, 마지막 하나가 사라질 때만 걷힌다.
    const b = attachFormatToolbar(() => [ed.el]);
    expect(document.querySelectorAll('.fmt').length).toBe(1);
    a.destroy();
    expect(document.querySelectorAll('.fmt').length).toBe(1);
    b.destroy();
    expect(document.querySelectorAll('.fmt').length).toBe(0);
  });
});

// ── 자동 서식: nbsp와 DOM 직접 변환 ────────────────────────────────────────
// contenteditable은 줄 끝 공백을 U+00A0으로 넣는다. 실제 앱에서 "- f"가 "irst item"+"f"로
// 갈라진 사고의 원인이었다(공백 시점에 안 걸리고 다음 글자에서 걸리며 캐럿이 앞에 놓임).
import { convertBlockToListItem, convertListItemToBlock } from '../src/editor/editor.ts';

describe('autoformat: nbsp와 목록 변환', () => {
  it('detectTrigger는 nbsp를 공백으로 본다', () => {
    expect(detectTrigger('- ')).toEqual({ kind: 'ul', len: 2 });
    expect(detectTrigger('1. ')).toEqual({ kind: 'ol', len: 3 });
    expect(detectTrigger('[] ')).toEqual({ kind: 'task', len: 3 });
    expect(detectTrigger('-x')).toBeNull();
  });

  it('빈 문단을 ul>li로 바꾸고 br을 남긴다', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>a</p><p></p>';
    const li = convertBlockToListItem(root.children[1] as HTMLElement, 'ul');
    expect(root.innerHTML).toBe('<p>a</p><ul><li><br></li></ul>');
    expect(li.parentElement?.tagName).toBe('UL');
  });

  it('바로 앞이 같은 종류의 목록이면 이어 붙이고, 다르면 새 목록', () => {
    const root = document.createElement('div');
    root.innerHTML = '<ul><li>x</li></ul><p>y</p><ol><li>n</li></ol><p>z</p>';
    convertBlockToListItem(root.children[1] as HTMLElement, 'ul');
    expect(root.innerHTML).toBe('<ul><li>x</li><li>y</li></ul><ol><li>n</li></ol><p>z</p>');
    convertBlockToListItem(root.children[2] as HTMLElement, 'ul');
    expect(root.innerHTML).toBe('<ul><li>x</li><li>y</li></ul><ol><li>n</li></ol><ul><li>z</li></ul>');
  });

  it('task는 li.task가 되고 인라인 서식은 그대로 옮겨진다', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p><b>bold</b> rest</p>';
    const li = convertBlockToListItem(root.children[0] as HTMLElement, 'task');
    expect(li.className).toBe('task');
    expect(root.innerHTML).toBe('<ul><li class="task"><b>bold</b> rest</li></ul>');
  });
});

describe('convertListItemToBlock: 빈 체크박스에서 Enter·Backspace', () => {
  // 실제 앱에서 "[] " 뒤 Backspace를 누르면 체크박스가 동그라미 글머리로 변하던 버그.
  // execCommand('outdent')가 li를 그대로 두고 class만 지웠기 때문이라 DOM으로 직접 뺀다.
  const mk = (html: string) => { const r = document.createElement('div'); r.innerHTML = html; return r; };

  it('유일한 항목이면 목록이 통째로 문단이 되고 체크박스 표시는 버린다', () => {
    const r = mk('<p>a</p><ul><li class="task"><span class="cb" contenteditable="false"></span><br></li></ul>');
    const p = convertListItemToBlock(r.querySelector('li')!);
    expect(r.innerHTML).toBe('<p>a</p><p><br></p>');
    expect(p.tagName).toBe('P');
  });

  it('마지막 항목이면 목록 뒤에, 첫 항목이면 목록 앞에 문단을 둔다', () => {
    const r1 = mk('<ul><li>x</li><li class="task"><span class="cb"></span>y</li></ul>');
    convertListItemToBlock(r1.querySelectorAll('li')[1] as HTMLElement);
    expect(r1.innerHTML).toBe('<ul><li>x</li></ul><p>y</p>');
    const r2 = mk('<ul><li class="task">y</li><li>x</li></ul>');
    convertListItemToBlock(r2.querySelector('li')!);
    expect(r2.innerHTML).toBe('<p>y</p><ul><li>x</li></ul>');
  });

  it('가운데 항목이면 목록을 둘로 가른다', () => {
    const r = mk('<ol><li>1</li><li class="task">m</li><li>3</li></ol>');
    convertListItemToBlock(r.querySelectorAll('li')[1] as HTMLElement);
    expect(r.innerHTML).toBe('<ol><li>1</li></ol><p>m</p><ol><li>3</li></ol>');
  });
});
