import { defineConfig } from 'vite';

// Tauri 권장 설정. 포트는 5175 고정 — 5173은 storyseed-cloud, 5174는 tarotcap이 strictPort로 쓴다.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 5175,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // Windows는 WebView2(Chromium), macOS는 WebKit(macOS 12+ = Safari 15). safari13은 esbuild 0.28이 구조 분해 변환을 거부한다.
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari15',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
