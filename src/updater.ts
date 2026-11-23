/**
 * 켤 때 자동 업데이트. 새 버전이 있으면 묻지 않고 내려받아 설치하고 다시 띄운다(사용자 결정 2026-11-23).
 * 실패(오프라인, 서버 문제)는 조용히 넘긴다. 설정의 '업데이트 확인' 버튼은 그대로 남아 있다.
 */
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export async function autoUpdate(): Promise<void> {
  try {
    const update = await check();
    if (!update) return;
    await update.downloadAndInstall();
    await relaunch();
  } catch (e) {
    console.error('자동 업데이트를 하지 못했습니다:', e);
  }
}
