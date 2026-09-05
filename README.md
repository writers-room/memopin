# 메모핀

바탕화면에 붙여 두는 개인용 스티커 메모 앱. Tauri 2 + Vite + vanilla TypeScript로 만들었고 프레임워크는 쓰지 않는다.

메모 하나가 OS 창 하나다. 창 라벨은 `box`(메모함), `settings`(설정), `note-<id>`(메모 한 장)로 구분한다. 계정도 서버도 없다.

## 저장

메모 한 장에 JSON 파일 하나다.

- 메모: 데이터 폴더의 `notes/<id>.json`
- 카테고리: 데이터 폴더의 `categories.json`

기본 데이터 폴더는 앱 데이터 폴더 아래 `data`다.

- Windows: `%APPDATA%\com.writersroom.memopin\data`
- macOS: `~/Library/Application Support/com.writersroom.memopin/data`

설정은 동기화하지 않는 기기별 파일이다. 앱 설정 폴더의 `settings.json`에 따로 둔다.

## 동기화

설정에서 데이터 폴더를 구글 드라이브·Dropbox·iCloud 폴더로 바꾸면, 동기화는 그 서비스가 알아서 한다. 앱에 API 연동은 없다.

- 옮길 폴더가 비어 있으면 현재 데이터를 그대로 복사한다.
- 옮길 폴더에 이미 메모가 있으면 그것을 읽어 들인다. 합치지 않는다.
- 외부에서 파일이 바뀌면 앱이 감지해 다시 읽는다.

## 개발

```bash
npm install
npm run app      # tauri dev, 개발 서버 포트 5175 고정
```

테스트:

```bash
npm test                      # vitest
cd src-tauri && cargo test    # Rust
```

## 빌드

```bash
npm run app:build   # tauri build
```

산출물은 `src-tauri/target/release/bundle/`에 나온다.

## 릴리스

서명 키는 한 번만 만든다.

```bash
npx tauri signer generate -w ~/.tauri/memopin.key
```

- 출력된 **공개키**를 `src-tauri/tauri.conf.json`의 `plugins.updater.pubkey`에 넣는다.
- **비밀키 파일 내용**과 **비밀번호**를 GitHub 저장소 Settings → Secrets and variables → Actions에 각각 `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`로 등록한다.

> 주의: pubkey가 비어 있으면 자동 업데이트가 동작하지 않는다. 초기 상태가 그렇다.

그다음 `package.json`과 `src-tauri/tauri.conf.json`의 version을 올리고 태그를 민다.

```bash
git tag v0.1.0 && git push origin v0.1.0
```

GitHub Actions가 윈도우·맥 설치본과 `latest.json`을 만들어 draft 릴리스에 올리고, 검증을 통과하면 자동으로 공개한다.

업데이트 endpoint:

```
https://github.com/writers-room/memopin/releases/latest/download/latest.json
```

## 맥 첫 실행

개발자 계정이 없어 ad-hoc 서명(`signingIdentity: "-"`)을 쓴다. 그래서 처음 열 때 "확인되지 않은 개발자" 경고가 뜬다.

응용 프로그램 폴더의 메모핀을 **우클릭 → 열기 → 열기**로 한 번만 실행하면, 그 뒤로는 그냥 열린다.

## 문서

- `docs/contract.md` — 프런트엔드와 Rust 사이의 계약. 유일한 원본이다.
- `design/mockup.html` — 시각 스펙.
- `CLAUDE.md` — 개발 규칙.
