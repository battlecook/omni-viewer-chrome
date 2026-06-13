#!/usr/bin/env bash
# 일괄 이슈 등록 스크립트. 한 번만 실행.
set -euo pipefail
REPO="battlecook/omni-viewer-chrome"

create() {
  local title="$1"
  local body="$2"
  echo "::: $title"
  gh issue create --repo "$REPO" --title "$title" --body "$body" >/dev/null
}

# ============================================================
# Foundation
# ============================================================

create "[Foundation] 프로젝트 구조 재편 + webpack/TypeScript 빌드 도입" "$(cat <<'BODY'
## 배경
현재 omni-viewer-chrome 은 단일 \`src/app.js\` (1022 라인) 에 모든 뷰어 로직이 들어가 있어 유지보수/확장이 어렵습니다. VSCode 측 \`vscode-omni-viewer\` 는 \`src/templates/<viewer>/\` 단위로 HTML/CSS/JS 가 분리돼 있고 webpack + TypeScript 로 번들됩니다. 본 작업은 동일 디렉토리 구조를 그대로 차용하고 빌드 시스템을 도입하는 것이 목표입니다.

## 참고 코드 (vscode-omni-viewer)
- \`webpack.config.js\`
- \`tsconfig.json\`
- \`package.json\` (scripts: compile/watch/sync:rhwp)
- \`src/templates/<viewer>/\` 디렉토리 트리 전반

## 구현 위치 (omni-viewer-chrome)
- \`webpack.config.js\` (신규)
- \`tsconfig.json\` (신규)
- \`package.json\` (scripts/devDeps 보강)
- \`src/\` 하위 templates 구조 디렉토리 골격
- \`dist/\` 산출물 경로 통일

## 작업 단계
1. webpack 5 + ts-loader + babel-loader 설치
2. entry 별 진입점 정의: 각 viewer 별 \`src/templates/<viewer>/js/<viewer>Viewer.js\` 를 entry 로 묶고 \`dist/templates/<viewer>/\` 로 출력
3. CopyWebpackPlugin 으로 manifest.json, icons, vendor, html 정적 자원 복사
4. tsconfig.json (target ES2020, module ESNext, strict true) 작성
5. package.json scripts: \`build\`, \`watch\`, \`package\`, \`zip\` 추가
6. \`src/templates/\` 하위 placeholder 디렉토리 생성 (image/pdf/audio/video/csv/excel/parquet/word/ppt/psd/hwp/archive/json/jsonl/yaml/toml)
7. \`dist/\` 가 manifest.json 의 service worker / file_handlers 와 정합성 유지

## DoD
- [ ] \`npm run build\` 로 \`dist/\` 가 생성되고 chrome://extensions 에서 unpacked 로딩 가능
- [ ] 기존 viewer.html 동작이 회귀 없이 동일하게 작동
- [ ] templates 디렉토리 골격 생성
- [ ] webpack watch 모드 정상 동작

## 수동 테스트
- [ ] 빌드 후 dist 로딩 → 기존 기능 1개씩 회귀 확인 (image/pdf/csv 최소 3종)
- [ ] watch 모드에서 파일 변경 후 reload 동작
- [ ] HMR 의 영향이 manifest CSP 와 충돌하지 않는지 확인

## 자동 테스트
- [ ] (없음. 별도 jest setup 이슈에서 처리)

## 의존
- 없음 (선행 이슈)

## 비고
- 예상 규모: L
- 모든 이후 이슈가 이 빌드 인프라 위에 올라옴
BODY
)"

create "[Foundation] viewerRegistry / router 이식 + viewer 별 진입 페이지" "$(cat <<'BODY'
## 배경
VSCode 의 \`viewerRegistry.ts\` + \`extension.ts\` 는 파일 시그니처/확장자 → viewType 매핑 → 적절한 Provider 위임 구조입니다. Chrome 환경에서는 \`launchQueue\` / \`fileInput\` / drag&drop 으로 받은 File 객체를 동일한 라우팅 로직으로 viewer 페이지에 위임해야 합니다.

## 참고 코드 (vscode-omni-viewer)
- \`src/extension.ts\`
- \`src/viewerRegistry.ts\`
- \`src/viewerProviderUtils.ts\`

## 구현 위치 (omni-viewer-chrome)
- \`src/router.ts\` (신규: launchQueue + drop + fileInput → router)
- \`src/viewerRegistry.ts\` (이식)
- \`src/viewerProviderUtils.ts\` (이식)
- \`src/templates/<viewer>/<viewer>Viewer.html\` (각 viewer 별 진입점)
- \`viewer.html\` 은 라우팅 허브로 단순화

## 작업 단계
1. VIEWER_REGISTRATIONS 배열 (viewType, command, missingMessage, retainContextWhenHidden, createProvider) 이식
2. Chrome 용 Provider interface 재정의: \`render(file: File, container: HTMLElement)\` 시그니처
3. 메인 \`viewer.html\` 에서 type 결정 후 \`location.replace(\`templates/<viewer>/\${viewer}Viewer.html?...\`)\` 또는 단일 SPA 라우팅
4. URL query 또는 chrome.storage.session 으로 File handle 전달
5. fallback 시 \`renderUnsupported\` 패턴 보존

## DoD
- [ ] 모든 viewer type 이 registry 로 라우팅됨
- [ ] viewer 추가 시 registry 한 줄 추가만으로 등록 가능
- [ ] 기존 single-page 모드도 동작 유지 (점진 전환 가능)

## 수동 테스트
- [ ] 각 type 의 샘플 파일 1개씩 라우팅 확인
- [ ] 시그니처-확장자 불일치 (예: .png 인데 jpg) 시 경고 표시

## 자동 테스트
- [ ] viewerRegistry 단위 테스트 (mapping)

## 의존
- #1 (빌드 시스템)

## 비고
- 예상 규모: M
BODY
)"

create "[Foundation] fileUtils + signature 감지 이식 (브라우저 변환)" "$(cat <<'BODY'
## 배경
VSCode 측 \`src/utils/fileUtils.ts\` (57KB) + \`fileUtils/{archive,media,tabular,word}.ts\` 는 파일 시그니처 기반 viewer 결정/오탐 보정 로직입니다. Chrome 측은 현재 \`detectType\` 단일 함수로 빈약합니다. fs 의존을 File API 로 치환해서 그대로 이식해야 합니다.

## 참고 코드 (vscode-omni-viewer)
- \`src/utils/fileUtils.ts\`
- \`src/utils/fileUtils/archive.ts\`
- \`src/utils/fileUtils/archivePreviewDecoder.ts\`
- \`src/utils/fileUtils/media.ts\`
- \`src/utils/fileUtils/tabular.ts\`
- \`src/utils/fileUtils/word.ts\`
- \`src/__tests__/fileUtils.test.ts\`
- \`src/__tests__/archivePreviewDecoder.test.ts\`

## 구현 위치 (omni-viewer-chrome)
- \`src/utils/fileUtils.ts\`
- \`src/utils/fileUtils/{archive,media,tabular,word}.ts\`

## 작업 단계
1. node:fs 의존 제거 → File.slice + arrayBuffer 사용
2. detectViewerType 함수 시그니처를 (file: File, requested?: ViewType) → Promise<{viewType, reason}> 로 변환
3. PNG/JPEG/GIF/WEBP/BMP/PSD/PDF/PARQUET/ZIP/RAR/7Z/GZ/TAR/MP4/AVI/WAV/FLAC/MP3/OGG/AIFF/AMR/CSV/TSV/JSONL 시그니처 모두 보존
4. OOXML 내부 디렉토리 (\`word/\`, \`xl/\`, \`ppt/\`, \`Contents/content.hpf\`) 검사
5. 기존 \`detectType\` 호출 지점을 새 함수로 마이그레이션

## DoD
- [ ] 시그니처 케이스 누락 0
- [ ] jest 테스트 fileUtils.test.ts 이식 + 통과
- [ ] OOXML/HWPX 정확 분기 보장

## 수동 테스트
- [ ] 확장자 위변조 파일 (png 를 jpg 로 rename) 도 정확 라우팅
- [ ] HWPX 와 일반 zip 을 정확 분리

## 자동 테스트
- [ ] fileUtils.test.ts 이식
- [ ] archivePreviewDecoder.test.ts 이식

## 의존
- #1, #2

## 비고
- 예상 규모: L
BODY
)"

create "[Foundation] templateUtils + messageHandler 추상화" "$(cat <<'BODY'
## 배경
VSCode 측 \`templateUtils.ts\` 는 \`{{fileName}}\`, \`{{omniShareButtons}}\`, \`{{pdfBase64}}\` 등 placeholder 치환 + 안전 escaping 을 담당합니다. \`messageHandler.ts\` 는 webview ↔ extension 메시징을 추상화합니다. Chrome 에서는 동일 placeholder 시스템 + window.postMessage 또는 직접 호출로 치환됩니다.

## 참고 코드 (vscode-omni-viewer)
- \`src/utils/templateUtils.ts\`
- \`src/utils/messageHandler.ts\`
- \`src/utils/messageHandlers/{mediaMessageHandlers,pdfMessageHandlers,textMessageHandlers,types}.ts\`
- \`src/utils/htmlEscaping.ts\`
- \`src/__tests__/templateUtils.test.ts\`
- \`src/__tests__/messageHandler.test.ts\`

## 구현 위치 (omni-viewer-chrome)
- \`src/utils/templateUtils.ts\`
- \`src/utils/messageHandler.ts\`
- \`src/utils/messageHandlers/\`
- \`src/utils/htmlEscaping.ts\`

## 작업 단계
1. templateUtils 의 \`renderTemplate(htmlPath, vars)\` 를 fetch + 치환으로 구현
2. {{omniShareButtons}} placeholder 는 share 가 비활성일 때 빈 문자열로 치환
3. messageHandler 는 (a) viewer 내부 모듈 간 호출, (b) viewer ↔ background service worker 호출 두 채널 지원
4. 핵심 메시지 타입 (mediaSeek, pdfSavePages, textCopy 등) 인터페이스 이식

## DoD
- [ ] templateUtils.test.ts 통과
- [ ] messageHandler.test.ts 통과
- [ ] HTML 인젝션 케이스 안전성 확인 (escape)

## 수동 테스트
- [ ] {{fileName}} 에 \`<script>\` 가 들어간 파일명도 안전

## 자동 테스트
- [ ] 이식된 두 테스트 파일 그대로 실행

## 의존
- #1

## 비고
- 예상 규모: M
BODY
)"

create "[Foundation] manifest.json 확장자/MIME 풀 매핑 + file_handlers 정비" "$(cat <<'BODY'
## 배경
현재 manifest.json 의 \`file_handlers.accept\` 에 누락된 확장자가 다수 있어 OS 단에서 Omni Viewer 로 열기 옵션이 노출되지 않습니다. VSCode 측 \`package.json\` customEditors selector 와 동등한 수준으로 보강 필요.

## 참고 코드 (vscode-omni-viewer)
- \`package.json\` → contributes.customEditors[*].selector

## 구현 위치 (omni-viewer-chrome)
- \`manifest.json\`

## 작업 단계
1. Audio: \`.pcm .aiff .aif .aifc .amr .awb .ac3\` 추가
2. Video: \`.mts .m2ts .avi .wmv .flv .mkv .m4v .ogv\` 추가
3. Archive: \`.dmg .tbz2 .tar.bz2 .txz .tar.xz .bz2 .xz\` 추가
4. MIME 그룹화: 단일 octet-stream 한 곳에 몰아넣기보다 audio/video/text 별 MIME accept 필드도 보강 (Chrome 이 octet-stream 을 우선 사용해도 OS hint 를 위해)
5. file_handlers 는 단일 viewer.html 진입 + 이후 router 로 분기

## DoD
- [ ] VSCode selector 와 1:1 대응 (HWPX/PSD/Parquet 포함)
- [ ] OS Open With → Omni Viewer 가 노출되는지 macOS/Windows 1대씩 확인
- [ ] manifest 검증 통과

## 수동 테스트
- [ ] 각 확장자 1개 파일 OS 더블클릭 → Omni Viewer 진입

## 자동 테스트
- [ ] (없음)

## 의존
- #1

## 비고
- 예상 규모: S
BODY
)"

create "[Foundation] CSP / web_accessible_resources / wasm 정책 정리" "$(cat <<'BODY'
## 배경
PDF.js / libarchive / rhwp / audio_engine 등 WASM/Worker 자산이 다수 vendor/ 에 있고 viewer 별 dynamic import 가 필요합니다. MV3 CSP 와 web_accessible_resources 매칭이 잘못되면 vendor 로딩이 차단됩니다.

## 참고 코드 (vscode-omni-viewer)
- vendor/ 의 wasm 자산 배포 방식 (webpack copy)

## 구현 위치 (omni-viewer-chrome)
- \`manifest.json\` (CSP, web_accessible_resources)
- \`webpack.config.js\` (asset 복사)

## 작업 단계
1. extension_pages CSP 에 \`wasm-unsafe-eval\` 보장 (현재 됨)
2. web_accessible_resources 의 \`vendor/*\` 외에 \`dist/templates/*\`, \`dist/wasm/*\` 도 노출
3. matches 를 \`<all_urls>\` 대신 \`*://*/*\` + extension scheme 위주로 좁힘
4. cross-origin isolation 필요 시 (SharedArrayBuffer) COOP/COEP 헤더는 chrome extension 한계 고려해 우회

## DoD
- [ ] vendor wasm 모두 로딩 성공 (PDF/libarchive/rhwp/audio_engine)
- [ ] CSP 위반 콘솔 에러 0
- [ ] WAR 매칭이 최소 권한 원칙 준수

## 수동 테스트
- [ ] PDF / Archive / HWP / Audio(WASM 경로) 각 1개씩 viewer 동작 확인

## 자동 테스트
- [ ] (없음)

## 의존
- #1

## 비고
- 예상 규모: S
BODY
)"

create "[Foundation] jest + ts-jest 테스트 setup" "$(cat <<'BODY'
## 배경
VSCode 측은 \`src/__tests__/\` 8개 테스트 파일이 있습니다. Chrome 측에도 동등 setup 도입.

## 참고 코드 (vscode-omni-viewer)
- \`jest.config.js\`
- \`src/__tests__/setup.ts\`
- \`src/__tests__/*.test.ts\`

## 구현 위치 (omni-viewer-chrome)
- \`jest.config.js\`
- \`src/__tests__/setup.ts\`
- \`src/__tests__/\` (이슈별로 추가)

## 작업 단계
1. jest, ts-jest, @types/jest 설치
2. jsdom 환경 + File polyfill
3. setup.ts 에 chrome.runtime / chrome.storage mock
4. coverage 설정

## DoD
- [ ] \`npm test\` 가 동작
- [ ] coverage 리포트 생성

## 수동 테스트
- [ ] (없음)

## 자동 테스트
- [ ] sample test 가 PASS

## 의존
- #1

## 비고
- 예상 규모: S
BODY
)"

create "[Foundation] Chrome Web Store 패키징 스크립트 + CI" "$(cat <<'BODY'
## 배경
스토어 배포를 위한 zip 패키징 + manifest 검증 + 버전 태깅 자동화가 필요합니다.

## 참고 코드 (vscode-omni-viewer)
- \`scripts/sync-rhwp-assets.js\` (asset 동기화 패턴)
- \`.github/workflows/\`

## 구현 위치 (omni-viewer-chrome)
- \`scripts/package.sh\` 또는 \`scripts/package.js\`
- \`.github/workflows/release.yml\`

## 작업 단계
1. \`npm run package\` 가 dist/ 에서 omni-viewer-<version>.zip 생성
2. manifest.json 의 version 과 package.json 의 version 동기화 검증
3. 미사용 vendor/소스 제외
4. GitHub Action: tag push → zip artifact 업로드

## DoD
- [ ] zip 사이즈가 Chrome Web Store 권장 크기 이내
- [ ] manifest 검증 + lint 통과

## 수동 테스트
- [ ] zip 을 실제 chrome 에 unpacked 로드해 회귀 확인

## 자동 테스트
- [ ] (없음)

## 의존
- #1

## 비고
- 예상 규모: S
BODY
)"

# ============================================================
# Image
# ============================================================

create "[Image] 줌/회전/플립/Fit + 파일 정보 패널" "$(cat <<'BODY'
## 배경
현재 omni-viewer-chrome 의 \`renderImage\` 는 +/- 줌과 회전 4 버튼만 있습니다. VSCode 측 imageViewer 는 Fit, 좌/우/상/하 플립, Reset, 키보드 단축키, 파일 정보 패널을 제공합니다.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/image/imageViewer.html\` (header/controls)
- \`src/templates/image/js/imageViewerMain.js\`
- \`src/templates/image/js/imageUtils.js\`
- \`src/templates/image/css/imageViewer.css\`

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/image/imageViewer.html\`
- \`src/templates/image/js/imageViewerMain.js\`
- \`src/templates/image/js/imageUtils.js\`
- \`src/templates/image/css/imageViewer.css\`

## 작업 단계
1. 컨트롤 버튼 ID/구조 그대로 차용: rotate, flipHorizontal, flipVertical, reset, fitToScreen, zoomOut, zoomIn
2. transform 누적 (rotate deg, scaleX/Y, scale) 관리 객체
3. fitToScreen: container width/height 기준 비율 계산
4. 파일 정보: width × height, format, file size 표시 (\`#sizeInfo\`, \`#formatInfo\`, \`#fileSizeInfo\`)
5. 이미지 onload 시 #imageWrapper 를 display:block 로 전환

## DoD
- [ ] 7가지 버튼 모두 동작
- [ ] 키보드 (←→ 회전, +/- 줌, 0 fit, R reset) 옵션
- [ ] 정보 패널 파일 메타 정확

## 수동 테스트
- [ ] 가로/세로 비율이 다른 이미지에서 fit 비교
- [ ] 회전 + 플립 조합 → reset 으로 원복

## 자동 테스트
- [ ] imageUtils 단위 테스트 (transform 행렬 누적)

## 의존
- #2

## 비고
- 예상 규모: M
BODY
)"

create "[Image] 필터 슬라이더 + 프리셋" "$(cat <<'BODY'
## 배경
brightness/contrast/saturation/grayscale 슬라이더와 Normal/Bright/Dark/Vintage/B&W 프리셋이 누락돼 있습니다.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/image/js/imageFilters.js\`
- \`src/templates/image/imageViewer.html\` (filter-presets, filter-sliders)

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/image/js/imageFilters.js\`
- \`src/templates/image/imageViewer.html\`
- \`src/templates/image/css/imageViewer.css\`

## 작업 단계
1. 4개 슬라이더 (brightnessSlider/contrastSlider/saturationSlider/grayscaleSlider) 의 값 → CSS filter 문자열 생성
2. 프리셋 5종 정의 (presetNormal/Bright/Dark/Vintage/Bw)
3. 프리셋 클릭 시 슬라이더 값 동기화
4. filter style 은 #image 에 적용

## DoD
- [ ] 슬라이더 4종 + 프리셋 5종 모두 동작
- [ ] 프리셋 → 슬라이더 → 프리셋 전환이 일관된 상태 유지

## 수동 테스트
- [ ] 각 프리셋 시각적 변화 확인
- [ ] 슬라이더 값 0/100/200 경계

## 자동 테스트
- [ ] filter 문자열 생성 함수 단위 테스트

## 의존
- #9

## 비고
- 예상 규모: S
BODY
)"

create "[Image] Edit mode 골격 + ToolManager" "$(cat <<'BODY'
## 배경
VSCode 측 imageEditMode 는 ToolManager 가 select / addText / addCircle / addRectangle / deleteSelected 의 활성 도구 상태를 관리합니다. 본 이슈는 모드 진입/종료 + ToolManager 만 우선 도입.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/image/js/ImageEditMode/index.js\`
- \`src/templates/image/js/ImageEditMode/managers/ToolManager.js\`
- \`src/templates/image/js/ImageEditMode/utils/{DOMUtils,StyleUtils,ColorUtils}.js\`

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/image/js/ImageEditMode/index.js\`
- \`src/templates/image/js/ImageEditMode/managers/ToolManager.js\`
- \`src/templates/image/js/ImageEditMode/utils/\`

## 작업 단계
1. \`#toggleEditMode\` 버튼으로 .edit-controls 표시/숨김
2. ToolManager: 현재 활성 도구 (select/text/circle/rect) 저장 + 버튼 active 클래스 관리
3. 도구 변경 시 캔버스 cursor / 동작 모드 전환
4. ESC 누르면 select 로 복귀

## DoD
- [ ] 도구 5종 토글 동작
- [ ] 활성 도구 시각 표시
- [ ] 모드 진입/종료 시 #editControls 토글

## 수동 테스트
- [ ] 도구 전환 시 cursor 변경 확인

## 자동 테스트
- [ ] ToolManager 단위 테스트

## 의존
- #9

## 비고
- 예상 규모: M
BODY
)"

create "[Image] ElementManager (text / circle / rectangle 추가)" "$(cat <<'BODY'
## 배경
캔버스 위에 텍스트, 원, 사각형 요소를 추가/렌더링하는 ElementManager 이식.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/image/js/ImageEditMode/managers/ElementManager.js\`

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/image/js/ImageEditMode/managers/ElementManager.js\`

## 작업 단계
1. addText: textInput + fontSize → div 요소 생성, position absolute
2. addCircle / addRectangle: SVG 또는 div 박스, fill/border color/opacity 적용
3. 데이터 구조: { id, type, x, y, w, h, text?, style }
4. \`#editCanvas\` 위에 stack 으로 누적

## DoD
- [ ] 3종 요소 모두 추가/표시
- [ ] 색/투명도/폰트 크기 반영

## 수동 테스트
- [ ] 다수 요소 추가 후 z-index 충돌 없음
- [ ] 캔버스 외곽 좌표 처리

## 자동 테스트
- [ ] ElementManager.create / serialize 단위 테스트

## 의존
- #11

## 비고
- 예상 규모: M
BODY
)"

create "[Image] SelectionManager + DragDropManager" "$(cat <<'BODY'
## 배경
요소 선택 / 드래그 이동 / 다중 선택 / 선택 해제.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/image/js/ImageEditMode/managers/SelectionManager.js\`
- \`src/templates/image/js/ImageEditMode/managers/DragDropManager.js\`

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/image/js/ImageEditMode/managers/SelectionManager.js\`
- \`src/templates/image/js/ImageEditMode/managers/DragDropManager.js\`

## 작업 단계
1. 클릭 → 선택, Shift+클릭 → 다중 선택
2. mousedown + mousemove 로 드래그 이동, scale 보정
3. 선택 시 outline 시각화
4. \`#selectionInfo\` 에 N selected 표기
5. Delete 키로 선택 요소 삭제 (\`#deleteSelected\` 와 연동)

## DoD
- [ ] 단일/다중 선택 동작
- [ ] 드래그 이동 시 정확한 좌표 갱신 (zoom/rotation 보정)
- [ ] Delete 키 + 버튼 모두 삭제

## 수동 테스트
- [ ] 줌/회전 적용 상태에서 드래그 정확성

## 자동 테스트
- [ ] selection state 단위 테스트

## 의존
- #12

## 비고
- 예상 규모: M
BODY
)"

create "[Image] ResizeManager + PropertiesPanel" "$(cat <<'BODY'
## 배경
8 방향 핸들 리사이즈 + 색/투명도/폰트 크기 등 속성 패널.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/image/js/ImageEditMode/managers/ResizeManager.js\`
- \`src/templates/image/js/ImageEditMode/managers/PropertiesPanel.js\`

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/image/js/ImageEditMode/managers/ResizeManager.js\`
- \`src/templates/image/js/ImageEditMode/managers/PropertiesPanel.js\`

## 작업 단계
1. 선택된 요소에 8개 핸들 표시 (n/s/e/w/ne/nw/se/sw)
2. mousedown 핸들 + mousemove 로 box 갱신
3. PropertiesPanel: shapeColor / borderColor / fillOpacity / borderOpacity / textInput / fontSize / fontSizeInput 동기화
4. 선택 변경 시 패널 값 자동 반영

## DoD
- [ ] 8방향 모두 정확한 비율로 리사이즈
- [ ] PropertiesPanel ↔ 선택 요소 양방향 바인딩

## 수동 테스트
- [ ] 작은 크기로 리사이즈 시 최소 크기 보장
- [ ] 텍스트 요소 폰트 크기 슬라이더 + 숫자 입력 동기화

## 자동 테스트
- [ ] resize 함수 좌표 계산 단위 테스트

## 의존
- #13

## 비고
- 예상 규모: L
BODY
)"

create "[Image] imageSave (필터/편집 적용본 저장) + 키보드 단축키" "$(cat <<'BODY'
## 배경
현재 이미지 저장은 원본 다운로드만 가능. 필터/편집 결과를 합성해서 저장 + 키보드 단축키 보강.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/image/js/imageSave.js\`
- \`src/templates/image/imageViewer.html\` (filenameModal)

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/image/js/imageSave.js\`
- \`src/templates/image/imageViewer.html\` (filenameModal 보존)

## 작업 단계
1. canvas 에 image + 필터 + edit elements 그리기
2. toBlob → showSaveFilePicker 또는 a.download
3. 파일명 모달: 기본 \`originalName-edited.png\`
4. 단축키: Ctrl+S 저장, +/- 줌, 0 fit, R reset, Delete 선택 삭제

## DoD
- [ ] 저장 결과가 화면 합성과 동일
- [ ] 모달 cancel/confirm 정상

## 수동 테스트
- [ ] 큰 이미지 (8K) 저장 메모리 한계 확인
- [ ] 키보드 단축키 충돌 없음

## 자동 테스트
- [ ] (수동만)

## 의존
- #14

## 비고
- 예상 규모: M
BODY
)"

# ============================================================
# PDF
# ============================================================

create "[PDF] viewer 분리 + 기본 렌더/줌 + 페이지 인디케이터" "$(cat <<'BODY'
## 배경
현재 PDF 렌더는 app.js 내 함수로 통합. templates/pdf 로 분리하고 thumbnail/annotation 인프라를 받을 수 있는 골격 도입.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/pdf/pdfViewer.html\`
- \`src/templates/pdf/js/pdfViewer.js\` (1125 라인)
- \`src/templates/pdf/css/pdfViewer.css\`
- \`src/pdfViewerProvider.ts\`

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/pdf/pdfViewer.html\`
- \`src/templates/pdf/js/pdfViewer.js\`
- \`src/templates/pdf/css/pdfViewer.css\`
- \`src/pdfViewerProvider.ts\` (브라우저용 변환)

## 작업 단계
1. window.__OMNI_PDFJS_WORKER__ / __OMNI_PDFJS_READY__ 부트스트랩 패턴 이식
2. #pagesContainer + #thumbnailSidebar + #overlayLayer DOM 구조 차용
3. zoomIn/zoomOut/zoomLevel 컨트롤
4. pageInfo (현재/총 페이지) 표시
5. 큰 PDF 처리: rendering throttle + intersection observer

## DoD
- [ ] 100p PDF 도 부드러운 스크롤
- [ ] 줌 단계가 VSCode 와 동일 (50/75/100/125/150/200/300%)

## 수동 테스트
- [ ] 다양한 사이즈 PDF
- [ ] 회전 페이지 포함 PDF

## 자동 테스트
- [ ] (없음)

## 의존
- #2, #6

## 비고
- 예상 규모: L
BODY
)"

create "[PDF] Thumbnail sidebar (페이지 미리보기)" "$(cat <<'BODY'
## 배경
좌측 사이드바에 페이지 썸네일 + 클릭 점프 + drag&drop 재정렬 골격.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/pdf/js/pdfViewer.js\` 의 thumbnail 관련 부분

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/pdf/js/thumbnail.js\` (모듈 분리)

## 작업 단계
1. 각 페이지 1회 렌더 → 작은 캔버스로 다운샘플
2. 클릭 시 \`#pagesContainer\` 해당 페이지로 scrollIntoView
3. 가상 스크롤 (페이지 100+ 대응)

## DoD
- [ ] 썸네일 클릭 → 본문 점프
- [ ] 100p 이상에서 메모리 폭발 방지

## 수동 테스트
- [ ] 한 페이지만 있는 PDF, 1000 페이지 PDF

## 자동 테스트
- [ ] (없음)

## 의존
- #16

## 비고
- 예상 규모: M
BODY
)"

create "[PDF] Password-protected PDF 모달" "$(cat <<'BODY'
## 배경
암호 PDF 를 열 때 모달로 비밀번호 입력 받기. pdfjs onPassword 콜백 사용.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/pdf/pdfViewer.html\` (#passwordModal)
- \`src/templates/pdf/js/pdfViewer.js\` 의 password 핸들러

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/pdf/pdfViewer.html\` (#passwordModal)
- \`src/templates/pdf/js/pdfPassword.js\`

## 작업 단계
1. getDocument({ data, password }) 호출 패턴
2. PasswordException 시 모달 표시
3. 잘못된 비밀번호 시 hint 표시 후 재시도
4. ESC 또는 Cancel 시 viewer 닫기

## DoD
- [ ] 정상/오답/취소 흐름 모두 동작

## 수동 테스트
- [ ] 사용자/소유자 비밀번호 모두 검증

## 자동 테스트
- [ ] (수동)

## 의존
- #16

## 비고
- 예상 규모: S
BODY
)"

create "[PDF] Text annotation 추가/편집" "$(cat <<'BODY'
## 배경
PDF 위에 텍스트를 올려놓고 위치/색/크기 조절. 저장 시 pdf-lib 으로 합성.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/pdf/pdfViewer.html\` (#textModal)
- \`src/templates/pdf/js/pdfViewer.js\` 의 text annotation 부분

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/pdf/js/annotations/text.js\`

## 작업 단계
1. \`btnText\` 클릭 시 모달 → 입력 → click on page → annotation 객체 생성
2. textSizeInModal / textColorInModal 적용
3. annotation 데이터: { pageIndex, x, y, text, size, color }
4. \`#overlayLayer\` 에 div 로 시각화

## DoD
- [ ] 페이지별 annotation 위치 정확
- [ ] 색/크기 모달 옵션 반영

## 수동 테스트
- [ ] 회전된 페이지에서도 좌표 정확

## 자동 테스트
- [ ] annotation 좌표 변환 단위 테스트

## 의존
- #16

## 비고
- 예상 규모: M
BODY
)"

create "[PDF] Signature annotation (canvas 서명)" "$(cat <<'BODY'
## 배경
캔버스에 서명을 그린 후 PDF 페이지 위에 부착.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/pdf/pdfViewer.html\` (#signatureModal)
- \`src/templates/pdf/js/pdfViewer.js\`

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/pdf/js/annotations/signature.js\`

## 작업 단계
1. signatureCanvasWrap 안에 canvas + pen 이벤트 처리
2. 색 선택 (signatureColorInModal)
3. 확정 시 PNG dataURL 추출
4. PDF 페이지 클릭 위치에 image annotation 부착

## DoD
- [ ] pen 입력이 부드럽게 그려짐 (touch + mouse)
- [ ] 다중 서명 가능

## 수동 테스트
- [ ] 작은 서명 / 큰 서명 / 빈 서명 케이스

## 자동 테스트
- [ ] (수동)

## 의존
- #19

## 비고
- 예상 규모: M
BODY
)"

create "[PDF] Annotation 선택/이동/삭제" "$(cat <<'BODY'
## 배경
View 모드에서 annotation 클릭 → 선택 → drag 이동 → Delete 삭제.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/pdf/js/pdfViewer.js\` 의 selection / drag 부분

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/pdf/js/annotations/selection.js\`

## 작업 단계
1. annotation div 클릭 → 선택 상태
2. mousemove 로 drag, page 좌표 변환
3. Delete 키 또는 우클릭 메뉴
4. Esc 로 선택 해제

## DoD
- [ ] 선택 / 이동 / 삭제 동작
- [ ] 다른 페이지로 이동도 옵션 (Stretch goal)

## 수동 테스트
- [ ] 줌 레벨 변경 후에도 정확

## 자동 테스트
- [ ] 좌표 변환 단위 테스트

## 의존
- #19, #20

## 비고
- 예상 규모: M
BODY
)"

create "[PDF] Page 재정렬 (drag&drop) + 삭제" "$(cat <<'BODY'
## 배경
썸네일 사이드바에서 페이지 순서 바꾸거나 삭제. Save/Save As 시 적용.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/pdf/js/pdfViewer.js\` 의 reorder/delete

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/pdf/js/pageOrder.js\`

## 작업 단계
1. HTML5 Drag&Drop API 로 썸네일 재정렬
2. × 버튼으로 페이지 삭제 (preview 만)
3. 변경 사항을 PageOrderState 에 저장

## DoD
- [ ] 재정렬/삭제가 미리보기에 즉시 반영
- [ ] 저장 전까지는 원본 보존 (취소 가능)

## 수동 테스트
- [ ] 1 페이지만 남은 상태 + 추가 삭제 시도 → 차단 확인

## 자동 테스트
- [ ] PageOrderState reducer 단위 테스트

## 의존
- #17

## 비고
- 예상 규모: M
BODY
)"

create "[PDF] Merge PDF + Save / Save As" "$(cat <<'BODY'
## 배경
다른 PDF 를 현재 문서 끝(또는 지정 위치) 에 병합 + 변경사항 저장.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/pdf/js/pdfViewer.js\` 의 merge / save / saveAs

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/pdf/js/save.js\`
- \`src/templates/pdf/js/merge.js\`

## 작업 단계
1. pdf-lib 으로 PDFDocument 로드/병합
2. annotation 합성 (text → drawText, signature → drawImage)
3. page reorder/delete 적용
4. Save: 원본 덮어쓰기 (showSaveFilePicker permission), Save As: 새 파일명
5. 저장 후 viewer 상태 동기화

## DoD
- [ ] Merge 후 페이지 수 일치
- [ ] Save 결과가 다른 PDF 뷰어에서도 정상 열림
- [ ] annotation 보존

## 수동 테스트
- [ ] Acrobat / macOS Preview 에서 결과 검증

## 자동 테스트
- [ ] merge 함수 unit (페이지 수 검증)

## 의존
- #19, #20, #21, #22

## 비고
- 예상 규모: L
BODY
)"

# ============================================================
# Audio
# ============================================================

create "[Audio] AudioController 모듈 분리 (managers/utils)" "$(cat <<'BODY'
## 배경
현재 audio 로직은 app.js 안에 단일 함수 (\`renderAudio\`). VSCode 측 \`AudioController\` 는 6개 manager + 3개 utils 구조로 깔끔히 분리돼 있음. 동일 구조 차용.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/audio/js/AudioController/index.js\`
- \`src/templates/audio/js/AudioController/managers/{AudioContextManager,EventManager,FileInfoManager,PluginManager,RegionManager,WaveSurferManager}.js\`
- \`src/templates/audio/js/AudioController/utils/{AudioUtils,Constants,DOMUtils}.js\`
- \`src/templates/audio/audioViewer.html\`

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/audio/js/AudioController/index.js\`
- \`src/templates/audio/js/AudioController/managers/\`
- \`src/templates/audio/js/AudioController/utils/\`
- \`src/templates/audio/audioViewer.html\`
- \`src/templates/audio/css/audioViewer.css\`

## 작업 단계
1. WaveSurferManager: WaveSurfer 인스턴스/옵션 관리
2. PluginManager: timeline/regions/spectrogram/minimap/hover 등록
3. RegionManager: drag selection, region-bar UI
4. FileInfoManager: duration/sampleRate/channels/bitDepth/format/size 표시
5. EventManager: 키보드/플레이/일시정지/스페이스 처리
6. AudioContextManager: WebAudio context 재사용

## DoD
- [ ] 단일파일 → 모듈 구조 마이그레이션 회귀 없음
- [ ] 기존 WASM precomputed 모드 유지

## 수동 테스트
- [ ] mp3/wav/flac 1개씩 회귀 테스트
- [ ] 50MB+ 큰 파일

## 자동 테스트
- [ ] manager 단위 테스트 (WaveSurfer mock)

## 의존
- #2

## 비고
- 예상 규모: L
BODY
)"

create "[Audio] 재생속도 + Bit Depth/채널 메타" "$(cat <<'BODY'
## 배경
재생속도 컨트롤 + Bit Depth, Channel details 정보 표시 누락.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/audio/audioViewer.html\` (file-info, channelDetailsInfo, bitDepthInfo)
- \`src/templates/audio/js/AudioController/managers/FileInfoManager.js\`

## 구현 위치 (omni-viewer-chrome)
- 동일 경로

## 작업 단계
1. WaveSurfer setPlaybackRate (0.25/0.5/0.75/1/1.25/1.5/2/4 등)
2. WASM analyze 결과에서 bitDepth/channelLayout 추출
3. mono/stereo/surround 라벨링
4. 재생속도 select UI + tooltip

## DoD
- [ ] 8가지 속도 정상 동작
- [ ] WAV/FLAC bit depth 표시 (16/24/32)

## 수동 테스트
- [ ] mono / stereo / 5.1 (있으면)
- [ ] 24bit FLAC

## 자동 테스트
- [ ] FileInfoManager 단위

## 의존
- #24

## 비고
- 예상 규모: S
BODY
)"

create "[Audio] 추가 확장자 디코딩 (PCM/AIFF/AMR/AWB/AC3)" "$(cat <<'BODY'
## 배경
manifest 와 라우터에 .pcm/.aiff/.aif/.aifc/.amr/.awb/.ac3 미포함. WASM audio_engine 확장 또는 폴백 처리.

## 참고 코드 (vscode-omni-viewer)
- \`src/audioEngine.ts\`
- \`src/wasm/audio_engine.c\`
- \`src/wasm/lib/dr_wav.h\`, \`dr_flac.h\`, \`dr_mp3.h\`, \`stb_vorbis.c\`

## 구현 위치 (omni-viewer-chrome)
- \`src/audioEngine.ts\`
- \`src/wasm/\` (필요 시 audio_engine.c 보강)
- \`vendor/audio_engine_browser.js\` 갱신
- \`manifest.json\` accept 확장자 보강

## 작업 단계
1. PCM raw s16le mono 16kHz 디코더 (헤더 없는 raw → 사용자 옵션)
2. AIFF/AMR/AC3: dr_libs 또는 별도 라이브러리 도입
3. WASM 빌드 스크립트 갱신
4. manifest accept 갱신 (#5 와 연동)

## DoD
- [ ] 새 확장자 5종 모두 viewer 진입 + 디코딩 시도
- [ ] 디코딩 실패 시 명확한 에러 메시지

## 수동 테스트
- [ ] 각 확장자 샘플 1개씩

## 자동 테스트
- [ ] decoder 선택 함수 단위 테스트

## 의존
- #24, #5

## 비고
- 예상 규모: L (WASM 확장 포함 시)
BODY
)"

create "[Audio] 컨텍스트 메뉴 + 키보드 단축키 보강" "$(cat <<'BODY'
## 배경
우클릭 컨텍스트 메뉴 (region 복사/내보내기/loop on)와 단축키 (Space/← →/+ -).

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/audio/audioViewer.html\` (#contextMenu)
- \`src/templates/audio/js/AudioController/managers/EventManager.js\`

## 구현 위치 (omni-viewer-chrome)
- 동일 경로

## 작업 단계
1. waveform 우클릭 → 컨텍스트 메뉴 표시
2. region 위 우클릭 시 region 전용 메뉴
3. 단축키: Space play/pause, ←→ ±5s, Shift+←→ ±0.5s, +/- zoom, L loop toggle
4. input/select 위에서는 비활성

## DoD
- [ ] 컨텍스트 메뉴 7개 항목 동작
- [ ] 단축키 충돌 없음

## 수동 테스트
- [ ] 다른 viewer 와 단축키 일관성

## 자동 테스트
- [ ] 키 핸들러 단위

## 의존
- #24

## 비고
- 예상 규모: S
BODY
)"

# ============================================================
# Video
# ============================================================

create "[Video] viewer 분리 + 기본 플레이어 골격" "$(cat <<'BODY'
## 배경
현재 video 는 app.js 의 단순 \`<video controls>\`. templates/video 디렉토리로 분리하고 file-info / playback-controls / progress-bar / 키보드 등 풀 UI 도입을 위한 골격 작성.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/videoViewer.html\` (640 라인)
- \`src/videoViewerProvider.ts\`

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/video/videoViewer.html\`
- \`src/templates/video/css/videoViewer.css\`
- \`src/templates/video/js/videoViewer.js\`
- \`src/videoViewerProvider.ts\`

## 작업 단계
1. videoViewer.html 의 컨테이너/header/file-info/controls/progress-bar 구조 차용
2. 자체 컨트롤로 native controls 대체 (커스텀)
3. video.duration / video.currentTime / video.playbackRate / video.volume 바인딩

## DoD
- [ ] 기본 재생/일시정지/볼륨 동작
- [ ] file-info 패널에 duration/resolution/format/fileSize 표기

## 수동 테스트
- [ ] mp4/webm/mov 회귀

## 자동 테스트
- [ ] (없음)

## 의존
- #2

## 비고
- 예상 규모: M
BODY
)"

create "[Video] Loop region + 재생속도 + skip ±10s" "$(cat <<'BODY'
## 배경
구간 반복, 0.25~4x 재생속도, ±10s 점프 누락.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/videoViewer.html\` 의 #playbackSpeed/#skipBackward/#skipForward

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/video/js/videoViewer.js\`

## 작업 단계
1. playbackSpeed select (0.25/0.5/0.75/1/1.25/1.5/2/4)
2. skipBackward/skipForward 버튼 (currentTime ±10)
3. Loop region: A/B 마커 설정 + 자동 반복

## DoD
- [ ] 8단계 속도 정확
- [ ] A/B 반복이 audio drift 없이 동작

## 수동 테스트
- [ ] 60분짜리 비디오에서 검증

## 자동 테스트
- [ ] (수동)

## 의존
- #28

## 비고
- 예상 규모: M
BODY
)"

create "[Video] 줌/Fit + 진행 바 + 시간 표시" "$(cat <<'BODY'
## 배경
컨트롤 줌 (#zoomOut/#zoomIn/#zoomFit), 자체 progressBar + currentTime/totalTime 표기.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/videoViewer.html\` 의 #progressBar/#progressFilled/#currentTime/#totalTime/#zoomLabel

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/video/js/videoViewer.js\`

## 작업 단계
1. video element CSS scale 로 줌 (또는 width/height)
2. progressBar 클릭 → seek
3. timeupdate 로 progressFilled width 갱신
4. zoomLabel 100/125/150/200% 단계

## DoD
- [ ] 시간 표시 m:ss / h:mm:ss
- [ ] progressBar 정확한 seek

## 수동 테스트
- [ ] HiDPI 디스플레이에서 fit 동작

## 자동 테스트
- [ ] formatTime 단위 테스트

## 의존
- #28

## 비고
- 예상 규모: M
BODY
)"

create "[Video] 정보 표시 + 키보드 단축키" "$(cat <<'BODY'
## 배경
duration/resolution/format/fileSize 표시 + Space/←→/F/M 등 단축키.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/videoViewer.html\` 의 #fileInfo
- 텍스트 컨트롤 키보드 핸들러

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/video/js/videoViewer.js\`

## 작업 단계
1. videoWidth × videoHeight, file.size, container detect
2. Space play/pause, ←→ ±5s, F fullscreen, M mute, +/- volume
3. 입력 포커스 시 단축키 비활성

## DoD
- [ ] 모든 단축키 + 정보 표기 동작

## 수동 테스트
- [ ] fullscreen 진입/종료

## 자동 테스트
- [ ] (수동)

## 의존
- #28

## 비고
- 예상 규모: S
BODY
)"

create "[Video] 추가 확장자 (MTS/M2TS/AVI/WMV/FLV/MKV)" "$(cat <<'BODY'
## 배경
manifest 와 라우터에 누락된 확장자 추가. 브라우저 지원 코덱 한계는 안내 문구로 처리.

## 참고 코드 (vscode-omni-viewer)
- \`package.json\` 의 videoViewer selector

## 구현 위치 (omni-viewer-chrome)
- \`manifest.json\`
- \`src/router.ts\` / \`fileUtils\`

## 작업 단계
1. manifest accept 보강 (#5 와 같이)
2. router 매핑
3. 디코딩 불가 시 \"브라우저 미지원\" 메시지 + 다운로드 옵션

## DoD
- [ ] 6 확장자 모두 viewer 진입
- [ ] 미지원 코덱일 때 우아한 실패

## 수동 테스트
- [ ] mts/avi/mkv 샘플 1개씩

## 자동 테스트
- [ ] (수동)

## 의존
- #28, #5

## 비고
- 예상 규모: S
BODY
)"

# ============================================================
# CSV
# ============================================================

create "[CSV] 컬럼 정렬 (numeric/text aware)" "$(cat <<'BODY'
## 배경
헤더 클릭 시 정렬, 숫자/문자 자동 판별. 현재 omni-viewer-chrome 은 정렬 없음.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/csv/js/csvViewer.js\` 정렬 부분

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/csv/js/csvViewer.js\`
- \`src/templates/csv/css/csvViewer.css\`

## 작업 단계
1. 헤더 th 에 클릭 핸들러 + sort indicator (↑↓)
2. 컬럼 샘플로 numeric/date/text 판별
3. 안정 정렬 (Array.prototype.sort 보완)
4. 페이지/검색과 호환

## DoD
- [ ] 다중 클릭 → asc/desc/none 사이클
- [ ] 숫자/날짜 정확 정렬

## 수동 테스트
- [ ] 1만 행 정렬 성능

## 자동 테스트
- [ ] sort 함수 단위 테스트

## 의존
- #2

## 비고
- 예상 규모: S
BODY
)"

create "[CSV] Delimiter 자동 감지" "$(cat <<'BODY'
## 배경
\`,\` / \`;\` / \`\t\` / \`|\` 자동 감지. 현재는 .tsv 만 \`\t\`.

## 참고 코드 (vscode-omni-viewer)
- \`src/utils/fileUtils/tabular.ts\` (delimiter 감지)
- \`src/templates/csv/js/csvViewer.js\`

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/csv/js/csvViewer.js\`
- \`src/utils/fileUtils/tabular.ts\` (이식)

## 작업 단계
1. 첫 N 라인 파싱하여 후보 delimiter 빈도 비교
2. 동률 시 우선순위: , > \t > ; > |
3. 사용자가 수동 변경 select 추가

## DoD
- [ ] 4종 delimiter 정확 감지
- [ ] 따옴표 escaping 보존

## 수동 테스트
- [ ] european 스타일 ; 구분
- [ ] pipe 분리 로그

## 자동 테스트
- [ ] tabular.ts 단위 테스트

## 의존
- #3

## 비고
- 예상 규모: S
BODY
)"

create "[CSV] Statistics 뷰 + 단축키" "$(cat <<'BODY'
## 배경
파일/데이터 통계 뷰 토글 + Ctrl+F (검색 포커스), Ctrl+C (필터 결과 복사).

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/csv/js/csvViewer.js\` 의 statistics

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/csv/js/csvViewer.js\`

## 작업 단계
1. row/col count, null 비율, numeric 컬럼 평균/min/max 계산
2. statistics 패널 토글 버튼
3. Ctrl+F 검색 input 포커스, Ctrl+C 클립보드 복사 (TSV)

## DoD
- [ ] 통계가 정확
- [ ] 단축키가 페이지 기본 동작과 충돌 없음

## 수동 테스트
- [ ] 큰 CSV (100k 행)

## 자동 테스트
- [ ] statistics 함수 단위 테스트

## 의존
- #33

## 비고
- 예상 규모: S
BODY
)"

# ============================================================
# Excel
# ============================================================

create "[Excel] 검색 + 페이지네이션" "$(cat <<'BODY'
## 배경
현재 Excel 뷰어는 첫 500행만 표시 + 검색/페이지네이션 없음.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/excel/excelViewer.html\` (#searchInput/#pagination)
- \`src/templates/excel/js/excelViewer.js\` (750 라인)

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/excel/excelViewer.html\`
- \`src/templates/excel/js/excelViewer.js\`
- \`src/templates/excel/css/excelViewer.css\`

## 작업 단계
1. 시트 전환 시 데이터 캐시
2. Search → 모든 컬럼 contains
3. Pagination N rows/page (예: 200), prev/next
4. row/col count 표시 (#rowCount/#columnCount)

## DoD
- [ ] 100k 행도 페이지 단위 부드러움
- [ ] 검색 결과 페이지 1로 reset

## 수동 테스트
- [ ] 다중 시트 전환 + 검색

## 자동 테스트
- [ ] pagination 헬퍼 단위

## 의존
- #2

## 비고
- 예상 규모: M
BODY
)"

create "[Excel] Copy/Export(JSON)" "$(cat <<'BODY'
## 배경
필터된 데이터 클립보드 복사 (TSV) + JSON export.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/excel/js/excelViewer.js\` copy/export

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/excel/js/excelViewer.js\`

## 작업 단계
1. Copy: navigator.clipboard.writeText(TSV)
2. JSON: array of objects { header: value }
3. toggle 버튼: copy / copyJson

## DoD
- [ ] 검색/페이징 후 보이는 데이터만 복사
- [ ] JSON 이 valid

## 수동 테스트
- [ ] 다른 앱(Excel/Numbers) 붙여넣기 정렬

## 자동 테스트
- [ ] toJson 함수 단위

## 의존
- #36

## 비고
- 예상 규모: S
BODY
)"

create "[Excel] Raw 토글 + 메타 정보" "$(cat <<'BODY'
## 배경
Raw JSON 뷰 + sheetInfo / fileSize / row/col 카운트 표기.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/excel/excelViewer.html\` (#rawDataWrapper/#fileInfo)

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/excel/excelViewer.html\`
- \`src/templates/excel/js/excelViewer.js\`

## 작업 단계
1. Toggle View 버튼 → table / raw 전환
2. raw 는 JSON.stringify(currentSheet, null, 2)
3. 시트 메타 정보 표시

## DoD
- [ ] 토글 시 스크롤 위치 보존
- [ ] raw 모드에서 검색은 disabled

## 수동 테스트
- [ ] 시트 변경 시 raw 도 갱신

## 자동 테스트
- [ ] (수동)

## 의존
- #36

## 비고
- 예상 규모: S
BODY
)"

# ============================================================
# Parquet
# ============================================================

create "[Parquet] hyparquet 브라우저 통합" "$(cat <<'BODY'
## 배경
현재 Parquet 뷰어는 footer length 만 표시. 실제 컬럼 파싱 없음. hyparquet 도입.

## 참고 코드 (vscode-omni-viewer)
- \`src/parquetViewerProvider.ts\`
- \`src/templates/parquet/js/parquetViewer.js\` (682 라인)
- \`src/types/hyparquet-node.d.ts\`

## 구현 위치 (omni-viewer-chrome)
- \`src/parquetViewerProvider.ts\`
- \`src/templates/parquet/js/parquetViewer.js\`
- \`src/templates/parquet/css/parquetViewer.css\`
- \`src/templates/parquet/parquetViewer.html\`
- \`vendor/hyparquet.min.js\` (UMD 번들 또는 webpack 번들 포함)

## 작업 단계
1. hyparquet 의 ParquetReader 로 schema + rows 읽기
2. Worker 로 큰 파일 비동기 처리
3. 컬럼 타입(int/float/string/binary/timestamp) 표시 변환

## DoD
- [ ] 1MB / 50MB 두 케이스 정상 파싱
- [ ] schema 표시

## 수동 테스트
- [ ] timestamp/decimal/list 타입 컬럼

## 자동 테스트
- [ ] (수동, 파일 의존)

## 의존
- #2

## 비고
- 예상 규모: L
BODY
)"

create "[Parquet] 검색/정렬/페이지네이션" "$(cat <<'BODY'
## 배경
hyparquet 데이터 위에서 클라이언트 검색/정렬/페이지네이션.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/parquet/js/parquetViewer.js\`

## 구현 위치 (omni-viewer-chrome)
- 동일 경로

## 작업 단계
1. row 단위 contains 검색
2. 컬럼 헤더 클릭 정렬
3. 페이지네이션 (N rows/page)

## DoD
- [ ] 1만 행에서 응답성 유지

## 수동 테스트
- [ ] 정렬 + 검색 조합

## 자동 테스트
- [ ] sort/filter 함수 단위

## 의존
- #39

## 비고
- 예상 규모: M
BODY
)"

create "[Parquet] 사이즈 가드 (≥150MB 차단, 50~150MB 10K rows 제한)" "$(cat <<'BODY'
## 배경
큰 Parquet 메모리 폭주 방지. README 의 정책 그대로 적용.

## 참고 코드 (vscode-omni-viewer)
- \`README.md\` Performance Notes 섹션
- \`src/templates/parquet/js/parquetViewer.js\` 의 limitWarning

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/parquet/js/parquetViewer.js\`
- \`src/templates/parquet/parquetViewer.html\` (#limitWarning)

## 작업 단계
1. 파일 size 검사 → 임계값 분기
2. ≥150MB: 명확한 에러 메시지 + 다운로드 옵션
3. 50~150MB: 10K rows 만 로드, limitWarning 표시 + Load More

## DoD
- [ ] 임계값 정책 일치
- [ ] limitMessage 가 총 행 수 명시

## 수동 테스트
- [ ] 49.9MB / 50.1MB / 149.9MB / 150.1MB 경계

## 자동 테스트
- [ ] threshold 함수 단위

## 의존
- #39

## 비고
- 예상 규모: S
BODY
)"

create "[Parquet] 10K rows 점진 로딩 + 컨텍스트 메뉴" "$(cat <<'BODY'
## 배경
\"Load Next 10,000 Rows\" 버튼 + 셀 우클릭 컨텍스트 메뉴.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/parquet/js/parquetViewer.js\`
- \`src/templates/parquet/parquetViewer.html\` (#contextMenu)

## 구현 위치 (omni-viewer-chrome)
- 동일 경로

## 작업 단계
1. loadMoreRowsButton 클릭 → 다음 10K 로드 + 진행률 표시
2. 컨텍스트 메뉴: 셀 값 복사 / 컬럼 복사 / 행 JSON 복사
3. progress 표시 \"X / Y rows loaded\"

## DoD
- [ ] 점진 로딩이 UI 차단 없이 진행
- [ ] 컨텍스트 메뉴 클릭 일관성

## 수동 테스트
- [ ] 100K 행 점진 로딩

## 자동 테스트
- [ ] (수동)

## 의존
- #41

## 비고
- 예상 규모: M
BODY
)"

# ============================================================
# Word
# ============================================================

create "[Word] 줌 컨트롤 + 인쇄" "$(cat <<'BODY'
## 배경
현재 docx-preview 만 사용. 줌(Ctrl+/-/0)/인쇄(Ctrl+P) 누락.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/word/js/wordViewer.js\` (1899 라인)
- \`src/templates/word/wordViewer.html\`

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/word/wordViewer.html\`
- \`src/templates/word/js/wordViewer.js\`
- \`src/templates/word/css/wordViewer.css\`

## 작업 단계
1. 컨테이너 CSS zoom 적용 (10단계)
2. window.print() + print-only stylesheet
3. 키보드 단축키 핸들러

## DoD
- [ ] 50%~250% 줌
- [ ] 인쇄 미리보기 정상

## 수동 테스트
- [ ] 큰 .docx (100p+) 인쇄

## 자동 테스트
- [ ] (수동)

## 의존
- #2

## 비고
- 예상 규모: S
BODY
)"

create "[Word] .doc legacy 렌더 (docBinaryParser 이식)" "$(cat <<'BODY'
## 배경
.doc (Word 97-2003) 은 현재 fallback 으로도 안 열림. VSCode 측 \`docBinaryParser.ts\` (187KB) 이식.

## 참고 코드 (vscode-omni-viewer)
- \`src/utils/docBinaryParser.ts\`
- \`src/utils/fileUtils/word.ts\`
- \`src/__tests__/docBinaryParser.test.ts\`

## 구현 위치 (omni-viewer-chrome)
- \`src/utils/docBinaryParser.ts\`
- \`src/utils/fileUtils/word.ts\`
- \`src/templates/word/js/wordViewer.js\`

## 작업 단계
1. CFB 컨테이너 파싱 → WordDocument stream
2. 단락/스타일/표 추출 → HTML 변환
3. 문자 인코딩 (CP949/UTF-16) 처리
4. mammoth fallback 우회

## DoD
- [ ] 한글/영문 .doc 모두 텍스트 표시
- [ ] 단순 표 렌더

## 수동 테스트
- [ ] 1990s .doc / Korean encoding .doc

## 자동 테스트
- [ ] docBinaryParser.test.ts 이식

## 의존
- #43

## 비고
- 예상 규모: L
BODY
)"

create "[Word] 임베디드 워크북 + SVG 차트 미리보기" "$(cat <<'BODY'
## 배경
.doc/.docx 안에 임베디드된 Excel 시트 / 차트 표시.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/word/js/wordViewer.js\` (embedded workbook/chart)

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/word/js/wordViewer.js\`

## 작업 단계
1. OOXML 의 embeddings 디렉토리 스캔
2. xlsx → 작은 표로 inline 표시
3. 차트 XML → 단순 SVG 변환

## DoD
- [ ] 워크북/차트 1개씩 정확 표시

## 수동 테스트
- [ ] PowerPoint 의 차트 포함 docx

## 자동 테스트
- [ ] (수동)

## 의존
- #43

## 비고
- 예상 규모: M
BODY
)"

# ============================================================
# PPT
# ============================================================

create "[PPT] pptxXmlParser 이식 (실 슬라이드 렌더)" "$(cat <<'BODY'
## 배경
현재 pptx 는 \`<a:t>\` 정규식으로 텍스트만 추출. 도형/이미지/레이아웃 미반영. VSCode 측 pptxXmlParser (72KB) 이식.

## 참고 코드 (vscode-omni-viewer)
- \`src/utils/pptxXmlParser.ts\`
- \`src/__tests__/pptxXmlParser.test.ts\`
- \`src/templates/ppt/js/pptViewer.js\` (1230 라인)

## 구현 위치 (omni-viewer-chrome)
- \`src/utils/pptxXmlParser.ts\`
- \`src/templates/ppt/js/pptViewer.js\`

## 작업 단계
1. ppt/slides/slide*.xml + slideLayouts + slideMasters + theme 파싱
2. shape geometry → SVG/HTML
3. text run / paragraph / bullets / fonts
4. picture (relationship → media/image*.png)

## DoD
- [ ] 도형/텍스트박스/이미지 보임
- [ ] 레이아웃 적용 (제목/본문)

## 수동 테스트
- [ ] 5종 다른 디자인 pptx

## 자동 테스트
- [ ] pptxXmlParser.test.ts 이식

## 의존
- #2

## 비고
- 예상 규모: XL
BODY
)"

create "[PPT] 슬라이드 도형/텍스트박스/이미지/레이아웃 적용" "$(cat <<'BODY'
## 배경
pptxXmlParser 결과를 실제 캔버스/HTML 로 렌더.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/ppt/js/pptViewer.js\` 의 렌더 부분
- \`src/utils/pptSlideLayouts.ts\`

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/ppt/js/pptViewer.js\`
- \`src/utils/pptSlideLayouts.ts\`

## 작업 단계
1. EMU → px 좌표 변환
2. shape fill / line / font 스타일 매핑
3. layout placeholder 매칭
4. 슬라이드 비율 보존 (4:3, 16:9, custom)

## DoD
- [ ] 슬라이드 위치/크기가 PowerPoint 와 유사

## 수동 테스트
- [ ] 16:9 / 4:3 / custom

## 자동 테스트
- [ ] layout 매칭 단위

## 의존
- #46

## 비고
- 예상 규모: L
BODY
)"

create "[PPT] .ppt legacy (pptBinaryParser 이식)" "$(cat <<'BODY'
## 배경
.ppt (PowerPoint 97-2003) 바이너리 파서 이식.

## 참고 코드 (vscode-omni-viewer)
- \`src/utils/pptBinaryParser.ts\` (143KB)
- \`src/utils/pptBinaryContainer.ts\`
- \`src/utils/pptBinaryBuildContext.ts\`
- \`src/utils/pptBinaryTypes.ts\`
- \`src/__tests__/pptBinaryParser.test.ts\`

## 구현 위치 (omni-viewer-chrome)
- \`src/utils/pptBinary*.ts\`
- \`src/templates/ppt/js/pptViewer.js\`

## 작업 단계
1. CFB 컨테이너 파싱
2. PPT record 트리 → 슬라이드/도형/텍스트
3. legacy color/font 처리
4. 인코딩

## DoD
- [ ] 한글/영문 .ppt 슬라이드 표시
- [ ] 도형 위치 정확도 80%+

## 수동 테스트
- [ ] 1990s/2000s .ppt 샘플

## 자동 테스트
- [ ] pptBinaryParser.test.ts 이식

## 의존
- #46, #47

## 비고
- 예상 규모: XL
BODY
)"

create "[PPT] Slide jump dropdown + 줌 컨트롤" "$(cat <<'BODY'
## 배경
슬라이드 점프 select + 줌 (Ctrl+/-/0).

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/ppt/pptViewer.html\`
- \`src/templates/ppt/js/pptViewer.js\`

## 구현 위치 (omni-viewer-chrome)
- 동일 경로

## 작업 단계
1. select option N 슬라이드
2. 선택 시 scrollIntoView
3. 줌 단계 6개

## DoD
- [ ] 점프 + 줌 동작
- [ ] 키보드 단축키

## 수동 테스트
- [ ] 100 슬라이드

## 자동 테스트
- [ ] (수동)

## 의존
- #47

## 비고
- 예상 규모: S
BODY
)"

# ============================================================
# PSD
# ============================================================

create "[PSD] ag-psd 브라우저 통합 + composite 렌더" "$(cat <<'BODY'
## 배경
현재 PSD 는 헤더 메타데이터만 표시. ag-psd 브라우저 번들 도입해 composite 캔버스 렌더.

## 참고 코드 (vscode-omni-viewer)
- \`src/psdViewerProvider.ts\`
- \`src/templates/psd/js/psdViewer.js\`
- \`src/templates/psd/psdViewer.html\`

## 구현 위치 (omni-viewer-chrome)
- \`src/psdViewerProvider.ts\`
- \`src/templates/psd/psdViewer.html\`
- \`src/templates/psd/js/psdViewer.js\`
- \`src/templates/psd/css/psdViewer.css\`
- \`vendor/ag-psd.min.js\`

## 작업 단계
1. ag-psd readPsd(arrayBuffer, { useImageData: true })
2. canvas 에 composite 렌더
3. document 크기 / 채널 / depth 표시

## DoD
- [ ] 다양한 PSD 정상 composite
- [ ] 큰 PSD (200MB) 메모리 가드

## 수동 테스트
- [ ] 8/16/32 bit
- [ ] 레이어 100개 PSD

## 자동 테스트
- [ ] (수동)

## 의존
- #2

## 비고
- 예상 규모: M
BODY
)"

create "[PSD] Layer panel + per-layer visibility" "$(cat <<'BODY'
## 배경
좌측 레이어 트리 + 가시성 토글 (eye icon).

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/psd/js/psdViewer.js\` 의 layer panel

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/psd/js/psdViewer.js\`

## 작업 단계
1. layer 트리 (그룹/레이어) depth indent
2. eye toggle → 가시성 변경
3. 보이는 layer 만 다시 composite (leaf 만)
4. 그룹 토글 시 자식 일괄

## DoD
- [ ] 가시성 변경 시 캔버스 정확 갱신

## 수동 테스트
- [ ] 깊은 그룹 (4단)

## 자동 테스트
- [ ] visibility reducer 단위

## 의존
- #50

## 비고
- 예상 규모: M
BODY
)"

create "[PSD] View modal + 투명도 체커보드" "$(cat <<'BODY'
## 배경
단일 레이어 확대 모달 + 투명 영역 체커보드.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/psd/js/psdViewer.js\`
- \`src/templates/psd/css/psdViewer.css\`

## 구현 위치 (omni-viewer-chrome)
- 동일 경로

## 작업 단계
1. 레이어 row 의 \"View\" 버튼 → modal 캔버스
2. 투명 부분 8x8 체커보드 배경
3. ESC/오버레이 클릭 닫기

## DoD
- [ ] 모달 closable + 투명도 시각화

## 수동 테스트
- [ ] 알파 채널 PSD

## 자동 테스트
- [ ] (수동)

## 의존
- #51

## 비고
- 예상 규모: S
BODY
)"

# ============================================================
# HWP
# ============================================================

create "[HWP] rhwp WASM 통합 (binary .hwp 렌더)" "$(cat <<'BODY'
## 배경
\.hwp 는 현재 미지원. rhwp wasm/js 자산이 vendor/ 에 있으나 통합 안 됨.

## 참고 코드 (vscode-omni-viewer)
- \`src/hwpViewerProvider.ts\`
- \`src/templates/hwp/js/hwpViewerMain.js\`
- \`src/templates/hwp/vendor/rhwp/rhwp.js\`
- \`src/templates/hwp/vendor/rhwp/rhwp_bg.wasm\`
- \`scripts/sync-rhwp-assets.js\`

## 구현 위치 (omni-viewer-chrome)
- \`src/hwpViewerProvider.ts\`
- \`src/templates/hwp/hwpViewer.html\`
- \`src/templates/hwp/js/hwpViewerMain.js\`
- \`src/templates/hwp/css/hwpViewer.css\`
- \`vendor/rhwp.js\` / \`vendor/rhwp_bg.wasm\` (이미 존재, 통합)

## 작업 단계
1. rhwp init (locateFile → chrome.runtime.getURL)
2. ArrayBuffer → 렌더 호출
3. 페이지 단위 캔버스 출력
4. 한글 폰트 fallback

## DoD
- [ ] 한글 .hwp 페이지 텍스트/도형 보임
- [ ] WASM 로딩 에러 시 명확한 안내

## 수동 테스트
- [ ] 일반 한글 .hwp / 표 포함 .hwp

## 자동 테스트
- [ ] (수동)

## 의존
- #2, #6

## 비고
- 예상 규모: L
BODY
)"

create "[HWP] HWPX 실 렌더 + hwpDocumentParser 이식" "$(cat <<'BODY'
## 배경
HWPX 는 현재 zip 의 section XML 텍스트만 추출. 진짜 단락/스타일 렌더 + hwpDocumentParser 이식.

## 참고 코드 (vscode-omni-viewer)
- \`src/utils/hwpDocumentParser.ts\` (133KB)
- \`src/utils/hwpDocumentTypes.ts\`

## 구현 위치 (omni-viewer-chrome)
- \`src/utils/hwpDocumentParser.ts\`
- \`src/utils/hwpDocumentTypes.ts\`
- \`src/templates/hwp/js/hwpViewerMain.js\`

## 작업 단계
1. HWPX schema → DOM 트리 변환
2. 단락/표/이미지 렌더
3. \.hwp/\.hwpx 통합 라우팅

## DoD
- [ ] HWPX 가 텍스트만이 아닌 레이아웃 표현

## 수동 테스트
- [ ] HWPX 표/이미지

## 자동 테스트
- [ ] hwpDocumentParser 단위 (가능 범위)

## 의존
- #53

## 비고
- 예상 규모: L
BODY
)"

# ============================================================
# Archive
# ============================================================

create "[Archive] libarchive worker 통합" "$(cat <<'BODY'
## 배경
vendor/ 에 libarchive-worker-bundle.js / libarchive.wasm 존재하나 통합 안 됨. ZIP 외 포맷 위해 필수.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/archive/js/archiveViewer.js\`
- \`src/archiveViewerProvider.ts\`

## 구현 위치 (omni-viewer-chrome)
- \`src/archiveViewerProvider.ts\`
- \`src/templates/archive/archiveViewer.html\`
- \`src/templates/archive/css/archiveViewer.css\`
- \`src/templates/archive/js/archiveViewer.js\`
- \`vendor/libarchive*\` 통합

## 작업 단계
1. Worker 로 libarchive 인스턴스 init (locateFile)
2. archive 열기 → 엔트리 메타 (path/size/dir)
3. 엔트리 추출 (preview)
4. 에러 처리

## DoD
- [ ] zip / tar / gz 1개씩 동작

## 수동 테스트
- [ ] 큰 archive (1GB)

## 자동 테스트
- [ ] worker mock 단위

## 의존
- #6

## 비고
- 예상 규모: L
BODY
)"

create "[Archive] TAR/GZ/TGZ/TBZ2/TXZ + 7Z/RAR" "$(cat <<'BODY'
## 배경
libarchive 가 지원하는 컨테이너 형식 라우팅 활성화.

## 참고 코드 (vscode-omni-viewer)
- \`src/utils/fileUtils/archive.ts\`
- \`src/templates/archive/js/archiveViewer.js\`

## 구현 위치 (omni-viewer-chrome)
- 동일 경로

## 작업 단계
1. 시그니처 detect: tar (ustar), gz (1f 8b), bz2 (BZh), xz (FD 37 7A 58 5A 00), 7z (37 7A BC AF 27 1C), rar (Rar!)
2. router 매핑
3. 각 포맷별 타입 라벨

## DoD
- [ ] 6 종 archive 모두 entry 표시

## 수동 테스트
- [ ] 각 포맷 샘플

## 자동 테스트
- [ ] signature 단위

## 의존
- #55, #5

## 비고
- 예상 규모: M
BODY
)"

create "[Archive] archivePreviewDecoder (내부 파일 미리보기)" "$(cat <<'BODY'
## 배경
archive 안의 텍스트/이미지/오디오를 클릭 시 인플레이스 미리보기.

## 참고 코드 (vscode-omni-viewer)
- \`src/utils/fileUtils/archivePreviewDecoder.ts\`
- \`src/__tests__/archivePreviewDecoder.test.ts\`

## 구현 위치 (omni-viewer-chrome)
- \`src/utils/fileUtils/archivePreviewDecoder.ts\`
- \`src/templates/archive/js/archiveViewer.js\`

## 작업 단계
1. 엔트리 클릭 → 추출
2. 텍스트(<256KB) 는 inline, 이미지는 blob URL, 미디어는 ObjectURL
3. preview pane

## DoD
- [ ] 일반적인 텍스트/이미지 미리보기

## 수동 테스트
- [ ] 깊은 디렉토리

## 자동 테스트
- [ ] archivePreviewDecoder.test.ts 이식

## 의존
- #55

## 비고
- 예상 규모: M
BODY
)"

create "[Archive] 새 확장자 매핑 (DMG 등)" "$(cat <<'BODY'
## 배경
\.dmg \.tbz2 \.tar.bz2 \.txz \.tar.xz \.bz2 \.xz 매핑.

## 참고 코드 (vscode-omni-viewer)
- \`package.json\` archiveViewer selector

## 구현 위치 (omni-viewer-chrome)
- \`manifest.json\`
- \`src/router.ts\` / \`src/utils/fileUtils/archive.ts\`

## 작업 단계
1. manifest accept 보강
2. router 매핑
3. DMG (HFS+/APFS) 는 libarchive 가 일부만 지원 → 명확한 안내

## DoD
- [ ] 새 확장자 모두 routing

## 수동 테스트
- [ ] DMG / tar.bz2

## 자동 테스트
- [ ] (수동)

## 의존
- #55, #5

## 비고
- 예상 규모: S
BODY
)"

# ============================================================
# JSONL
# ============================================================

create "[JSONL] Hover popup" "$(cat <<'BODY'
## 배경
라인 hover 시 포맷팅된 JSON 팝업 표시.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/jsonl/js/jsonlViewer.js\` (1237 라인)
- \`src/templates/jsonl/jsonlViewer.html\`

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/jsonl/jsonlViewer.html\`
- \`src/templates/jsonl/js/jsonlViewer.js\`
- \`src/templates/jsonl/css/jsonlViewer.css\`

## 작업 단계
1. 라인 mouseenter 디바운스 → 팝업 표시
2. JSON.stringify(parsed, null, 2)
3. 위치: 마우스 옆, viewport 경계 보정

## DoD
- [ ] hover 시 부드러운 표시
- [ ] mouseleave 시 즉시 사라짐

## 수동 테스트
- [ ] 큰 라인 (>5KB)

## 자동 테스트
- [ ] popup positioning 단위

## 의존
- #2

## 비고
- 예상 규모: M
BODY
)"

create "[JSONL] Click-to-edit + 인라인 편집 + 실시간 검증" "$(cat <<'BODY'
## 배경
팝업 클릭 시 인라인 편집, 또는 라인 직접 수정. 실시간 valid/invalid 표기.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/jsonl/js/jsonlViewer.js\`

## 구현 위치 (omni-viewer-chrome)
- 동일 경로

## 작업 단계
1. 팝업 textarea 모드 + Save/Cancel
2. 입력 시 try/catch JSON.parse → 시각 피드백
3. 라인 ↔ 팝업 양방향 동기화
4. 변경된 JSONL 다운로드

## DoD
- [ ] 편집 후 표 행/팝업 동기화
- [ ] invalid 시 명확한 에러 위치

## 수동 테스트
- [ ] 따옴표/이스케이프 케이스

## 자동 테스트
- [ ] validator 단위

## 의존
- #59

## 비고
- 예상 규모: L
BODY
)"

create "[JSONL] 신택스 하이라이트" "$(cat <<'BODY'
## 배경
JSON 키/문자열/숫자/null/bool 색상 표기.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/jsonl/js/jsonlViewer.js\` syntax highlight

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/jsonl/css/jsonlViewer.css\`
- \`src/templates/jsonl/js/jsonlViewer.js\`

## 작업 단계
1. 가벼운 토크나이저 (정규식 기반)
2. CSS 클래스 적용 (.tok-key/.tok-str/.tok-num/.tok-bool/.tok-null)
3. 다크/라이트 테마 모두

## DoD
- [ ] 컬러링 정확
- [ ] 큰 라인 성능

## 수동 테스트
- [ ] 한글 문자열 / 이모지

## 자동 테스트
- [ ] tokenizer 단위

## 의존
- #59

## 비고
- 예상 규모: M
BODY
)"

# ============================================================
# JSON
# ============================================================

create "[JSON] 검색 + 노드 접기" "$(cat <<'BODY'
## 배경
JSON 트리뷰에서 키/값 검색 + 노드 접기/펼치기.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/json/js/jsonViewer.js\` (523 라인)
- \`src/templates/json/jsonViewer.html\`

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/json/jsonViewer.html\`
- \`src/templates/json/js/jsonViewer.js\`
- \`src/templates/json/css/jsonViewer.css\`

## 작업 단계
1. 트리 노드별 토글 버튼 (▶ ▼)
2. 검색 input → 매칭 노드 강조 + 부모 자동 펼침
3. 키보드: Ctrl+F 포커스, n/N 다음/이전

## DoD
- [ ] 깊이 5+ JSON 도 부드러움
- [ ] 검색 결과 강조

## 수동 테스트
- [ ] 큰 JSON (10MB)

## 자동 테스트
- [ ] tree state reducer 단위

## 의존
- #2

## 비고
- 예상 규모: M
BODY
)"

create "[JSON] 신택스 하이라이트" "$(cat <<'BODY'
## 배경
Source 모드에서 JSON 색상 표기.

## 참고 코드 (vscode-omni-viewer)
- \`src/templates/json/js/jsonViewer.js\`

## 구현 위치 (omni-viewer-chrome)
- \`src/templates/json/js/jsonViewer.js\`
- \`src/templates/json/css/jsonViewer.css\`

## 작업 단계
1. 토크나이저 (#61 과 공유 가능)
2. CSS 클래스 적용

## DoD
- [ ] 컬러링 정확

## 수동 테스트
- [ ] 다크/라이트

## 자동 테스트
- [ ] tokenizer 단위

## 의존
- #62

## 비고
- 예상 규모: S
BODY
)"

# ============================================================
# YAML / TOML
# ============================================================

create "[YAML] yamlNodeBuilder 이식 + 검색/접기" "$(cat <<'BODY'
## 배경
YAML 트리 뷰 + 검색/접기. 현재는 단순 jsyaml.load → JSON 트리.

## 참고 코드 (vscode-omni-viewer)
- \`src/utils/yamlNodeBuilder.ts\`
- \`src/templates/yaml/js/yamlViewer.js\` (514 라인)

## 구현 위치 (omni-viewer-chrome)
- \`src/utils/yamlNodeBuilder.ts\`
- \`src/templates/yaml/yamlViewer.html\`
- \`src/templates/yaml/js/yamlViewer.js\`
- \`src/templates/yaml/css/yamlViewer.css\`

## 작업 단계
1. yaml 의 AST → 노드 트리 (anchor/alias/comment 보존)
2. 검색/접기 (#62 와 패턴 공유)
3. Source / Tree 토글

## DoD
- [ ] anchor/alias 정확 표현

## 수동 테스트
- [ ] kubernetes manifest

## 자동 테스트
- [ ] yamlNodeBuilder 단위

## 의존
- #2

## 비고
- 예상 규모: M
BODY
)"

create "[TOML] tomlParser 이식 + 트리 뷰/검색" "$(cat <<'BODY'
## 배경
현재 TOML 은 raw text 만. tomlParser (19KB) 이식해 트리 표시.

## 참고 코드 (vscode-omni-viewer)
- \`src/utils/tomlParser.ts\`
- \`src/templates/toml/js/tomlViewer.js\` (421 라인)

## 구현 위치 (omni-viewer-chrome)
- \`src/utils/tomlParser.ts\`
- \`src/templates/toml/tomlViewer.html\`
- \`src/templates/toml/js/tomlViewer.js\`
- \`src/templates/toml/css/tomlViewer.css\`

## 작업 단계
1. TOML AST 빌드 (table/array of tables/inline table)
2. 트리/소스 토글
3. 검색/접기

## DoD
- [ ] 표준 TOML 1.0 케이스 모두

## 수동 테스트
- [ ] cargo.toml / pyproject.toml

## 자동 테스트
- [ ] tomlParser 단위

## 의존
- #2

## 비고
- 예상 규모: M
BODY
)"

# ============================================================
# Share / QA
# ============================================================

create "[Share] 공유 업로드 (옵션, 사이즈 가드 10MB)" "$(cat <<'BODY'
## 배경
VSCode 측 \`shareCommand.ts\` 와 동등한 업로드 → share_id 발급. README 의 정책: 단일 파일, 5분 만료, 10MB 제한.

## 참고 코드 (vscode-omni-viewer)
- \`src/shareCommand.ts\`

## 구현 위치 (omni-viewer-chrome)
- \`src/shareCommand.ts\` (브라우저용 변환)
- \`src/templates/<viewer>/<viewer>Viewer.html\` 의 {{omniShareButtons}}
- \`manifest.json\` host_permissions 추가 (share API base)

## 작업 단계
1. POST /upload-token → JWT 받기
2. multipart upload
3. POST /share → share_id
4. 사이즈/만료/링크 모달

## DoD
- [ ] 10MB 가드
- [ ] 실패 케이스 안내

## 수동 테스트
- [ ] 텍스트/바이너리/한글 파일명

## 자동 테스트
- [ ] payload 빌더 단위

## 의존
- #4 (messageHandler)

## 비고
- 예상 규모: L
- 정책 페이지/약관 노출 필요
BODY
)"

create "[Share] 공유 링크 열기 (옵션)" "$(cat <<'BODY'
## 배경
share_id 또는 URL 입력 → 다운로드 → 적절한 viewer 라우팅.

## 참고 코드 (vscode-omni-viewer)
- \`src/shareCommand.ts\` openSharedLinkCommand

## 구현 위치 (omni-viewer-chrome)
- \`src/shareCommand.ts\`

## 작업 단계
1. 입력 모달 (share URL 또는 ID)
2. ticket fetch → download_url
3. 파일 다운로드 → File 객체화
4. router 위임

## DoD
- [ ] 만료된 링크 (410) 안내
- [ ] 라우팅 정확

## 수동 테스트
- [ ] 정상 / 만료 / 잘못된 ID

## 자동 테스트
- [ ] URL 파서 단위

## 의존
- #66

## 비고
- 예상 규모: M
BODY
)"

create "[QA] 스토어 출시 매뉴얼 + 정책 페이지 + 권한 최소화" "$(cat <<'BODY'
## 배경
Chrome Web Store 게시 전 체크리스트: 권한 최소화, 개인정보 정책 URL, 스토어 자료(스크린샷, 설명, 약속) 준비.

## 참고 코드 (vscode-omni-viewer)
- \`README.md\` Privacy 섹션
- \`open-vsx-listing-privacy.md\`

## 구현 위치 (omni-viewer-chrome)
- \`store/\` (스크린샷/설명/약관)
- \`store/privacy.md\`
- \`manifest.json\` permissions 검토

## 작업 단계
1. 권한 재검토 (storage 외 추가 시 정당화 명시)
2. 개인정보 처리방침 URL 등록
3. 스크린샷 5장(각 viewer 대표)
4. 영문/한국어 설명
5. 호스트 권한 사용 정당화 (share 한정)

## DoD
- [ ] 스토어 검수 통과 자료 일체
- [ ] 권한 최소화 확인

## 수동 테스트
- [ ] 검수 거절 시 빠른 회신 가능 자료 정리

## 자동 테스트
- [ ] (없음)

## 의존
- #1, #66

## 비고
- 예상 규모: M
BODY
)"

echo "=== DONE ==="
