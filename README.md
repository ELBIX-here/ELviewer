# ELviewer

Tauri 2 + React 기반의 고성능 소설/전자책 뷰어 (Windows).

## 지원 형식

| 분류 | 형식 | 처리 |
|---|---|---|
| 텍스트 | txt, log, md, html/htm, docx, hwpx, rtf | Rust에서 인코딩 감지 후 본문 추출 (`src-tauri/src/text.rs`) |
| 전자책 | epub, mobi, azw/azw3, fb2, cbz | foliate-js |
| 문서 | pdf | pdfjs-dist |
| 이미지 폴더 | jpg, png, webp, avif, gif, bmp | 폴더 단위로 한 권처럼 취급 |
| 압축 | zip, 7z | 압축을 풀지 않고 내부 파일을 직접 읽음 (`archive|member` 가상 경로) |

인코딩: BOM → UTF-16 휴리스틱 → chardetng 자동 감지 (한국어 우선). 파일별로 수동 지정 가능.

## 개발

```powershell
npm install
npm run tauri dev      # 개발 실행 (Rust 자동 컴파일)
npm run tauri build    # 릴리즈 빌드 → src-tauri/target/release/ELviewer.exe, bundle/nsis/*.exe
```

필요: Node 20+, Rust (rustup), Visual Studio Build Tools (C++ 워크로드), WebView2 런타임.

### 테스트

```powershell
npm test            # 프론트 단위 테스트 (Vitest): 텍스트 전처리, 동기화 병합, 문서 분할·목차, 정렬
npm run test:rust   # Rust 단위 테스트: 인코딩 감지, HTML/DOCX 추출, zip/7z, 서재 스캔
npm run check       # 타입 검사 + 위 두 가지 전부 (커밋 전에)
```

테스트 파일은 대상 옆에 둡니다 (`src/lib/*.test.ts`, Rust는 각 모듈의 `#[cfg(test)] mod tests`).

### UI 미리보기

`npm run dev`만 띄우고 브라우저에서 http://localhost:1420 을 열면 샘플 서재로 UI를 볼 수 있습니다 (`src/dev/mockTauri.ts`, 개발 모드 전용). 디자인 기준은 [DESIGN.md](DESIGN.md).

## 구조

```
src-tauri/src
  lib.rs       Tauri 커맨드: read_text, read_binary, scan_library, watch_roots, list_encodings
  text.rs      인코딩 감지 + docx/hwpx/rtf/html → 텍스트
  archive.rs   zip/7z 멤버 목록·읽기 (CP949 파일명 처리)
  library.rs   폴더 재귀 스캔
  watcher.rs   notify 기반 폴더 감시 → "library-changed" 이벤트
src
  store/       zustand 스토어 (settings, progress, library) – tauri-plugin-store로 영속화
  components/library/LibraryView.tsx   서재 (폴더 탐색, 검색, 정렬, 이어 읽기)
  components/reader/TextReader.tsx     텍스트 리더 (ScrollView / PageView)
  components/reader/EbookReader.tsx    epub/mobi/fb2/cbz
  components/reader/PdfReader.tsx      pdf
  components/reader/ImageReader.tsx    이미지 폴더
  components/reader/ReaderChrome.tsx   툴바, 진행 바, 패널(목차/검색/책갈피/설정)
```

## 글꼴: EL Sans

`fonts/`에 ELviewer 전용 본문 글꼴이 있습니다. Noto Sans KR(SIL OFL 1.1)을 바탕으로 다음을 바꿨습니다.

- 조금 더 두껍게: 가변 글꼴의 굵기 축에서 470(보통) / 730(굵게)으로 뽑음. Noto Sans KR 보통은 400
- 획 끝을 둥글게: 윤곽선을 반경 28/30 unit만큼 깎았다가 다시 불려서 볼록한 모서리를 모두 둥글게 만듦
- 받침 있는 음절은 가로 94%로 좁힘 (글자 폭도 같이 줄어듦)
- 한자는 제외 (시스템 글꼴로 대체 표시), woff2 약 1.1 MB씩

```powershell
python -m pip install fonttools skia-pathops brotli pillow
python fonts/build_font.py              # → fonts/dist/ELSans-{Regular,Bold}.{ttf,woff2}
python fonts/preview.py preview.png     # Noto Sans KR과 비교 이미지
copy fonts\dist\*.woff2 src\assets\fonts\
```

설정값(굵기, 둥글기 반경, 받침 축소 비율)은 `build_font.py` 위쪽의 `STYLES`, `BATCHIM_SCALE`에 있습니다. `fonts/dist/*.ttf`를 Windows에 설치하면 다른 프로그램에서도 쓸 수 있습니다. 라이선스는 OFL 1.1입니다(`fonts/dist/OFL.txt`).

## 아이콘

`E-book Reader 아이콘.html` 디자인(펼친 책 + 엎어 둔 책 = 모래시계)을 [icons-src/build_icons.mjs](icons-src/build_icons.mjs)에 옮겨 두었습니다.

```powershell
node icons-src/build_icons.mjs   # icons-src/*.svg, src-tauri/icons/*, src/assets/logo.svg 생성
```

- `icon.ico` (exe, 작업 표시줄, 설치 파일): 배경판 없는 Windows 변형. 48px 이하는 단순화 글리프
- PNG와 앱 로고: 네이비 배경판이 있는 메인 아이콘. 32px 이하는 단순화 글리프
- 색은 스크립트 위쪽 `C` 객체 (Navy `#1C2640`, Paper `#F3EAD8`, Sand `#E8A23C`, Cap `#C9822A`)

## 단축키

`←/→/Space/PgUp/PgDn` 이동 · `Home/End` · `Ctrl+←/→` 이전/다음 파일 · `M` 모드 전환 · `T` 목차 · `B` 책갈피 · `A` 자동 스크롤/넘김 · `Ctrl+F` 검색 · `Ctrl +/-` 글자 크기 · `F11` 전체 화면 · `Esc` 닫기/서재로
