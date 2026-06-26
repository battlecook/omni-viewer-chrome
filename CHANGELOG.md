# Changelog

All notable changes to the Chrome build of Omni Viewer are documented in this file.

## [0.2.0] - 2026-06-26

### Added
- Added dedicated Chrome viewer registrations and file routing for Avro, ROS
  bag, STEP/STP, SQLite/DB3, ReqIF, PCAP, and PCAPNG files.
- Added manifest file-handler coverage for `.avro`, `.bag`, `.stp`, `.step`,
  `.db3`, `.sqlite`, `.sqlite3`, `.reqif`, `.pcap`, and `.pcapng` files.
- Added signature detection for Avro object containers, ROS bag files, SQLite 3
  databases, classic PCAP captures, and PCAPNG captures.
- Added lightweight Avro, ROS bag, STEP, SQLite/DB3, ReqIF, PCAP, and PCAPNG
  inspectors through the automotive table viewer.
- Added packet summaries for PCAP and PCAPNG captures, including Ethernet, ARP,
  IPv4, IPv6, TCP, UDP, ICMP, DNS, DHCP, NTP, SSDP, CoAP, MQTT, HTTP, and TLS
  hints where available.

### Changed
- Reused the automotive viewer provider for the new engineering and capture
  formats so they share the same tabular summary, preview, and warning layout.
- Expanded viewer registry and file utility coverage so the new formats can be
  opened by extension, signature, command, and share/download routing.

### Fixed
- Added regression coverage for the new format signatures, extension fallbacks,
  viewer registry entries, manifest file-handler requirements, ReqIF rendering,
  and PCAP/PCAPNG parsing.

## [0.1.2] - 2026-06-26

### Changed
- Removed the redundant format badge from the viewer header for a cleaner file
  viewing layout.

## [0.1.1] - 2026-06-15

### Changed
- Replaced file-format keyword lists in localized Chrome Web Store package
  summaries with concise descriptions of the extension's viewing purpose.

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
