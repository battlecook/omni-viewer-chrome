# Changelog

All notable changes to the Chrome build of Omni Viewer are documented in this file.

## [0.7.0] - 2026-10-05

### Added
- Added a Jupyter Notebook (`.ipynb`) viewer backed by `omni-viewer-core`. It
  is a read-only preview: no kernel is started and no cell is re-run, so the
  code is shown as highlighted text and every output is the one saved in the
  file — Markdown cells (with KaTeX math and `attachment:` images), stream and
  error outputs, `execute_result`/`display_data` bundles, inline images and
  `text/html` fragments, all behind the core's sanitizer, plus a cell/output
  search and show-code / show-outputs toggles. A notebook is JSON and carries
  no magic bytes, so routing claims an `.ipynb` file by extension and a
  renamed one by a top-level `nbformat: 4` together with a top-level `cells`
  array — the rule the core itself applies. Only where the head is truncated,
  and either key can therefore sit past it, does one of them count alone:
  `nbformat: 4`, or a `cells` array with a `cell_type` inside it. Both keys
  are read as members of the root object, so a document that merely contains
  a notebook (a Contents API response, an nbdime diff) stays with the JSON
  tree, as does a complete document carrying just one of the two. This runs
  ahead of the generic JSON tree, in both `app.js` and
  `FileUtils.detectViewerType`. Relative image paths
  (`![](figures/plot.png)`) stay unresolved — Chrome hands a viewer a lone
  File with no access to its siblings — and render as "Image unavailable".
- Added an ExecuTorch (`.pte`) program viewer backed by `omni-viewer-core`.
  Routing keys off the `ET12` FlatBuffer identifier at byte offset 4 — ahead
  of the optional `eh00` extended header — with a `.pte` extension fallback
  for files whose header is gone, in both `app.js` and
  `FileUtils.detectViewerType`. The viewer renders the program's methods,
  instruction chains, values, inputs/outputs, delegates and segment table
  without decoding the constant or delegate payloads that trail the program.
- Added a HAR (`.har`) network-log viewer backed by `omni-viewer-core`, aimed
  at web and API failure analysis: a filterable request table (method, status
  class, resource type, domain, free-text search over URLs, headers and
  optionally bodies) with per-request waterfall bars, and a detail pane for
  headers, request payload, response body, cookies and the timing breakdown.
  A HAR archive is JSON, so it carries no magic bytes — routing claims a
  `.har` file by extension and a renamed or extensionless capture by its
  `log` object holding an `entries` array — each looked up as an own member,
  so a document that merely wraps a capture stays with the JSON tree — ahead
  of the generic JSON tree, in both `app.js` and `FileUtils.detectViewerType`.

## [0.6.0] - 2026-09-16

### Added
- Added an OpenVINO IR model viewer backed by `omni-viewer-core` for the
  `.xml` + `.bin` pair. Routing is by content only — `.xml` belongs to every
  XML dialect, so the `<net version>` root with a `<layers>` child is what
  selects the viewer, both in `app.js` and in `FileUtils.detectViewerType`.
  The `.bin` is a sidecar the browser cannot read off disk by itself: the
  picker and drop zone now accept several files and pair a `.bin` with its
  same-stem `.xml` (multi-file launches from the OS do the same), and the
  viewer carries an "Attach .bin…" bar for a model opened on its own. The
  topology, layer, constant, input/output and model-information panels render
  without the weights; with them, constant byte ranges are checked and their
  leading values previewed while the rest of the `.bin` is never decoded.

- Added a NumPy array viewer backed by `omni-viewer-core` for `.npy` and
  ZIP-backed `.npz` files. It shows array metadata and bounded value grids,
  supports multidimensional slice selection and NPZ array switching, and
  refuses unsafe pickle-backed object arrays while preserving diagnostics.

- Added a Core ML model viewer backed by `omni-viewer-core`, including
  `.mlmodel` / `.mlpackage` file-handler routing and detection of a zipped
  `.mlpackage` from its `Manifest.json` + `Data/com.apple.CoreML/` layout.
  The viewer exposes the per-graph computation graph for both ML Programs and
  the older neural-network encoding, with operation, value, weight,
  input/output, package and model-information panels. Weight payloads are
  never decoded — blob references resolve to a file, an offset and a byte
  count — so a multi-gigabyte model costs nothing to open.

- Added a TFLite / LiteRT model viewer backed by `omni-viewer-core`, including
  `.tflite` / `.lite` file-handler routing and `TFL3` identifier detection.
  The viewer exposes subgraph topology, operators, tensors, inputs/outputs,
  buffers, quantization, sparsity, signatures, metadata and model warnings
  without decoding model weight payloads.

- Added a GGUF metadata and tensor-index viewer backed by
  `omni-viewer-core`, including `.gguf` file-handler routing and `GGUF`
  magic-byte detection. The Chrome adapter parses through a temporary Blob
  URL, so tensor payloads are not decoded or duplicated in memory.

- Added an ONNX model viewer backed by `omni-viewer-core`, covering the model
  info, graph, node, tensor and input/output panes, with `.onnx` file-handler
  routing. ONNX is bare protobuf with no magic bytes, so routing is
  extension-driven by design. The core parser reads graph topology, types,
  shapes and attributes without materializing tensor payloads, so weights are
  never decoded into memory.

- Added a safetensors model viewer backed by `omni-viewer-core`, covering the
  header summary, tensor table with search, and raw header preview, with
  `.safetensors` file-handler routing. The format carries no magic bytes — a
  little-endian u64 header length is followed by that many bytes of JSON — so
  detection accepts only a declared header that fits inside the file and opens
  a JSON object, with the extension as the fallback. The Chrome adapter hands
  the core a lazy `Blob.slice()` source, so only the header is ever read and
  multi-gigabyte tensor payloads never enter memory.

- Added a Keras model viewer backed by `omni-viewer-core`, covering the layer
  table, weight index, model config, compile/training settings and archive
  members, with `.keras` file-handler routing. A `.keras` file is a ZIP with no
  distinguishing leading bytes, so the extension claims it; a renamed one is
  still recognized when `config.json` and `model.weights.h5` both sit at the
  root of the archive. The weight store is walked for shapes and datatypes
  only, so parameter payloads are never decoded.
- Read the older Keras 2 save format too: a model named `.keras` opens in the
  Keras viewer whether it holds the archive or plain HDF5. A file named `.h5`
  stays with the HDF5 viewer, since nothing short of reading it tells a Keras
  model apart from any other HDF5 file.

### Changed
- Upgraded `omni-viewer-core` from 0.11.1 to 0.18.0, which supplies the model
  viewers above and the shared audio viewer.
- Migrated the audio viewer onto `omni-viewer-core`, replacing both the legacy
  SPA renderer in `src/app.js` and the in-repo `AudioController` (~1,600 lines
  total). Chrome now supplies only the platform bindings: the vendored
  WaveSurfer modules, the core's WASM decode/analysis engine (copied to
  `assets/audio-engine/` and run in a Worker so a stalled decode cannot freeze
  the page), and i18n. Large files still render from WASM-computed peaks
  instead of a full browser decode, and files the browser cannot decode are
  remuxed to WAV by the engine rather than failing.
- Dropped features the shared viewer does not (yet) have: playback speed,
  region export to WAV, the mel/linear/bark/ERB spectrogram scale selector,
  the simultaneous waveform+spectrogram view, the minimap and hover overlays,
  and the keyboard shortcuts.
- Removed `vendor/audio_engine_browser.js` and `vendor/audio_engine.wasm`; the
  engine now ships from `omni-viewer-core`.

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
