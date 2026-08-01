# Changelog

All notable changes to the Chrome build of Omni Viewer are documented in this file.

## [0.5.0] - 2026-08-01

### Added
- Added a LaTeX viewer for `.tex`, `.latex` and `.ltx` files, backed by
  `omni-viewer-core`: sectioning outline, prose, lists, tables, theorem
  environments and KaTeX-rendered math, with a source/split/preview switch,
  editing, and Save (in-place writeback on the file-handler path, download
  otherwise). The preview states on screen that it is a partial render —
  constructs the viewer cannot model, such as TikZ, are shown as their own
  source with a badge rather than dropped, and `\input`/`\include` are reported
  as unresolved because the extension is handed a single file with no access to
  its siblings.
- Bundled the KaTeX stylesheet and fonts for the LaTeX viewer's shadow root and
  the document head, so math layout and glyph metrics are correct. Formulas
  render progressively as they approach the viewport, keeping first paint fast
  on math-heavy documents.
- Routed `.tex` files through Chrome's file handlers, the viewer registry and
  the extension's own detection, including a `\documentclass` text sniff so
  extensionless LaTeX files still open in the right viewer.

### Changed
- Upgraded `omni-viewer-core` from 0.8.0 to 0.11.1. For existing viewers this
  brings a heading outline and split-view scroll sync to Markdown, recovers
  charts and embedded workbooks that were dropped from DOCX files, resolves
  in-document anchors in the Word and Markdown viewers, and stops PowerPoint
  metafile images from being substituted with an unrelated raster.
- Migrated the PDF, Mermaid, PlantUML, HDF5, MAT and PowerPoint viewers onto the
  shared core implementations, removing the legacy in-repo renderers.

## [0.4.0] - 2026-07-25

### Added
- Rendered LaTeX math in Markdown via KaTeX: `katex.min.css` and its fonts are
  bundled and injected into the viewer's shadow root and the document head so
  inline (`$…$`) and display (`$$…$$`) math display correctly.

### Changed
- Migrated supported viewer adapters to `omni-viewer-core` 0.8.0 while keeping
  the existing Chrome image viewer and its editing workflow.
- Unified viewer Save/Export actions on browser-managed downloads without the
  `downloads` permission.
- Upgraded `puml-canvas-js` to 0.10.0 for PlantUML diagram rendering in
  Markdown documents.
- Switched the spreadsheet engine to SheetJS (`xlsx`) 0.20.3.
- Updated DOMPurify to 3.4.12 or newer and declared the runtime peer
  dependencies (including `katex` and `buffer`) required by the published core
  package.

### Fixed
- Preserved Chrome-specific keyboard, asset, localization, file-picking, and
  save integration around the shared core viewers.
- Restored a warning when an archive contains encrypted entries that the
  current extraction backend cannot extract.
- Aligned the Web Store permission copy with the packaged manifest and actual
  download behavior.

## [0.3.0] - 2026-07-01

### Added
- Added Protocol Buffers schema viewing for `.proto` files, including Chrome
  file-handler coverage, extension routing, and a dedicated viewer bundle.
- Added a Proto parser that indexes syntax, package declarations, imports,
  messages, nested messages, enums, services, RPCs, fields, oneofs, reserved
  declarations, documentation comments, and references.
- Added Proto diagnostics for duplicate field numbers.
- Added HDF5 viewer support for `.h5` and `.hdf5` files, including Chrome file
  handler coverage, extension routing, signature detection, and a dedicated
  viewer bundle.
- Added a lightweight HDF5 metadata parser that validates the HDF5 signature,
  reads superblock metadata, and enumerates decoded groups and datasets without
  loading dataset payloads.
- Added MATLAB MAT-file inspection for `.mat` files, including MAT v4,
  MAT v5/v6/v7, and HDF5-backed MAT v7.3 headers.
- Added MAT variable summaries with names, classes, dimensions, data types,
  byte sizes, attributes, and small value previews where available.
- Added regression coverage for Proto schema indexing, HDF5 superblock
  traversal, HDF5 signature failures, large trailing HDF5 payloads, MAT
  v4/v5/v7.3 parsing, viewer registry entries, and bundle exports.

### Changed
- Updated the home-screen supported-format summary in English and Korean to
  include Proto files.
- Reused the tabular automotive-style viewer layout for MAT files while adding
  a dedicated HDF5 provider and viewer registration for HDF5 files.
- Expanded the main viewer routing and dynamic bundle configuration for Proto,
  HDF5, and MAT viewers.

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
