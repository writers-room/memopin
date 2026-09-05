import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 편집기 모듈은 DOM 구조를 만지므로 jsdom. execCommand는 jsdom에 없으니 테스트는
    // 순수 함수(정제, 평문 추출, 자동 서식 감지)와 DOM 변환 결과에 한정한다.
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
  },
});
