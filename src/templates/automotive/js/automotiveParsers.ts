export interface AutomotiveSummaryItem { label: string; value: string | number; }
export interface AutomotiveTable { title: string; headers: string[]; rows: Array<Array<string | number>>; }
export interface AutomotiveViewerModel {
    format: string; title: string; fileSize: string; summary: AutomotiveSummaryItem[];
    tables: AutomotiveTable[]; rawPreview?: string; warnings: string[];
}

export async function parseAutomotiveFile(file: File): Promise<AutomotiveViewerModel> {
    const ext = extensionOf(file.name);
    if (ext === '.arxml') return parseArxml(await readBlobText(file), formatSize(file.size));
    if (ext === '.a2l') return parseA2l(await readBlobText(file), formatSize(file.size));
    if (ext === '.asc') return parseAsc(await readBlobText(file), formatSize(file.size));
    const bytes = new Uint8Array(await readBlobBuffer(file));
    return ext === '.blf' ? parseBlf(bytes, formatSize(file.size)) : parseMf4(bytes, formatSize(file.size));
}

export function parseArxml(source: string, fileSize: string): AutomotiveViewerModel {
    const packages = collectTagText(source, 'AR-PACKAGE', 'SHORT-NAME');
    const elements = collectNamedElements(source, ['CAN-CLUSTER', 'CAN-PHYSICAL-CHANNEL', 'CAN-FRAME-TRIGGERING', 'FRAME', 'I-SIGNAL', 'I-PDU', 'SIGNAL-I-PDU', 'ECU-INSTANCE']);
    const refs = collectRefs(source);
    return {
        format: 'ARXML', title: 'AUTOSAR XML', fileSize,
        summary: [{ label: 'Packages', value: packages.length }, { label: 'Named elements', value: elements.length }, { label: 'References', value: refs.length }, { label: 'XML namespace', value: /<AUTOSAR\b[^>]*\sxmlns="([^"]+)"/.exec(source)?.[1] || '-' }],
        tables: [
            { title: 'Packages', headers: ['#', 'Short name'], rows: packages.map((name, index) => [index + 1, name]) },
            { title: 'Named elements', headers: ['Type', 'Short name'], rows: elements.slice(0, 1000).map((item) => [item.type, item.name]) },
            { title: 'References', headers: ['Tag', 'Dest', 'Target'], rows: refs.slice(0, 1000).map((item) => [item.tag, item.dest || '-', item.target]) }
        ], rawPreview: preview(source), warnings: elements.length > 1000 || refs.length > 1000 ? ['Large ARXML file: tables are limited to the first 1,000 elements/references.'] : []
    };
}

export function parseA2l(source: string, fileSize: string): AutomotiveViewerModel {
    const blocks: Array<{ type: string; name: string; line: number }> = [];
    source.split(/\r?\n/).forEach((line, index) => { const match = /^\s*\/begin\s+([A-Za-z0-9_]+)(?:\s+("[^"]+"|\S+))?/.exec(line); if (match) blocks.push({ type: match[1].toUpperCase(), name: (match[2] || '').replace(/^"|"$/g, ''), line: index + 1 }); });
    const counts = new Map<string, number>(); blocks.forEach((block) => counts.set(block.type, (counts.get(block.type) || 0) + 1));
    const focus = new Set(['PROJECT', 'MODULE', 'IF_DATA', 'MEASUREMENT', 'CHARACTERISTIC', 'COMPU_METHOD', 'RECORD_LAYOUT', 'EVENT']);
    return {
        format: 'A2L', title: 'ASAM MCD-2 MC / ASAP2', fileSize,
        summary: [{ label: 'Blocks', value: blocks.length }, { label: 'Measurements', value: counts.get('MEASUREMENT') || 0 }, { label: 'Characteristics', value: counts.get('CHARACTERISTIC') || 0 }, { label: 'IF_DATA', value: counts.get('IF_DATA') || 0 }],
        tables: [
            { title: 'Important blocks', headers: ['Type', 'Name', 'Line'], rows: blocks.filter((block) => focus.has(block.type)).slice(0, 1000).map((block) => [block.type, block.name || '-', block.line]) },
            { title: 'Block counts', headers: ['Type', 'Count'], rows: Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([type, count]) => [type, count]) }
        ], rawPreview: preview(source), warnings: blocks.length > 1000 ? ['Large A2L file: important block table is limited to the first 1,000 entries.'] : []
    };
}

export function parseAsc(source: string, fileSize: string): AutomotiveViewerModel {
    const headers: string[] = []; const events: Array<Array<string | number>> = []; let canFd = 0; let classic = 0;
    source.split(/\r?\n/).forEach((line, index) => {
        const text = line.trim(); if (!text) return;
        if (!/^\d+(?:\.\d+)?\s+/.test(text)) { if (headers.length < 20) headers.push(text); return; }
        const event = parseAscEvent(text, index + 1); if (!event) return;
        event[1] === 'CANFD' ? canFd++ : classic++; if (events.length < 5000) events.push(event);
    });
    return {
        format: 'ASC', title: 'Vector ASCII CAN log', fileSize,
        summary: [{ label: 'Parsed events', value: canFd + classic }, { label: 'CAN FD events', value: canFd }, { label: 'Classic CAN events', value: classic }, { label: 'Header lines', value: headers.length }],
        tables: [{ title: 'Header', headers: ['#', 'Line'], rows: headers.map((line, index) => [index + 1, line]) }, { title: 'CAN events', headers: ['Time', 'Type', 'Channel', 'Dir', 'ID', 'DLC', 'Data', 'Line'], rows: events }],
        rawPreview: preview(source), warnings: canFd + classic > events.length ? ['Large ASC file: event table is limited to the first 5,000 parsed events.'] : []
    };
}

export function parseBlf(bytes: Uint8Array, fileSize: string): AutomotiveViewerModel {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const signature = ascii(bytes.subarray(0, 4));
    const headerSize = bytes.length >= 8 ? view.getUint32(4, true) : 0; const applicationId = bytes.length >= 36 ? view.getUint32(32, true) : 0;
    const objectCount = bytes.length >= 136 ? readUint64(view, 128) : 0;
    return { format: 'BLF', title: 'Vector Binary Logging Format', fileSize, summary: [{ label: 'Signature', value: signature || '-' }, { label: 'Header size', value: headerSize }, { label: 'Application ID', value: applicationId }, { label: 'Object count hint', value: objectCount || '-' }], tables: [{ title: 'Header preview', headers: ['Offset', 'Hex', 'ASCII'], rows: hexRows(bytes.subarray(0, 256)) }], warnings: signature === 'LOGG' ? ['BLF binary payload preview is available. Full object decoding will require a dedicated BLF object parser.'] : ['The file does not start with the expected BLF LOGG signature.'] };
}

export function parseMf4(bytes: Uint8Array, fileSize: string): AutomotiveViewerModel {
    const magic = ascii(bytes.subarray(0, 8)).trim(); const version = ascii(bytes.subarray(8, 16)).trim(); const program = ascii(bytes.subarray(16, 24)).replace(/\0/g, '').trim();
    const markers = ['##HD', '##DG', '##CG', '##CN', '##TX', '##MD', '##CC', '##SI', '##DT', '##DZ'].map((name) => [name, countAscii(bytes, name)] as Array<string | number>).filter((row) => Number(row[1]) > 0);
    return { format: 'MF4', title: 'ASAM MDF 4 measurement data', fileSize, summary: [{ label: 'Magic', value: magic || '-' }, { label: 'Version', value: version || '-' }, { label: 'Program ID', value: program || '-' }, { label: 'Known block markers', value: markers.reduce((sum, row) => sum + Number(row[1]), 0) }], tables: [{ title: 'MDF block markers', headers: ['Block', 'Count'], rows: markers }, { title: 'Header preview', headers: ['Offset', 'Hex', 'ASCII'], rows: hexRows(bytes.subarray(0, 256)) }], warnings: magic === 'MDF' ? ['MF4 metadata and header preview are available. Full sample decoding will require an MDF block graph reader.'] : ['The file does not start with the expected MDF signature.'] };
}

function parseAscEvent(line: string, lineNumber: number): Array<string | number> | null {
    const parts = line.split(/\s+/);
    if (parts[1] === 'CANFD') { const idIndex = parts.findIndex((part, index) => index > 2 && /^[0-9A-Fa-f]+x?$/.test(part)); return [parts[0], 'CANFD', parts[2] || '-', parts[3] || '-', idIndex >= 0 ? parts[idIndex] : '-', idIndex >= 0 ? parts[idIndex + 1] || '-' : '-', idIndex >= 0 ? parts.slice(idIndex + 5).join(' ') : '', lineNumber]; }
    const match = /^(\d+(?:\.\d+)?)\s+(\d+)\s+([0-9A-Fa-f]+x?)\s+(Rx|Tx)\s+d\s+(\d+)\s*(.*)$/.exec(line);
    return match ? [match[1], 'CAN', match[2], match[4], match[3], match[5], match[6].trim(), lineNumber] : null;
}
function collectTagText(source: string, parent: string, child: string): string[] { const out: string[] = []; const pattern = new RegExp(`<${parent}\\b[^>]*>([\\s\\S]*?)<\\/${parent}>`, 'g'); let match; while ((match = pattern.exec(source))) { const childMatch = new RegExp(`<${child}\\b[^>]*>([\\s\\S]*?)<\\/${child}>`).exec(match[1]); if (childMatch) out.push(decodeXml(childMatch[1].trim())); } return out; }
function collectNamedElements(source: string, tags: string[]): Array<{ type: string; name: string }> { const out: Array<{ type: string; name: string }> = []; tags.forEach((tag) => { const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g'); let match; while ((match = pattern.exec(source))) { const name = /<SHORT-NAME\b[^>]*>([\s\S]*?)<\/SHORT-NAME>/.exec(match[1]); if (name) out.push({ type: tag, name: decodeXml(name[1].trim()) }); } }); return out; }
function collectRefs(source: string): Array<{ tag: string; dest: string; target: string }> { const out = []; const pattern = /<([A-Z0-9-]*REF)\b([^>]*)>([\s\S]*?)<\/\1>/g; let match; while ((match = pattern.exec(source))) out.push({ tag: match[1], dest: /\bDEST="([^"]+)"/.exec(match[2])?.[1] || '', target: decodeXml(match[3].trim()) }); return out; }
function hexRows(bytes: Uint8Array): Array<Array<string>> { const rows = []; for (let offset = 0; offset < bytes.length; offset += 16) { const chunk = bytes.subarray(offset, offset + 16); rows.push([`0x${offset.toString(16).padStart(4, '0')}`, Array.from(chunk, (byte) => byte.toString(16).padStart(2, '0')).join(' '), Array.from(chunk, (byte) => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.').join('')]); } return rows; }
function countAscii(bytes: Uint8Array, needle: string): number { const text = ascii(bytes); let count = 0; let index = 0; while ((index = text.indexOf(needle, index)) !== -1) { count++; index += needle.length; } return count; }
function readUint64(view: DataView, offset: number): number { const value = view.getBigUint64(offset, true); return value > BigInt(Number.MAX_SAFE_INTEGER) ? 0 : Number(value); }
function preview(source: string): string { return source.length > 20000 ? `${source.slice(0, 20000)}\n\n... preview truncated ...` : source; }
function decodeXml(value: string): string { return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); }
function ascii(bytes: Uint8Array): string { return Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''); }
function extensionOf(name: string): string { const index = name.lastIndexOf('.'); return index < 0 ? '' : name.slice(index).toLowerCase(); }
function formatSize(bytes: number): string { if (!bytes) return '0 B'; const units = ['B', 'KB', 'MB', 'GB']; const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024))); return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`; }
async function readBlobText(blob: Blob): Promise<string> { const candidate = blob as Blob & { text?: () => Promise<string> }; if (typeof candidate.text === 'function') return candidate.text(); return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(reader.error ?? new Error('Failed to read text file.')); reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : ''); reader.readAsText(blob); }); }
async function readBlobBuffer(blob: Blob): Promise<ArrayBuffer> { const candidate = blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> }; if (typeof candidate.arrayBuffer === 'function') return candidate.arrayBuffer(); return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(reader.error ?? new Error('Failed to read binary file.')); reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error('Unexpected binary result.')); reader.readAsArrayBuffer(blob); }); }
