/**
 * 이미지 메모를 만들기 전에 자르는 화면. 메모함 편집 칸 자리에 오버레이로 뜬다.
 *
 * 좌표가 둘이라는 것만 기억하면 된다.
 *  1. **액자 좌표** — 화면에 보이는 이미지 상자(`.crop-frame`) 안쪽. 선택 영역과 손잡이 드래그는
 *     전부 여기서 계산한다(순수 함수 `clampCrop` / `dragCrop`. 테스트가 여기를 본다).
 *  2. **원본 픽셀** — canvas로 잘라 낼 때만 쓴다. `toSource`가 액자 좌표를 원본으로 옮긴다.
 *
 * 원본은 남기지 않는다(계약: 자른 결과만 저장). 긴 변이 4000px를 넘으면 줄여서 저장한다 —
 * 메모 창에 띄우려고 만드는 그림이라 그 이상은 파일만 무겁다.
 */
import './cropper.css';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

/** 모서리 넷·변 넷과 안쪽 옮기기. */
export type CropHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

/** 선택 영역의 가장 짧은 변(액자 좌표). 이보다 작게는 줄지 않는다. */
export const MIN_CROP = 16;
/** 저장할 그림의 긴 변 한계. */
export const MAX_SAVE = 4000;

const HANDLES: readonly CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

// ── 순수 계산 ───────────────────────────────────────────────────────────────

/** `contain`으로 상자에 넣었을 때의 크기. 상자가 0이면 0을 돌려준다. */
export function fitBox(w: number, h: number, boxW: number, boxH: number): Size {
  if (w <= 0 || h <= 0 || boxW <= 0 || boxH <= 0) return { w: 0, h: 0 };
  const k = Math.min(boxW / w, boxH / h);
  return { w: w * k, h: h * k };
}

/** 선택 영역을 액자 안으로 가둔다. 변은 `min`보다 짧아지지 않는다(액자가 더 좁으면 액자까지). */
export function clampCrop(rect: Rect, bounds: Size, min = MIN_CROP): Rect {
  const bw = Math.max(0, bounds.w);
  const bh = Math.max(0, bounds.h);
  const minW = Math.min(min, bw);
  const minH = Math.min(min, bh);
  const w = Math.min(Math.max(rect.w, minW), bw);
  const h = Math.min(Math.max(rect.h, minH), bh);
  const x = Math.min(Math.max(rect.x, 0), bw - w);
  const y = Math.min(Math.max(rect.y, 0), bh - h);
  return { x, y, w, h };
}

/**
 * 손잡이를 (dx, dy)만큼 끌었을 때의 새 선택 영역.
 * `start`는 드래그를 시작할 때의 사각형이다(누적하지 않는다 — 반올림 오차가 쌓이지 않게).
 */
export function dragCrop(
  start: Rect,
  handle: CropHandle,
  dx: number,
  dy: number,
  bounds: Size,
  min = MIN_CROP,
): Rect {
  if (handle === 'move') {
    return clampCrop({ x: start.x + dx, y: start.y + dy, w: start.w, h: start.h }, bounds, min);
  }
  const bw = Math.max(0, bounds.w);
  const bh = Math.max(0, bounds.h);
  const minW = Math.min(min, bw);
  const minH = Math.min(min, bh);

  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;

  if (handle.includes('w')) left = Math.min(Math.max(left + dx, 0), right - minW);
  if (handle.includes('e')) right = Math.max(Math.min(right + dx, bw), left + minW);
  if (handle.includes('n')) top = Math.min(Math.max(top + dy, 0), bottom - minH);
  if (handle.includes('s')) bottom = Math.max(Math.min(bottom + dy, bh), top + minH);

  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** 액자 좌표의 선택 영역을 원본 픽셀로 옮긴다. 원본 밖으로는 나가지 않는다. */
export function toSource(rect: Rect, frame: Size, source: Size): Rect {
  const kx = frame.w > 0 ? source.w / frame.w : 1;
  const ky = frame.h > 0 ? source.h / frame.h : 1;
  const x = Math.min(Math.max(Math.round(rect.x * kx), 0), Math.max(0, source.w - 1));
  const y = Math.min(Math.max(Math.round(rect.y * ky), 0), Math.max(0, source.h - 1));
  const w = Math.max(1, Math.min(Math.round(rect.w * kx), source.w - x));
  const h = Math.max(1, Math.min(Math.round(rect.h * ky), source.h - y));
  return { x, y, w, h };
}

/** 저장할 크기. 긴 변이 `max`를 넘으면 비율을 지키며 줄인다. */
export function saveSize(w: number, h: number, max = MAX_SAVE): Size {
  const long = Math.max(w, h);
  if (long <= 0) return { w: 1, h: 1 };
  const k = long > max ? max / long : 1;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

// ── 화면 ────────────────────────────────────────────────────────────────────

/** `create_image_note`에 그대로 넘길 수 있는 모양. */
export interface CropDone {
  png_base64: string;
  name: string;
  w: number;
  h: number;
}

export interface CropperOptions {
  /** 원본 그림(data URL). 파일에서 읽었거나 붙여넣은 것. */
  dataUrl: string;
  /** 메모 제목이 될 이름. */
  name: string;
  onCancel: () => void;
  onDone: (result: CropDone) => void;
  onError: (message: string) => void;
}

export interface CropperHandle {
  el: HTMLElement;
  destroy: () => void;
}

export function createCropper(opts: CropperOptions): CropperHandle {
  const el = document.createElement('div');
  el.className = 'cropper';
  el.innerHTML =
    '<div class="crop-stage"><div class="crop-frame">' +
    '<img class="crop-img" alt="" draggable="false">' +
    `<div class="crop-sel">${HANDLES.map((h) => `<span class="crop-h ${h}" data-h="${h}"></span>`).join('')}</div>` +
    '</div></div>' +
    '<div class="crop-foot"><div class="crop-name"></div><div class="crop-acts">' +
    '<button class="btn ghost crop-full" type="button">자르지 않고 그대로</button>' +
    '<button class="btn ghost crop-cancel" type="button">취소</button>' +
    '<button class="btn crop-make" type="button">만들기</button>' +
    '</div></div>';

  const stage = el.querySelector<HTMLElement>('.crop-stage')!;
  const frameEl = el.querySelector<HTMLElement>('.crop-frame')!;
  const img = el.querySelector<HTMLImageElement>('.crop-img')!;
  const selEl = el.querySelector<HTMLElement>('.crop-sel')!;
  el.querySelector<HTMLElement>('.crop-name')!.textContent = opts.name;

  /** 액자(= 화면에 보이는 그림)의 크기. 창 크기에 따라 달라진다. */
  let frame: Size = { w: 0, h: 0 };
  let sel: Rect = { x: 0, y: 0, w: 0, h: 0 };

  function renderSel(): void {
    selEl.style.left = `${sel.x}px`;
    selEl.style.top = `${sel.y}px`;
    selEl.style.width = `${sel.w}px`;
    selEl.style.height = `${sel.h}px`;
  }

  /** 액자를 편집 칸 크기에 맞춰 다시 재고, 선택 영역은 비율을 지켜 따라가게 한다. */
  function layout(): void {
    const box = stage.getBoundingClientRect();
    const next = fitBox(img.naturalWidth, img.naturalHeight, box.width, box.height);
    const prev = frame;
    frame = next;
    frameEl.style.width = `${next.w}px`;
    frameEl.style.height = `${next.h}px`;
    if (prev.w > 0 && prev.h > 0 && sel.w > 0) {
      const kx = next.w / prev.w;
      const ky = next.h / prev.h;
      sel = clampCrop({ x: sel.x * kx, y: sel.y * ky, w: sel.w * kx, h: sel.h * ky }, frame);
    } else {
      sel = { x: 0, y: 0, w: next.w, h: next.h };
    }
    renderSel();
  }

  const onLoad = (): void => layout();
  const onImgError = (): void => opts.onError('이미지를 읽지 못했습니다.');
  const onWinResize = (): void => layout();

  img.addEventListener('load', onLoad);
  img.addEventListener('error', onImgError);
  window.addEventListener('resize', onWinResize);
  img.src = opts.dataUrl;

  // ── 드래그 ──
  // pointer capture로 잡아 두면 커서가 액자 밖으로 나가도 계속 따라온다.
  let drag: { handle: CropHandle; x: number; y: number; start: Rect } | null = null;

  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    const handleEl = e.target.closest<HTMLElement>('.crop-h');
    const inside = e.target.closest('.crop-sel');
    if (!handleEl && !inside) return;
    const handle = (handleEl?.dataset['h'] as CropHandle | undefined) ?? 'move';
    e.preventDefault();
    drag = { handle, x: e.clientX, y: e.clientY, start: { ...sel } };
    selEl.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: PointerEvent): void => {
    if (!drag) return;
    e.preventDefault();
    sel = dragCrop(drag.start, drag.handle, e.clientX - drag.x, e.clientY - drag.y, frame);
    renderSel();
  };
  const onUp = (e: PointerEvent): void => {
    if (!drag) return;
    drag = null;
    selEl.releasePointerCapture?.(e.pointerId);
  };

  selEl.addEventListener('pointerdown', onDown);
  selEl.addEventListener('pointermove', onMove);
  selEl.addEventListener('pointerup', onUp);
  selEl.addEventListener('pointercancel', onUp);

  // ── 버튼 ──
  function make(full: boolean): void {
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (!nw || !nh) {
      opts.onError('이미지를 읽지 못했습니다.');
      return;
    }
    const source: Size = { w: nw, h: nh };
    const src = full ? { x: 0, y: 0, w: nw, h: nh } : toSource(sel, frame, source);
    const out = saveSize(src.w, src.h);
    const canvas = document.createElement('canvas');
    canvas.width = out.w;
    canvas.height = out.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      opts.onError('이미지를 자를 수 없습니다.');
      return;
    }
    ctx.drawImage(img, src.x, src.y, src.w, src.h, 0, 0, out.w, out.h);
    const url = canvas.toDataURL('image/png');
    const comma = url.indexOf(',');
    if (comma < 0) {
      opts.onError('이미지를 자를 수 없습니다.');
      return;
    }
    opts.onDone({ png_base64: url.slice(comma + 1), name: opts.name, w: out.w, h: out.h });
  }

  el.querySelector<HTMLButtonElement>('.crop-full')!.addEventListener('click', () => make(true));
  el.querySelector<HTMLButtonElement>('.crop-make')!.addEventListener('click', () => make(false));
  el.querySelector<HTMLButtonElement>('.crop-cancel')!.addEventListener('click', () => opts.onCancel());

  return {
    el,
    destroy(): void {
      img.removeEventListener('load', onLoad);
      img.removeEventListener('error', onImgError);
      window.removeEventListener('resize', onWinResize);
      selEl.removeEventListener('pointerdown', onDown);
      selEl.removeEventListener('pointermove', onMove);
      selEl.removeEventListener('pointerup', onUp);
      selEl.removeEventListener('pointercancel', onUp);
      el.remove();
    },
  };
}
