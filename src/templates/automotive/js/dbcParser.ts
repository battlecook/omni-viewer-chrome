export interface DbcSignalValue { value: number; label: string; }
export interface DbcSignal {
    name: string; multiplexer: string | null; startBit: number; length: number;
    byteOrder: 'little_endian' | 'big_endian'; valueType: 'unsigned' | 'signed';
    factor: number; offset: number; minimum: number; maximum: number; unit: string;
    receivers: string[]; comment: string | null; values: DbcSignalValue[]; line: number;
}
export interface DbcMessage {
    id: number; idHex: string; name: string; dlc: number; transmitter: string;
    comment: string | null; signals: DbcSignal[]; line: number;
}
export interface DbcComment {
    target: 'network' | 'node' | 'message' | 'signal' | 'unknown';
    messageId?: number; signalName?: string; nodeName?: string; text: string; line: number;
}
export interface DbcViewerModel {
    version: string; busConfiguration: string | null; nodes: string[]; messages: DbcMessage[];
    comments: DbcComment[]; warnings: string[];
    stats: { messageCount: number; signalCount: number; nodeCount: number; extendedMessageCount: number; maxDlc: number; };
}

export function parseDbc(source: string): DbcViewerModel {
    const model: DbcViewerModel = {
        version: '', busConfiguration: null, nodes: [], messages: [], comments: [], warnings: [],
        stats: { messageCount: 0, signalCount: 0, nodeCount: 0, extendedMessageCount: 0, maxDlc: 0 }
    };
    const messages = new Map<number, DbcMessage>();
    let current: DbcMessage | null = null;
    source.split(/\r?\n/).forEach((line, index) => {
        const text = line.trim();
        const lineNumber = index + 1;
        if (!text) return;
        if (text.startsWith('VERSION')) { model.version = unquote(text.replace(/^VERSION\s*/, '').trim()); return; }
        if (text.startsWith('BS_:')) { model.busConfiguration = text.slice(4).trim() || null; return; }
        if (text.startsWith('BU_:')) { model.nodes = text.slice(4).trim().split(/\s+/).filter(Boolean); return; }
        const messageMatch = /^BO_\s+(\d+)\s+([A-Za-z_][\w.]*)\s*:\s*(\d+)\s+(\S+)/.exec(text);
        if (messageMatch) {
            const id = Number(messageMatch[1]);
            current = { id, idHex: `0x${id.toString(16).toUpperCase()}`, name: messageMatch[2], dlc: Number(messageMatch[3]), transmitter: messageMatch[4], comment: null, signals: [], line: lineNumber };
            model.messages.push(current); messages.set(id, current); return;
        }
        const signalMatch = /^SG_\s+([A-Za-z_][\w.]*)\s*(M|m\d+)?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s+\(([-+.\deE]+),([-+.\deE]+)\)\s+\[([-+.\deE]+)\|([-+.\deE]+)\]\s+"([^"]*)"\s*(.*)$/.exec(text);
        if (signalMatch) {
            const signal: DbcSignal = {
                name: signalMatch[1], multiplexer: signalMatch[2] || null, startBit: Number(signalMatch[3]), length: Number(signalMatch[4]),
                byteOrder: signalMatch[5] === '1' ? 'little_endian' : 'big_endian', valueType: signalMatch[6] === '+' ? 'unsigned' : 'signed',
                factor: Number(signalMatch[7]), offset: Number(signalMatch[8]), minimum: Number(signalMatch[9]), maximum: Number(signalMatch[10]),
                unit: signalMatch[11], receivers: signalMatch[12].trim().split(',').map((value) => value.trim()).filter(Boolean), comment: null, values: [], line: lineNumber
            };
            if (current) current.signals.push(signal); else model.warnings.push(`Line ${lineNumber}: signal "${signal.name}" appears before any message.`);
            return;
        }
        let match = /^CM_\s+BO_\s+(\d+)\s+"((?:[^"\\]|\\.)*)"\s*;/.exec(text);
        if (match) { const comment = makeComment('message', match[2], lineNumber, Number(match[1])); model.comments.push(comment); const target = messages.get(Number(match[1])); if (target) target.comment = comment.text; return; }
        match = /^CM_\s+SG_\s+(\d+)\s+([A-Za-z_][\w.]*)\s+"((?:[^"\\]|\\.)*)"\s*;/.exec(text);
        if (match) { const comment = makeComment('signal', match[3], lineNumber, Number(match[1]), match[2]); model.comments.push(comment); const target = messages.get(Number(match[1]))?.signals.find((signal) => signal.name === match![2]); if (target) target.comment = comment.text; return; }
        const valueMatch = /^VAL_\s+(\d+)\s+([A-Za-z_][\w.]*)\s+(.+);$/.exec(text);
        if (valueMatch) {
            const target = messages.get(Number(valueMatch[1]))?.signals.find((signal) => signal.name === valueMatch[2]);
            const values: DbcSignalValue[] = []; const pattern = /(-?\d+)\s+"((?:[^"\\]|\\.)*)"/g; let item: RegExpExecArray | null;
            while ((item = pattern.exec(valueMatch[3])) !== null) values.push({ value: Number(item[1]), label: unescapeDbc(item[2]) });
            if (target) target.values = values; else model.warnings.push(`Line ${lineNumber}: value table target ${valueMatch[1]}.${valueMatch[2]} was not found.`);
        }
    });
    model.stats = {
        messageCount: model.messages.length,
        signalCount: model.messages.reduce((sum, message) => sum + message.signals.length, 0),
        nodeCount: model.nodes.length,
        extendedMessageCount: model.messages.filter((message) => message.id > 0x7ff).length,
        maxDlc: model.messages.reduce((max, message) => Math.max(max, message.dlc), 0)
    };
    return model;
}

function makeComment(target: DbcComment['target'], text: string, line: number, messageId?: number, signalName?: string): DbcComment {
    return { target, text: unescapeDbc(text), line, messageId, signalName };
}
function unquote(value: string): string { return value.startsWith('"') && value.endsWith('"') ? unescapeDbc(value.slice(1, -1)) : value; }
function unescapeDbc(value: string): string { return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\'); }
