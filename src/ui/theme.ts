/**
 * 메모함·설정 창의 테마. 메모 창은 메모 색이 곧 테마라 여기를 쓰지 않는다.
 *
 * 정한 결과('dark' | 'light')를 localStorage에 남기는 이유는 index.html의 인라인 스크립트가
 * 첫 페인트 전에 그것을 읽기 때문이다. 그래서 창을 다시 열어도 흰 화면이 번쩍이지 않는다.
 * 'system'이면 matchMedia를 계속 듣는다 — OS 테마가 바뀌면 창도 따라간다.
 */
import type { Theme } from '../types.ts';

export const THEME_KEY = 'memopin.theme';

type Resolved = 'light' | 'dark';

export function resolveTheme(theme: Theme, prefersDark: boolean): Resolved {
  if (theme === 'dark') return 'dark';
  if (theme === 'light') return 'light';
  return prefersDark ? 'dark' : 'light';
}

function darkQuery(): MediaQueryList | null {
  if (typeof window.matchMedia !== 'function') return null;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)');
  } catch {
    return null;
  }
}

function paint(resolved: Resolved): void {
  document.documentElement.dataset['theme'] = resolved;
  try {
    localStorage.setItem(THEME_KEY, resolved);
  } catch {
    /* 저장이 막혀 있어도 화면은 이미 맞다 */
  }
}

let mql: MediaQueryList | null = null;
let listener: ((e: MediaQueryListEvent) => void) | null = null;

function unlisten(): void {
  if (mql && listener) {
    if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', listener);
    else if (typeof mql.removeListener === 'function') mql.removeListener(listener);
  }
  mql = null;
  listener = null;
}

/** 테마를 적용한다. 여러 번 불러도 되고, 'system'일 때만 OS 변경을 따라간다. */
export function applyTheme(theme: Theme): void {
  unlisten();
  const q = darkQuery();
  paint(resolveTheme(theme, q?.matches ?? false));
  if (theme !== 'system' || !q) return;
  mql = q;
  listener = (e: MediaQueryListEvent) => paint(e.matches ? 'dark' : 'light');
  if (typeof q.addEventListener === 'function') q.addEventListener('change', listener);
  else if (typeof q.addListener === 'function') q.addListener(listener);
}
