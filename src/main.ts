/**
 * 진입점. 창 하나가 index.html 하나를 로드하고, 창 라벨로 무엇을 그릴지 정한다.
 *   box         → 메모함 (src/ui/box.ts)
 *   settings    → 설정 (src/ui/settings.ts)
 *   note-<id>   → 메모 창 (src/ui/note.ts)
 * URL 쿼리로 구분하지 않는 이유: 서재에서 WebviewUrl::App에 쿼리를 붙였다가 흰 화면만 뜬 적이 있다.
 */
import './styles/tokens.css';
import { getCurrentWindow } from '@tauri-apps/api/window';

async function main() {
  const label = getCurrentWindow().label;
  const root = document.getElementById('app')!;
  if (label === 'box') {
    const { mountBox } = await import('./ui/box.ts');
    mountBox(root);
  } else if (label === 'settings') {
    const { mountSettings } = await import('./ui/settings.ts');
    mountSettings(root);
  } else if (label.startsWith('note-')) {
    const { mountNote } = await import('./ui/note.ts');
    mountNote(root, label.slice('note-'.length));
  } else {
    root.textContent = `알 수 없는 창: ${label}`;
  }
}

void main();
