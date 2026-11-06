import { looksLikeEml, looksLikeJUnit, looksLikeOpenApi } from 'omni-viewer-core/registry';
import { loadOpenApiYamlDeps } from 'omni-viewer-core/viewers/openapi/self-loading';

let yamlDeps;

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
