const $ = (selector) => document.querySelector(selector);

const state = {
  file: null,
  fileHandle: null,
  type: 'unknown',
  pdfScale: 1.1,
  table: { rows: [], headers: [], page: 1, pageSize: 80, query: '' },
  // Files that arrived together with `file` (multi-select or multi-drop).
  // Only viewers with a sidecar — OpenVINO's `.bin` — look here.
  companions: [],
  openFileGeneration: 0,
  advancedViewerGeneration: 0,
  advancedViewerAbortController: null
};

const fileInput = $('#fileInput');
const dropZone = $('#dropZone');
const viewer = $('#viewer');
const statusBox = $('#status');
const fileMeta = $('#fileMeta');
const shareCurrentFileButton = $('#shareCurrentFile');
const openSharedLinkButton = $('#openSharedLink');
const shareToast = $('#shareToast');
const shareToastLink = $('#shareToastLink');
const languageSelect = $('#languageSelect');
let shareToastTimer;

const LOCALE_NATIVE_NAMES = {
  am: 'አማርኛ', ar: 'العربية', as: 'অসমীয়া', az: 'azərbaycan',
  bg: 'български', bn: 'বাংলা', ca: 'català', cs: 'čeština',
  da: 'dansk', de: 'Deutsch', el: 'Ελληνικά', en: 'English',
  en_AU: 'English (Australia)', en_GB: 'English (United Kingdom)',
  en_US: 'English (United States)', es: 'español',
  es_419: 'español (Latinoamérica)', et: 'eesti', eu: 'euskara', fa: 'فارسی',
  fi: 'suomi', fil: 'Filipino', fr: 'français', gu: 'ગુજરાતી', he: 'עברית',
  hi: 'हिन्दी', hr: 'hrvatski', hu: 'magyar', hy: 'հայերեն',
  id: 'Bahasa Indonesia', it: 'italiano', ja: '日本語', ka: 'ქართული',
  kn: 'ಕನ್ನಡ', ko: '한국어', lt: 'lietuvių', lv: 'latviešu',
  mk: 'македонски', ml: 'മലയാളം', mr: 'मराठी', ms: 'Bahasa Melayu',
  my: 'မြန်မာ', ne: 'नेपाली', nl: 'Nederlands', no: 'norsk', or: 'ଓଡ଼ିଆ',
  pa: 'ਪੰਜਾਬੀ', pl: 'polski', pt_BR: 'português (Brasil)',
  pt_PT: 'português (Portugal)', ro: 'română', ru: 'русский', si: 'සිංහල',
  sk: 'slovenčina', sl: 'slovenščina', sq: 'shqip', sr: 'српски',
  sv: 'svenska', sw: 'Kiswahili', ta: 'தமிழ்', te: 'తెలుగు', th: 'ไทย',
  tr: 'Türkçe', uk: 'українська', ur: 'اردو', uz: 'o‘zbek',
  vi: 'Tiếng Việt', zh_CN: '中文（中国）', zh_TW: '中文（台灣）'
};
const SUPPORTED_LOCALES = Object.keys(LOCALE_NATIVE_NAMES);
let activeLocale = '';

let shareModulePromise;
async function loadShareModule() {
  if (!shareModulePromise) {
    shareModulePromise = loadFirstModule([
      'share/shareCommand.js',
      'dist/share/shareCommand.js',
    ]);
  }
  return shareModulePromise;
}

async function loadFirstModule(candidates) {
  let lastError;
  for (const relativePath of candidates) {
    try {
      const url = globalThis.chrome?.runtime?.getURL
        ? chrome.runtime.getURL(relativePath)
        : relativePath;
      return await import(url);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Failed to load module.');
}

function i18n(messageName, substitutions) {
  const override = globalThis.__omniLocaleMessages?.[messageName]?.message;
  if (override) {
    const values = Array.isArray(substitutions)
      ? substitutions
      : substitutions == null ? [] : [substitutions];
    return override.replace(/\$(\d+)/g, (match, index) => values[Number(index) - 1] ?? match);
  }
  const message = globalThis.chrome?.i18n?.getMessage?.(messageName, substitutions);
  return message || '';
}

const RTL_LOCALES = new Set(['ar', 'fa', 'he', 'ur']);
function isRtlLocale(locale) {
  if (!locale) return false;
  return RTL_LOCALES.has(String(locale).toLowerCase().split(/[_-]/)[0]);
}

function localizeDocument() {
  const locale = activeLocale || i18n('@@ui_locale');
  if (locale) {
    document.documentElement.lang = locale.replace('_', '-');
    document.documentElement.dir = isRtlLocale(locale) ? 'rtl' : 'ltr';
  }
  const appName = i18n('appName');
  if (appName) document.title = appName;
  document.querySelectorAll('[data-i18n]').forEach((element) => {
    const message = i18n(element.dataset.i18n);
    if (message) element.textContent = message;
  });
  document.querySelectorAll('[data-i18n-title]').forEach((element) => {
    const message = i18n(element.dataset.i18nTitle);
    if (message) element.title = message;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
    const message = i18n(element.dataset.i18nPlaceholder);
    if (message) element.placeholder = message;
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach((element) => {
    const message = i18n(element.dataset.i18nAriaLabel);
    if (message) element.setAttribute('aria-label', message);
  });
}

function populateLanguageSelect(selectedLocale) {
  if (!languageSelect) return;
  const systemOption = document.createElement('option');
  systemOption.value = '';
  systemOption.textContent = i18n('languageSystemDefault') || 'System default';
  languageSelect.replaceChildren(systemOption);

  for (const locale of SUPPORTED_LOCALES) {
    const option = document.createElement('option');
    option.value = locale;
    option.textContent = LOCALE_NATIVE_NAMES[locale];
    languageSelect.appendChild(option);
  }
  languageSelect.value = selectedLocale;
}

async function readLocalePreference() {
  try {
    const result = await chrome.storage?.local?.get?.(['locale']);
    return SUPPORTED_LOCALES.includes(result?.locale) ? result.locale : '';
  } catch {
    return '';
  }
}

async function initializeLanguagePreference() {
  const selectedLocale = await readLocalePreference();
  if (selectedLocale) {
    try {
      const relativePath = `_locales/${selectedLocale}/messages.json`;
      const url = globalThis.chrome?.runtime?.getURL
        ? chrome.runtime.getURL(relativePath)
        : relativePath;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      globalThis.__omniLocaleMessages = await response.json();
      activeLocale = selectedLocale;
    } catch (error) {
      console.warn(`Could not load locale ${selectedLocale}; using the system language.`, error);
    }
  }
  populateLanguageSelect(activeLocale);
}

async function saveLocalePreference(locale) {
  try {
    await chrome.storage?.local?.set?.({ locale });
  } finally {
    globalThis.location.reload();
  }
}

const formats = {
  image: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'],
  pdf: ['.pdf'],
  csv: ['.csv', '.tsv'],
  json: ['.json'],
  jsonl: ['.jsonl', '.ndjson', '.jsonlines'],
  yaml: ['.yaml', '.yml'],
  toml: ['.toml'],
  markdown: ['.md', '.markdown'],
  latex: ['.tex', '.latex', '.ltx'],
  mermaid: ['.mmd', '.mermaid'],
  plantuml: ['.puml', '.plantuml', '.iuml'],
  proto: ['.proto'],
  automotive: ['.dbc', '.arxml', '.a2l', '.asc', '.blf', '.mf4', '.mdf', '.avro', '.bag', '.stp', '.step', '.db3', '.sqlite', '.sqlite3', '.reqif', '.pcap', '.pcapng'],
  hdf5: ['.h5', '.hdf5'],
  mat: ['.mat'],
  numpy: ['.npy', '.npz'],
  gguf: ['.gguf'],
  onnx: ['.onnx'],
  tflite: ['.tflite', '.lite'],
  keras: ['.keras'],
  coreml: ['.mlmodel', '.mlpackage'],
  // Routed by content only: `.xml` belongs to every XML dialect.
  openvino: [],
  safetensors: ['.safetensors'],
  audio: ['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a'],
  video: ['.mp4', '.webm', '.mov', '.m4v', '.ogv'],
  excel: ['.xlsx', '.xls'],
  word: ['.docx', '.doc'],
  ppt: ['.pptx', '.ppt'],
  psd: ['.psd'],
  parquet: ['.parquet'],
  hwp: ['.hwp', '.hwpx'],
  archive: ['.zip', '.jar', '.apk', '.tar', '.tgz', '.tar.gz', '.gz', '.7z', '.rar']
};

const labels = {
  image: 'Image',
  pdf: 'PDF',
  csv: 'CSV/TSV',
  json: 'JSON',
  jsonl: 'JSONL',
  yaml: 'YAML',
  toml: 'TOML',
  markdown: 'Markdown',
  latex: 'LaTeX',
  mermaid: 'Mermaid',
  plantuml: 'PlantUML',
  proto: 'Protocol Buffers',
  automotive: 'Automotive',
  hdf5: 'HDF5',
  mat: 'MAT',
  numpy: 'NumPy',
  gguf: 'GGUF',
  onnx: 'ONNX',
  tflite: 'TFLite',
  keras: 'Keras',
  coreml: 'Core ML',
  openvino: 'OpenVINO IR',
  safetensors: 'Safetensors',
  audio: 'Audio',
  video: 'Video',
  excel: 'Excel',
  word: 'Word',
  ppt: 'PowerPoint',
  psd: 'PSD',
  parquet: 'Parquet',
  hwp: 'HWP/HWPX',
  archive: 'Archive',
  unknown: 'Raw Data'
};

const RAW_TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function extOf(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.gz')) return '.tar.gz';
  return lower.includes('.') ? `.${lower.split('.').pop()}` : '';
}

async function readHead(file, size = 65536) {
  return new Uint8Array(await file.slice(0, size).arrayBuffer());
}

async function readTail(file, size = 4) {
  return new Uint8Array(await file.slice(Math.max(0, file.size - size)).arrayBuffer());
}

function hasPrefix(bytes, values, offset = 0) {
  if (bytes.length < offset + values.length) return false;
  return values.every((value, index) => bytes[offset + index] === value);
}

// Safetensors carries no magic bytes — a little-endian u64 header length is
// followed by that many bytes of JSON. The declared header has to fit inside
// the file and the byte after the prefix has to open a JSON object.
function isSafetensorsHead(head, fileSize) {
  if (head.length < 10) return false;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (view.getUint32(4, true) !== 0) return false;
  const headerLength = view.getUint32(0, true);
  if (headerLength < 2 || headerLength > fileSize - 8) return false;
  return head[8] === 0x7b && (head[9] === 0x22 || head[9] === 0x7d);
}

function ascii(bytes, start = 0, length = bytes.length - start) {
  return Array.from(bytes.slice(start, start + length), (value) => String.fromCharCode(value)).join('');
}

// Entry names read from the ZIP local file headers that fit inside `head`.
// Comparing names beats scanning the raw bytes for a string: an entry called
// `notes/config.json` must not read as the root `config.json` a format spec
// asks for. The walk needs each entry's size to find the next header, so it
// stops at the first one that runs past the bytes we read — callers get a
// short list, never a wrong one. That bound has a price: a *renamed* model
// whose leading members already fill the head window is left to the archive
// viewer, which lists it rather than getting it wrong. A file that still
// carries its own extension is claimed before this runs.
function zipEntryNames(head) {
  const names = [];
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let offset = 0;
  while (offset + 30 <= head.length && view.getUint32(offset, true) === 0x04034b50) {
    const flags = view.getUint16(offset + 6, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameEnd = offset + 30 + nameLength;
    if (nameEnd > head.length) break;
    names.push(ascii(head, offset + 30, nameLength));
    // Bit 3 defers the sizes to a descriptor after the data, leaving nothing
    // here to advance by.
    if (flags & 0x08) break;
    offset = nameEnd + extraLength + compressedSize;
  }
  return names;
}

// Mirror of `looksLikeOpenVinoIr` in omni-viewer-core/parsers/openvino: a
// lowercase `<net>` root carrying a numeric `version` and holding `<layers>`,
// after any BOM / declaration / comment prologue.
function looksLikeOpenVinoIr(text) {
  let sample = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (;;) {
    sample = sample.trimStart();
    let closer;
    if (sample.startsWith('<?')) closer = '?>';
    else if (sample.startsWith('<!--')) closer = '-->';
    else break;
    const end = sample.indexOf(closer, 2);
    if (end === -1) return false;
    sample = sample.slice(end + closer.length);
  }
  const root = /^\s*(?:<!DOCTYPE(?:[^[>]|\[[^\]]*\])*>\s*)?<net(?:\s[^>]*)?>/.exec(sample);
  if (!root) return false;
  const tag = root[0];
  return /\sversion\s*=\s*["']\d+["']/.test(tag) && /<layers[\s/>]/.test(sample.slice(root.index + tag.length));
}

// `model.xml` -> `model.bin`, the pair OpenVINO's serializer writes. Picks the
// matching `.bin` out of the files that arrived with the model, or the only
// `.bin` when there is just one — a user who dropped exactly one weights file
// meant it for this model.
function companionBinFor(file, companions) {
  const bins = companions.filter((other) => other !== file && /\.bin$/i.test(other.name));
  const expected = `${file.name.replace(/\.xml$/i, '')}.bin`.toLowerCase();
  return bins.find((other) => other.name.toLowerCase() === expected) || (bins.length === 1 ? bins[0] : null);
}

// Which of several files opened together is the one to show. An IR pair is
// the only case where the answer isn't "the first": its `.xml` leads and the
// `.bin` rides along, whichever order the picker or the drop delivered them.
function pickPrimaryFile(files) {
  if (files.length > 1) {
    const xml = files.find((file) => /\.xml$/i.test(file.name));
    if (xml && companionBinFor(xml, files)) return xml;
  }
  return files[0];
}

function byExtension(file) {
  const ext = extOf(file.name);
  for (const [type, exts] of Object.entries(formats)) {
    if (exts.includes(ext)) return type;
  }
  return 'unknown';
}

async function detectType(file) {
  const head = await readHead(file);
  const ext = extOf(file.name);
  if (hasPrefix(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf';
  if (hasPrefix(head, [0x38, 0x42, 0x50, 0x53])) return 'psd';
  if (hasPrefix(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image';
  if (hasPrefix(head, [0xff, 0xd8, 0xff])) return 'image';
  if (ascii(head, 0, 4) === 'GIF8') return 'image';
  if (ascii(head, 0, 2) === 'BM') return 'image';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return 'image';
  if (ascii(head, 0, 4) === 'fLaC' || ascii(head, 0, 3) === 'ID3' || ascii(head, 0, 4) === 'OggS') return ext === '.ogv' ? 'video' : 'audio';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WAVE') return 'audio';
  if (ascii(head, 4, 4) === 'ftyp') return ext === '.m4a' ? 'audio' : 'video';
  if (hasPrefix(head, [0x1a, 0x45, 0xdf, 0xa3])) return 'video';
  if (hasPrefix(head, [0x50, 0x41, 0x52, 0x31]) && hasPrefix(await readTail(file), [0x50, 0x41, 0x52, 0x31])) return 'parquet';
  // Keras 2 saved models are plain HDF5. Only the contents tell them apart
  // from any other HDF5 file, so `.h5` stays with the HDF5 viewer and just the
  // declared `.keras` name moves it to the Keras viewer, which reads both.
  if (hasPrefix(head, [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a])) return ext === '.keras' ? 'keras' : 'hdf5';
  if (hasPrefix(head, [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59])) return 'numpy';
  if (ascii(head, 0, 4) === 'GGUF') return 'gguf';
  if (ascii(head, 4, 4) === 'TFL3') return 'tflite';
  if (isSafetensorsHead(head, file.size)) return 'safetensors';
  if (ascii(head, 0, 4) === 'LOGG') return 'automotive';
  if (/^MDF\s/.test(ascii(head, 0, Math.min(head.length, 64)))) return 'automotive';
  if (ascii(head, 0, 4) === 'Obj\x01') return 'automotive';
  if (ascii(head, 0, 11) === '#ROSBAG V2.') return 'automotive';
  if (ascii(head, 0, 16) === 'SQLite format 3\0') return 'automotive';
  if (hasPrefix(head, [0xd4, 0xc3, 0xb2, 0xa1]) || hasPrefix(head, [0xa1, 0xb2, 0xc3, 0xd4]) || hasPrefix(head, [0x4d, 0x3c, 0xb2, 0xa1]) || hasPrefix(head, [0xa1, 0xb2, 0x3c, 0x4d])) return 'automotive';
  if (hasPrefix(head, [0x0a, 0x0d, 0x0d, 0x0a])) return 'automotive';
  if (hasPrefix(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return byExtension(file);
  if (hasPrefix(head, [0x50, 0x4b])) {
    if (ext === '.npz') return 'numpy';
    if (ext === '.keras') return 'keras';
    // An .mlpackage is a directory bundle on disk, so the browser only ever
    // sees the zipped form.
    if (ext === '.mlpackage') return 'coreml';
    const text = ascii(head, 0, Math.min(head.length, 65536));
    // Likewise for a renamed .mlpackage: only Core ML reserves this Data tree.
    if (text.includes('Data/com.apple.CoreML/')) return 'coreml';
    if (text.includes('word/')) return 'word';
    if (text.includes('xl/')) return 'excel';
    if (text.includes('ppt/')) return 'ppt';
    if (text.includes('Contents/content.hpf') || text.includes('version.xml')) return 'hwp';
    // A mislabeled Keras 3 archive. Neither member is distinctive on its own —
    // an ordinary archive can hold a `model.weights.h5` — so both have to sit
    // at the root, which is where the core resolves them (and an unpacked
    // model re-zipped under a folder is an archive, not a model). The
    // structured containers above get first refusal.
    const rootNames = zipEntryNames(head);
    if (rootNames.includes('config.json') && rootNames.includes('model.weights.h5')) return 'keras';
    return formats.archive.includes(ext) ? 'archive' : byExtension(file);
  }
  // The `<net>` root is what identifies an IR — `.xml` on its own says nothing.
  if (looksLikeOpenVinoIr(new TextDecoder().decode(head))) return 'openvino';
  const textHead = ascii(head, 0, Math.min(head.length, 4096)).trimStart();
  if (/^@start(?:uml|plantuml|mindmap|wbs|gantt|json|yaml|salt|ditaa)?\b/i.test(textHead)) return 'plantuml';
  return byExtension(file);
}

function setStatus(message, error = false) {
  statusBox.textContent = message;
  statusBox.classList.toggle('hidden', !message);
  statusBox.classList.toggle('error', error);
}

function showShareToast(url, copied) {
  clearTimeout(shareToastTimer);
  shareToast.querySelector('strong').textContent = copied ? 'Share link copied' : 'Share link created';
  shareToastLink.href = url;
  shareToastLink.textContent = url;
  shareToast.classList.remove('hidden');
  shareToastTimer = setTimeout(() => shareToast.classList.add('hidden'), 7000);
}

async function downloadSharedFileViaBackground(url) {
  try {
    const ping = await chrome.runtime.sendMessage({ type: 'omniViewerSharePing' });
    if (!ping?.ok) throw new Error('Share background service is not ready.');
    const response = await chrome.runtime.sendMessage({
      type: 'omniViewerFetchSharedFile',
      url,
    });
    if (response?.ok && typeof response.base64 === 'string') {
      return base64ToBlob(response.base64, response.contentType);
    }
    if (response) {
      throw new Error(response.error || 'Background download failed.');
    }
  } catch (backgroundError) {
    console.warn('Background shared-file download unavailable; trying direct fetch.', backgroundError);
  }

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.blob();
  } catch (directError) {
    throw new Error(
      'Shared file download failed. Reload the extension at chrome://extensions, close this viewer tab, '
      + 'then open Omni Viewer again. '
      + (directError instanceof Error ? directError.message : String(directError))
    );
  }
}

function base64ToBlob(base64, contentType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], {
    type: contentType || 'application/octet-stream',
  });
}

function panel(title, body = '') {
  viewer.innerHTML = `
    <article class="viewer-panel">
      <header class="viewer-head">
        <div>
          <div class="viewer-title">${escapeHtml(title)}</div>
        </div>
        <div class="viewer-head-actions">
          <button id="shareViewerFile" type="button" title="Shared data is stored on the server for 5 minutes only, then discarded.">Share</button>
          <button id="downloadOriginal" type="button">${escapeHtml(i18n('downloadOriginal') || 'Download original')}</button>
        </div>
      </header>
      <div class="viewer-body">${body}</div>
    </article>
  `;
  $('#downloadOriginal')?.addEventListener('click', () => downloadBlob(state.file, state.file.name));
  $('#shareViewerFile')?.addEventListener('click', shareCurrentFile);
  return $('.viewer-body');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[char]));
}

// Cache + loader for the per-viewer ESM bundles produced by webpack.
// `src/app.js` is the legacy SPA entry; the new per-viewer bundles
// (e.g. `templates/hwp/hwpViewer.js`) self-register their providers via
// `VIEWER_REGISTRATIONS` mutation when imported, and also export their
// `mount<Viewer>Viewer(file, container)` directly. We dynamic-import the
// bundle and call mount when the user opens an HWP / Parquet file.
//
// We try two URL layouts so unpacking from either repo root or `dist/`
// works (DoD on issues #69 / #70):
//   - "templates/<slug>/<slug>Viewer.js"      (when the extension is
//     loaded from `dist/` directly — that is the canonical layout)
//   - "dist/templates/<slug>/<slug>Viewer.js" (legacy: extension loaded
//     from repo root, dist/ alongside as a build output)
const advancedViewerModules = new Map();
async function loadAdvancedViewerBundle(slug) {
  if (advancedViewerModules.has(slug)) {
    return advancedViewerModules.get(slug);
  }
  const candidates = [
    `templates/${slug}/${slug}Viewer.js`,
    `dist/templates/${slug}/${slug}Viewer.js`,
  ];
  let lastErr;
  for (const rel of candidates) {
    try {
      const url = (typeof chrome !== 'undefined' && chrome.runtime?.getURL)
        ? chrome.runtime.getURL(rel)
        : new URL(rel, globalThis.location.href).href;
      // eslint-disable-next-line no-await-in-loop
      const mod = await import(/* @vite-ignore */ url);
      advancedViewerModules.set(slug, mod);
      return mod;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`Failed to load ${slug} viewer bundle`);
}

function releaseAdvancedViewer() {
  state.advancedViewerGeneration += 1;
  state.advancedViewerAbortController?.abort();
  state.advancedViewerAbortController = null;
  if (state.advancedViewerHandle) {
    try { state.advancedViewerHandle.dispose?.(); } catch {}
    state.advancedViewerHandle = null;
  }
}

async function mountAdvancedViewer(slug, mountFnName, container, mountOptions) {
  releaseAdvancedViewer();
  const generation = state.advancedViewerGeneration;
  const file = state.file;
  const fileHandle = state.fileHandle;
  const controller = new AbortController();
  state.advancedViewerAbortController = controller;
  const mod = await loadAdvancedViewerBundle(slug);
  if (generation !== state.advancedViewerGeneration || controller.signal.aborted) return;
  const mountFn = mod[mountFnName];
  if (typeof mountFn !== 'function') {
    throw new Error(`${slug} bundle missing ${mountFnName}`);
  }
  // Pass the writable FileSystemFileHandle (launchQueue path only; null
  // otherwise) as a third arg. Viewers that don't support in-place writeback
  // simply ignore it.
  let handle;
  try {
    handle = await mountFn(file, container, fileHandle, controller.signal, mountOptions);
  } catch (error) {
    if (generation !== state.advancedViewerGeneration || controller.signal.aborted) return;
    throw error;
  }
  if (generation !== state.advancedViewerGeneration || controller.signal.aborted) {
    handle?.dispose?.();
    return;
  }
  state.advancedViewerAbortController = null;
  if (handle && typeof handle.dispose === 'function') {
    state.advancedViewerHandle = handle;
  }
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function claimOpenFileIntent() {
  return ++state.openFileGeneration;
}

async function openFile(file, handle = null, generation = claimOpenFileIntent(), companions = []) {
  await languageReady;
  if (generation !== state.openFileGeneration) return;
  releaseAdvancedViewer();
  state.file = file;
  state.companions = companions.filter((other) => other !== file);
  // Only the file_handlers (launchQueue) path supplies a writable
  // FileSystemFileHandle; input/drop paths pass none, so writeback stays off
  // and those viewers fall back to a download save.
  state.fileHandle = handle ?? null;
  shareCurrentFileButton.disabled = false;
  const detectedType = await detectType(file);
  if (generation !== state.openFileGeneration) return;
  state.type = detectedType;
  setStatus('');
  fileMeta.classList.remove('hidden');
  fileMeta.innerHTML = `<div class="meta-grid">
    <span class="meta-item"><strong>${escapeHtml(file.name)}</strong></span>
    <span class="meta-item">${escapeHtml(labels[state.type])}</span>
    <span class="meta-item">${formatSize(file.size)}</span>
    <span class="meta-item">${escapeHtml(file.type || 'application/octet-stream')}</span>
  </div>`;

  try {
    await renderByType();
  } catch (error) {
    if (generation !== state.openFileGeneration) return;
    console.error(error);
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function shareCurrentFile() {
  if (!state.file) {
    setStatus('No file selected to share.', true);
    return;
  }
  const buttons = [shareCurrentFileButton, $('#shareViewerFile')].filter(Boolean);
  buttons.forEach((button) => { button.disabled = true; });
  setStatus(`Uploading ${state.file.name}...`);
  try {
    const { shareFile } = await loadShareModule();
    const result = await shareFile(state.file);
    let copied = false;
    try {
      await navigator.clipboard.writeText(result.url);
      copied = true;
    } catch (clipboardError) {
      console.warn('Could not copy share link to clipboard.', clipboardError);
    }
    showShareToast(result.url, copied);
    setStatus(`${copied ? 'Share link copied to clipboard' : 'Share link created'}: ${result.url} The link is valid for 5 minutes only, then it expires.`);
  } catch (error) {
    console.error(error);
    setStatus(`Share failed: ${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function openSharedLinkPrompt() {
  const input = window.prompt('Enter Omni Viewer share URL or share ID');
  if (!input) return;
  const generation = claimOpenFileIntent();
  openSharedLinkButton.disabled = true;
  setStatus('Downloading shared file...');
  try {
    const { openSharedLink } = await loadShareModule();
    if (generation !== state.openFileGeneration) return;
    const file = await openSharedLink(input, { downloadImpl: downloadSharedFileViaBackground });
    if (generation !== state.openFileGeneration) return;
    await openFile(file, null, generation);
  } catch (error) {
    if (generation !== state.openFileGeneration) return;
    console.error(error);
    setStatus(`Download failed: ${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    openSharedLinkButton.disabled = false;
  }
}

async function renderByType() {
  const type = state.type;
  if (type === 'image') return renderImage();
  if (type === 'pdf') return renderPdf();
  if (type === 'csv') return renderCsv();
  if (type === 'json') return renderJson();
  if (type === 'jsonl') return renderJsonl();
  if (type === 'yaml') return renderYaml();
  if (type === 'toml') return renderToml();
  if (type === 'markdown') return renderMarkdown();
  if (type === 'latex') return renderLatex();
  if (type === 'mermaid') return renderMermaid();
  if (type === 'plantuml') return renderPlantUml();
  if (type === 'proto') return renderProto();
  if (type === 'automotive') return renderAutomotive();
  if (type === 'hdf5') return renderHdf5();
  if (type === 'mat') return renderMat();
  if (type === 'numpy') return renderNumpy();
  if (type === 'gguf') return renderGguf();
  if (type === 'onnx') return renderOnnx();
  if (type === 'tflite') return renderTflite();
  if (type === 'keras') return renderKeras();
  if (type === 'coreml') return renderCoreml();
  if (type === 'openvino') return renderOpenvino();
  if (type === 'safetensors') return renderSafetensors();
  if (type === 'audio') return renderAudio();
  if (type === 'video') return renderVideo();
  if (type === 'excel') return renderExcel();
  if (type === 'word') return renderWord();
  if (type === 'ppt') return renderPpt();
  if (type === 'psd') return renderPsd();
  if (type === 'parquet') return renderParquet();
  if (type === 'hwp') return renderHwp();
  if (type === 'archive') return renderArchive();
  return renderRawData();
}

async function renderImage() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading image viewer…</p></div>';
  try {
    await mountAdvancedViewer('image', 'mountImageViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load image viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderPdf() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading PDF viewer…</p></div>';
  try {
    await mountAdvancedViewer('pdf', 'mountPdfViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load PDF viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && char === delimiter) {
      row.push(field);
      field = '';
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function renderTable(title, headers, rows) {
  state.table = { headers, rows, page: 1, pageSize: 80, query: '' };
  const body = panel(title, '<div id="tableToolbar" class="toolbar"></div><div id="tableWrap" class="table-wrap"></div>');
  const draw = () => {
    const q = state.table.query.toLowerCase();
    const filtered = q ? rows.filter((row) => row.some((cell) => String(cell ?? '').toLowerCase().includes(q))) : rows;
    const start = (state.table.page - 1) * state.table.pageSize;
    const pageRows = filtered.slice(start, start + state.table.pageSize);
    const pages = Math.max(1, Math.ceil(filtered.length / state.table.pageSize));
    $('#tableToolbar').innerHTML = `
      <input id="tableSearch" type="search" placeholder="Search" value="${escapeHtml(state.table.query)}">
      <button id="prevPage" ${state.table.page <= 1 ? 'disabled' : ''}>Prev</button>
      <span>${state.table.page} / ${pages} (${filtered.length} rows)</span>
      <button id="nextPage" ${state.table.page >= pages ? 'disabled' : ''}>Next</button>
      <button id="copyTable">Copy TSV</button>
    `;
    $('#tableWrap').innerHTML = `<table><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${pageRows.map((row) => `<tr>${headers.map((_, index) => `<td>${escapeHtml(row[index] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    $('#tableSearch').oninput = (event) => { state.table.query = event.target.value; state.table.page = 1; draw(); };
    $('#prevPage').onclick = () => { state.table.page -= 1; draw(); };
    $('#nextPage').onclick = () => { state.table.page += 1; draw(); };
    $('#copyTable').onclick = () => navigator.clipboard.writeText([headers, ...filtered].map((row) => row.join('\t')).join('\n'));
  };
  draw();
  return body;
}

async function renderCsv() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading CSV viewer…</p></div>';
  try {
    await mountAdvancedViewer('csv', 'mountCsvViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load CSV viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

function renderJsonTree(value) {
  const rows = [];
  const walk = (val, key, depth) => {
    const type = Array.isArray(val) ? 'array' : val === null ? 'null' : typeof val;
    const primitive = type === 'object' || type === 'array' ? '' : JSON.stringify(val);
    rows.push(`<div class="tree-row" style="padding-left:${8 + depth * 14}px"><span class="key">${escapeHtml(key)}</span><span class="type">${type}</span><span class="value">${escapeHtml(primitive)}</span></div>`);
    if (val && typeof val === 'object') {
      Object.entries(val).forEach(([childKey, childValue]) => walk(childValue, childKey, depth + 1));
    }
  };
  walk(value, '$', 0);
  return rows.join('');
}

async function renderJson() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading JSON viewer…</p></div>';
  try {
    await mountAdvancedViewer('json', 'mountJsonViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load JSON viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderJsonl() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading JSONL viewer…</p></div>';
  try {
    await mountAdvancedViewer('jsonl', 'mountJsonlViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load JSONL viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderYaml() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading YAML viewer…</p></div>';
  try {
    await mountAdvancedViewer('yaml', 'mountYamlViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load YAML viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderToml() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading TOML viewer…</p></div>';
  try {
    await mountAdvancedViewer('toml', 'mountTomlViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load TOML viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderMarkdown() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading Markdown viewer...</p></div>';
  try {
    await mountAdvancedViewer('markdown', 'mountMarkdownViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load Markdown viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderLatex() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading LaTeX viewer...</p></div>';
  try {
    await mountAdvancedViewer('latex', 'mountLatexViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load LaTeX viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderMermaid() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading Mermaid viewer…</p></div>';
  try {
    await mountAdvancedViewer('mermaid', 'mountMermaidViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load Mermaid viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderPlantUml() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading PlantUML viewer…</p></div>';
  try {
    await mountAdvancedViewer('plantuml', 'mountPlantUmlViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load PlantUML viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderProto() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading Protocol Buffers viewer...</p></div>';
  try {
    await mountAdvancedViewer('proto', 'mountProtoViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load Protocol Buffers viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderAutomotive() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading automotive data viewer...</p></div>';
  try {
    await mountAdvancedViewer('automotive', 'mountAutomotiveViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load automotive data viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderHdf5() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading HDF5 viewer...</p></div>';
  try {
    await mountAdvancedViewer('hdf5', 'mountHdf5Viewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load HDF5 viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderMat() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading MAT viewer...</p></div>';
  try {
    await mountAdvancedViewer('mat', 'mountMatViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load MAT viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderNumpy() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading NumPy viewer...</p></div>';
  try {
    await mountAdvancedViewer('numpy', 'mountNumpyViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load NumPy viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderGguf() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading GGUF viewer...</p></div>';
  try {
    await mountAdvancedViewer('gguf', 'mountGgufViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load GGUF viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderOnnx() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading ONNX viewer...</p></div>';
  try {
    await mountAdvancedViewer('onnx', 'mountOnnxViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load ONNX viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderTflite() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading TFLite viewer...</p></div>';
  try {
    await mountAdvancedViewer('tflite', 'mountTfliteViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load TFLite viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderKeras() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading Keras viewer...</p></div>';
  try {
    await mountAdvancedViewer('keras', 'mountKerasViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load Keras viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderCoreml() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading Core ML viewer...</p></div>';
  try {
    await mountAdvancedViewer('coreml', 'mountCoremlViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load Core ML viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderOpenvino() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading OpenVINO IR viewer...</p></div>';
  try {
    // The `.bin` is a sidecar the core never sees on its own; hand over the
    // one that arrived with the `.xml`, if any. The adapter lets the user
    // attach one later either way.
    const bin = companionBinFor(state.file, state.companions);
    await mountAdvancedViewer('openvino', 'mountOpenVinoViewer', body, { sidecars: { bin } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load OpenVINO IR viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderSafetensors() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading safetensors viewer...</p></div>';
  try {
    await mountAdvancedViewer('safetensors', 'mountSafetensorsViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load safetensors viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderVideo() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading video viewer…</p></div>';
  try {
    await mountAdvancedViewer('video', 'mountVideoViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load video viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderAudio() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading audio viewer…</p></div>';
  try {
    await mountAdvancedViewer('audio', 'mountAudioViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load audio viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderExcel() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading Excel viewer…</p></div>';
  try {
    await mountAdvancedViewer('excel', 'mountExcelViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load Excel viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderWord() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading Word viewer…</p></div>';
  try {
    await mountAdvancedViewer('word', 'mountWordViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load Word viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderPpt() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading presentation viewer…</p></div>';
  try {
    await mountAdvancedViewer('ppt', 'mountPptViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load presentation viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderPsd() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading PSD viewer…</p></div>';
  try {
    await mountAdvancedViewer('psd', 'mountPsdViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load PSD viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderParquet() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading Parquet reader…</p></div>';
  try {
    await mountAdvancedViewer('parquet', 'mountParquetViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load Parquet reader.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderHwp() {
  // Both `.hwp` (binary, rhwp WASM) and `.hwpx` (zipped XML) flow through
  // the new HWP viewer bundle. The bundle's main module dispatches by
  // filename internally (see `mountHwpViewer` in
  // `src/templates/hwp/js/hwpViewerMain.ts`).
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading HWP renderer…</p></div>';
  try {
    await mountAdvancedViewer('hwp', 'mountHwpViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load HWP renderer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderArchive() {
  const body = panel(state.file.name);
  body.innerHTML = '<div class="unsupported"><p>Loading archive viewer…</p></div>';
  try {
    await mountAdvancedViewer('archive', 'mountArchiveViewer', body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    body.innerHTML = `<div class="unsupported"><p>Couldn't load archive viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
  }
}

async function renderRawData() {
  const body = panel(state.file?.name || 'Raw data');
  body.innerHTML = '<div class="unsupported"><p>Loading raw data...</p></div>';
  const size = state.file?.size || 0;
  const sliceSize = Math.min(size, RAW_TEXT_PREVIEW_LIMIT);
  const bytes = new Uint8Array(await state.file.slice(0, sliceSize).arrayBuffer());
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const truncated = size > sliceSize;
  body.innerHTML = `
    <div class="raw-text-viewer">
      ${truncated ? `<div class="audio-status">Showing first ${formatSize(sliceSize)} of ${formatSize(size)}.</div>` : ''}
      <pre>${escapeHtml(text)}</pre>
    </div>
  `;
}

const languageReady = initializeLanguagePreference().then(localizeDocument);

shareCurrentFileButton.addEventListener('click', shareCurrentFile);
openSharedLinkButton.addEventListener('click', openSharedLinkPrompt);
languageSelect?.addEventListener('change', () => saveLocalePreference(languageSelect.value));

// Several files at once (multi-select, multi-drop, or a multi-file launch)
// open as one: the primary is shown, the rest travel as its companions.
function openFiles(files, handle = null, generation = claimOpenFileIntent()) {
  const list = Array.from(files || []);
  if (list.length === 0) return Promise.resolve();
  return openFile(pickPrimaryFile(list), handle, generation, list);
}

fileInput.addEventListener('change', () => {
  openFiles(fileInput.files);
});

dropZone.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dropZone.classList.add('dragging');
});
dropZone.addEventListener('dragover', (event) => event.preventDefault());
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('dragging');
  openFiles(event.dataTransfer?.files);
});

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (event) => {
  if (event.target !== dropZone) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
  }
});

chrome.storage?.local?.get?.(['theme']).then((result) => {
  if (result.theme === 'light') document.documentElement.classList.add('light');
});

if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (launchParams) => {
    const handles = launchParams.files || [];
    if (handles.length === 0) return;
    const generation = claimOpenFileIntent();
    try {
      const files = await Promise.all(handles.map((handle) => handle.getFile()));
      if (generation !== state.openFileGeneration) return;
      const file = pickPrimaryFile(files);
      // Only the primary's handle matters: it is the one a viewer may write
      // back to, and companions are read-only sidecars.
      await openFile(file, handles[files.indexOf(file)], generation, files);
    } catch (error) {
      if (generation !== state.openFileGeneration) return;
      console.error(error);
      setStatus(error instanceof Error ? error.message : String(error), true);
    }
  });
}
