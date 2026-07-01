const $ = (selector) => document.querySelector(selector);

const state = {
  file: null,
  type: 'unknown',
  objectUrl: null,
  pdfScale: 1.1,
  table: { rows: [], headers: [], page: 1, pageSize: 80, query: '' },
  audio: {
    wavesurfer: null,
    regions: null,
    spectrogram: null,
    timeline: null,
    minimap: null,
    mode: 'default',
    loop: false,
    selectedRegion: null,
    audioEngine: null,
    blobUrl: null,
    zoomMin: 1,
    regionOverlays: [],
    eventCleanups: []
  }
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
  mermaid: ['.mmd', '.mermaid'],
  plantuml: ['.puml', '.plantuml', '.iuml'],
  proto: ['.proto'],
  automotive: ['.dbc', '.arxml', '.a2l', '.asc', '.blf', '.mf4', '.mdf', '.avro', '.bag', '.stp', '.step', '.db3', '.sqlite', '.sqlite3', '.reqif', '.pcap', '.pcapng'],
  hdf5: ['.h5', '.hdf5'],
  mat: ['.mat'],
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
  mermaid: 'Mermaid',
  plantuml: 'PlantUML',
  proto: 'Protocol Buffers',
  automotive: 'Automotive',
  hdf5: 'HDF5',
  mat: 'MAT',
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

const LARGE_AUDIO_THRESHOLD = 50 * 1024 * 1024;
const LONG_AUDIO_THRESHOLD = 300;
const AUDIO_PEAKS_WIDTH = 32000;
const AUDIO_FFT_SIZE = 2048;
const AUDIO_MAX_SPEC_WIDTH = 3500;
const RAW_TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;
const AUDIO_BITRATE_ESTIMATES = {
  '.mp3': 16000,
  '.ogg': 16000,
  '.aac': 16000,
  '.m4a': 16000,
  '.flac': 100000,
  '.wav': 176400
};
const UNRELIABLE_AUDIO_DURATION_EXTS = new Set(['.ogg']);

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

function ascii(bytes, start = 0, length = bytes.length - start) {
  return Array.from(bytes.slice(start, start + length), (value) => String.fromCharCode(value)).join('');
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
  if (hasPrefix(head, [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a])) return 'hdf5';
  if (ascii(head, 0, 4) === 'LOGG') return 'automotive';
  if (/^MDF\s/.test(ascii(head, 0, Math.min(head.length, 64)))) return 'automotive';
  if (ascii(head, 0, 4) === 'Obj\x01') return 'automotive';
  if (ascii(head, 0, 11) === '#ROSBAG V2.') return 'automotive';
  if (ascii(head, 0, 16) === 'SQLite format 3\0') return 'automotive';
  if (hasPrefix(head, [0xd4, 0xc3, 0xb2, 0xa1]) || hasPrefix(head, [0xa1, 0xb2, 0xc3, 0xd4]) || hasPrefix(head, [0x4d, 0x3c, 0xb2, 0xa1]) || hasPrefix(head, [0xa1, 0xb2, 0x3c, 0x4d])) return 'automotive';
  if (hasPrefix(head, [0x0a, 0x0d, 0x0d, 0x0a])) return 'automotive';
  if (hasPrefix(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return byExtension(file);
  if (hasPrefix(head, [0x50, 0x4b])) {
    const text = ascii(head, 0, Math.min(head.length, 65536));
    if (text.includes('word/')) return 'word';
    if (text.includes('xl/')) return 'excel';
    if (text.includes('ppt/')) return 'ppt';
    if (text.includes('Contents/content.hpf') || text.includes('version.xml')) return 'hwp';
    return formats.archive.includes(ext) ? 'archive' : byExtension(file);
  }
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

function objectUrl(file) {
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(file);
  return state.objectUrl;
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
        : rel;
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
  if (state.advancedViewerHandle) {
    try { state.advancedViewerHandle.dispose?.(); } catch {}
    state.advancedViewerHandle = null;
  }
}

async function mountAdvancedViewer(slug, mountFnName, container) {
  releaseAdvancedViewer();
  const mod = await loadAdvancedViewerBundle(slug);
  const mountFn = mod[mountFnName];
  if (typeof mountFn !== 'function') {
    throw new Error(`${slug} bundle missing ${mountFnName}`);
  }
  const handle = await mountFn(state.file, container);
  if (handle && typeof handle.dispose === 'function') {
    state.advancedViewerHandle = handle;
  }
}

function releaseAudio() {
  const audio = state.audio;
  document.removeEventListener('keydown', audioSpaceHandler);
  audio.eventCleanups.forEach((cleanup) => cleanup());
  audio.eventCleanups = [];
  removeRegionOverlays();
  try { audio.wavesurfer?.destroy?.(); } catch {}
  audio.wavesurfer = null;
  audio.regions = null;
  audio.spectrogram = null;
  audio.timeline = null;
  audio.minimap = null;
  audio.selectedRegion = null;
  if (audio.blobUrl) {
    URL.revokeObjectURL(audio.blobUrl);
    audio.blobUrl = null;
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

async function openFile(file) {
  releaseAudio();
  releaseAdvancedViewer();
  state.file = file;
  shareCurrentFileButton.disabled = false;
  state.type = await detectType(file);
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
  openSharedLinkButton.disabled = true;
  setStatus('Downloading shared file...');
  try {
    const { openSharedLink } = await loadShareModule();
    const file = await openSharedLink(input, { downloadImpl: downloadSharedFileViaBackground });
    await openFile(file);
  } catch (error) {
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
  if (type === 'mermaid') return renderMermaid();
  if (type === 'plantuml') return renderPlantUml();
  if (type === 'proto') return renderProto();
  if (type === 'automotive') return renderAutomotive();
  if (type === 'hdf5') return renderHdf5();
  if (type === 'mat') return renderMat();
  if (type === 'audio') return renderAudio();
  if (type === 'video') return renderMedia('video');
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

async function renderMedia(kind) {
  if (kind === 'video') {
    const body = panel(state.file.name);
    body.innerHTML = '<div class="unsupported"><p>Loading video viewer…</p></div>';
    try {
      await mountAdvancedViewer('video', 'mountVideoViewer', body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      body.innerHTML = `<div class="unsupported"><p>Couldn't load video viewer.</p><pre>${escapeHtml(message)}</pre></div>`;
    }
    return;
  }
  // Audio: keep the legacy renderAudio path — it has a comprehensive
  // WaveSurfer + WASM peaks integration that isn't yet replicated 1:1
  // by the template/audio bundle. The advanced bundle exists but the
  // legacy SPA's audio impl is feature-richer today; #72's audio leg
  // is intentionally deferred for a separate audit pass.
  const tag = `<audio class="media-player" controls src="${objectUrl(state.file)}"></audio>`;
  panel(state.file.name, tag);
}

function estimateAudioDuration(file, metadataDuration = 0) {
  const ext = extOf(file.name);
  if (metadataDuration > 0 && !UNRELIABLE_AUDIO_DURATION_EXTS.has(ext)) return metadataDuration;
  const bytesPerSecond = AUDIO_BITRATE_ESTIMATES[ext];
  return bytesPerSecond ? file.size / bytesPerSecond : 0;
}

function audioFormat(file) {
  const ext = extOf(file.name).replace('.', '').toUpperCase();
  return ext || (file.type || 'audio').replace('audio/', '').toUpperCase();
}

function audioFrequencyToScale(frequency, scale) {
  switch (scale) {
    case 'mel': return 2595 * Math.log10(1 + frequency / 700);
    case 'bark': {
      let value = 26.81 * frequency / (1960 + frequency) - 0.53;
      if (value < 2) value += 0.15 * (2 - value);
      if (value > 20.1) value += 0.22 * (value - 20.1);
      return value;
    }
    case 'erb': return (1000 * Math.log(10) / 107.939) * Math.log10(1 + 0.00437 * frequency);
    default: return frequency;
  }
}

function audioScaleToFrequency(value, scale) {
  switch (scale) {
    case 'mel': return 700 * (10 ** (value / 2595) - 1);
    case 'bark': {
      let adjusted = value;
      if (adjusted < 2) adjusted = (adjusted - 0.3) / 0.85;
      if (adjusted > 20.1) adjusted = (adjusted + 4.422) / 1.22;
      return (adjusted + 0.53) / (26.28 - adjusted) * 1960;
    }
    case 'erb': return (10 ** (value / (1000 * Math.log(10) / 107.939)) - 1) / 0.00437;
    default: return value;
  }
}

function remapPrecomputedSpectrogram(columns, sampleRate, targetScale) {
  if (!columns?.length || targetScale === 'mel') return columns;
  const binCount = columns[0]?.length || 0;
  if (binCount < 2) return columns;
  const nyquist = sampleRate / 2;
  const sourceMax = audioFrequencyToScale(nyquist, 'mel');
  const targetMax = audioFrequencyToScale(nyquist, targetScale);

  return columns.map((column) => {
    const remapped = new Uint8Array(binCount);
    for (let index = 0; index < binCount; index += 1) {
      const targetValue = targetMax * index / (binCount - 1);
      const frequency = audioScaleToFrequency(targetValue, targetScale);
      const sourcePosition = audioFrequencyToScale(frequency, 'mel') / sourceMax * (binCount - 1);
      const lower = Math.max(0, Math.min(binCount - 1, Math.floor(sourcePosition)));
      const upper = Math.max(0, Math.min(binCount - 1, lower + 1));
      const fraction = sourcePosition - lower;
      remapped[index] = Math.round(column[lower] * (1 - fraction) + column[upper] * fraction);
    }
    return remapped;
  });
}

function parseWavFmt(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength < 44) return null;
  try {
    const view = new DataView(arrayBuffer);
    const tag = (offset) => String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;

    let offset = 12;
    const max = view.byteLength - 8;
    while (offset <= max) {
      const id = tag(offset);
      const size = view.getUint32(offset + 4, true);
      if (id === 'fmt ') {
        if (offset + 24 > view.byteLength) return null;
        const channels = view.getUint16(offset + 10, true);
        const sampleRate = view.getUint32(offset + 12, true);
        const bitsPerSample = view.getUint16(offset + 22, true);
        if (channels <= 0 || sampleRate <= 0 || bitsPerSample <= 0) return null;
        return { channels, sampleRate, bitsPerSample };
      }
      offset += 8 + size + (size & 1);
    }
  } catch (error) {
    console.warn('[AudioViewer] WAV metadata parse failed:', error);
  }
  return null;
}

async function getAudioMetadata(file) {
  const url = URL.createObjectURL(file);
  try {
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.src = url;
    const duration = await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const done = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        audio.removeAttribute('src');
        audio.load();
        resolve(value);
      };
      audio.addEventListener('loadedmetadata', () => done(Number.isFinite(audio.duration) ? audio.duration : 0), { once: true });
      audio.addEventListener('error', () => done(0), { once: true });
      timer = setTimeout(() => done(0), 5000);
    });
    const metadata = { duration, fileSize: formatSize(file.size), format: audioFormat(file) };
    if (metadata.format === 'WAV') {
      const wavFmt = parseWavFmt(await file.slice(0, 65536).arrayBuffer());
      if (wavFmt) Object.assign(metadata, wavFmt);
    }
    return metadata;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.000';
  const minutes = Math.floor(seconds / 60);
  const sec = (seconds % 60).toFixed(3).padStart(6, '0');
  return `${minutes}:${sec}`;
}

async function initAudioEngine() {
  if (state.audio.audioEngine) return state.audio.audioEngine;
  if (typeof window.AudioEngineModule !== 'function') {
    throw new Error('Audio WASM glue is not loaded.');
  }
  state.audio.audioEngine = await window.AudioEngineModule({
    locateFile: (file) => chrome.runtime.getURL(`vendor/${file}`)
  });
  return state.audio.audioEngine;
}

async function analyzeAudioWithWasm(file) {
  const module = await initAudioEngine();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const inputPtr = module._malloc(bytes.length);
  if (!inputPtr) throw new Error(`WASM malloc failed for ${(bytes.length / 1024 / 1024).toFixed(1)}MB audio file.`);
  module.HEAPU8.set(bytes, inputPtr);
  const audioPtr = module._decode_audio(inputPtr, bytes.length);
  module._free(inputPtr);
  if (!audioPtr) throw new Error(`WASM audio decode failed for ${extOf(file.name) || file.type || 'audio file'}.`);

  try {
    const channels = module._audio_get_channels(audioPtr);
    const sampleRate = module._audio_get_sample_rate(audioPtr);
    const framesLow = module._audio_get_total_frames(audioPtr);
    const framesHigh = module._audio_get_total_frames_high(audioPtr);
    const totalFrames = framesLow + framesHigh * 0x100000000;
    const duration = totalFrames / sampleRate;

    const peaksPtr = module._generate_peaks(audioPtr, AUDIO_PEAKS_WIDTH);
    if (!peaksPtr) throw new Error('WASM peak generation failed.');
    const peaks = new Float32Array(module.HEAPF32.buffer, peaksPtr, AUDIO_PEAKS_WIDTH).slice();
    module._free_buffer(peaksPtr);

    const hopSize = Math.max(512, Math.ceil(totalFrames / AUDIO_MAX_SPEC_WIDTH));
    const outWidthPtr = module._malloc(4);
    const outHeightPtr = module._malloc(4);
    const specPtr = module._generate_spectrogram(audioPtr, AUDIO_FFT_SIZE, hopSize, outWidthPtr, outHeightPtr);
    const specWidth = module.getValue(outWidthPtr, 'i32');
    const specHeight = module.getValue(outHeightPtr, 'i32');
    module._free(outWidthPtr);
    module._free(outHeightPtr);

    const spectrogram = [];
    if (specPtr && specWidth > 0 && specHeight > 0) {
      for (let t = 0; t < specWidth; t += 1) {
        const column = new Uint8Array(specHeight);
        for (let f = 0; f < specHeight; f += 1) {
          column[f] = module.HEAPU8[specPtr + t * specHeight + f];
        }
        spectrogram.push(column);
      }
      module._free_buffer(specPtr);
    }

    return { peaks: [Array.from(peaks)], duration, sampleRate, channels, spectrogram };
  } finally {
    module._free_audio(audioPtr);
  }
}

async function renderAudio() {
  const [
    { default: WaveSurfer },
    { default: HoverPlugin },
    { default: MinimapPlugin },
    { default: RegionsPlugin },
    { default: SpectrogramPlugin },
    { default: TimelinePlugin }
  ] = await Promise.all([
    import('../vendor/wavesurfer/wavesurfer.esm.js'),
    import('../vendor/wavesurfer/plugins/hover.js'),
    import('../vendor/wavesurfer/plugins/minimap.js'),
    import('../vendor/wavesurfer/plugins/regions.js'),
    import('../vendor/wavesurfer/plugins/spectrogram.js'),
    import('../vendor/wavesurfer/plugins/timeline.js')
  ]);

  const body = panel(state.file.name, `
    <div class="audio-viewer">
      <div id="audioInfo" class="audio-info"></div>
      <div class="audio-controls">
        <button id="audioPlay" class="audio-icon-button" type="button" aria-label="Play" title="Play">
          <svg class="audio-control-icon audio-play-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"></path></svg>
          <svg class="audio-control-icon audio-pause-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z"></path></svg>
        </button>
        <button id="audioStop" class="audio-icon-button" type="button" aria-label="Stop" title="Stop">
          <svg class="audio-control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h12v12H6z"></path></svg>
        </button>
        <label class="audio-slider" aria-label="Volume" title="Volume"><input id="audioVolume" type="range" min="0" max="1" step="0.01" value="0.8" aria-label="Volume"></label>
        <label id="audioLoopControl" class="audio-check" hidden><input id="audioLoop" type="checkbox"> Loop</label>
        <button id="audioZoomOut" type="button">-</button>
        <span id="audioZoomLabel">fit</span>
        <button id="audioZoomIn" type="button">+</button>
        <div class="segmented">
          <button class="audio-mode active" data-mode="waveform" type="button">Wave</button>
          <button class="audio-mode" data-mode="spectrogram" type="button">Spec</button>
          <button class="audio-mode" data-mode="both" type="button">Both</button>
        </div>
        <select id="audioSpecScale">
          <option value="mel" selected>Mel</option>
          <option value="linear">Linear</option>
          <option value="bark">Bark</option>
          <option value="erb">ERB</option>
        </select>
        <button id="audioDownload" type="button">Download</button>
      </div>
      <div id="audioStatus" class="audio-status">Loading audio...</div>
      <div id="audioMinimap" class="audio-minimap"></div>
      <div id="audioTimeline" class="audio-timeline"></div>
      <div id="audioWaveform" class="audio-waveform"></div>
      <div id="audioSpectrogram" class="audio-spectrogram"></div>
      <div id="audioSpecProgress" class="audio-spec-progress" role="slider" aria-label="Playback position" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0">
        <div id="audioSpecProgressFill" class="audio-spec-progress-fill"></div>
      </div>
      <div id="audioContextMenu" class="audio-context-menu" role="menu">
        <button id="audioSaveRegion" type="button" role="menuitem">Save Selected Region as New File</button>
      </div>
    </div>
  `);

  const metadata = await getAudioMetadata(state.file);
  const estimatedDuration = estimateAudioDuration(state.file, metadata.duration);
  const useWasm = state.file.size > LARGE_AUDIO_THRESHOLD || estimatedDuration > LONG_AUDIO_THRESHOLD;
  const directUrl = objectUrl(state.file);
  const audioInfo = $('#audioInfo');
  const audioStatus = $('#audioStatus');
  const setAudioStatus = (message, isError = false) => {
    audioStatus.textContent = message;
    audioStatus.classList.toggle('error', isError);
  };

  let analysis = null;
  let mode = 'default';
  if (useWasm) {
    mode = 'precomputed';
    setAudioStatus('Large/long audio detected. Analyzing waveform with WASM...');
    try {
      analysis = await analyzeAudioWithWasm(state.file);
      if (estimatedDuration > 60 && analysis.duration < estimatedDuration * 0.5) {
        throw new Error(`WASM decoded ${analysis.duration.toFixed(1)}s but estimated ~${estimatedDuration.toFixed(1)}s.`);
      }
    } catch (error) {
      console.warn('[AudioViewer] WASM analysis failed, falling back to streaming mode:', error);
      mode = 'streaming';
      setAudioStatus(`WASM analysis failed. Falling back to streaming WaveSurfer. ${error.message}`, true);
    }
  }
  state.audio.mode = mode;

  const updateAudioInfo = () => {
    const decoded = (() => {
      try { return wavesurfer?.getDecodedData?.() || null; } catch { return null; }
    })();
    const sampleRate = analysis?.sampleRate || metadata.sampleRate || decoded?.sampleRate || null;
    const channels = analysis?.channels || metadata.channels || decoded?.numberOfChannels || null;
    const duration = analysis?.duration || metadata.duration || wavesurfer?.getDuration?.() || estimatedDuration;
    audioInfo.innerHTML = `
      <span><strong>Mode</strong> ${mode}</span>
      <span><strong>Duration</strong> ${formatTime(duration)}</span>
      <span><strong>Sample Rate</strong> ${sampleRate ? sampleRate.toLocaleString() + ' Hz' : '--'}</span>
      <span><strong>Channels</strong> ${channels || '--'}</span>
      <span><strong>Bit Depth</strong> ${metadata.bitsPerSample ? metadata.bitsPerSample + '-bit' : '--'}</span>
      <span><strong>File Size</strong> ${formatSize(state.file.size)}</span>
      <span><strong>Format</strong> ${escapeHtml(metadata.format)}</span>
    `;
  };

  const splitChannelOptions = [
    { overlay: false, waveColor: '#4F4A85', progressColor: '#383351' },
    { overlay: false, waveColor: '#2f7d8c', progressColor: '#245867' }
  ];
  const knownChannels = analysis?.channels || metadata.channels || null;
  const shouldSplitChannels = mode === 'default' && knownChannels === 2;

  const commonPlugins = [
    HoverPlugin.create({
      lineWidth: 2,
      labelBackground: '#000',
      labelColor: '#fff',
      formatTimeCallback: formatTime
    })
  ];

  const wsOptions = {
    container: '#audioWaveform',
    waveColor: '#4F4A85',
    progressColor: '#383351',
    cursorColor: '#fff',
    barWidth: mode === 'precomputed' ? 1 : 2,
    barRadius: 2,
    barGap: mode === 'precomputed' ? 1 : 3,
    normalize: true,
    interact: true,
    hideScrollbar: false,
    plugins: commonPlugins
  };
  if (shouldSplitChannels) wsOptions.splitChannels = splitChannelOptions;

  if (mode === 'precomputed' && analysis) {
    const containerWidth = $('#audioWaveform')?.offsetWidth || 1000;
    const visibleSeconds = Math.min(30, analysis.duration);
    const minPxPerSec = containerWidth / visibleSeconds;
    state.audio.zoomMin = Math.max(containerWidth / analysis.duration, minPxPerSec);
    wsOptions.url = directUrl;
    wsOptions.backend = 'MediaElement';
    wsOptions.peaks = analysis.peaks;
    wsOptions.duration = analysis.duration;
    wsOptions.minPxPerSec = minPxPerSec;
    wsOptions.autoScroll = true;
    wsOptions.autoCenter = true;
    wsOptions.plugins.push(MinimapPlugin.create({
      height: 42,
      waveColor: '#3a366e',
      progressColor: '#2a2546',
      overlayColor: 'rgba(100, 100, 200, 0.15)',
      container: '#audioMinimap'
    }));
  } else if (mode === 'streaming') {
    wsOptions.url = directUrl;
    wsOptions.backend = 'MediaElement';
  } else {
    wsOptions.url = directUrl;
    wsOptions.backend = 'WebAudio';
    wsOptions.sampleRate = 44100;
  }

  const wavesurfer = WaveSurfer.create(wsOptions);
  state.audio.wavesurfer = wavesurfer;
  updateAudioInfo();

  const setupPlugins = async () => {
    if (!state.audio.wavesurfer || state.audio.wavesurfer !== wavesurfer) return;
    if (state.audio.timeline || state.audio.regions) return;
    const decoded = wavesurfer.getDecodedData?.();
    const splitChannels = mode === 'default' && decoded?.numberOfChannels === 2;
    if (splitChannels && !wavesurfer.options.splitChannels) {
      wavesurfer.setOptions({ splitChannels: splitChannelOptions });
    }
    updateAudioInfo();
    state.audio.timeline = wavesurfer.registerPlugin(TimelinePlugin.create({
      container: '#audioTimeline',
      formatTimeCallback: formatTime
    }));
    state.audio.regions = wavesurfer.registerPlugin(RegionsPlugin.create({}));
    state.audio.regions.enableDragSelection({ color: 'rgba(47, 111, 237, 0.18)' });
    state.audio.regions.on('region-created', (region) => {
      state.audio.regions.getRegions().forEach((item) => {
        if (item.id !== region.id) item.remove();
      });
      state.audio.selectedRegion = region;
      createRegionOverlays(region);
      $('#audioLoopControl').hidden = false;
    });
    state.audio.regions.on('region-update', updateRegionOverlays);
    state.audio.regions.on('region-updated', updateRegionOverlays);
    state.audio.regions.on('region-removed', (region) => {
      if (state.audio.selectedRegion?.id !== region.id) return;
      state.audio.selectedRegion = null;
      removeRegionOverlays();
      wavesurfer.stop();
      $('#audioLoopControl').hidden = true;
    });

    if (mode === 'precomputed' && analysis?.spectrogram?.length) {
      state.audio.spectrogram = wavesurfer.registerPlugin(SpectrogramPlugin.create({
        container: '#audioSpectrogram',
        labels: true,
        scale: $('#audioSpecScale').value,
        height: 250,
        sampleRate: analysis.sampleRate,
        splitChannels
      }));
      const plugin = state.audio.spectrogram;
      plugin.wrapper?.classList?.add('audio-spectrogram-wrapper');
      plugin.frequencyMax = analysis.sampleRate / 2;
      plugin.cachedFrequencies = [remapPrecomputedSpectrogram(
        analysis.spectrogram,
        analysis.sampleRate,
        $('#audioSpecScale').value
      )];
      plugin.render = async function renderPrecomputedSpectrogram() {
        if (this.isRendering) return;
        this.isRendering = true;
        try {
          this.drawSpectrogram(this.cachedFrequencies);
          this.lastZoomLevel = this.wavesurfer?.options.minPxPerSec || 0;
        } finally {
          this.isRendering = false;
        }
      };
      setTimeout(() => plugin.render(), 150);
    } else {
      state.audio.spectrogram = wavesurfer.registerPlugin(SpectrogramPlugin.create({
        container: '#audioSpectrogram',
        labels: true,
        scale: $('#audioSpecScale').value,
        fftSize: 4096,
        noverlap: 2048,
        height: 250,
        splitChannels
      }));
      state.audio.spectrogram.wrapper?.classList?.add('audio-spectrogram-wrapper');
    }

    setAudioViewMode('waveform');
    setAudioStatus('Ready');
  };

  wavesurfer.on('ready', setupPlugins);
  wavesurfer.on('decode', setupPlugins);
  const setAudioPlayState = (playing) => {
    const button = $('#audioPlay');
    button.classList.toggle('playing', playing);
    button.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    button.setAttribute('title', playing ? 'Pause' : 'Play');
  };
  const updateSpecProgress = (currentTime = wavesurfer.getCurrentTime()) => {
    const duration = wavesurfer.getDuration();
    const percent = Number.isFinite(duration) && duration > 0
      ? Math.max(0, Math.min(100, currentTime / duration * 100))
      : 0;
    $('#audioSpecProgressFill').style.width = `${percent}%`;
    $('#audioSpecProgress').setAttribute('aria-valuenow', String(Math.round(percent)));
  };
  const seekSpecProgress = (time) => {
    const duration = wavesurfer.getDuration();
    if (!Number.isFinite(duration) || duration <= 0) return;
    const nextTime = Math.max(0, Math.min(duration, time));
    if (typeof wavesurfer.setTime === 'function') wavesurfer.setTime(nextTime);
    else wavesurfer.seekTo?.(nextTime / duration);
    updateSpecProgress(nextTime);
  };
  wavesurfer.on('play', () => setAudioPlayState(true));
  wavesurfer.on('pause', () => setAudioPlayState(false));
  wavesurfer.on('stop', () => {
    setAudioPlayState(false);
    updateSpecProgress(0);
  });
  wavesurfer.on('timeupdate', updateSpecProgress);
  wavesurfer.on('seeking', updateSpecProgress);
  wavesurfer.on('finish', () => {
    if (state.audio.loop) {
      const region = state.audio.selectedRegion;
      if (region) wavesurfer.play(region.start, region.end);
      else wavesurfer.play();
    } else {
      setAudioPlayState(false);
      updateSpecProgress(wavesurfer.getDuration());
    }
  });
  wavesurfer.on('error', (error) => setAudioStatus(`Audio error: ${error?.message || error}`, true));

  $('#audioPlay').onclick = async () => {
    const region = state.audio.selectedRegion;
    if (wavesurfer.isPlaying()) {
      wavesurfer.pause();
    } else if (region) {
      await wavesurfer.play(region.start, region.end);
    } else {
      await wavesurfer.play();
    }
  };
  $('#audioStop').onclick = () => wavesurfer.stop();
  $('#audioSpecProgress').onclick = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    seekSpecProgress(ratio * wavesurfer.getDuration());
  };
  $('#audioSpecProgress').onkeydown = (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    seekSpecProgress(wavesurfer.getCurrentTime() + (event.key === 'ArrowRight' ? 5 : -5));
  };
  $('#audioVolume').oninput = (event) => wavesurfer.setVolume(Number(event.target.value));
  $('#audioLoop').onchange = (event) => { state.audio.loop = event.target.checked; };
  $('#audioDownload').onclick = () => downloadBlob(state.file, state.file.name);
  $('#audioSaveRegion').onclick = async () => {
    hideAudioContextMenu();
    await downloadAudioRegion(state.audio.selectedRegion, setAudioStatus);
  };
  $('#audioZoomIn').onclick = () => updateAudioZoom(2);
  $('#audioZoomOut').onclick = () => updateAudioZoom(0.5);
  $('#audioSpecScale').onchange = async () => {
    if (!state.audio.spectrogram) return;
    const scale = $('#audioSpecScale').value;
    const activeMode = document.querySelector('.audio-mode.active')?.dataset.mode || 'waveform';
    wavesurfer.unregisterPlugin?.(state.audio.spectrogram);
    state.audio.spectrogram = null;
    $('#audioSpectrogram').replaceChildren();

    if (mode === 'precomputed' && analysis?.spectrogram?.length) {
      state.audio.spectrogram = wavesurfer.registerPlugin(SpectrogramPlugin.create({
        container: '#audioSpectrogram', labels: true, scale, height: 250, sampleRate: analysis.sampleRate,
        splitChannels: mode === 'default' && wavesurfer.getDecodedData?.()?.numberOfChannels === 2
      }));
      const plugin = state.audio.spectrogram;
      plugin.wrapper?.classList?.add('audio-spectrogram-wrapper');
      plugin.frequencyMax = analysis.sampleRate / 2;
      plugin.cachedFrequencies = [remapPrecomputedSpectrogram(analysis.spectrogram, analysis.sampleRate, scale)];
      plugin.render = async function renderPrecomputedSpectrogram() {
        if (this.isRendering) return;
        this.isRendering = true;
        try {
          this.drawSpectrogram(this.cachedFrequencies);
          this.lastZoomLevel = this.wavesurfer?.options.minPxPerSec || 0;
        } finally {
          this.isRendering = false;
        }
      };
      setTimeout(() => void plugin.render(), 120);
    } else {
      state.audio.spectrogram = wavesurfer.registerPlugin(SpectrogramPlugin.create({
        container: '#audioSpectrogram', labels: true, scale, fftSize: 4096, noverlap: 2048, height: 250,
        splitChannels: mode === 'default' && wavesurfer.getDecodedData?.()?.numberOfChannels === 2
      }));
      state.audio.spectrogram.wrapper?.classList?.add('audio-spectrogram-wrapper');
      setTimeout(() => void state.audio.spectrogram?.render?.(), 120);
    }
    setAudioViewMode(activeMode);
  };
  document.querySelectorAll('.audio-mode').forEach((button) => {
    button.onclick = () => setAudioViewMode(button.dataset.mode);
  });
  document.addEventListener('keydown', audioSpaceHandler);
  setupAudioRegionInteractions();

  if (mode !== 'precomputed') {
    setAudioStatus(mode === 'streaming' ? 'Streaming through WaveSurfer...' : 'Decoding with WaveSurfer...');
  }

  return body;
}

function hideAudioContextMenu() {
  const menu = $('#audioContextMenu');
  if (menu) menu.style.display = 'none';
}

function audioEventPath(event) {
  return typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
}

function isAudioRegionInteraction(event) {
  const region = state.audio.selectedRegion;
  return audioEventPath(event).some((element) => {
    if (element === region?.element) return true;
    if (!(element instanceof Element)) return false;
    if (element.closest?.('.audio-region-overlay')) return true;
    return element.getAttribute?.('part')?.split(/\s+/).includes('region') || false;
  });
}

function clearSelectedAudioRegion() {
  const region = state.audio.selectedRegion;
  if (region) region.remove();
}

function setupAudioRegionInteractions() {
  const waveform = $('#audioWaveform');
  const spectrogram = $('#audioSpectrogram');
  const menu = $('#audioContextMenu');
  if (!waveform || !menu) return;

  const showMenu = (event) => {
    event.preventDefault();
    const clickedOverlay = audioEventPath(event).some(
      (element) => element instanceof Element && element.closest?.('.audio-region-overlay')
    );
    if (!state.audio.selectedRegion || clickedOverlay) {
      hideAudioContextMenu();
      return;
    }
    menu.style.display = 'block';
    const rect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  };
  const clearFromWaveform = (event) => {
    hideAudioContextMenu();
    if (!isAudioRegionInteraction(event)) clearSelectedAudioRegion();
  };
  const clearFromSpectrogram = () => {
    hideAudioContextMenu();
    clearSelectedAudioRegion();
  };
  const hideFromDocument = (event) => {
    if (!menu.contains(event.target)) hideAudioContextMenu();
  };
  const hideOnEscape = (event) => {
    if (event.key === 'Escape') hideAudioContextMenu();
  };

  waveform.addEventListener('contextmenu', showMenu);
  waveform.addEventListener('click', clearFromWaveform);
  spectrogram?.addEventListener('contextmenu', showMenu);
  spectrogram?.addEventListener('click', clearFromSpectrogram);
  document.addEventListener('click', hideFromDocument);
  document.addEventListener('keydown', hideOnEscape);
  state.audio.eventCleanups.push(
    () => waveform.removeEventListener('contextmenu', showMenu),
    () => waveform.removeEventListener('click', clearFromWaveform),
    () => spectrogram?.removeEventListener('contextmenu', showMenu),
    () => spectrogram?.removeEventListener('click', clearFromSpectrogram),
    () => document.removeEventListener('click', hideFromDocument),
    () => document.removeEventListener('keydown', hideOnEscape)
  );
}

async function getAudioBufferForRegionExport() {
  if (state.audio.mode === 'default') {
    const decoded = state.audio.wavesurfer?.getDecodedData?.();
    if (decoded?.numberOfChannels && decoded?.sampleRate) return decoded;
  }
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error('Web Audio decoding is not supported in this browser.');
  const context = new AudioContextClass();
  try {
    return await context.decodeAudioData(await state.file.arrayBuffer());
  } finally {
    await context.close?.();
  }
}

function audioRegionToWav(buffer, startTime, endTime) {
  const sampleRate = buffer.sampleRate;
  const channelCount = buffer.numberOfChannels;
  const startSample = Math.max(0, Math.min(buffer.length, Math.floor(startTime * sampleRate)));
  const endSample = Math.max(startSample, Math.min(buffer.length, Math.floor(endTime * sampleRate)));
  const frameCount = endSample - startSample;
  if (frameCount <= 0) throw new Error('The selected region is empty.');

  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = frameCount * blockAlign;
  const wav = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wav);
  const writeString = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, wav.byteLength - 8, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  const channels = Array.from({ length: channelCount }, (_, channel) => buffer.getChannelData(channel));
  for (let frame = startSample; frame < endSample; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channels[channel][frame]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }
  return wav;
}

async function downloadAudioRegion(region, setAudioStatus) {
  if (!region) {
    setAudioStatus('No region selected.', true);
    return;
  }
  try {
    setAudioStatus('Extracting selected audio region...');
    const buffer = await getAudioBufferForRegionExport();
    const wav = audioRegionToWav(buffer, region.start, region.end);
    const baseName = state.file.name.replace(/\.[^/.]+$/, '') || 'audio_file';
    const fileName = `${baseName}_${region.start.toFixed(2)}s-${region.end.toFixed(2)}s.wav`;
    const blob = new Blob([wav], { type: 'audio/wav' });
    downloadBlob(blob, fileName);
    setAudioStatus(`Downloaded ${fileName} (${formatSize(blob.size)})`);
  } catch (error) {
    console.error('[AudioViewer] Region export failed:', error);
    setAudioStatus(`Region export failed: ${error?.message || error}`, true);
  }
}

function audioSpaceHandler(event) {
  if (event.code !== 'Space' || event.target.matches('input, textarea, select, button')) return;
  if (!state.audio.wavesurfer) return;
  event.preventDefault();
  $('#audioPlay')?.click();
}

function setAudioViewMode(mode) {
  const waveform = $('#audioWaveform');
  const spectrogram = $('#audioSpectrogram');
  const showWave = mode === 'waveform' || mode === 'both';
  const showSpec = mode === 'spectrogram' || mode === 'both';
  const wrapper = state.audio.wavesurfer?.getWrapper?.();
  const specWrapper = state.audio.spectrogram?.wrapper;
  const specProgress = $('#audioSpecProgress');
  if (waveform) waveform.style.display = (showWave || showSpec) ? 'block' : 'none';
  if (spectrogram) spectrogram.style.display = showSpec && !specWrapper ? 'block' : 'none';
  if (wrapper) {
    wrapper.querySelectorAll('.canvases, .progress, .cursor').forEach((element) => {
      element.style.display = showWave ? '' : 'none';
    });
  }
  if (specWrapper) specWrapper.style.display = showSpec ? 'block' : 'none';
  if (specProgress) specProgress.style.display = mode === 'spectrogram' ? 'block' : 'none';
  document.querySelectorAll('.audio-mode').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === mode);
  });
  requestAnimationFrame(() => updateRegionOverlays(state.audio.selectedRegion));
  if (showSpec) setTimeout(() => state.audio.spectrogram?.render?.(), 80);
}

function updateAudioZoom(factor) {
  const wavesurfer = state.audio.wavesurfer;
  if (!wavesurfer) return;
  const duration = wavesurfer.getDuration() || 1;
  const containerWidth = $('#audioWaveform')?.offsetWidth || 1000;
  const fit = containerWidth / duration;
  const current = wavesurfer.options.minPxPerSec || fit;
  const next = Math.max(fit, Math.min(containerWidth / 2, current * factor));
  wavesurfer.zoom(next);
  const visibleSec = containerWidth / next;
  $('#audioZoomLabel').textContent = visibleSec >= 60 ? `${Math.round(visibleSec / 60)}m` : `${Math.round(visibleSec)}s`;
  requestAnimationFrame(() => updateRegionOverlays(state.audio.selectedRegion));
  setTimeout(() => state.audio.spectrogram?.render?.(), 80);
}

function removeRegionOverlays() {
  const waveform = $('#audioWaveform');
  if (waveform) waveform.onscroll = null;
  state.audio.regionOverlays.forEach((element) => element.remove());
  state.audio.regionOverlays = [];
}

function createRegionOverlays(region) {
  removeRegionOverlays();
  const waveform = $('#audioWaveform');
  if (!waveform || !region?.element) return;

  const createOverlay = (className, label, value) => {
    const overlay = document.createElement('label');
    overlay.className = `audio-region-overlay ${className}`;
    overlay.innerHTML = `${label}<input type="number" min="0" step="0.001" value="${value.toFixed(3)}">`;
    waveform.appendChild(overlay);
    return overlay;
  };

  const startOverlay = createOverlay('audio-region-start', 'Start', region.start);
  const endOverlay = createOverlay('audio-region-end', 'End', region.end);
  const durationOverlay = createOverlay('audio-region-duration', 'Duration', region.end - region.start);
  state.audio.regionOverlays = [startOverlay, endOverlay, durationOverlay];
  waveform.onscroll = () => updateRegionOverlays(region);

  const startInput = startOverlay.querySelector('input');
  const endInput = endOverlay.querySelector('input');
  const durationInput = durationOverlay.querySelector('input');
  const normalizeBounds = (startValue, endValue, preserveStart = false) => {
    const total = state.audio.wavesurfer?.getDuration?.() || region.end;
    const minDuration = Math.min(0.1, total);
    let start = Number.isFinite(startValue) ? startValue : region.start;
    let end = Number.isFinite(endValue) ? endValue : region.end;
    if (!preserveStart && start > end) [start, end] = [end, start];
    start = Math.max(0, Math.min(total, start));
    end = Math.max(0, Math.min(total, end));
    if (end < start + minDuration) {
      end = Math.min(total, start + minDuration);
      start = Math.max(0, Math.min(start, end - minDuration));
    }
    return { start, end };
  };
  const applyBounds = () => {
    const { start, end } = normalizeBounds(Number(startInput.value), Number(endInput.value));
    region.setOptions({ start, end });
    updateRegionOverlays(region);
  };
  startInput.onchange = applyBounds;
  endInput.onchange = applyBounds;
  durationInput.onchange = () => {
    const length = Math.max(0.1, Number(durationInput.value) || (region.end - region.start));
    const { start, end } = normalizeBounds(region.start, region.start + length, true);
    region.setOptions({ start, end });
    updateRegionOverlays(region);
  };
  [startInput, endInput, durationInput].forEach((input) => {
    input.onkeydown = (event) => {
      if (event.key === 'Enter') input.blur();
    };
  });
  updateRegionOverlays(region);
}

function updateRegionOverlays(region) {
  if (!region || state.audio.regionOverlays.length !== 3 || !region.element) return;
  const waveform = $('#audioWaveform');
  if (!waveform) return;
  const [startOverlay, endOverlay, durationOverlay] = state.audio.regionOverlays;
  startOverlay.querySelector('input').value = region.start.toFixed(3);
  endOverlay.querySelector('input').value = region.end.toFixed(3);
  durationOverlay.querySelector('input').value = (region.end - region.start).toFixed(3);

  const parentRect = waveform.getBoundingClientRect();
  const regionRect = region.element.getBoundingClientRect();
  const startLeft = regionRect.left - parentRect.left + waveform.scrollLeft;
  const endLeft = regionRect.right - parentRect.left + waveform.scrollLeft;
  const centerLeft = startLeft + regionRect.width / 2;
  const top = regionRect.top - parentRect.top + waveform.scrollTop;
  const bottom = regionRect.bottom - parentRect.top + waveform.scrollTop;
  const viewportLeft = waveform.scrollLeft + 4;
  const viewportRight = waveform.scrollLeft + waveform.clientWidth - 4;
  const startPosition = Math.max(viewportLeft, startLeft - startOverlay.offsetWidth - 8);
  const endPosition = Math.min(viewportRight - endOverlay.offsetWidth, endLeft + 8);
  const durationPosition = Math.max(
    viewportLeft,
    Math.min(viewportRight - durationOverlay.offsetWidth, centerLeft - durationOverlay.offsetWidth / 2)
  );
  const inputTop = Math.max(top + 8, bottom - startOverlay.offsetHeight - 8);
  startOverlay.style.left = `${startPosition}px`;
  startOverlay.style.top = `${inputTop}px`;
  endOverlay.style.left = `${endPosition}px`;
  endOverlay.style.top = `${inputTop}px`;
  durationOverlay.style.left = `${durationPosition}px`;
  durationOverlay.style.top = `${top + 8}px`;
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

initializeLanguagePreference().then(localizeDocument);

shareCurrentFileButton.addEventListener('click', shareCurrentFile);
openSharedLinkButton.addEventListener('click', openSharedLinkPrompt);
languageSelect?.addEventListener('change', () => saveLocalePreference(languageSelect.value));

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) openFile(file);
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
  const file = event.dataTransfer?.files?.[0];
  if (file) openFile(file);
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
    const [handle] = launchParams.files || [];
    if (handle) openFile(await handle.getFile());
  });
}
