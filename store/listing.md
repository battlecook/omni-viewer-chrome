# Chrome Web Store Listing Copy

This document holds the copy that goes into the Chrome Web Store listing
form. English first, Korean second. Keep both in sync when you edit either.

---

## English

### Name

Omni Viewer

### Short description (max 132 characters)

> Preview documents, media, structured data, and archives locally in Chrome.

### Long description

Omni Viewer turns Chrome into a single, local viewer for the file types you
deal with every day. Drop a file onto the extension page, or use **Open with
Omni Viewer** from your file manager, and the right viewer renders instantly
— no upload, no sign-in, no ads.

**View files without switching between apps**

Omni Viewer supports common documents, images, audio, video, tabular and
structured data, design files, and compressed archives. It automatically
selects an appropriate viewer after you choose a file.

Depending on the content, you can browse pages or slides, inspect sheets and
data rows, search structured text, control media playback, inspect image and
design-file properties, or preview entries inside an archive. Viewer-specific
tools such as zoom, sorting, filtering, annotations, and export are shown only
when they apply.

Save and Export actions start a normal browser-managed download. Whether Chrome
asks for a destination or saves directly follows the user's Chrome download
settings.

**Privacy by default**

Files stay on your machine. The extension does not include analytics, does
not load remote code, and uses Chrome's `storage` API only to remember small
UI preferences such as theme. The optional share feature, when you choose to
use it, uploads bytes to a dedicated endpoint that auto-deletes after at
most five minutes; access is gated by a signed `share_id`.

**What it asks for**

- `storage` — to remember UI preferences (theme, last-used mode).
- Share API host access — only to upload a file after you press Share and
  to resolve an Omni Viewer share ID. Upload requests identify this client
  as the `chrome` platform. No content scripts.
- Firebase Authentication hosts — create and refresh an anonymous account
  used only to authenticate Share uploads.

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
local viewer appropriate for the selected content.

### Permissions justification (paste verbatim into the Web Store form)

- `storage`: persists small UI preferences such as theme. No file contents,
  no personal data.
- `https://omni-viewer-share-624036133562.us-west1.run.app/*`: creates and
  opens temporary share links only after an explicit Share or Open Link
  action. Shared files expire after five minutes.
- `https://identitytoolkit.googleapis.com/*` and
  `https://securetoken.googleapis.com/*`: create and refresh the anonymous
  Firebase identity used to authenticate Share uploads.
- `https://storage.googleapis.com/*`: downloads only signed URLs whose path
  is validated as the `omni-viewer-web-share` bucket before the request.

### Remote code declaration

No, I am not using remote code. All viewer code and third-party libraries
are packaged under the extension directory.

---

## 한국어

### 이름

옴니 뷰어 (Omni Viewer)

### 짧은 설명 (최대 132자)

> 문서, 미디어, 구조화 데이터와 압축 파일을 Chrome에서 로컬로 미리보세요.

### 긴 설명

옴니 뷰어는 매일 다루는 다양한 파일을 **하나의 로컬 뷰어**에서 열 수
있도록 만들어 주는 Chrome 확장 프로그램입니다. 파일을 뷰어 페이지에
드롭하거나, OS의 파일 관리자에서 **Omni Viewer로 열기**를 선택하면
적절한 뷰어가 즉시 실행됩니다. 업로드도, 로그인도, 광고도 없습니다.

**여러 앱을 오가지 않고 파일 보기**

옴니 뷰어는 일반 문서, 이미지, 오디오, 영상, 표와 구조화 데이터,
디자인 파일, 압축 파일을 지원합니다. 사용자가 파일을 선택하면 내용에
맞는 뷰어를 자동으로 실행합니다.

파일에 따라 페이지나 슬라이드를 탐색하고, 시트와 데이터 행을 살펴보고,
구조화된 텍스트를 검색하거나 미디어를 재생할 수 있습니다. 이미지와
디자인 파일의 속성 확인, 압축 파일 내부 미리보기도 지원합니다. 확대,
정렬, 필터, 주석, 내보내기 같은 도구는 해당 파일에 필요한 경우에만
표시됩니다.

Save와 Export는 브라우저가 관리하는 일반 다운로드를 시작합니다. 저장
위치를 물을지 바로 저장할지는 사용자의 Chrome 다운로드 설정을 따릅니다.

**기본값이 프라이버시**

파일은 사용자의 기기에 그대로 머무릅니다. 확장 프로그램에는 분석
도구가 포함되어 있지 않고, 원격 코드를 불러오지 않습니다. Chrome의
`storage` API는 테마 같은 작은 UI 환경설정만 저장합니다. 선택 사항인
공유 기능을 사용할 때만 지정된 엔드포인트로 바이트를 업로드하며,
업로드된 데이터는 **최대 5분** 이후 자동 삭제됩니다. 접근은 서명된
`share_id`로만 가능합니다.

**요구하는 권한**

- `storage` — 테마, 마지막으로 사용한 모드 등 UI 환경설정 저장 용도.
- 공유 API 호스트 접근 — 사용자가 Share를 누른 뒤 파일을 업로드하거나
  Omni Viewer 공유 ID를 열 때만 사용하며 업로드 요청은 `chrome`
  플랫폼으로 식별됩니다. 콘텐츠 스크립트는 없습니다.
- Firebase Authentication 호스트 — Share 업로드 인증에만 사용하는 익명
  계정을 생성하고 토큰을 갱신합니다.

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
콘텐츠에 맞는 로컬 뷰어로 렌더링하는 단일 목적의 확장 프로그램입니다.

### 권한 정당화 (Web Store 양식에 그대로 사용)

- `storage`: 테마 등 작은 UI 환경설정 저장. 파일 내용이나 개인정보는
  저장하지 않습니다.
- `https://omni-viewer-share-624036133562.us-west1.run.app/*`: 사용자가
  Share 또는 Open Link를 명시적으로 실행했을 때만 5분짜리 임시 공유
  링크를 생성하거나 엽니다.
- `https://identitytoolkit.googleapis.com/*`,
  `https://securetoken.googleapis.com/*`: Share 업로드 인증용 Firebase 익명
  ID를 생성하고 갱신합니다.
- `https://storage.googleapis.com/*`: 요청 전에
  `omni-viewer-web-share` 버킷 경로인지 검증한 서명 URL만 다운로드합니다.

### 원격 코드 선언

원격 코드를 사용하지 않습니다. 모든 뷰어 코드와 서드파티 라이브러리는
확장 디렉터리 안에 포함되어 배포됩니다.
