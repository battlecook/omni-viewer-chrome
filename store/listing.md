# Chrome Web Store Listing Copy

This document holds the copy that goes into the Chrome Web Store listing
form. English first, Korean second. Keep both in sync when you edit either.

---

## English

### Name

Omni Viewer

### Short description (max 132 characters)

> Open many file formats locally in Chrome — images, PDF, audio, video,
> CSV, Excel, Word, PowerPoint, PSD, HWP, archives, and more.

### Long description

Omni Viewer turns Chrome into a single, local viewer for the file types you
deal with every day. Drop a file onto the extension page, or use **Open with
Omni Viewer** from your file manager, and the right viewer renders instantly
— no upload, no sign-in, no ads.

**Sixteen viewers in one extension**

- **Image** — JPG, PNG, GIF, BMP, WebP, SVG, with crop, resize, filters,
  selection tools, and a properties panel.
- **PDF** — pages, thumbnails, zoom, password-protected files, text and
  signature annotations, and reordering.
- **Audio** — MP3, WAV, FLAC, OGG, AAC, M4A, AIFF, AMR, AC3, raw PCM, with a
  waveform and spectrogram view, loop regions, and playback-speed controls.
- **Video** — MP4, MKV, WebM, MOV, AVI, WMV, FLV, MTS, OGV, with zoom, loop
  regions, and a keyboard shortcut layer.
- **CSV / TSV** — sortable columns, search, delimiter detection, statistics
  panel.
- **Excel** — XLSX/XLS workbooks with multi-sheet pagination, raw cell
  toggle, and CSV export.
- **Parquet** — schema preview, row inspection.
- **Word** — DOCX/DOC rendering with charts, embeddings, and zoom.
- **PowerPoint** — PPTX/PPT slide layout viewer with zoom.
- **PSD** — Photoshop layer visibility, metadata, and per-layer view modal.
- **HWP / HWPX** — Korean word processor documents, including newer XML
  bundles.
- **Archive** — ZIP, RAR, 7Z, TAR, GZ, BZ2, XZ, DMG, JAR, APK, with entry
  list, in-archive previews, and signature-based routing.
- **JSON / JSONL** — tokenized syntax-highlighted tree, popup editor, large
  file friendly streaming.
- **YAML** — node-by-node tree.
- **TOML** — typed parser with section navigation.

**Privacy by default**

Files stay on your machine. The extension does not include analytics, does
not load remote code, and uses Chrome's `storage` API only to remember small
UI preferences such as theme. The optional share feature, when you choose to
use it, uploads bytes to a dedicated endpoint that auto-deletes after at
most five minutes; access is gated by a signed `share_id`.

**What it asks for**

- `storage` — to remember UI preferences (theme, last-used mode). Nothing
  else. No host permissions. No content scripts.

**What it does not do**

- No upload of your files unless you explicitly press share.
- No analytics, no tracking, no ads, no account.
- No remote code execution. Every script and WASM module is bundled inside
  the extension.

Read the full privacy policy linked from the listing for the formal
statement.

### Category

Productivity

### Single purpose statement

Omni Viewer opens user-selected local files in Chrome and renders them in a
local viewer for the supported formats listed above.

### Permissions justification (paste verbatim into the Web Store form)

- `storage`: persists small UI preferences such as theme. No file contents,
  no personal data.
- No `host_permissions`. The `web_accessible_resources` block only exposes
  the extension's own `vendor/**/*` and `templates/**/*` files to its own
  viewer page.

### Remote code declaration

No, I am not using remote code. All viewer code and third-party libraries
are packaged under the extension directory.

---

## 한국어

### 이름

옴니 뷰어 (Omni Viewer)

### 짧은 설명 (최대 132자)

> Chrome 안에서 이미지, PDF, 오디오, 영상, CSV, 엑셀, Word, PPT, PSD, HWP,
> 압축파일까지 다양한 파일 형식을 로컬로 열어보세요.

### 긴 설명

옴니 뷰어는 매일 다루는 다양한 파일을 **하나의 로컬 뷰어**에서 열 수
있도록 만들어 주는 Chrome 확장 프로그램입니다. 파일을 뷰어 페이지에
드롭하거나, OS의 파일 관리자에서 **Omni Viewer로 열기**를 선택하면
적절한 뷰어가 즉시 실행됩니다. 업로드도, 로그인도, 광고도 없습니다.

**한 확장에 16개 뷰어**

- **이미지** — JPG, PNG, GIF, BMP, WebP, SVG. 자르기, 크기 조정, 필터,
  선택 도구, 속성 패널 제공.
- **PDF** — 페이지/썸네일/확대, 비밀번호 보호 파일 지원, 텍스트 및
  서명 주석, 페이지 재정렬.
- **오디오** — MP3, WAV, FLAC, OGG, AAC, M4A, AIFF, AMR, AC3, 원시 PCM
  지원. 파형/스펙트로그램, 루프 영역, 재생 속도 조절.
- **영상** — MP4, MKV, WebM, MOV, AVI, WMV, FLV, MTS, OGV. 확대, 루프
  영역, 단축키 지원.
- **CSV / TSV** — 정렬, 검색, 구분자 자동 감지, 통계 패널.
- **엑셀** — XLSX/XLS의 다중 시트 페이지네이션, 원시 셀 토글, CSV
  내보내기.
- **Parquet** — 스키마 미리보기, 행 단위 조회.
- **Word** — DOCX/DOC 렌더링, 차트, 임베딩, 확대.
- **PowerPoint** — PPTX/PPT 슬라이드 레이아웃 뷰어, 확대.
- **PSD** — Photoshop 레이어 표시 토글, 메타데이터, 레이어별 뷰 모달.
- **HWP / HWPX** — 한글 문서, 최신 XML 번들 포맷 포함.
- **압축 파일** — ZIP, RAR, 7Z, TAR, GZ, BZ2, XZ, DMG, JAR, APK. 항목
  목록, 압축 내부 미리보기, 시그니처 기반 라우팅.
- **JSON / JSONL** — 토큰 기반 구문 강조 트리, 팝업 편집기, 대용량
  스트리밍.
- **YAML** — 노드 단위 트리.
- **TOML** — 타입을 인식하는 파서와 섹션 탐색.

**기본값이 프라이버시**

파일은 사용자의 기기에 그대로 머무릅니다. 확장 프로그램에는 분석
도구가 포함되어 있지 않고, 원격 코드를 불러오지 않습니다. Chrome의
`storage` API는 테마 같은 작은 UI 환경설정만 저장합니다. 선택 사항인
공유 기능을 사용할 때만 지정된 엔드포인트로 바이트를 업로드하며,
업로드된 데이터는 **최대 5분** 이후 자동 삭제됩니다. 접근은 서명된
`share_id`로만 가능합니다.

**요구하는 권한**

- `storage` — 테마, 마지막으로 사용한 모드 등 UI 환경설정 저장 용도.
  그 외에는 사용하지 않습니다. `host_permissions` 없음, 콘텐츠 스크립트
  없음.

**하지 않는 것**

- 사용자가 직접 공유를 누르기 전까지 어떠한 업로드도 발생하지
  않습니다.
- 분석/추적/광고/계정 없음.
- 원격 코드 실행 없음. 모든 스크립트와 WASM 모듈은 확장 프로그램 안에
  번들로 포함되어 있습니다.

전체 개인정보 처리방침은 스토어 등록 정보에 링크된 문서를 참고하세요.

### 카테고리

생산성 (Productivity)

### 단일 목적 (Single purpose) 진술

옴니 뷰어는 사용자가 선택한 로컬 파일을 Chrome 안에서 열어, 지원되는
형식을 로컬 뷰어로 렌더링하는 단일 목적의 확장 프로그램입니다.

### 권한 정당화 (Web Store 양식에 그대로 사용)

- `storage`: 테마 등 작은 UI 환경설정 저장. 파일 내용이나 개인정보는
  저장하지 않습니다.
- `host_permissions` 없음. `web_accessible_resources`는 확장 자체의
  `vendor/**/*`, `templates/**/*` 자산만을 자체 뷰어 페이지에 공급하는
  용도입니다.

### 원격 코드 선언

원격 코드를 사용하지 않습니다. 모든 뷰어 코드와 서드파티 라이브러리는
확장 디렉터리 안에 포함되어 배포됩니다.
