# memopin (메모핀)

개인용 데스크톱 스티커 메모 앱. 윈도우 스티키 메모의 느낌을 유지하되 동기화 계정 없이 단순하게. Tauri 2 + Vite + vanilla TypeScript, 프레임워크 없음(스토리시드·타로캡과 같은 머리로 작업하기 위해). 만든 사람은 `D:\dev\storyseed-tauri`(서재)와 `D:\dev\tarotcap`의 그 사람이다.

## 설계의 축

1. **메모 하나 = OS 창 하나.** 항상 위 고정을 메모별로 걸어야 해서 큰 투명 창 하나에 그리지 않는다. 창 라벨(`box` / `settings` / `note-<id>`)이 곧 역할이다. URL 쿼리로 구분하지 않는다(서재에서 흰 화면 사고).
2. **Rust가 유일한 저장소.** 메모당 JSON 파일 하나(`notes/<id>.json`) + `categories.json`. 창은 전부 커맨드로 읽고 쓰며 `store:changed` 이벤트로 따라온다. 계약은 `docs/contract.md`가 유일한 원본이다.
3. **동기화는 폴더로.** 저장 폴더를 구글 드라이브·Dropbox 폴더로 바꾸면 그 서비스가 동기화한다. API 연동은 하지 않는다(요청이 들어오면 그때).
4. **본문은 제한된 HTML.** p/br/ul/ol/li/b/i/u/s와 `li.task(.done)`만. 편집기는 `src/editor/`의 직접 만든 contenteditable. 제목은 저장하지 않고 평문 첫 줄에서 파생한다.

## 시각 스펙

`design/mockup.html`이 시안이자 스펙이다. 토큰은 `src/styles/tokens.css`에만 둔다. 메모 창은 메모 색에서 띠·글자색을 밝기로 계산한다. 보라(accent)는 상호작용, 금색(star)은 즐겨찾기뿐.

## 환경

- 개발 포트 **5175** 고정(5173 스토리시드, 5174 타로캡).
- `npm test`는 vitest + jsdom. `execCommand`는 jsdom에 없으니 편집기 테스트는 순수 함수와 DOM 변환에 한정.
- 창 생성은 async 커맨드 + `run_on_main_thread`. 모든 창에 Windows IME 서브클래스 설치. 위치·크기는 논리 픽셀. 이유는 서재 `src-tauri/src/main.rs` 머리 주석.
- 배포: 태그 push → GitHub Actions → Releases + latest.json(서재 방식). 맥은 ad-hoc 서명(개발자 계정 없음).

---

## Task Delegation: Advisor, Worker

메인 오케스트레이터인 너는 Advisor다. 직접 구현하기보다 판단과 통제에 집중하고, 실제 코드 구현은 Worker에게 위임하라.

Advisor: 요구사항·완료 조건 분석, 작업 분해와 설계 결정, 구체적 작업 프롬프트 작성, Worker diff 직접 검토와 테스트 직접 실행, 검증 통과분만 승인.
Worker: 코드·테스트 작성, 반복 구현과 오류 수정, 분리 가능한 조사.

절대 원칙: 의존 없는 작업은 병렬로. 같은 파일·같은 설계 결정은 병렬 금지. Advisor가 아는 것은 프롬프트에 담아 Worker가 재조사하지 않게. **Worker의 완료 보고를 믿지 말고 diff와 테스트 결과만 본다.** 실패하면 원인과 범위를 담아 재위임. 한두 줄은 Advisor가 직접.

## Core Coding Rules

멋대로 가정하지 말고 불명확한 부분과 tradeoff를 구현 전에 드러내라. 요청받지 않은 기능·추상화를 만들지 마라. 요청과 직접 관련된 부분만 고쳐라. 완료 조건을 먼저 정의하고 검증을 통과할 때까지 반복하라.
