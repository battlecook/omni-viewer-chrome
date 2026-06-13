export type ConfigSourceTokenKind =
    | 'key'
    | 'string'
    | 'number'
    | 'boolean'
    | 'null'
    | 'comment'
    | 'punctuation'
    | 'value';

export interface ConfigSourceToken {
    kind?: ConfigSourceTokenKind;
    text: string;
}

export function tokenizeYamlSource(source: string): ConfigSourceToken[] {
    return tokenizeSource(source, tokenizeYamlLine);
}

export function tokenizeTomlSource(source: string): ConfigSourceToken[] {
    return tokenizeSource(source, tokenizeTomlLine);
}

function tokenizeSource(
    source: string,
    tokenizeLine: (line: string) => ConfigSourceToken[]
): ConfigSourceToken[] {
    if (!source) return [];
    const tokens: ConfigSourceToken[] = [];
    let cursor = 0;
    while (cursor < source.length) {
        const newline = source.indexOf('\n', cursor);
        const end = newline === -1 ? source.length : newline;
        tokens.push(...tokenizeLine(source.slice(cursor, end)));
        if (newline !== -1) tokens.push({ text: '\n' });
        cursor = newline === -1 ? source.length : newline + 1;
    }
    return tokens;
}

function tokenizeYamlLine(line: string): ConfigSourceToken[] {
    const commentAt = findOutsideQuotes(line, '#');
    const code = commentAt === -1 ? line : line.slice(0, commentAt);
    const comment = commentAt === -1 ? '' : line.slice(commentAt);
    const colonAt = findYamlKeyColon(code);
    const tokens: ConfigSourceToken[] = [];

    if (colonAt !== -1) {
        const keyStart = yamlKeyStart(code, colonAt);
        pushPlain(tokens, code.slice(0, keyStart));
        pushToken(tokens, 'key', code.slice(keyStart, colonAt));
        pushToken(tokens, 'punctuation', ':');
        pushValueWithWhitespace(tokens, code.slice(colonAt + 1));
    } else {
        const listValue = /^(\s*-\s*)(\S.*)$/.exec(code);
        if (listValue) {
            pushPlain(tokens, listValue[1]);
            pushValue(tokens, listValue[2]);
        } else {
            pushPlain(tokens, code);
        }
    }

    pushToken(tokens, 'comment', comment);
    return tokens;
}

function tokenizeTomlLine(line: string): ConfigSourceToken[] {
    const commentAt = findOutsideQuotes(line, '#');
    const code = commentAt === -1 ? line : line.slice(0, commentAt);
    const comment = commentAt === -1 ? '' : line.slice(commentAt);
    const tokens: ConfigSourceToken[] = [];
    const section = /^(\s*)(\[\[?)(.*?)(\]\]?)(\s*)$/.exec(code);

    if (section && section[2].length === section[4].length) {
        pushPlain(tokens, section[1]);
        pushToken(tokens, 'punctuation', section[2]);
        pushToken(tokens, 'key', section[3]);
        pushToken(tokens, 'punctuation', section[4]);
        pushPlain(tokens, section[5]);
    } else {
        const equalsAt = findOutsideQuotes(code, '=');
        if (equalsAt !== -1) {
            const firstNonWhitespace = code.search(/\S/);
            const keyStart = firstNonWhitespace === -1 ? equalsAt : firstNonWhitespace;
            const keyEnd = trimEndIndex(code, equalsAt);
            pushPlain(tokens, code.slice(0, keyStart));
            pushToken(tokens, 'key', code.slice(keyStart, keyEnd));
            pushPlain(tokens, code.slice(keyEnd, equalsAt));
            pushToken(tokens, 'punctuation', '=');
            pushValueWithWhitespace(tokens, code.slice(equalsAt + 1));
        } else {
            pushPlain(tokens, code);
        }
    }

    pushToken(tokens, 'comment', comment);
    return tokens;
}

function pushValueWithWhitespace(tokens: ConfigSourceToken[], text: string): void {
    const valueStart = text.search(/\S/);
    if (valueStart === -1) {
        pushPlain(tokens, text);
        return;
    }
    pushPlain(tokens, text.slice(0, valueStart));
    pushValue(tokens, text.slice(valueStart));
}

function pushValue(tokens: ConfigSourceToken[], text: string): void {
    const trailingStart = trimEndIndex(text, text.length);
    const value = text.slice(0, trailingStart);
    pushToken(tokens, classifyValue(value), value);
    pushPlain(tokens, text.slice(trailingStart));
}

function classifyValue(value: string): ConfigSourceTokenKind {
    const trimmed = value.trim();
    if (/^(?:true|false)$/i.test(trimmed)) return 'boolean';
    if (/^(?:null|~)$/i.test(trimmed)) return 'null';
    if (/^[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?$/.test(trimmed)) {
        return 'number';
    }
    if (/^(?:"|')/.test(trimmed)) return 'string';
    return 'value';
}

function findYamlKeyColon(line: string): number {
    let quote = '';
    let escaped = false;
    let flowDepth = 0;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
            if (quote === '"' && escaped) escaped = false;
            else if (quote === '"' && ch === '\\') escaped = true;
            else if (ch === quote) quote = '';
            continue;
        }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '[' || ch === '{') flowDepth++;
        else if (ch === ']' || ch === '}') flowDepth = Math.max(0, flowDepth - 1);
        else if (
            ch === ':' &&
            flowDepth === 0 &&
            (i + 1 === line.length || /\s/.test(line[i + 1]))
        ) return i;
    }
    return -1;
}

function yamlKeyStart(line: string, colonAt: number): number {
    return /^(\s*(?:-\s+)?)/.exec(line.slice(0, colonAt))?.[1].length ?? 0;
}

function findOutsideQuotes(text: string, target: string): number {
    let quote = '';
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (quote === '"' && escaped) escaped = false;
            else if (quote === '"' && ch === '\\') escaped = true;
            else if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === target) return i;
    }
    return -1;
}

function trimEndIndex(text: string, end: number): number {
    let index = end;
    while (index > 0 && /\s/.test(text[index - 1])) index--;
    return index;
}

function pushPlain(tokens: ConfigSourceToken[], text: string): void {
    if (text) tokens.push({ text });
}

function pushToken(
    tokens: ConfigSourceToken[],
    kind: ConfigSourceTokenKind,
    text: string
): void {
    if (text) tokens.push({ kind, text });
}
