export interface AutomotiveSummaryItem { label: string; value: string | number; }
export interface AutomotiveTable { title: string; headers: string[]; rows: Array<Array<string | number>>; }
export interface AutomotiveViewerModel {
    format: string; title: string; fileSize: string; summary: AutomotiveSummaryItem[];
    tables: AutomotiveTable[]; rawPreview?: string; warnings: string[];
}

const SQLITE_HEADER = 'SQLite format 3\0';

interface SqliteSchemaEntry { type: string; name: string; tableName: string; rootPage: number; sql: string; }
interface SqliteRecord { rowid: number | string; values: Array<string | number>; }
interface SqliteParseResult {
    schema: SqliteSchemaEntry[];
    previews: Array<{ tableName: string; columns: string[]; rows: SqliteRecord[]; truncated: boolean }>;
    warnings: string[];
}

export async function parseAutomotiveFile(file: File): Promise<AutomotiveViewerModel> {
    const ext = extensionOf(file.name);
    if (ext === '.arxml') return parseArxml(await readBlobText(file), formatSize(file.size));
    if (ext === '.a2l') return parseA2l(await readBlobText(file), formatSize(file.size));
    if (ext === '.asc') return parseAsc(await readBlobText(file), formatSize(file.size));
    if (ext === '.stp' || ext === '.step') return parseStp(await readBlobText(file), formatSize(file.size));
    if (ext === '.reqif') return parseReqif(await readBlobText(file), formatSize(file.size));
    const bytes = new Uint8Array(await readBlobBuffer(file));
    if (ext === '.blf') return parseBlf(bytes, formatSize(file.size));
    if (ext === '.avro') return parseAvro(bytes, formatSize(file.size));
    if (ext === '.bag') return parseBag(bytes, formatSize(file.size));
    if (ext === '.db3' || ext === '.sqlite' || ext === '.sqlite3') return parseDb3(bytes, formatSize(file.size));
    if (ext === '.pcap') return parsePcap(bytes, formatSize(file.size));
    if (ext === '.pcapng') return parsePcapng(bytes, formatSize(file.size));
    return parseMf4(bytes, formatSize(file.size));
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

export function parseAvro(bytes: Uint8Array, fileSize: string): AutomotiveViewerModel {
    const isObjectContainer = bytes.length >= 4 && ascii(bytes.subarray(0, 4)) === 'Obj\x01';
    const metadata = isObjectContainer ? readAvroMetadata(bytes) : [];
    const schema = metadata.find((row) => row[0] === 'avro.schema')?.[1];
    const codec = metadata.find((row) => row[0] === 'avro.codec')?.[1];
    const syncMarker = bytes.length >= 16 ? hex(bytes.subarray(Math.max(0, bytes.length - 16))) : '-';
    return {
        format: 'AVRO',
        title: 'Apache Avro object container',
        fileSize,
        summary: [
            { label: 'Magic', value: isObjectContainer ? 'Obj\\x01' : '-' },
            { label: 'Metadata entries', value: metadata.length },
            { label: 'Codec', value: codec || 'null' },
            { label: 'Sync marker hint', value: syncMarker }
        ],
        tables: [
            { title: 'Metadata', headers: ['Key', 'Value'], rows: metadata.length ? metadata : [['-', 'No Avro metadata map could be decoded from the header preview.']] },
            { title: 'Header preview', headers: ['Offset', 'Hex', 'ASCII'], rows: hexRows(bytes.subarray(0, 256)) }
        ],
        rawPreview: schema ? prettyJsonPreview(schema) : undefined,
        warnings: isObjectContainer
            ? ['Avro container metadata and header preview are available. Full block decoding will require Avro schema-based record decoding.']
            : ['The file does not start with the expected Avro object container magic bytes.']
    };
}

export function parseBag(bytes: Uint8Array, fileSize: string): AutomotiveViewerModel {
    const headerLine = firstAsciiLine(bytes);
    const isRosBag = headerLine.startsWith('#ROSBAG V2.');
    const opCounts = countRosBagOps(bytes);
    return {
        format: 'BAG',
        title: 'ROS bag',
        fileSize,
        summary: [
            { label: 'Header', value: headerLine || '-' },
            { label: 'Connection records', value: opCounts.connection },
            { label: 'Chunk records', value: opCounts.chunk },
            { label: 'Message data records', value: opCounts.messageData }
        ],
        tables: [
            {
                title: 'Record op hints',
                headers: ['Record type', 'Count'],
                rows: [
                    ['Bag header', opCounts.bagHeader],
                    ['Connection', opCounts.connection],
                    ['Chunk', opCounts.chunk],
                    ['Index data', opCounts.indexData],
                    ['Chunk info', opCounts.chunkInfo],
                    ['Message data', opCounts.messageData]
                ].filter((row) => Number(row[1]) > 0)
            },
            { title: 'Header preview', headers: ['Offset', 'Hex', 'ASCII'], rows: hexRows(bytes.subarray(0, 256)) }
        ],
        warnings: isRosBag
            ? ['ROS bag structure hints and binary preview are available. Full topic/message decoding will require a ROS bag record reader.']
            : ['The file does not start with the expected ROS bag header.']
    };
}

export function parseStp(source: string, fileSize: string): AutomotiveViewerModel {
    const header = extractStepHeader(source);
    const entities = collectStepEntities(source);
    const counts = new Map<string, number>();
    entities.forEach((entity) => counts.set(entity.type, (counts.get(entity.type) || 0) + 1));
    return {
        format: 'STP',
        title: 'ISO 10303 STEP model',
        fileSize,
        summary: [
            { label: 'Schema', value: header.schema || '-' },
            { label: 'Name', value: header.name || '-' },
            { label: 'Entity lines', value: entities.length },
            { label: 'Entity types', value: counts.size }
        ],
        tables: [
            {
                title: 'Header',
                headers: ['Field', 'Value'],
                rows: [
                    ['Name', header.name || '-'],
                    ['Timestamp', header.timestamp || '-'],
                    ['Author', header.author || '-'],
                    ['Organization', header.organization || '-'],
                    ['Preprocessor', header.preprocessor || '-'],
                    ['Originating system', header.originatingSystem || '-'],
                    ['Authorization', header.authorization || '-'],
                    ['Schema', header.schema || '-']
                ]
            },
            { title: 'Top entity types', headers: ['Entity', 'Count'], rows: Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 100).map(([type, count]) => [type, count]) },
            { title: 'Entity preview', headers: ['ID', 'Type', 'Line'], rows: entities.slice(0, 1000).map((entity) => [entity.id, entity.type, entity.line]) }
        ],
        rawPreview: preview(source),
        warnings: entities.length > 1000 ? ['Large STEP file: entity preview is limited to the first 1,000 entities.'] : []
    };
}

export function parseDb3(bytes: Uint8Array, fileSize: string): AutomotiveViewerModel {
    const header = ascii(bytes.subarray(0, SQLITE_HEADER.length));
    const isSqlite = header === SQLITE_HEADER;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const pageSize = bytes.length >= 18 ? readSqlitePageSize(view) : 0;
    const pageCount = bytes.length >= 32 ? view.getUint32(28, false) : 0;
    const sqlite: SqliteParseResult = isSqlite && pageSize > 0
        ? parseSqliteDatabase(bytes, pageSize)
        : { schema: [], previews: [], warnings: [] };
    const schemaRows: Array<Array<string | number>> = sqlite.schema.length > 0
        ? sqlite.schema.map((entry) => [entry.type, entry.name, entry.tableName, entry.rootPage, entry.sql])
        : extractSqliteSchemaHints(bytes).map((sql, index) => ['hint', `schema-${index + 1}`, '-', '-', sql]);
    const userTables = sqlite.schema.filter((entry) => entry.type === 'table' && !entry.name.startsWith('sqlite_'));
    const ros2Tables = ['topics', 'messages', 'schemas', 'metadata'].filter((name) => userTables.some((entry) => entry.name === name));
    return {
        format: 'DB3',
        title: 'SQLite 3 database',
        fileSize,
        summary: [
            { label: 'Signature', value: isSqlite ? 'SQLite format 3' : '-' },
            { label: 'Page size', value: pageSize || '-' },
            { label: 'Page count hint', value: pageCount || '-' },
            { label: 'Tables', value: userTables.length }
        ],
        tables: [
            {
                title: 'Database header',
                headers: ['Field', 'Value'],
                rows: [
                    ['Page size', pageSize || '-'],
                    ['Page count hint', pageCount || '-'],
                    ['Schema entries', sqlite.schema.length],
                    ['ROS2 tables detected', ros2Tables.length > 0 ? ros2Tables.join(', ') : '-']
                ]
            },
            {
                title: 'Schema',
                headers: ['Type', 'Name', 'Table', 'Root page', 'SQL'],
                rows: schemaRows.length > 0 ? schemaRows : [['-', '-', '-', '-', 'No sqlite_master schema rows could be decoded.']]
            },
            ...sqlite.previews.map((preview) => ({
                title: `Rows: ${preview.tableName}`,
                headers: ['rowid', ...preview.columns],
                rows: preview.rows.map((row) => [row.rowid, ...row.values])
            })),
            { title: 'Header preview', headers: ['Offset', 'Hex', 'ASCII'], rows: hexRows(bytes.subarray(0, 256)) }
        ],
        warnings: isSqlite
            ? ['SQLite table previews are decoded directly from table b-tree pages without external dependencies. Complex SQL queries, indexes, WAL replay, and full overflow recovery are not supported.', ...sqlite.warnings]
            : ['The file does not start with the expected SQLite 3 database header.']
    };
}

export function parseReqif(source: string, fileSize: string): AutomotiveViewerModel {
    const header = extractReqifHeader(source);
    const specObjects = collectReqifElements(source, 'SPEC-OBJECT');
    const specifications = collectReqifElements(source, 'SPECIFICATION');
    const specRelations = collectReqifElements(source, 'SPEC-RELATION');
    const datatypes = collectReqifElements(source, 'DATATYPE-DEFINITION-[A-Z-]+');
    const specTypes = collectReqifElements(source, 'SPEC-[A-Z-]*TYPE');
    return {
        format: 'REQIF',
        title: 'Requirements Interchange Format',
        fileSize,
        summary: [
            { label: 'Title', value: header.title || '-' },
            { label: 'Spec objects', value: specObjects.length },
            { label: 'Specifications', value: specifications.length },
            { label: 'Spec relations', value: specRelations.length }
        ],
        tables: [
            { title: 'Header', headers: ['Field', 'Value'], rows: [['Title', header.title || '-'], ['Identifier', header.identifier || '-'], ['Source tool ID', header.sourceToolId || '-'], ['ReqIF tool ID', header.reqifToolId || '-'], ['Creation time', header.creationTime || '-'], ['Comment', header.comment || '-']] },
            { title: 'Specifications', headers: ['Identifier', 'Long name', 'Type'], rows: specifications.slice(0, 1000).map((item) => [item.identifier, item.longName, item.type]) },
            { title: 'Spec objects', headers: ['Identifier', 'Long name', 'Type'], rows: specObjects.slice(0, 1000).map((item) => [item.identifier, item.longName, item.type]) },
            { title: 'Spec relations', headers: ['Identifier', 'Long name', 'Type'], rows: specRelations.slice(0, 1000).map((item) => [item.identifier, item.longName, item.type]) },
            { title: 'Definitions', headers: ['Kind', 'Identifier', 'Long name'], rows: [...datatypes.slice(0, 500).map((item) => [item.type, item.identifier, item.longName]), ...specTypes.slice(0, 500).map((item) => [item.type, item.identifier, item.longName])] }
        ],
        rawPreview: preview(source),
        warnings: specObjects.length > 1000 || specifications.length > 1000 || specRelations.length > 1000
            ? ['Large ReqIF file: object, specification, and relation tables are limited to the first 1,000 entries.']
            : []
    };
}

export function parsePcap(bytes: Uint8Array, fileSize: string): AutomotiveViewerModel {
    const header = detectPcapHeader(bytes);
    const packets = header
        ? collectPcapPackets(bytes, header.littleEndian, header.network)
        : { rows: [] as Array<Array<string | number>>, count: 0, truncated: false, invalidOffset: 0 };
    const version = header ? `${header.versionMajor}.${header.versionMinor}` : '-';
    return {
        format: 'PCAP',
        title: 'Packet Capture',
        fileSize,
        summary: [
            { label: 'Magic', value: header?.magic || '-' },
            { label: 'Byte order', value: header ? (header.littleEndian ? 'little endian' : 'big endian') : '-' },
            { label: 'Version', value: version },
            { label: 'Packets parsed', value: packets.count }
        ],
        tables: [
            {
                title: 'Global header',
                headers: ['Field', 'Value'],
                rows: [
                    ['Timestamp resolution', header?.timestampResolution || '-'],
                    ['Timezone offset', header?.thisZone ?? '-'],
                    ['Timestamp accuracy', header?.sigFigs ?? '-'],
                    ['Snapshot length', header?.snapLen ?? '-'],
                    ['Link type', header ? describePcapLinkType(header.network) : '-']
                ]
            },
            { title: 'Packet records', headers: ['#', 'Timestamp', 'Protocol', 'Source', 'Destination', 'Captured length', 'Original length', 'Offset', 'Info'], rows: packets.rows },
            { title: 'Header preview', headers: ['Offset', 'Hex', 'ASCII'], rows: hexRows(bytes.subarray(0, Math.min(bytes.length, 256))) }
        ],
        warnings: [
            ...(header ? ['Lightweight packet decoding is available for Ethernet, ARP, IPv4, IPv6, TCP, UDP, ICMP, DNS, and HTTP-like payloads.'] : ['The file does not start with a supported PCAP magic value.']),
            ...(packets.truncated ? [`Packet parsing stopped near offset 0x${packets.invalidOffset.toString(16)} because a record was truncated or invalid.`] : [])
        ]
    };
}

export function parsePcapng(bytes: Uint8Array, fileSize: string): AutomotiveViewerModel {
    const blocks = collectPcapngBlocks(bytes);
    const blockCounts = new Map<string, number>();
    blocks.rows.forEach((row) => blockCounts.set(String(row[1]), (blockCounts.get(String(row[1])) || 0) + 1));
    const firstSection = blocks.sections[0];
    return {
        format: 'PCAPNG',
        title: 'Packet Capture Next Generation',
        fileSize,
        summary: [
            { label: 'Sections', value: blocks.sections.length },
            { label: 'Interfaces', value: blockCounts.get('Interface Description') || 0 },
            { label: 'Enhanced packets', value: blockCounts.get('Enhanced Packet') || 0 },
            { label: 'Byte order', value: firstSection ? (firstSection.littleEndian ? 'little endian' : 'big endian') : '-' }
        ],
        tables: [
            {
                title: 'Sections',
                headers: ['#', 'Byte order', 'Version', 'Section length', 'Offset'],
                rows: blocks.sections.map((section, index) => [index + 1, section.littleEndian ? 'little endian' : 'big endian', `${section.major}.${section.minor}`, section.sectionLength, `0x${section.offset.toString(16)}`])
            },
            { title: 'Blocks', headers: ['#', 'Type', 'Length', 'Captured length', 'Original length', 'Offset'], rows: blocks.rows },
            { title: 'Interfaces', headers: ['#', 'Link type', 'Snap length', 'Name', 'Description', 'Timestamp resolution'], rows: blocks.interfaceRows },
            { title: 'Packet summaries', headers: ['#', 'Timestamp', 'Protocol', 'Source', 'Destination', 'Captured length', 'Original length', 'Offset', 'Info'], rows: blocks.packetRows },
            { title: 'Header preview', headers: ['Offset', 'Hex', 'ASCII'], rows: hexRows(bytes.subarray(0, Math.min(bytes.length, 256))) }
        ],
        warnings: [
            ...(blocks.isPcapng ? ['Lightweight packet decoding is available for Ethernet, ARP, IPv4, IPv6, TCP, UDP, ICMP, DNS, and HTTP-like payloads.'] : ['The file does not start with the expected PCAPNG Section Header Block.']),
            ...(blocks.truncated ? [`Block parsing stopped near offset 0x${blocks.invalidOffset.toString(16)} because a block was truncated or invalid.`] : []),
            ...(blocks.totalBlocks > blocks.rows.length ? ['Large PCAPNG file: block table is limited to the first 5,000 blocks.'] : [])
        ]
    };
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
function hex(bytes: Uint8Array): string { return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''); }
function readAvroMetadata(bytes: Uint8Array): Array<Array<string>> { const rows: Array<Array<string>> = []; let offset = 4; const maxOffset = Math.min(bytes.length, 64 * 1024); try { while (offset < maxOffset) { const countResult = readAvroLong(bytes, offset); offset = countResult.offset; let count = countResult.value; if (count === BigInt(0)) break; if (count < BigInt(0)) { const blockSize = readAvroLong(bytes, offset); offset = blockSize.offset; count = -count; } if (count > BigInt(64)) break; for (let i = BigInt(0); i < count && offset < maxOffset; i++) { const key = readAvroBytes(bytes, offset); offset = key.offset; const value = readAvroBytes(bytes, offset); offset = value.offset; const keyText = utf8(key.bytes); rows.push([keyText, printableMetadataValue(keyText, value.bytes)]); } } } catch { return rows; } return rows; }
function readAvroLong(bytes: Uint8Array, offset: number): { value: bigint; offset: number } { let result = BigInt(0); let shift = BigInt(0); let current = offset; while (current < bytes.length) { const byte = bytes[current++]; result |= BigInt(byte & 0x7f) << shift; if ((byte & 0x80) === 0) { const value = (result >> BigInt(1)) ^ -(result & BigInt(1)); return { value, offset: current }; } shift += BigInt(7); if (shift > BigInt(63)) break; } throw new Error('Invalid Avro long value.'); }
function readAvroBytes(bytes: Uint8Array, offset: number): { bytes: Uint8Array; offset: number } { const lengthResult = readAvroLong(bytes, offset); const length = Number(lengthResult.value); if (!Number.isFinite(length) || length < 0 || lengthResult.offset + length > bytes.length) throw new Error('Invalid Avro bytes value.'); return { bytes: bytes.subarray(lengthResult.offset, lengthResult.offset + length), offset: lengthResult.offset + length }; }
function printableMetadataValue(key: string, bytes: Uint8Array): string { if (key === 'avro.schema') return compactJson(utf8(bytes)); return Array.from(bytes).every((byte) => (byte >= 32 && byte <= 126) || byte === 9 || byte === 10 || byte === 13) ? utf8(bytes) : hex(bytes); }
function compactJson(value: string): string { try { return JSON.stringify(JSON.parse(value)); } catch { return value; } }
function prettyJsonPreview(value: string): string { try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; } }
function firstAsciiLine(bytes: Uint8Array): string { const end = bytes.indexOf(0x0a); const sliceEnd = end === -1 ? Math.min(bytes.length, 256) : end; return ascii(bytes.subarray(0, sliceEnd)).trim(); }
function countRosBagOps(bytes: Uint8Array): Record<string, number> { return { bagHeader: countAscii(bytes, 'op=\x03'), chunk: countAscii(bytes, 'op=\x05'), connection: countAscii(bytes, 'op=\x07'), indexData: countAscii(bytes, 'op=\x04'), chunkInfo: countAscii(bytes, 'op=\x06'), messageData: countAscii(bytes, 'op=\x02') }; }
function extractStepHeader(source: string): { name: string; timestamp: string; author: string; organization: string; preprocessor: string; originatingSystem: string; authorization: string; schema: string } { const description = matchStepHeaderValue(source, 'FILE_DESCRIPTION'); const name = matchStepHeaderValue(source, 'FILE_NAME'); const schema = matchStepHeaderValue(source, 'FILE_SCHEMA'); const nameFields = splitStepArguments(name); return { name: nameFields[0] || '', timestamp: nameFields[1] || '', author: nameFields[2] || '', organization: nameFields[3] || '', preprocessor: nameFields[4] || '', originatingSystem: nameFields[5] || '', authorization: nameFields[6] || description || '', schema: splitStepArguments(schema).join(', ') }; }
function matchStepHeaderValue(source: string, keyword: string): string { const match = new RegExp(`${keyword}\\s*\\(([^;]*)\\);`, 'i').exec(source); return match ? match[1].trim() : ''; }
function splitStepArguments(value: string): string[] { const args: string[] = []; let current = ''; let inString = false; let depth = 0; for (let i = 0; i < value.length; i++) { const char = value[i]; if (char === "'") { inString = !inString; continue; } if (!inString && char === '(') { depth++; continue; } if (!inString && char === ')') { depth = Math.max(0, depth - 1); continue; } if (!inString && depth === 0 && char === ',') { args.push(cleanStepValue(current)); current = ''; continue; } current += char; } if (current.trim()) args.push(cleanStepValue(current)); return args; }
function cleanStepValue(value: string): string { return value.replace(/^\s*\$?\s*|\s*$/g, '').replace(/^'(.*)'$/s, '$1').trim(); }
function collectStepEntities(source: string): Array<{ id: string; type: string; line: number }> { const entities: Array<{ id: string; type: string; line: number }> = []; source.split(/\r?\n/).forEach((line, index) => { const match = /^\s*#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(/i.exec(line); if (match) entities.push({ id: `#${match[1]}`, type: match[2].toUpperCase(), line: index + 1 }); }); return entities; }
function readSqlitePageSize(view: DataView): number { const value = view.getUint16(16, false); return value === 1 ? 65536 : value; }
function extractSqliteSchemaHints(bytes: Uint8Array): string[] { const text = latin1(bytes.subarray(0, Math.min(bytes.length, 1024 * 1024))); const matches = text.match(/CREATE\s+(?:TABLE|INDEX|VIEW|TRIGGER)[\s\S]{0,400}?(?=\0|$)/gi) || []; return matches.map((value) => value.replace(/[^\x20-\x7E]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 100); }
function dv(bytes: Uint8Array): DataView { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function u16be(bytes: Uint8Array, offset: number): number { return (bytes[offset] << 8) | bytes[offset + 1]; }
function u32be(bytes: Uint8Array, offset: number): number { return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0; }
function concatBytes(chunks: Uint8Array[]): Uint8Array { const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0); const out = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; } return out; }
function parseSqliteDatabase(bytes: Uint8Array, pageSize: number): SqliteParseResult {
    const warnings: string[] = [];
    const schemaRecords = readSqliteTableRecords(bytes, pageSize, 1, 500, warnings);
    const schema = schemaRecords.map((record) => toSqliteSchemaEntry(record)).filter((entry): entry is SqliteSchemaEntry => entry !== null);
    const tableEntries = schema.filter((entry) => entry.type === 'table' && entry.rootPage > 0 && !entry.name.startsWith('sqlite_')).slice(0, 12);
    const previews = tableEntries.map((entry) => {
        const columns = extractSqliteColumnNames(entry.sql);
        const rows = readSqliteTableRecords(bytes, pageSize, entry.rootPage, 100, warnings);
        return { tableName: entry.name, columns, rows: rows.map((row) => ({ rowid: row.rowid, values: alignSqliteRowValues(columns, row) })), truncated: rows.length >= 100 };
    });
    if (schemaRecords.length === 0) warnings.push('Could not decode sqlite_master rows from page 1.');
    if (schema.length > 500) warnings.push('Large schema: sqlite_master decoding is limited to the first 500 rows.');
    previews.filter((preview) => preview.truncated).forEach((preview) => warnings.push(`Table ${preview.tableName} preview is limited to the first 100 rows.`));
    return { schema, previews, warnings: Array.from(new Set(warnings)) };
}
function toSqliteSchemaEntry(record: SqliteRecord): SqliteSchemaEntry | null {
    if (record.values.length < 5) return null;
    const [type, name, tableName, rootPage, sql] = record.values;
    return { type: String(type || ''), name: String(name || ''), tableName: String(tableName || ''), rootPage: Number(rootPage) || 0, sql: String(sql || '') };
}
function readSqliteTableRecords(bytes: Uint8Array, pageSize: number, rootPage: number, limit: number, warnings: string[], visited = new Set<number>()): SqliteRecord[] {
    if (rootPage <= 0 || visited.has(rootPage) || visited.size > 512) return [];
    visited.add(rootPage);
    const page = getSqlitePage(bytes, pageSize, rootPage);
    if (!page) { warnings.push(`Could not read SQLite page ${rootPage}.`); return []; }
    const headerOffset = rootPage === 1 ? 100 : 0;
    if (page.length < headerOffset + 8) { warnings.push(`SQLite page ${rootPage} is too small to contain a b-tree header.`); return []; }
    const pageType = page[headerOffset];
    const cellCount = u16be(page, headerOffset + 3);
    const records: SqliteRecord[] = [];
    if (pageType === 0x0D) {
        for (let i = 0; i < cellCount && records.length < limit; i++) {
            const pointerOffset = headerOffset + 8 + i * 2;
            if (pointerOffset + 2 > page.length) break;
            const cellOffset = u16be(page, pointerOffset);
            const record = readSqliteTableLeafCell(bytes, page, pageSize, cellOffset, rootPage, warnings);
            if (record) records.push(record);
        }
        return records;
    }
    if (pageType === 0x05) {
        for (let i = 0; i < cellCount && records.length < limit; i++) {
            const pointerOffset = headerOffset + 12 + i * 2;
            if (pointerOffset + 2 > page.length) break;
            const cellOffset = u16be(page, pointerOffset);
            if (cellOffset + 4 > page.length) continue;
            const childPage = u32be(page, cellOffset);
            records.push(...readSqliteTableRecords(bytes, pageSize, childPage, limit - records.length, warnings, visited));
        }
        if (records.length < limit && headerOffset + 12 <= page.length) {
            const rightMostPage = u32be(page, headerOffset + 8);
            records.push(...readSqliteTableRecords(bytes, pageSize, rightMostPage, limit - records.length, warnings, visited));
        }
        return records;
    }
    warnings.push(`SQLite page ${rootPage} has unsupported b-tree page type 0x${pageType.toString(16)}.`);
    return [];
}
function getSqlitePage(bytes: Uint8Array, pageSize: number, pageNumber: number): Uint8Array | null {
    const offset = (pageNumber - 1) * pageSize;
    if (pageNumber <= 0 || offset < 0 || offset >= bytes.length) return null;
    return bytes.subarray(offset, Math.min(offset + pageSize, bytes.length));
}
function readSqliteTableLeafCell(database: Uint8Array, page: Uint8Array, pageSize: number, cellOffset: number, pageNumber: number, warnings: string[]): SqliteRecord | null {
    if (cellOffset <= 0 || cellOffset >= page.length) return null;
    try {
        const payloadSizeResult = readSqliteVarint(page, cellOffset);
        const rowidResult = readSqliteVarint(page, payloadSizeResult.offset);
        const payloadStart = rowidResult.offset;
        const payload = readSqlitePayload(database, page, pageSize, payloadStart, Number(payloadSizeResult.value), warnings);
        return { rowid: displaySqliteInteger(rowidResult.value), values: decodeSqliteRecord(payload) };
    } catch {
        warnings.push(`Could not decode SQLite table cell on page ${pageNumber} at offset 0x${cellOffset.toString(16)}.`);
        return null;
    }
}
function readSqlitePayload(database: Uint8Array, page: Uint8Array, pageSize: number, payloadStart: number, payloadSize: number, warnings: string[]): Uint8Array {
    if (payloadSize <= 0) return new Uint8Array(0);
    const usableSize = pageSize;
    const maxLocal = usableSize - 35;
    let localSize = payloadSize;
    let overflowPointerOffset = -1;
    if (payloadSize > maxLocal) {
        const minLocal = Math.floor((usableSize - 12) * 32 / 255) - 23;
        localSize = minLocal + (payloadSize - minLocal) % (usableSize - 4);
        if (localSize > maxLocal) localSize = minLocal;
        overflowPointerOffset = payloadStart + localSize;
    }
    const chunks: Uint8Array[] = [];
    chunks.push(page.subarray(payloadStart, Math.min(payloadStart + localSize, page.length)));
    if (overflowPointerOffset >= 0 && overflowPointerOffset + 4 <= page.length) {
        let nextPage = u32be(page, overflowPointerOffset);
        let remaining = payloadSize - localSize;
        let guard = 0;
        while (nextPage > 0 && remaining > 0 && guard < 256) {
            const overflowPage = getSqlitePage(database, pageSize, nextPage);
            if (!overflowPage || overflowPage.length < 4) { warnings.push(`SQLite overflow page ${nextPage} could not be read.`); break; }
            nextPage = u32be(overflowPage, 0);
            const chunk = overflowPage.subarray(4, Math.min(4 + remaining, overflowPage.length));
            chunks.push(chunk);
            remaining -= chunk.length;
            guard++;
        }
        if (remaining > 0) warnings.push('A SQLite record uses overflow pages that could not be fully reconstructed.');
    }
    return concatBytes(chunks).subarray(0, payloadSize);
}
function decodeSqliteRecord(payload: Uint8Array): Array<string | number> {
    if (payload.length === 0) return [];
    const headerSizeResult = readSqliteVarint(payload, 0);
    const headerSize = Number(headerSizeResult.value);
    const serialTypes: bigint[] = [];
    let headerOffset = headerSizeResult.offset;
    while (headerOffset < headerSize && headerOffset < payload.length) {
        const serialType = readSqliteVarint(payload, headerOffset);
        serialTypes.push(serialType.value);
        headerOffset = serialType.offset;
    }
    let bodyOffset = headerSize;
    return serialTypes.map((serialType) => {
        const decoded = decodeSqliteValue(payload, bodyOffset, serialType);
        bodyOffset += decoded.bytesRead;
        return decoded.value;
    });
}
function decodeSqliteValue(payload: Uint8Array, offset: number, serialType: bigint): { value: string | number; bytesRead: number } {
    const type = Number(serialType);
    const view = dv(payload);
    switch (type) {
    case 0: return { value: 'NULL', bytesRead: 0 };
    case 1: return { value: view.getInt8(offset), bytesRead: 1 };
    case 2: return { value: view.getInt16(offset, false), bytesRead: 2 };
    case 3: return { value: readSqliteSignedInteger(payload, offset, 3), bytesRead: 3 };
    case 4: return { value: view.getInt32(offset, false), bytesRead: 4 };
    case 5: return { value: readSqliteSignedInteger(payload, offset, 6), bytesRead: 6 };
    case 6: return { value: displaySqliteInteger(view.getBigInt64(offset, false)), bytesRead: 8 };
    case 7: return { value: view.getFloat64(offset, false), bytesRead: 8 };
    case 8: return { value: 0, bytesRead: 0 };
    case 9: return { value: 1, bytesRead: 0 };
    default:
        if (type >= 12) {
            const length = type % 2 === 0 ? (type - 12) / 2 : (type - 13) / 2;
            const valueBytes = payload.subarray(offset, Math.min(offset + length, payload.length));
            if (type % 2 === 0) return { value: formatSqliteBlob(valueBytes, length), bytesRead: length };
            return { value: utf8(valueBytes), bytesRead: length };
        }
        return { value: `reserved(${type})`, bytesRead: 0 };
    }
}
function readSqliteVarint(bytes: Uint8Array, offset: number): { value: bigint; offset: number } {
    let value = BigInt(0);
    for (let i = 0; i < 9; i++) {
        if (offset + i >= bytes.length) throw new Error('SQLite varint exceeds buffer bounds.');
        const byte = bytes[offset + i];
        if (i === 8) { value = (value << BigInt(8)) | BigInt(byte); return { value, offset: offset + 9 }; }
        value = (value << BigInt(7)) | BigInt(byte & 0x7f);
        if ((byte & 0x80) === 0) return { value, offset: offset + i + 1 };
    }
    throw new Error('Invalid SQLite varint.');
}
function readSqliteSignedInteger(bytes: Uint8Array, offset: number, byteLength: number): number {
    let value = BigInt(0);
    for (let i = 0; i < byteLength; i++) value = (value << BigInt(8)) | BigInt(bytes[offset + i]);
    const signBit = BigInt(1) << BigInt(byteLength * 8 - 1);
    if ((value & signBit) !== BigInt(0)) value -= BigInt(1) << BigInt(byteLength * 8);
    return Number(value);
}
function displaySqliteInteger(value: bigint): number | string {
    return value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER) ? value.toString() : Number(value);
}
function formatSqliteBlob(bytes: Uint8Array, expectedLength: number): string {
    const previewHex = hex(bytes.subarray(0, 24));
    const suffix = expectedLength > 24 ? '...' : '';
    return `BLOB(${expectedLength} bytes) ${previewHex}${suffix}`;
}
function extractSqliteColumnNames(sql: string): string[] {
    const open = sql.indexOf('('); const close = sql.lastIndexOf(')');
    if (open === -1 || close <= open) return [];
    return splitSqliteDefinitions(sql.slice(open + 1, close)).map((definition) => extractSqliteColumnName(definition)).filter((name): name is string => Boolean(name));
}
function splitSqliteDefinitions(source: string): string[] {
    const definitions: string[] = []; let current = ''; let depth = 0; let quote: string | null = null;
    for (let i = 0; i < source.length; i++) {
        const char = source[i];
        if (quote) { current += char; if (char === quote) quote = null; continue; }
        if (char === '\'' || char === '"' || char === '`' || char === '[') { quote = char === '[' ? ']' : char; current += char; continue; }
        if (char === '(') depth++; else if (char === ')') depth = Math.max(0, depth - 1); else if (char === ',' && depth === 0) { definitions.push(current.trim()); current = ''; continue; }
        current += char;
    }
    if (current.trim()) definitions.push(current.trim());
    return definitions;
}
function extractSqliteColumnName(definition: string): string | null {
    const trimmed = definition.trim();
    if (!trimmed || /^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|KEY)\b/i.test(trimmed)) return null;
    const quoted = /^"([^"]+)"|^`([^`]+)`|^\[([^\]]+)\]|^'([^']+)'/.exec(trimmed);
    if (quoted) return quoted[1] || quoted[2] || quoted[3] || quoted[4] || null;
    const match = /^([^\s,]+)/.exec(trimmed);
    return match ? match[1] : null;
}
function alignSqliteRowValues(columns: string[], row: SqliteRecord): Array<string | number> {
    const values = [...row.values];
    if (values.length < columns.length) values.push(...Array(columns.length - values.length).fill(''));
    return values.slice(0, Math.max(columns.length, values.length));
}
function extractReqifHeader(source: string): { title: string; identifier: string; sourceToolId: string; reqifToolId: string; creationTime: string; comment: string } { const headerMatch = /<REQ-IF-HEADER\b[^>]*>([\s\S]*?)<\/REQ-IF-HEADER>/i.exec(source); const header = headerMatch ? headerMatch[1] : ''; return { title: extractFirstTagText(header, 'TITLE'), identifier: extractAttribute(headerMatch?.[0] || '', 'IDENTIFIER'), sourceToolId: extractFirstTagText(header, 'SOURCE-TOOL-ID'), reqifToolId: extractFirstTagText(header, 'REQ-IF-TOOL-ID'), creationTime: extractFirstTagText(header, 'CREATION-TIME'), comment: extractFirstTagText(header, 'COMMENT') }; }
function collectReqifElements(source: string, tagPattern: string): Array<{ identifier: string; longName: string; type: string }> { const elements: Array<{ identifier: string; longName: string; type: string }> = []; const pattern = new RegExp(`<(${tagPattern})(?!-)\\b([^>]*)>`, 'gi'); let match; while ((match = pattern.exec(source))) elements.push({ type: match[1].toUpperCase(), identifier: extractAttribute(match[2], 'IDENTIFIER') || '-', longName: decodeXml(extractAttribute(match[2], 'LONG-NAME') || '-') }); return elements; }
function extractFirstTagText(source: string, tagName: string): string { const match = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i').exec(source); return match ? decodeXml(match[1].trim()) : ''; }
function extractAttribute(source: string, attributeName: string): string { const match = new RegExp(`\\b${attributeName}="([^"]*)"`, 'i').exec(source); return match ? match[1] : ''; }
function preview(source: string): string { return source.length > 20000 ? `${source.slice(0, 20000)}\n\n... preview truncated ...` : source; }
function decodeXml(value: string): string { return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); }
function ascii(bytes: Uint8Array): string { return Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''); }
function utf8(bytes: Uint8Array): string { return typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8').decode(bytes) : ascii(bytes); }
function latin1(bytes: Uint8Array): string { return typeof TextDecoder !== 'undefined' ? new TextDecoder('latin1').decode(bytes) : ascii(bytes); }
function extensionOf(name: string): string { const index = name.lastIndexOf('.'); return index < 0 ? '' : name.slice(index).toLowerCase(); }
function formatSize(bytes: number): string { if (!bytes) return '0 B'; const units = ['B', 'KB', 'MB', 'GB']; const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024))); return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`; }
async function readBlobText(blob: Blob): Promise<string> { const candidate = blob as Blob & { text?: () => Promise<string> }; if (typeof candidate.text === 'function') return candidate.text(); return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(reader.error ?? new Error('Failed to read text file.')); reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : ''); reader.readAsText(blob); }); }
async function readBlobBuffer(blob: Blob): Promise<ArrayBuffer> { const candidate = blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> }; if (typeof candidate.arrayBuffer === 'function') return candidate.arrayBuffer(); return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(reader.error ?? new Error('Failed to read binary file.')); reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error('Unexpected binary result.')); reader.readAsArrayBuffer(blob); }); }

interface PacketDissection { protocol: string; source: string; destination: string; info: string; }

function readU16(bytes: Uint8Array, offset: number, littleEndian: boolean): number { return dv(bytes).getUint16(offset, littleEndian); }
function readU32(bytes: Uint8Array, offset: number, littleEndian: boolean): number { return dv(bytes).getUint32(offset, littleEndian); }
function readI32(bytes: Uint8Array, offset: number, littleEndian: boolean): number { return dv(bytes).getInt32(offset, littleEndian); }
function readInt64AsDisplay(bytes: Uint8Array, offset: number, littleEndian: boolean): string { if (offset + 8 > bytes.length) return '-'; const value = dv(bytes).getBigInt64(offset, littleEndian); return value === BigInt(-1) ? 'unspecified' : value.toString(); }

function detectPcapHeader(bytes: Uint8Array): { magic: string; littleEndian: boolean; timestampResolution: string; versionMajor: number; versionMinor: number; thisZone: number; sigFigs: number; snapLen: number; network: number } | null {
    if (bytes.length < 24) return null;
    const variants = [
        { bytes: [0xd4, 0xc3, 0xb2, 0xa1], littleEndian: true, timestampResolution: 'microseconds', magic: '0xA1B2C3D4' },
        { bytes: [0xa1, 0xb2, 0xc3, 0xd4], littleEndian: false, timestampResolution: 'microseconds', magic: '0xA1B2C3D4' },
        { bytes: [0x4d, 0x3c, 0xb2, 0xa1], littleEndian: true, timestampResolution: 'nanoseconds', magic: '0xA1B23C4D' },
        { bytes: [0xa1, 0xb2, 0x3c, 0x4d], littleEndian: false, timestampResolution: 'nanoseconds', magic: '0xA1B23C4D' }
    ];
    const variant = variants.find((item) => item.bytes.every((byte, index) => bytes[index] === byte));
    if (!variant) return null;
    return {
        magic: variant.magic,
        littleEndian: variant.littleEndian,
        timestampResolution: variant.timestampResolution,
        versionMajor: readU16(bytes, 4, variant.littleEndian),
        versionMinor: readU16(bytes, 6, variant.littleEndian),
        thisZone: readI32(bytes, 8, variant.littleEndian),
        sigFigs: readU32(bytes, 12, variant.littleEndian),
        snapLen: readU32(bytes, 16, variant.littleEndian),
        network: readU32(bytes, 20, variant.littleEndian)
    };
}

function collectPcapPackets(bytes: Uint8Array, littleEndian: boolean, linkType: number): { rows: Array<Array<string | number>>; count: number; truncated: boolean; invalidOffset: number } {
    const rows: Array<Array<string | number>> = [];
    let offset = 24;
    let count = 0;
    while (offset + 16 <= bytes.length) {
        const recordOffset = offset;
        const timestampSeconds = readU32(bytes, offset, littleEndian);
        const timestampFraction = readU32(bytes, offset + 4, littleEndian);
        const capturedLength = readU32(bytes, offset + 8, littleEndian);
        const originalLength = readU32(bytes, offset + 12, littleEndian);
        offset += 16;
        if (capturedLength > bytes.length - offset) return { rows, count, truncated: true, invalidOffset: recordOffset };
        count++;
        if (rows.length < 5000) {
            const dissection = dissectPacket(bytes.subarray(offset, offset + capturedLength), linkType);
            rows.push([count, `${timestampSeconds}.${String(timestampFraction).padStart(6, '0')}`, dissection.protocol, dissection.source, dissection.destination, capturedLength, originalLength, `0x${recordOffset.toString(16)}`, dissection.info]);
        }
        offset += capturedLength;
    }
    return { rows, count, truncated: offset !== bytes.length, invalidOffset: offset };
}

function collectPcapngBlocks(bytes: Uint8Array): { isPcapng: boolean; rows: Array<Array<string | number>>; packetRows: Array<Array<string | number>>; interfaceRows: Array<Array<string | number>>; sections: Array<{ offset: number; littleEndian: boolean; major: number; minor: number; sectionLength: string }>; totalBlocks: number; truncated: boolean; invalidOffset: number } {
    const isPcapng = bytes.length >= 12 && readU32(bytes, 0, true) === 0x0a0d0d0a;
    const rows: Array<Array<string | number>> = [];
    const packetRows: Array<Array<string | number>> = [];
    const interfaceRows: Array<Array<string | number>> = [];
    const sections: Array<{ offset: number; littleEndian: boolean; major: number; minor: number; sectionLength: string }> = [];
    const interfaceLinkTypes: number[] = [];
    let offset = 0;
    let littleEndian = true;
    let totalBlocks = 0;
    while (offset + 12 <= bytes.length) {
        const blockOffset = offset;
        const rawBlockType = readU32(bytes, offset, littleEndian);
        if (rawBlockType === 0x0a0d0d0a) {
            if (offset + 28 > bytes.length) return { isPcapng, rows, packetRows, interfaceRows, sections, totalBlocks, truncated: true, invalidOffset: blockOffset };
            const b0 = bytes[offset + 8], b1 = bytes[offset + 9], b2 = bytes[offset + 10], b3 = bytes[offset + 11];
            if (b0 === 0x4d && b1 === 0x3c && b2 === 0x2b && b3 === 0x1a) littleEndian = true;
            else if (b0 === 0x1a && b1 === 0x2b && b2 === 0x3c && b3 === 0x4d) littleEndian = false;
        }
        const blockType = readU32(bytes, offset, littleEndian);
        const blockLength = readU32(bytes, offset + 4, littleEndian);
        if (blockLength < 12 || offset + blockLength > bytes.length) return { isPcapng, rows, packetRows, interfaceRows, sections, totalBlocks, truncated: true, invalidOffset: blockOffset };
        totalBlocks++;
        const typeName = describePcapngBlockType(blockType);
        let capturedLength: string | number = '-';
        let originalLength: string | number = '-';
        let timestamp = '-';
        let packetPayload: Uint8Array | null = null;
        let linkType = interfaceLinkTypes[0] ?? 1;
        if (blockType === 0x00000006 && blockLength >= 32) {
            const interfaceId = readU32(bytes, offset + 8, littleEndian);
            const timestampHigh = readU32(bytes, offset + 12, littleEndian);
            const timestampLow = readU32(bytes, offset + 16, littleEndian);
            capturedLength = readU32(bytes, offset + 20, littleEndian);
            originalLength = readU32(bytes, offset + 24, littleEndian);
            timestamp = `${(BigInt(timestampHigh) << BigInt(32)) + BigInt(timestampLow)}`;
            linkType = interfaceLinkTypes[interfaceId] ?? 1;
            packetPayload = bytes.subarray(offset + 28, offset + 28 + Number(capturedLength));
        } else if (blockType === 0x00000003 && blockLength >= 16) {
            capturedLength = readU32(bytes, offset + 8, littleEndian);
            originalLength = capturedLength;
            packetPayload = bytes.subarray(offset + 12, offset + 12 + Number(capturedLength));
        }
        if (rows.length < 5000) rows.push([totalBlocks, typeName, blockLength, capturedLength, originalLength, `0x${blockOffset.toString(16)}`]);
        if (blockType === 0x0a0d0d0a) {
            const sectionLength = offset + 24 <= bytes.length ? readInt64AsDisplay(bytes, offset + 16, littleEndian) : '-';
            sections.push({ offset: blockOffset, littleEndian, major: readU16(bytes, offset + 12, littleEndian), minor: readU16(bytes, offset + 14, littleEndian), sectionLength });
        } else if (blockType === 0x00000001 && blockLength >= 20) {
            const ifaceLinkType = readU16(bytes, offset + 8, littleEndian);
            const snapLength = readU32(bytes, offset + 12, littleEndian);
            const options = readPcapngOptions(bytes, offset + 16, offset + blockLength - 4, littleEndian);
            interfaceLinkTypes.push(ifaceLinkType);
            interfaceRows.push([interfaceRows.length + 1, describePcapLinkType(ifaceLinkType), snapLength, options.get(2) || '-', options.get(3) || '-', options.get(9) || 'microseconds']);
        }
        if (packetPayload && packetRows.length < 5000) {
            const dissection = dissectPacket(packetPayload, linkType);
            packetRows.push([packetRows.length + 1, timestamp, dissection.protocol, dissection.source, dissection.destination, capturedLength, originalLength, `0x${blockOffset.toString(16)}`, dissection.info]);
        }
        offset += blockLength;
    }
    return { isPcapng, rows, packetRows, interfaceRows, sections, totalBlocks, truncated: offset !== bytes.length, invalidOffset: offset };
}

function describePcapLinkType(value: number): string {
    const names: Record<number, string> = { 0: 'BSD loopback', 1: 'Ethernet', 6: 'IEEE 802.5 Token Ring', 7: 'ARCNET', 8: 'SLIP', 9: 'PPP', 101: 'Raw IP', 105: 'IEEE 802.11', 113: 'Linux cooked capture', 127: 'Radiotap', 147: 'User0', 228: 'IPv4', 229: 'IPv6' };
    return names[value] ? `${value} (${names[value]})` : String(value);
}

function describePcapngBlockType(value: number): string {
    const names: Record<number, string> = { 0x0a0d0d0a: 'Section Header', 0x00000001: 'Interface Description', 0x00000002: 'Packet', 0x00000003: 'Simple Packet', 0x00000004: 'Name Resolution', 0x00000005: 'Interface Statistics', 0x00000006: 'Enhanced Packet', 0x0000000a: 'Decryption Secrets' };
    return names[value] || `Unknown 0x${value.toString(16).padStart(8, '0')}`;
}

function dissectPacket(packet: Uint8Array, linkType: number): PacketDissection {
    if (packet.length === 0) return { protocol: '-', source: '-', destination: '-', info: 'Empty packet' };
    if (linkType === 1) return dissectEthernet(packet);
    if (linkType === 101 || linkType === 228 || linkType === 229) return dissectIpPacket(packet);
    if (linkType === 113 && packet.length >= 16) { const protocol = u16be(packet, 14); return dissectEtherTypePayload(packet.subarray(16), protocol, 'Linux cooked'); }
    return { protocol: `Link ${linkType}`, source: '-', destination: '-', info: `Unsupported link type (${describePcapLinkType(linkType)})` };
}

function dissectEthernet(packet: Uint8Array): PacketDissection {
    if (packet.length < 14) return { protocol: 'Ethernet', source: '-', destination: '-', info: 'Truncated Ethernet frame' };
    const destinationMac = formatMac(packet.subarray(0, 6));
    const sourceMac = formatMac(packet.subarray(6, 12));
    let etherType = u16be(packet, 12);
    let payloadOffset = 14;
    const vlanTags: number[] = [];
    while ((etherType === 0x8100 || etherType === 0x88a8) && packet.length >= payloadOffset + 4) {
        const tagControlInformation = u16be(packet, payloadOffset);
        const vlanId = tagControlInformation & 0x0fff;
        const priority = (tagControlInformation >> 13) & 0x07;
        vlanTags.push(vlanId);
        etherType = u16be(packet, payloadOffset + 2);
        payloadOffset += 4;
        if (priority > 0) vlanTags[vlanTags.length - 1] = Number(`${vlanId}.${priority}`);
    }
    const result = dissectEtherTypePayload(packet.subarray(payloadOffset), etherType, 'Ethernet');
    const vlanInfo = vlanTags.length > 1 ? ` QinQ VLAN ${vlanTags.join('/')}` : vlanTags.length === 1 ? ` VLAN ${vlanTags[0]}` : '';
    if (result.source === '-' && result.destination === '-') return { ...result, source: sourceMac, destination: destinationMac, info: `${result.info}${vlanInfo}` };
    return { ...result, info: `${result.info}${vlanInfo}` };
}

function dissectEtherTypePayload(payload: Uint8Array, etherType: number, prefix: string): PacketDissection {
    switch (etherType) {
    case 0x0800: return dissectIpv4(payload);
    case 0x86dd: return dissectIpv6(payload);
    case 0x0806: return dissectArp(payload);
    default: return { protocol: prefix, source: '-', destination: '-', info: `EtherType 0x${etherType.toString(16).padStart(4, '0')}, ${payload.length} byte payload` };
    }
}

function dissectIpPacket(packet: Uint8Array): PacketDissection {
    const version = packet.length > 0 ? packet[0] >> 4 : 0;
    if (version === 4) return dissectIpv4(packet);
    if (version === 6) return dissectIpv6(packet);
    return { protocol: 'IP', source: '-', destination: '-', info: 'Unknown IP version' };
}

function dissectIpv4(packet: Uint8Array): PacketDissection {
    if (packet.length < 20) return { protocol: 'IPv4', source: '-', destination: '-', info: 'Truncated IPv4 packet' };
    const headerLength = (packet[0] & 0x0f) * 4;
    if (headerLength < 20 || packet.length < headerLength) return { protocol: 'IPv4', source: '-', destination: '-', info: 'Invalid IPv4 header length' };
    const protocol = packet[9];
    const source = formatIpv4(packet, 12);
    const destination = formatIpv4(packet, 16);
    const totalLength = u16be(packet, 2);
    const flagsAndOffset = u16be(packet, 6);
    const fragmentOffset = (flagsAndOffset & 0x1fff) * 8;
    const moreFragments = (flagsAndOffset & 0x2000) !== 0;
    const fragmentInfo = moreFragments || fragmentOffset > 0 ? ` fragment offset=${fragmentOffset}${moreFragments ? ', more fragments' : ''};` : '';
    const payloadLength = Math.max(0, Math.min(packet.length, totalLength || packet.length) - headerLength);
    const transport = dissectTransport(protocol, packet.subarray(headerLength, headerLength + payloadLength), source, destination, 'IPv4');
    if (transport) return fragmentInfo ? { ...transport, info: `${fragmentInfo} ${transport.info}` } : transport;
    return { protocol: `IPv4/${protocol}`, source, destination, info: `${fragmentInfo} ${payloadLength} byte payload`.trim() };
}

function dissectIpv6(packet: Uint8Array): PacketDissection {
    if (packet.length < 40) return { protocol: 'IPv6', source: '-', destination: '-', info: 'Truncated IPv6 packet' };
    const nextHeader = packet[6];
    const source = formatIpv6(packet.subarray(8, 24));
    const destination = formatIpv6(packet.subarray(24, 40));
    const payloadLength = u16be(packet, 4);
    const transport = dissectTransport(nextHeader, packet.subarray(40, 40 + payloadLength), source, destination, 'IPv6');
    return transport || { protocol: `IPv6/${nextHeader}`, source, destination, info: `${payloadLength} byte payload` };
}

function dissectArp(packet: Uint8Array): PacketDissection {
    if (packet.length < 28) return { protocol: 'ARP', source: '-', destination: '-', info: 'Truncated ARP packet' };
    const operation = u16be(packet, 6);
    const senderMac = formatMac(packet.subarray(8, 14));
    const senderIp = formatIpv4(packet, 14);
    const targetMac = formatMac(packet.subarray(18, 24));
    const targetIp = formatIpv4(packet, 24);
    const opName = operation === 1 ? 'Request' : operation === 2 ? 'Reply' : `Op ${operation}`;
    return { protocol: 'ARP', source: `${senderIp} (${senderMac})`, destination: `${targetIp} (${targetMac})`, info: operation === 1 ? `Who has ${targetIp}? Tell ${senderIp}` : `${senderIp} is at ${senderMac} (${opName})` };
}

function dissectTransport(protocol: number, payload: Uint8Array, sourceIp: string, destinationIp: string, ipVersion: string): PacketDissection | null {
    if (protocol === 6) return dissectTcp(payload, sourceIp, destinationIp, ipVersion);
    if (protocol === 17) return dissectUdp(payload, sourceIp, destinationIp, ipVersion);
    if (protocol === 1 || protocol === 58) return dissectIcmp(payload, sourceIp, destinationIp, protocol === 58 ? 'ICMPv6' : 'ICMP');
    return null;
}

function dissectTcp(payload: Uint8Array, sourceIp: string, destinationIp: string, ipVersion: string): PacketDissection {
    if (payload.length < 20) return { protocol: `${ipVersion}/TCP`, source: sourceIp, destination: destinationIp, info: 'Truncated TCP segment' };
    const sourcePort = u16be(payload, 0);
    const destinationPort = u16be(payload, 2);
    const seq = u32be(payload, 4);
    const ack = u32be(payload, 8);
    const dataOffset = (payload[12] >> 4) * 4;
    const flags = describeTcpFlags(payload[13]);
    const window = u16be(payload, 14);
    const appPayload = dataOffset <= payload.length ? payload.subarray(dataOffset) : new Uint8Array(0);
    const app = describeApplicationPayload(sourcePort, destinationPort, appPayload, true);
    return { protocol: app.protocol || `${ipVersion}/TCP`, source: `${sourceIp}:${sourcePort}`, destination: `${destinationIp}:${destinationPort}`, info: app.info || `TCP ${flags || 'no flags'}, seq=${seq}, ack=${ack}, win=${window}, ${appPayload.length} byte payload${payloadPreview(appPayload)}` };
}

function dissectUdp(payload: Uint8Array, sourceIp: string, destinationIp: string, ipVersion: string): PacketDissection {
    if (payload.length < 8) return { protocol: `${ipVersion}/UDP`, source: sourceIp, destination: destinationIp, info: 'Truncated UDP datagram' };
    const sourcePort = u16be(payload, 0);
    const destinationPort = u16be(payload, 2);
    const length = u16be(payload, 4);
    const appPayload = payload.subarray(8, Math.min(payload.length, length || payload.length));
    const app = describeApplicationPayload(sourcePort, destinationPort, appPayload, false);
    return { protocol: app.protocol || `${ipVersion}/UDP`, source: `${sourceIp}:${sourcePort}`, destination: `${destinationIp}:${destinationPort}`, info: app.info || `UDP ${appPayload.length} byte payload${payloadPreview(appPayload)}` };
}

function dissectIcmp(payload: Uint8Array, sourceIp: string, destinationIp: string, protocol: string): PacketDissection {
    if (payload.length < 2) return { protocol, source: sourceIp, destination: destinationIp, info: `Truncated ${protocol} message` };
    return { protocol, source: sourceIp, destination: destinationIp, info: `Type ${payload[0]}, code ${payload[1]}` };
}

function describeApplicationPayload(sourcePort: number, destinationPort: number, payload: Uint8Array, isTcp: boolean): { protocol: string; info: string } {
    const lowerPort = Math.min(sourcePort, destinationPort);
    const higherPort = Math.max(sourcePort, destinationPort);
    if ((!isTcp && sourcePort === 5353) || (!isTcp && destinationPort === 5353)) return { protocol: 'mDNS', info: describeDns(payload) };
    if (sourcePort === 53 || destinationPort === 53) { const dnsPayload = isTcp && payload.length >= 2 ? payload.subarray(2) : payload; return { protocol: 'DNS', info: describeDns(dnsPayload) }; }
    if (!isTcp && (sourcePort === 67 || sourcePort === 68 || destinationPort === 67 || destinationPort === 68)) return { protocol: 'DHCP', info: describeDhcp(payload) };
    if (!isTcp && (sourcePort === 123 || destinationPort === 123)) return { protocol: 'NTP', info: describeNtp(payload) };
    if (!isTcp && (sourcePort === 1900 || destinationPort === 1900)) { const ssdp = describeSsdp(payload); if (ssdp) return { protocol: 'SSDP', info: ssdp }; }
    if (!isTcp && (sourcePort === 5683 || destinationPort === 5683 || sourcePort === 5684 || destinationPort === 5684)) return { protocol: 'CoAP', info: describeCoap(payload) };
    if (isTcp && ([80, 8080, 8000, 8008, 8888].includes(lowerPort) || higherPort === 80)) { const http = describeHttp(payload); if (http) return { protocol: 'HTTP', info: http }; }
    if (isTcp && (sourcePort === 1883 || destinationPort === 1883)) return { protocol: 'MQTT', info: describeMqtt(payload) };
    if (isTcp && (sourcePort === 443 || destinationPort === 443)) return { protocol: 'TLS', info: describeTls(payload) };
    return { protocol: '', info: '' };
}

function describeDns(payload: Uint8Array): string {
    if (payload.length < 12) return 'Truncated DNS message';
    const id = u16be(payload, 0);
    const flags = u16be(payload, 2);
    const qdCount = u16be(payload, 4);
    const anCount = u16be(payload, 6);
    const isResponse = (flags & 0x8000) !== 0;
    const responseCode = flags & 0x000f;
    const questionData = qdCount > 0 ? readDnsQuestion(payload, 12) : null;
    const answers = questionData ? readDnsAnswers(payload, questionData.offset, anCount) : [];
    const question = questionData ? `${questionData.name} ${questionData.type}` : '';
    return `${isResponse ? 'Response' : 'Query'} id=0x${id.toString(16).padStart(4, '0')}, rcode=${describeDnsRcode(responseCode)}, questions=${qdCount}, answers=${anCount}${question ? `, ${question}` : ''}${answers.length > 0 ? `, ${answers.join('; ')}` : ''}`;
}

function readDnsName(payload: Uint8Array, offset: number): { name: string; offset: number } {
    const labels: string[] = [];
    let currentOffset = offset;
    let jumps = 0;
    while (currentOffset < payload.length && jumps < 16) {
        const length = payload[currentOffset];
        if (length === 0) return { name: labels.join('.'), offset: currentOffset + 1 };
        if ((length & 0xc0) === 0xc0) { if (currentOffset + 1 >= payload.length) break; const pointer = ((length & 0x3f) << 8) | payload[currentOffset + 1]; currentOffset = pointer; jumps++; continue; }
        currentOffset++;
        if (currentOffset + length > payload.length) break;
        labels.push(ascii(payload.subarray(currentOffset, currentOffset + length)));
        currentOffset += length;
    }
    return { name: labels.join('.') || '-', offset: currentOffset };
}

function readDnsQuestion(payload: Uint8Array, offset: number): { name: string; type: string; offset: number } | null {
    const name = readDnsName(payload, offset);
    if (name.offset + 4 > payload.length) return null;
    return { name: name.name, type: describeDnsType(u16be(payload, name.offset)), offset: name.offset + 4 };
}

function readDnsAnswers(payload: Uint8Array, offset: number, answerCount: number): string[] {
    const answers: string[] = [];
    let currentOffset = offset;
    for (let index = 0; index < answerCount && index < 3 && currentOffset < payload.length; index++) {
        const name = readDnsName(payload, currentOffset);
        currentOffset = name.offset;
        if (currentOffset + 10 > payload.length) break;
        const type = u16be(payload, currentOffset);
        const dataLength = u16be(payload, currentOffset + 8);
        const dataOffset = currentOffset + 10;
        if (dataOffset + dataLength > payload.length) break;
        answers.push(`${name.name} ${describeDnsType(type)} ${describeDnsRdata(payload, type, dataOffset, dataLength)}`);
        currentOffset = dataOffset + dataLength;
    }
    return answers;
}

function describeDnsType(type: number): string {
    const names: Record<number, string> = { 1: 'A', 2: 'NS', 5: 'CNAME', 12: 'PTR', 15: 'MX', 16: 'TXT', 28: 'AAAA', 33: 'SRV', 65: 'HTTPS' };
    return names[type] || `TYPE${type}`;
}

function describeDnsRcode(code: number): string {
    const names: Record<number, string> = { 0: 'NOERROR', 1: 'FORMERR', 2: 'SERVFAIL', 3: 'NXDOMAIN', 4: 'NOTIMP', 5: 'REFUSED' };
    return names[code] || String(code);
}

function describeDnsRdata(payload: Uint8Array, type: number, offset: number, length: number): string {
    if (type === 1 && length === 4) return formatIpv4(payload, offset);
    if (type === 28 && length === 16) return formatIpv6(payload.subarray(offset, offset + length));
    if ([2, 5, 12].includes(type)) return readDnsName(payload, offset).name;
    return `${length} bytes`;
}

function describeDhcp(payload: Uint8Array): string {
    if (payload.length < 240) return 'Truncated DHCP/BOOTP message';
    const op = payload[0] === 1 ? 'Request' : payload[0] === 2 ? 'Reply' : `Op ${payload[0]}`;
    const xid = u32be(payload, 4).toString(16).padStart(8, '0');
    const clientIp = formatIpv4(payload, 12);
    const yourIp = formatIpv4(payload, 16);
    const clientMac = formatMac(payload.subarray(28, 34));
    const messageType = describeDhcpMessageType(readDhcpOption(payload, 53)?.[0] || 0);
    return `${messageType || op}, xid=0x${xid}, client=${clientMac}, ciaddr=${clientIp}, yiaddr=${yourIp}`;
}

function readDhcpOption(payload: Uint8Array, optionCode: number): Uint8Array | null {
    let offset = 240;
    while (offset + 1 < payload.length) {
        const code = payload[offset++];
        if (code === 255) break;
        if (code === 0) continue;
        if (offset >= payload.length) break;
        const length = payload[offset++];
        if (offset + length > payload.length) break;
        if (code === optionCode) return payload.subarray(offset, offset + length);
        offset += length;
    }
    return null;
}

function describeDhcpMessageType(value: number): string {
    const names: Record<number, string> = { 1: 'Discover', 2: 'Offer', 3: 'Request', 4: 'Decline', 5: 'Ack', 6: 'Nak', 7: 'Release', 8: 'Inform' };
    return names[value] ? `DHCP ${names[value]}` : '';
}

function describeNtp(payload: Uint8Array): string {
    if (payload.length < 48) return 'Truncated NTP message';
    const leap = payload[0] >> 6;
    const version = (payload[0] >> 3) & 0x07;
    const mode = payload[0] & 0x07;
    const stratum = payload[1];
    const transmitSeconds = u32be(payload, 40);
    return `LI=${leap}, version=${version}, mode=${describeNtpMode(mode)}, stratum=${stratum}, tx=${transmitSeconds}`;
}

function describeNtpMode(mode: number): string {
    const names: Record<number, string> = { 1: 'symmetric active', 2: 'symmetric passive', 3: 'client', 4: 'server', 5: 'broadcast' };
    return names[mode] || String(mode);
}

function describeSsdp(payload: Uint8Array): string {
    const text = utf8(payload.subarray(0, Math.min(payload.length, 1024)));
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const firstLine = lines[0] || '';
    if (!/^(M-SEARCH|NOTIFY|HTTP\/1\.)/i.test(firstLine)) return '';
    const host = lines.find((line) => /^host:/i.test(line));
    const target = lines.find((line) => /^(st|nt):/i.test(line));
    const location = lines.find((line) => /^location:/i.test(line));
    return [firstLine, host, target, location].filter(Boolean).join(' | ');
}

function describeMqtt(payload: Uint8Array): string {
    if (payload.length < 2) return 'Truncated MQTT packet';
    const type = payload[0] >> 4;
    const typeName = describeMqttType(type);
    const remaining = readMqttRemainingLength(payload, 1);
    if (!remaining) return `${typeName}, invalid remaining length`;
    let detail = '';
    if (type === 1 && remaining.offset + 2 <= payload.length) {
        const protocolNameLength = u16be(payload, remaining.offset);
        const nameStart = remaining.offset + 2;
        const protocolName = nameStart + protocolNameLength <= payload.length ? utf8(payload.subarray(nameStart, nameStart + protocolNameLength)) : '';
        detail = protocolName ? `, protocol=${protocolName}` : '';
    } else if ((type === 3 || type === 8 || type === 10) && remaining.offset + 2 <= payload.length) {
        const topicLength = u16be(payload, remaining.offset);
        const topicStart = remaining.offset + 2;
        const topic = topicStart + topicLength <= payload.length ? utf8(payload.subarray(topicStart, topicStart + topicLength)) : '';
        detail = topic ? `, topic=${topic}` : '';
    }
    return `${typeName}, remaining=${remaining.length}${detail}`;
}

function readMqttRemainingLength(payload: Uint8Array, offset: number): { length: number; offset: number } | null {
    let multiplier = 1;
    let value = 0;
    let currentOffset = offset;
    for (let index = 0; index < 4 && currentOffset < payload.length; index++) {
        const byte = payload[currentOffset++];
        value += (byte & 0x7f) * multiplier;
        if ((byte & 0x80) === 0) return { length: value, offset: currentOffset };
        multiplier *= 128;
    }
    return null;
}

function describeMqttType(type: number): string {
    const names: Record<number, string> = { 1: 'CONNECT', 2: 'CONNACK', 3: 'PUBLISH', 4: 'PUBACK', 5: 'PUBREC', 6: 'PUBREL', 7: 'PUBCOMP', 8: 'SUBSCRIBE', 9: 'SUBACK', 10: 'UNSUBSCRIBE', 11: 'UNSUBACK', 12: 'PINGREQ', 13: 'PINGRESP', 14: 'DISCONNECT', 15: 'AUTH' };
    return names[type] || `Type ${type}`;
}

function describeCoap(payload: Uint8Array): string {
    if (payload.length < 4) return 'Truncated CoAP message';
    const version = payload[0] >> 6;
    const type = (payload[0] >> 4) & 0x03;
    const tokenLength = payload[0] & 0x0f;
    const codeClass = payload[1] >> 5;
    const codeDetail = payload[1] & 0x1f;
    const messageId = u16be(payload, 2);
    return `v${version}, ${describeCoapType(type)}, code=${codeClass}.${String(codeDetail).padStart(2, '0')}, mid=${messageId}, tokenLen=${tokenLength}`;
}

function describeCoapType(type: number): string {
    const names: Record<number, string> = { 0: 'Confirmable', 1: 'Non-confirmable', 2: 'Acknowledgement', 3: 'Reset' };
    return names[type] || String(type);
}

function describeHttp(payload: Uint8Array): string {
    const text = utf8(payload.subarray(0, Math.min(payload.length, 1024)));
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const firstLine = lines[0] || '';
    if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\s|^HTTP\/\d/.test(firstLine)) return '';
    const host = lines.find((line) => /^host:/i.test(line));
    const contentType = lines.find((line) => /^content-type:/i.test(line));
    return [firstLine, host, contentType].filter(Boolean).join(' | ');
}

function describeTls(payload: Uint8Array): string {
    if (payload.length < 5) return 'TLS/SSL encrypted payload';
    const contentTypes: Record<number, string> = { 20: 'ChangeCipherSpec', 21: 'Alert', 22: 'Handshake', 23: 'Application Data' };
    const contentType = contentTypes[payload[0]] || `Type ${payload[0]}`;
    const version = `0x${u16be(payload, 1).toString(16)}`;
    const length = u16be(payload, 3);
    const sni = payload[0] === 22 ? extractTlsSni(payload) : '';
    return `${contentType}, version ${version}, ${length} byte record${sni ? `, SNI ${sni}` : ''}`;
}

function extractTlsSni(payload: Uint8Array): string {
    if (payload.length < 9 || payload[0] !== 22 || payload[5] !== 1) return '';
    let offset = 9;
    offset += 2 + 32;
    if (offset >= payload.length) return '';
    const sessionIdLength = payload[offset++];
    offset += sessionIdLength;
    if (offset + 2 > payload.length) return '';
    const cipherSuitesLength = u16be(payload, offset);
    offset += 2 + cipherSuitesLength;
    if (offset >= payload.length) return '';
    const compressionMethodsLength = payload[offset++];
    offset += compressionMethodsLength;
    if (offset + 2 > payload.length) return '';
    const extensionsEnd = offset + 2 + u16be(payload, offset);
    offset += 2;
    while (offset + 4 <= payload.length && offset + 4 <= extensionsEnd) {
        const extensionType = u16be(payload, offset);
        const extensionLength = u16be(payload, offset + 2);
        offset += 4;
        if (extensionType === 0 && offset + extensionLength <= payload.length) return readTlsServerName(payload.subarray(offset, offset + extensionLength));
        offset += extensionLength;
    }
    return '';
}

function readTlsServerName(extension: Uint8Array): string {
    if (extension.length < 5) return '';
    let offset = 2;
    while (offset + 3 <= extension.length) {
        const nameType = extension[offset++];
        const nameLength = u16be(extension, offset);
        offset += 2;
        if (nameType === 0 && offset + nameLength <= extension.length) return utf8(extension.subarray(offset, offset + nameLength));
        offset += nameLength;
    }
    return '';
}

function describeTcpFlags(value: number): string {
    const flags: string[] = [];
    if (value & 0x01) flags.push('FIN');
    if (value & 0x02) flags.push('SYN');
    if (value & 0x04) flags.push('RST');
    if (value & 0x08) flags.push('PSH');
    if (value & 0x10) flags.push('ACK');
    if (value & 0x20) flags.push('URG');
    if (value & 0x40) flags.push('ECE');
    if (value & 0x80) flags.push('CWR');
    return flags.join(',');
}

function payloadPreview(payload: Uint8Array): string {
    if (payload.length === 0) return '';
    const preview = payload.subarray(0, Math.min(payload.length, 16));
    const hexStr = Array.from(preview, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
    const asciiStr = Array.from(preview, (byte) => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.').join('');
    return `, payload ${hexStr} | ${asciiStr}`;
}

function readPcapngOptions(bytes: Uint8Array, start: number, end: number, littleEndian: boolean): Map<number, string> {
    const options = new Map<number, string>();
    let offset = start;
    while (offset + 4 <= end) {
        const code = readU16(bytes, offset, littleEndian);
        const length = readU16(bytes, offset + 2, littleEndian);
        offset += 4;
        if (code === 0) break;
        if (offset + length > end) break;
        const value = bytes.subarray(offset, offset + length);
        options.set(code, printablePcapngOption(code, value));
        offset += length + ((4 - length % 4) % 4);
    }
    return options;
}

function printablePcapngOption(code: number, value: Uint8Array): string {
    if (code === 9 && value.length > 0) { const raw = value[0]; if ((raw & 0x80) !== 0) return `2^-${raw & 0x7f}`; return `10^-${raw}`; }
    return value.every((byte) => (byte >= 32 && byte <= 126) || byte === 9) ? utf8(value) : hex(value);
}

function formatMac(bytes: Uint8Array): string { return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(':'); }
function formatIpv4(bytes: Uint8Array, offset: number): string { if (offset + 4 > bytes.length) return '-'; return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`; }
function formatIpv6(bytes: Uint8Array): string { if (bytes.length < 16) return '-'; const groups: string[] = []; for (let offset = 0; offset < 16; offset += 2) groups.push(u16be(bytes, offset).toString(16)); return groups.join(':'); }
