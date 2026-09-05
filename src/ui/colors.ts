/**
 * 메모 색. 배경 hex 하나만 저장하고, 띠(bar)와 글자색(ink)은 밝기로 계산한다.
 * 직접 고른 색도 같은 규칙을 타므로 프리셋과 구분할 필요가 없다. 값은 design/mockup.html과 같다.
 */

export const PALETTE: ReadonlyArray<readonly [hex: string, label: string]> = [
  ['#FFF4A3', '노랑'], ['#FFDDB8', '살구'], ['#DDF5B0', '초록'], ['#C6F1E3', '민트'],
  ['#D2E7FF', '파랑'], ['#D6F0FA', '하늘'], ['#E3D6FF', '보라'],
  ['#FFD3DC', '분홍'], ['#F7C4C4', '장미'], ['#EADCF5', '라벤더'], ['#F1E4CF', '모래'],
  ['#EDEDED', '회색'], ['#CFD6E0', '슬레이트'], ['#4A4A4E', '차콜'],
];

export const DEFAULT_COLOR = '#FFF4A3';

function hexToRgb(hex: string): [number, number, number] {
  const h = /^#?([0-9a-f]{6})$/i.exec(hex.trim())?.[1] ?? 'fff4a3';
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex(rgb: readonly number[]): string {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

function luminance([r, g, b]: [number, number, number]): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export interface NoteShades {
  bg: string;
  bar: string;
  ink: string;
  /** 밝은 배경이면 true. 어두운 배경(차콜)은 false. */
  light: boolean;
}

export function shades(bg: string): NoteShades {
  const rgb = hexToRgb(bg);
  const light = luminance(rgb) > 0.45;
  return {
    bg: rgbToHex(rgb),
    bar: rgbToHex(rgb.map((v) => v * (light ? 0.9 : 0.76))),
    ink: light ? rgbToHex(rgb.map((v) => v * 0.18)) : '#F2F2F2',
    light,
  };
}

/** 엘리먼트에 --n-bg / --n-bar / --n-ink 를 건다. 메모 창 루트와 메모함 편집 칸이 쓴다. */
export function applyNoteColor(el: HTMLElement, bg: string): NoteShades {
  const s = shades(bg);
  el.style.setProperty('--n-bg', s.bg);
  el.style.setProperty('--n-bar', s.bar);
  el.style.setProperty('--n-ink', s.ink);
  // 스크롤바 엄지도 메모 밝기에 맞춘다(tokens.css의 ::-webkit-scrollbar-thumb가 이 토큰을 쓴다).
  el.style.setProperty('--scroll-thumb', s.light ? 'rgba(0, 0, 0, .16)' : 'rgba(255, 255, 255, .2)');
  el.style.setProperty('--scroll-thumb-hover', s.light ? 'rgba(0, 0, 0, .3)' : 'rgba(255, 255, 255, .34)');
  return s;
}

export function isValidHex(hex: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(hex);
}
