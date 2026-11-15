import {
  DRAWIO_VIEWER_DESCRIPTOR, GPS_VIEWER_DESCRIPTOR, JSON_VIEWER_DESCRIPTOR, MSG_VIEWER_DESCRIPTOR,
  OPENDOCUMENT_VIEWER_DESCRIPTOR, SARIF_VIEWER_DESCRIPTOR, SBOM_VIEWER_DESCRIPTOR,
  TRACE_VIEWER_DESCRIPTOR, XML_VIEWER_DESCRIPTOR,
  detectViewer, looksLikeEml, looksLikeJUnit, looksLikeOpenApi, probeContainer
} from 'omni-viewer-core/registry';
import { loadOpenApiYamlDeps } from 'omni-viewer-core/viewers/openapi/self-loading';

let yamlDeps;

// The core's read-only previews. SARIF, CycloneDX, traces, GPX/KML and draw.io
// share JSON or XML names; the generic descriptors are listed only so that
// `detectViewer` reaches the refinement it applies to them.
const PREVIEW_DESCRIPTORS = [
  JSON_VIEWER_DESCRIPTOR, XML_VIEWER_DESCRIPTOR,
  SARIF_VIEWER_DESCRIPTOR, GPS_VIEWER_DESCRIPTOR, TRACE_VIEWER_DESCRIPTOR, SBOM_VIEWER_DESCRIPTOR,
  MSG_VIEWER_DESCRIPTOR, DRAWIO_VIEWER_DESCRIPTOR, OPENDOCUMENT_VIEWER_DESCRIPTOR
];
const TEXT_PREVIEWS = new Set(['sarif', 'gps', 'trace', 'sbom', 'drawio']);
const CONTAINER_PREVIEWS = new Set(['msg', 'gps', 'opendocument']);

/** The preview parsers' input bound; a larger container is not read to probe it. */
export const PREVIEW_PROBE_MAX_BYTES = 32 * 1024 * 1024;

function sniffPreviewDocument(text, extension, extensionClaimed) {
  const name = extension === '.json' || extension === '.xml' ? `document${extension}`
    : extensionClaimed ? null : 'document';
  if (!name) return null;
  const { viewerId } = detectViewer(name, new Set(), PREVIEW_DESCRIPTORS, undefined, text);
  return TEXT_PREVIEWS.has(viewerId) ? viewerId : null;
}

// The roots omni-viewer-core's GPS parser accepts (parsers/gps).
const GPS_NAMESPACES = {
  gpx: new Set(['', 'http://www.topografix.com/GPX/1/0', 'http://www.topografix.com/GPX/1/1']),
  kml: new Set(['', 'http://www.opengis.net/kml/2.2', 'http://earth.google.com/kml/2.0',
    'http://earth.google.com/kml/2.1', 'http://earth.google.com/kml/2.2'])
};
/**
 * Index of the root element's `<` past the BOM, declaration, PIs, comments and
 * DOCTYPE, or -1 when the prologue does not close within the sample. A single
 * forward scan, as in core's parsers/xml/prologue, so hostile input stays linear.
 */
function xmlRootStart(text) {
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (index < text.length && /\s/.test(text[index])) index++;
    if (text.startsWith('<?', index) || text.startsWith('<!--', index)) {
      const pi = text.startsWith('<?', index);
      const closer = pi ? '?>' : '-->';
      // Past the whole opener, so `<!--->` does not close itself.
      const end = text.indexOf(closer, index + (pi ? 2 : 4));
      if (end === -1) return -1;
      index = end + closer.length;
    } else if (text.startsWith('<!DOCTYPE', index)) {
      index = doctypeEnd(text, index + 9);
      if (index === -1) return -1;
    } else {
      return index;
    }
  }
}

/** Index just past the DOCTYPE's closing `>`, skipping literals and the internal subset. */
function doctypeEnd(text, from) {
  let inSubset = false;
  for (let i = from; i < text.length; i++) {
    const char = text[i];
    if (char === '"' || char === "'") {
      i = text.indexOf(char, i + 1);
      if (i === -1) return -1;
    } else if (inSubset && text.startsWith('<!--', i)) {
      i = text.indexOf('-->', i + 4);
      if (i === -1) return -1;
      i += 2;
    } else if (char === '[') inSubset = true;
    else if (char === ']') inSubset = false;
    else if (char === '>' && !inSubset) return i + 1;
  }
  return -1;
}

/**
 * Whether a `.gpx` / `.kml` text belongs to the map preview. A root the core
 * parser would reject — another dialect or namespace, such as KML 2.3 — stays
 * with the generic XML tree; a root past the sniff window keeps the extension.
 */
export function acceptsGpsDocument(bytes) {
  const decoded = decodeDocumentHead(bytes);
  const start = xmlRootStart(decoded);
  if (start === -1) return true;
  const text = decoded.slice(start);
  if (!text.startsWith('<')) return true;
  const root = /^<(?:([\w.-]+):)?([\w.-]+)(?=[\s/>]|$)((?:"[^"]*"|'[^']*'|[^>"'])*)/.exec(text);
  // An element name that runs on past the dialect's (`<gpxé>`) is another root;
  // markup this scan does not model (`<![CDATA[`, `<!doctype`) keeps the extension.
  if (!root) return !/^<[\w.-]/.test(text);
  const [, prefix, local, attributes] = root;
  if (!GPS_NAMESPACES[local]) return false;
  const declaration = new RegExp(`\\s${prefix ? `xmlns:${prefix.replace(/\./g, '\\.')}` : 'xmlns'}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attributes);
  return GPS_NAMESPACES[local].has(declaration ? declaration[1] ?? declaration[2] : '');
}

/**
 * Identify a renamed or extensionless Outlook message (`ole`) or KMZ / ODF
 * text and presentation package (`zip`) with the core's container probe,
 * which gives Office and HWP documents first refusal.
 */
export async function probePreviewContainer(bytes, container) {
  try {
    const viewerId = await probeContainer(bytes, container);
    return CONTAINER_PREVIEWS.has(viewerId) ? viewerId : null;
  } catch {
    return null;
  }
}

/** Decode the bounded sniff window, including XML exported as UTF-16. */
export function decodeDocumentHead(bytes) {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  return new TextDecoder(encoding).decode(bytes);
}

/** Use the core's signatures for formats sharing JSON, YAML, or XML names. */
export async function refineDocumentType(bytes, extension, extensionClaimed, file) {
  let text = decodeDocumentHead(bytes);
  if (!extensionClaimed && looksLikeEml(text)) return 'eml';
  if ((!extensionClaimed || extension === '.xml') && looksLikeJUnit(text)) return 'junit';
  const preview = sniffPreviewDocument(text, extension, extensionClaimed);
  if (preview) return preview;
  const structuredExtension = ['.json', '.yaml', '.yml'].includes(extension);
  // Real API specs commonly exceed the 64 KiB sniff window. The core requires
  // a complete document, so read up to its 10 MiB input bound for refinement.
  const candidate = structuredExtension || (!extensionClaimed && /openapi|swagger/.test(text));
  if (candidate && file && file.size > bytes.length && file.size <= 10 * 1024 * 1024) {
    text = decodeDocumentHead(new Uint8Array(await file.arrayBuffer()));
  }
  if ((!extensionClaimed || structuredExtension)
      && (/openapi|swagger/.test(text) || (/^\s*[{[]/.test(text) && text.includes('\\')))) {
    const json = extension === '.json';
    const deps = !json ? await (yamlDeps ??= loadOpenApiYamlDeps()) : undefined;
    if (looksLikeOpenApi(text, { ...(deps ? { yamlDeps: deps } : {}), ...(json ? { format: 'json' } : {}) })) {
      return 'openapi';
    }
  }
  return null;
}
