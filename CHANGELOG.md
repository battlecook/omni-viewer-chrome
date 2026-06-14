# Changelog

All notable changes to the Chrome build of Omni Viewer are documented in this file.

## [0.1.0] - 2026-06-14

### Added
- Added local Chrome viewers for images, PDF, CSV/TSV, JSON/JSONL, YAML,
  TOML, Markdown, Mermaid, PlantUML, audio, video, Office documents, PSD,
  Parquet, HWP/HWPX, automotive files, and archives.
- Added temporary file sharing with a 10 MB client-side limit and five-minute
  expiration.
- Added Firebase anonymous authentication for Share API uploads.
- Added `platform=chrome` metadata to shared-file uploads.
- Added Share and Open Link actions to the main viewer and file headers.
- Added clipboard copying and a temporary clickable popup for generated share
  URLs.
- Added support for opening a full Omni Viewer share URL or a bare share ID and
  routing the downloaded file through the normal viewer pipeline.
- Added a background service worker download transport for signed Google Cloud
  Storage URLs, including host and bucket-path validation.
- Added unit and integration coverage for anonymous authentication, share
  uploads, share URL parsing, download handling, and manifest permissions.
- Added a language picker with a persisted system-default or explicit locale
  preference across 69 supported locales.
- Added translated viewer messages and locale override support, including
  placeholder substitution for the selected language.
- Added a locale translation maintenance script and tests for selected-locale
  message resolution.
- Added Chrome Web Store icon and screenshot source assets.
- Added bundled third-party license texts to extension release packages.

### Changed
- Replaced the placeholder Share API host and endpoints with the production
  Omni Viewer Share API contract.
- Updated Chrome host permissions for the Share API, Firebase Authentication,
  token refresh, and signed share-file downloads.
- Updated Chrome Web Store privacy, permission, and release-checklist
  documentation for the Share feature.
- Revised the Chrome Web Store listing copy to describe viewer capabilities
  without repetitive format and keyword lists.
- Updated copyright attribution and third-party font and dependency notices.

### Fixed
- Fixed Open Link downloads failing when signed Google Cloud Storage URLs could
  not be fetched directly from the viewer page.
- Added direct-download fallback and actionable extension reload guidance when
  the updated background service worker is not available to an existing tab.
