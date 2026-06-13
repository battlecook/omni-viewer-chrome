// TOML 1.0 parser ported for browser-side use (issue #65).
//
// Originally lives at vscode-omni-viewer/src/utils/tomlParser.ts. The Chrome
// port keeps the same parser surface but drops the small VSCode-only bits
// (none of the parser referenced node/vscode imports anyway).
//
// Coverage (TOML 1.0):
//   - Key-value pairs: bare keys, quoted keys, dotted keys
//   - Strings: basic ("..."), multi-line basic (""" """), literal ('...'),
//     multi-line literal (''' ''')
//   - Integers (incl. underscores, hex/oct/bin, +/-, leading-zero rejection)
//   - Floats (incl. nan/inf, exponent notation, underscores)
//   - Booleans
//   - Date/time: offset date-time, local date-time, local date, local time
//   - Arrays (mixed-type allowed per TOML 1.0)
//   - Tables `[a.b.c]`
//   - Array of tables `[[a]]`
//   - Inline tables `{ a = 1, b = 2 }`
//   - Comments (line-only `# ...`)
//
// Out of scope:
//   - Strict over-key redefinition diagnostics in every edge case (we
//     reject the obvious cases — table redefinition, key collision in same
//     scope — but do not exhaustively police every spec corner).
//
// The parser exports:
//   - `parseToml(text)`        -> a JS object representation (data)
//   - `parseTomlAst(text)`     -> a tree AST suited for the tree viewer
//
// The AST nodes are deliberately flat / serializable (no class instances)
// so the renderer can walk them without further translation.

// ===========================================================================
// AST shapes
// ===========================================================================

/**
 * The kind of value a leaf node holds. Mirrors the TOML 1.0 type system.
 * `datetime-*` variants disambiguate the four chronological types.
 */
export type TomlValueType =
    | 'string'
    | 'integer'
    | 'float'
    | 'boolean'
    | 'datetime-offset'
    | 'datetime-local'
    | 'date-local'
    | 'time-local'
    | 'array'
    | 'inline-table';

export interface TomlPosition {
    line: number;   // 1-based
    column: number; // 1-based
}

export interface TomlAstNode {
    /**
     * The display key segment for this node within its parent. For the root
     * AST it is the empty string. For dotted keys (`a.b.c = 1`) the AST is
     * still split into one node per segment so the tree view can render
     * `a -> b -> c`.
     */
    key: string;
    /**
     * Whether this node represents a leaf value (`scalar` / `array`) or a
     * nesting container (`table`, `array-of-tables`).
     */
    nodeType: 'table' | 'array-of-tables' | 'scalar' | 'array' | 'inline-table';
    /**
     * The concrete value type for scalars. Undefined for tables.
     */
    valueType?: TomlValueType;
    /**
     * The raw parsed value, normalized:
     *   - string  -> JS string
     *   - integer -> JS number (or bigint safety: see note below)
     *   - float   -> JS number (NaN/Infinity allowed)
     *   - boolean -> JS boolean
     *   - dates   -> JS string (preserves original RFC 3339 text, see notes)
     *   - array   -> JS array (decoded recursively)
     *   - inline  -> JS object (decoded recursively)
     *
     * Tables / array-of-tables don't carry a `value`; their children are in
     * `children`.
     *
     * BigInt note: TOML allows 64-bit signed integers. We coerce to Number
     * to keep the parser dependency-free; values outside the safe-integer
     * range fall back to a string representation.
     */
    value?: unknown;
    /**
     * Child nodes, populated for tables, array-of-tables (one entry per
     * occurrence), and inline tables.
     */
    children?: TomlAstNode[];
    /**
     * Where in the source this node was declared. Useful for the "jump to
     * source" affordance and for parser error messages.
     */
    position?: TomlPosition;
}

// ===========================================================================
// Public entry points
// ===========================================================================

/**
 * Parse a TOML document and return a JS object (the "data" representation).
 * Throws `TomlParseError` on malformed input.
 */
export function parseToml(text: string): Record<string, unknown> {
    const parser = new Parser(text);
    parser.parse();
    return parser.root.data;
}

/**
 * Parse a TOML document and return the tree AST. Throws on malformed input.
 */
export function parseTomlAst(text: string): TomlAstNode {
    const parser = new Parser(text);
    parser.parse();
    return parser.root.toAst();
}

export class TomlParseError extends Error {
    line: number;
    column: number;
    constructor(message: string, line: number, column: number) {
        super(`TOML parse error at line ${line}, column ${column}: ${message}`);
        this.name = 'TomlParseError';
        this.line = line;
        this.column = column;
    }
}

// ===========================================================================
// Internal: a tree node used during parse
// ===========================================================================

interface InternalNode {
    /** The literal key segment (post-decoding, never the dotted form). */
    key: string;
    nodeType: 'table' | 'array-of-tables' | 'scalar' | 'array' | 'inline-table';
    valueType?: TomlValueType;
    value?: unknown;
    /** Child nodes keyed by key segment. Map preserves insertion order. */
    children: Map<string, InternalNode>;
    /**
     * For array-of-tables: each entry is its own table-frame. The `children`
     * map of *this* node is empty — instead `tableArray` holds frames and
     * each frame's `children` is what users wrote.
     */
    tableArray?: InternalNode[];
    /**
     * Whether this table was created implicitly (by a dotted key or a
     * subtable `[a.b]` referencing `a` first). Implicit tables can be
     * promoted to explicit later, but the same explicit `[a]` cannot appear
     * twice.
     */
    implicit: boolean;
    /** Whether the table was opened by a literal `[a]` (or `[[a]]`) header. */
    explicitlyDefined: boolean;
    /** Inline tables and arrays-of-tables seal their children. */
    sealed: boolean;
    position?: TomlPosition;
}

function createNode(
    key: string,
    nodeType: InternalNode['nodeType']
): InternalNode {
    return {
        key,
        nodeType,
        children: new Map(),
        implicit: false,
        explicitlyDefined: false,
        sealed: false
    };
}

// ===========================================================================
// Root holder — exposes both the JS data view and the AST view.
// ===========================================================================

class Root {
    rootNode: InternalNode = createNode('', 'table');

    /** JS-object view (recursive). */
    get data(): Record<string, unknown> {
        return nodeToData(this.rootNode) as Record<string, unknown>;
    }

    /** AST view (recursive). */
    toAst(): TomlAstNode {
        return nodeToAst(this.rootNode);
    }
}

function nodeToData(n: InternalNode): unknown {
    switch (n.nodeType) {
        case 'scalar':
            return n.value;
        case 'array':
            // Array values can themselves be arrays or inline tables.
            return (n.value as unknown[]).map((v) => unwrapArrayElement(v));
        case 'inline-table':
        case 'table': {
            const obj: Record<string, unknown> = {};
            for (const [k, child] of n.children) {
                obj[k] = nodeToData(child);
            }
            return obj;
        }
        case 'array-of-tables': {
            const arr: unknown[] = [];
            for (const frame of n.tableArray ?? []) {
                arr.push(nodeToData(frame));
            }
            return arr;
        }
    }
}

function unwrapArrayElement(v: unknown): unknown {
    // Array elements parsed via `parseValue` are already in their JS form
    // (numbers, strings, arrays, plain objects for inline tables). Pass
    // through.
    return v;
}

function nodeToAst(n: InternalNode): TomlAstNode {
    const ast: TomlAstNode = {
        key: n.key,
        nodeType: n.nodeType,
        position: n.position
    };

    if (n.nodeType === 'scalar') {
        ast.valueType = n.valueType;
        ast.value = n.value;
        return ast;
    }

    if (n.nodeType === 'array') {
        ast.valueType = 'array';
        ast.value = n.value;
        return ast;
    }

    if (n.nodeType === 'array-of-tables') {
        ast.children = (n.tableArray ?? []).map((frame, idx) => {
            const frameAst = nodeToAst(frame);
            // Override the key so the renderer can show "[0]", "[1]", ...
            frameAst.key = `[${idx}]`;
            return frameAst;
        });
        return ast;
    }

    // table / inline-table
    ast.valueType = n.nodeType === 'inline-table' ? 'inline-table' : undefined;
    ast.children = [];
    for (const [, child] of n.children) {
        ast.children.push(nodeToAst(child));
    }
    return ast;
}

// ===========================================================================
// The parser proper.
// ===========================================================================

class Parser {
    root = new Root();

    private text: string;
    private pos = 0;
    private line = 1;
    private col = 1;

    /**
     * The current "active table" — where bare key-value pairs are added.
     * Starts as the root; a `[a.b]` header changes it.
     */
    private currentTable: InternalNode;

    constructor(text: string) {
        // Strip a UTF-8 BOM if present so column counts match user expectation.
        if (text.charCodeAt(0) === 0xfeff) {
            text = text.slice(1);
        }
        this.text = text;
        this.currentTable = this.root.rootNode;
    }

    parse(): void {
        while (!this.eof()) {
            this.skipWhitespaceAndComments();
            if (this.eof()) break;
            const ch = this.peek();

            if (ch === '\n' || ch === '\r') {
                this.consumeNewline();
                continue;
            }

            if (ch === '[') {
                if (this.peek(1) === '[') {
                    this.parseArrayOfTablesHeader();
                } else {
                    this.parseTableHeader();
                }
                continue;
            }

            // Otherwise: key = value
            this.parseKeyValue();
        }
    }

    // -----------------------------------------------------------------------
    // Headers
    // -----------------------------------------------------------------------

    private parseTableHeader(): void {
        const start = this.posSnapshot();
        this.expect('[');
        const keys = this.parseKeyPath();
        this.skipInlineWhitespace();
        this.expect(']');
        this.skipInlineWhitespace();
        if (!this.eof() && !this.atLineEnd() && this.peek() !== '#') {
            this.fail(`Unexpected content after table header`);
        }

        // Walk/create the table chain. Every prefix is implicitly a table
        // (or already explicit), and the last segment becomes the new
        // "currentTable".
        let node = this.root.rootNode;
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const last = i === keys.length - 1;
            let child = node.children.get(key);
            if (!child) {
                child = createNode(key, 'table');
                child.implicit = !last;
                child.position = start;
                node.children.set(key, child);
            } else {
                if (child.nodeType === 'array-of-tables') {
                    // Headers like [a] cannot reopen an array-of-tables.
                    if (last) {
                        this.failAt(start, `Cannot redefine ${keys.join('.')} as table; it is an array of tables`);
                    }
                    // Stepping into the most recent frame is the canonical
                    // semantics for `[[a]]` followed by `[a.b]`.
                    const frames = child.tableArray ?? [];
                    if (frames.length === 0) {
                        this.failAt(start, `Cannot enter ${key}: no frames`);
                    }
                    node = frames[frames.length - 1];
                    continue;
                }
                if (child.nodeType !== 'table') {
                    this.failAt(start, `Key ${keys.slice(0, i + 1).join('.')} is not a table`);
                }
                if (last) {
                    if (child.explicitlyDefined) {
                        this.failAt(start, `Table ${keys.join('.')} already defined`);
                    }
                }
            }
            if (last) {
                child.explicitlyDefined = true;
                child.implicit = false;
                if (child.sealed) {
                    this.failAt(start, `Cannot extend inline-defined table ${keys.join('.')}`);
                }
                this.currentTable = child;
            } else {
                node = child;
            }
        }
    }

    private parseArrayOfTablesHeader(): void {
        const start = this.posSnapshot();
        this.expect('[');
        this.expect('[');
        const keys = this.parseKeyPath();
        this.skipInlineWhitespace();
        this.expect(']');
        this.expect(']');
        this.skipInlineWhitespace();
        if (!this.eof() && !this.atLineEnd() && this.peek() !== '#') {
            this.fail(`Unexpected content after array-of-tables header`);
        }

        let node = this.root.rootNode;
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const last = i === keys.length - 1;
            let child = node.children.get(key);
            if (!child) {
                if (last) {
                    child = createNode(key, 'array-of-tables');
                    child.tableArray = [];
                    child.position = start;
                    node.children.set(key, child);
                } else {
                    child = createNode(key, 'table');
                    child.implicit = true;
                    child.position = start;
                    node.children.set(key, child);
                }
            } else {
                if (last) {
                    if (child.nodeType !== 'array-of-tables') {
                        this.failAt(start, `Cannot redefine ${keys.join('.')} as array of tables`);
                    }
                    if (child.sealed) {
                        this.failAt(start, `Cannot append to sealed ${keys.join('.')}`);
                    }
                } else {
                    if (child.nodeType === 'array-of-tables') {
                        const frames = child.tableArray ?? [];
                        if (frames.length === 0) {
                            this.failAt(start, `Cannot enter ${key}: no frames`);
                        }
                        node = frames[frames.length - 1];
                        continue;
                    }
                    if (child.nodeType !== 'table') {
                        this.failAt(start, `Key ${keys.slice(0, i + 1).join('.')} is not a table`);
                    }
                }
            }
            if (last) {
                const frame = createNode(key, 'table');
                frame.explicitlyDefined = true;
                frame.position = start;
                (child.tableArray ??= []).push(frame);
                this.currentTable = frame;
            } else {
                node = child;
            }
        }
    }

    // -----------------------------------------------------------------------
    // key = value
    // -----------------------------------------------------------------------

    private parseKeyValue(): void {
        const start = this.posSnapshot();
        const keys = this.parseKeyPath();
        this.skipInlineWhitespace();
        this.expect('=');
        this.skipInlineWhitespace();
        const { value, valueType } = this.parseValue();

        // Walk dotted-key path, creating implicit subtables as needed.
        let node = this.currentTable;
        if (node.sealed) {
            this.failAt(start, `Cannot add keys to sealed table`);
        }
        for (let i = 0; i < keys.length - 1; i++) {
            const key = keys[i];
            let child = node.children.get(key);
            if (!child) {
                child = createNode(key, 'table');
                child.implicit = true;
                child.position = start;
                node.children.set(key, child);
            } else if (child.nodeType !== 'table') {
                this.failAt(start, `Key ${keys.slice(0, i + 1).join('.')} is not a table`);
            } else if (child.explicitlyDefined) {
                // Dotted-key cannot extend an explicitly-defined table.
                this.failAt(start, `Cannot extend already-defined table ${keys.slice(0, i + 1).join('.')} via dotted key`);
            } else if (child.sealed) {
                this.failAt(start, `Cannot extend sealed table ${keys.slice(0, i + 1).join('.')}`);
            }
            node = child;
        }

        const lastKey = keys[keys.length - 1];
        if (node.children.has(lastKey)) {
            this.failAt(start, `Duplicate key '${lastKey}'`);
        }

        const leaf = createNode(
            lastKey,
            valueType === 'array'
                ? 'array'
                : valueType === 'inline-table'
                    ? 'inline-table'
                    : 'scalar'
        );
        leaf.value = value;
        leaf.valueType = valueType;
        leaf.position = start;

        if (valueType === 'inline-table') {
            // For inline tables we also populate `children` so the AST
            // can render them as a tree.
            populateInlineTableChildren(leaf, value as Record<string, unknown>, start);
            leaf.sealed = true;
        }

        node.children.set(lastKey, leaf);

        // After a value, expect end of line or comment.
        this.skipInlineWhitespace();
        if (!this.eof()) {
            const ch = this.peek();
            if (ch === '#') {
                this.skipComment();
            } else if (ch === '\n' || ch === '\r') {
                this.consumeNewline();
            } else {
                this.fail(`Unexpected content after value`);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Key path: bare-or-quoted (.bare-or-quoted)*
    // -----------------------------------------------------------------------

    private parseKeyPath(): string[] {
        const keys: string[] = [];
        keys.push(this.parseKeySegment());
        this.skipInlineWhitespace();
        while (!this.eof() && this.peek() === '.') {
            this.advance();
            this.skipInlineWhitespace();
            keys.push(this.parseKeySegment());
            this.skipInlineWhitespace();
        }
        return keys;
    }

    private parseKeySegment(): string {
        this.skipInlineWhitespace();
        const ch = this.peek();
        if (ch === '"') {
            return this.parseBasicString(false);
        }
        if (ch === '\'') {
            return this.parseLiteralString(false);
        }
        return this.parseBareKey();
    }

    private parseBareKey(): string {
        const start = this.pos;
        while (!this.eof()) {
            const ch = this.peek();
            if (
                (ch >= 'a' && ch <= 'z') ||
                (ch >= 'A' && ch <= 'Z') ||
                (ch >= '0' && ch <= '9') ||
                ch === '-' ||
                ch === '_'
            ) {
                this.advance();
            } else {
                break;
            }
        }
        if (this.pos === start) {
            this.fail(`Expected key`);
        }
        return this.text.slice(start, this.pos);
    }

    // -----------------------------------------------------------------------
    // Values
    // -----------------------------------------------------------------------

    private parseValue(): { value: unknown; valueType: TomlValueType } {
        const ch = this.peek();
        if (ch === undefined) this.fail(`Unexpected end of input`);

        if (ch === '"') {
            const isMulti = this.peek(1) === '"' && this.peek(2) === '"';
            return {
                value: isMulti
                    ? this.parseMultilineBasicString()
                    : this.parseBasicString(true),
                valueType: 'string'
            };
        }

        if (ch === '\'') {
            const isMulti = this.peek(1) === '\'' && this.peek(2) === '\'';
            return {
                value: isMulti
                    ? this.parseMultilineLiteralString()
                    : this.parseLiteralString(true),
                valueType: 'string'
            };
        }

        if (ch === '[') {
            return { value: this.parseArray(), valueType: 'array' };
        }

        if (ch === '{') {
            return {
                value: this.parseInlineTable(),
                valueType: 'inline-table'
            };
        }

        if (ch === 't' || ch === 'f') {
            return this.parseBooleanLike();
        }

        // Number / date-time. Determine which by peeking the prefix.
        return this.parseNumberOrDate();
    }

    // ----- Strings ---------------------------------------------------------

    private parseBasicString(quotedKey: boolean): string {
        this.expect('"');
        let out = '';
        while (!this.eof()) {
            const ch = this.advance();
            if (ch === '"') return out;
            if (ch === '\n') this.fail(`Unterminated basic string`);
            if (ch === '\\') {
                out += this.parseEscape(false);
            } else {
                out += ch;
            }
        }
        this.fail(`Unterminated basic string`);
    }

    private parseMultilineBasicString(): string {
        this.expect('"');
        this.expect('"');
        this.expect('"');
        // A newline immediately after the opening delimiter is trimmed.
        if (this.peek() === '\n') this.advance();
        else if (this.peek() === '\r' && this.peek(1) === '\n') {
            this.advance();
            this.advance();
        }
        let out = '';
        while (!this.eof()) {
            // End delimiter: look for """ that is not followed by another
            // immediate quote (TOML allows up to two trailing quotes inside
            // the string body, e.g. `"""foo""""""` -> "foo\"\"" -no wait,
            // closing is at most two quotes before """).
            if (
                this.peek() === '"' &&
                this.peek(1) === '"' &&
                this.peek(2) === '"'
            ) {
                this.advance();
                this.advance();
                this.advance();
                // Allow up to two extra quotes after closing delim.
                if (this.peek() === '"') {
                    out += '"';
                    this.advance();
                    if (this.peek() === '"') {
                        out += '"';
                        this.advance();
                    }
                }
                return out;
            }
            const ch = this.advance();
            if (ch === '\\') {
                // Line-ending backslash trims the following whitespace.
                if (this.peek() === '\n' || this.peek() === '\r' || this.peek() === ' ' || this.peek() === '\t') {
                    // Look ahead — if this whitespace run includes a newline
                    // then we are in "line ending backslash" mode.
                    let j = this.pos;
                    let sawNewline = false;
                    while (j < this.text.length) {
                        const c = this.text[j];
                        if (c === ' ' || c === '\t') {
                            j++;
                            continue;
                        }
                        if (c === '\n' || c === '\r') {
                            sawNewline = true;
                            break;
                        }
                        break;
                    }
                    if (sawNewline) {
                        // Skip all whitespace + newlines.
                        while (this.pos < this.text.length) {
                            const c = this.text[this.pos];
                            if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
                                this.advance();
                            } else {
                                break;
                            }
                        }
                        continue;
                    }
                }
                out += this.parseEscape(true);
            } else {
                out += ch;
            }
        }
        this.fail(`Unterminated multi-line basic string`);
    }

    private parseLiteralString(quotedKey: boolean): string {
        this.expect('\'');
        const start = this.pos;
        while (!this.eof()) {
            const ch = this.peek();
            if (ch === '\'') {
                const out = this.text.slice(start, this.pos);
                this.advance();
                return out;
            }
            if (ch === '\n') this.fail(`Unterminated literal string`);
            this.advance();
        }
        this.fail(`Unterminated literal string`);
    }

    private parseMultilineLiteralString(): string {
        this.expect('\'');
        this.expect('\'');
        this.expect('\'');
        if (this.peek() === '\n') this.advance();
        else if (this.peek() === '\r' && this.peek(1) === '\n') {
            this.advance();
            this.advance();
        }
        let out = '';
        while (!this.eof()) {
            if (
                this.peek() === '\'' &&
                this.peek(1) === '\'' &&
                this.peek(2) === '\''
            ) {
                this.advance();
                this.advance();
                this.advance();
                if (this.peek() === '\'') {
                    out += '\'';
                    this.advance();
                    if (this.peek() === '\'') {
                        out += '\'';
                        this.advance();
                    }
                }
                return out;
            }
            out += this.advance();
        }
        this.fail(`Unterminated multi-line literal string`);
    }

    private parseEscape(allowLineEndingBackslash: boolean): string {
        const ch = this.advance();
        switch (ch) {
            case 'b': return '\b';
            case 't': return '\t';
            case 'n': return '\n';
            case 'f': return '\f';
            case 'r': return '\r';
            case '"': return '"';
            case '\\': return '\\';
            case 'u': return this.parseUnicodeEscape(4);
            case 'U': return this.parseUnicodeEscape(8);
            default:
                this.fail(`Invalid escape sequence \\${ch}`);
        }
    }

    private parseUnicodeEscape(width: number): string {
        let code = 0;
        for (let i = 0; i < width; i++) {
            const ch = this.advance();
            const v = hexValue(ch);
            if (v < 0) this.fail(`Invalid unicode escape`);
            code = code * 16 + v;
        }
        return String.fromCodePoint(code);
    }

    // ----- Booleans / numbers / dates --------------------------------------

    private parseBooleanLike(): { value: boolean; valueType: TomlValueType } {
        if (this.text.startsWith('true', this.pos)) {
            this.advanceN(4);
            return { value: true, valueType: 'boolean' };
        }
        if (this.text.startsWith('false', this.pos)) {
            this.advanceN(5);
            return { value: false, valueType: 'boolean' };
        }
        this.fail(`Expected boolean`);
    }

    private parseNumberOrDate(): { value: unknown; valueType: TomlValueType } {
        // Date-like prefix detection: 4 digits + '-' suggests a date.
        // Time-like: 2 digits + ':' suggests a local time.
        if (this.looksLikeDate()) {
            return this.parseDateTime();
        }
        if (this.looksLikeTime()) {
            return this.parseTime();
        }
        return this.parseNumber();
    }

    private looksLikeDate(): boolean {
        return (
            isDigit(this.peek(0)) &&
            isDigit(this.peek(1)) &&
            isDigit(this.peek(2)) &&
            isDigit(this.peek(3)) &&
            this.peek(4) === '-' &&
            isDigit(this.peek(5))
        );
    }

    private looksLikeTime(): boolean {
        return (
            isDigit(this.peek(0)) &&
            isDigit(this.peek(1)) &&
            this.peek(2) === ':' &&
            isDigit(this.peek(3))
        );
    }

    private parseDateTime(): { value: string; valueType: TomlValueType } {
        const start = this.pos;
        // YYYY-MM-DD
        for (let i = 0; i < 4; i++) this.advance();
        this.expect('-');
        for (let i = 0; i < 2; i++) this.advance();
        this.expect('-');
        for (let i = 0; i < 2; i++) this.advance();

        // Optionally followed by 'T' or ' ' + time.
        const sep = this.peek();
        if (sep === 'T' || sep === 't' || sep === ' ') {
            // Disambiguate `1979-05-27 ` (trailing space terminates) from
            // `1979-05-27 07:32:00`.
            if (sep === ' ' && !isDigit(this.peek(1))) {
                return {
                    value: this.text.slice(start, this.pos),
                    valueType: 'date-local'
                };
            }
            this.advance();
            // HH:MM:SS
            this.parseTimeBody();
            // Optional fractional seconds.
            if (this.peek() === '.') {
                this.advance();
                while (isDigit(this.peek())) this.advance();
            }
            // Optional timezone: Z | +HH:MM | -HH:MM
            const tz = this.peek();
            if (tz === 'Z' || tz === 'z') {
                this.advance();
                return {
                    value: this.text.slice(start, this.pos),
                    valueType: 'datetime-offset'
                };
            }
            if (tz === '+' || tz === '-') {
                this.advance();
                for (let i = 0; i < 2; i++) this.advance();
                this.expect(':');
                for (let i = 0; i < 2; i++) this.advance();
                return {
                    value: this.text.slice(start, this.pos),
                    valueType: 'datetime-offset'
                };
            }
            return {
                value: this.text.slice(start, this.pos),
                valueType: 'datetime-local'
            };
        }
        return {
            value: this.text.slice(start, this.pos),
            valueType: 'date-local'
        };
    }

    private parseTime(): { value: string; valueType: TomlValueType } {
        const start = this.pos;
        this.parseTimeBody();
        if (this.peek() === '.') {
            this.advance();
            while (isDigit(this.peek())) this.advance();
        }
        return {
            value: this.text.slice(start, this.pos),
            valueType: 'time-local'
        };
    }

    private parseTimeBody(): void {
        for (let i = 0; i < 2; i++) {
            if (!isDigit(this.peek())) this.fail(`Expected hour digit`);
            this.advance();
        }
        this.expect(':');
        for (let i = 0; i < 2; i++) {
            if (!isDigit(this.peek())) this.fail(`Expected minute digit`);
            this.advance();
        }
        this.expect(':');
        for (let i = 0; i < 2; i++) {
            if (!isDigit(this.peek())) this.fail(`Expected second digit`);
            this.advance();
        }
    }

    private parseNumber(): { value: number; valueType: TomlValueType } {
        const start = this.pos;
        let sign = 1;
        if (this.peek() === '+') this.advance();
        else if (this.peek() === '-') {
            sign = -1;
            this.advance();
        }

        // Special floats.
        if (this.text.startsWith('inf', this.pos)) {
            this.advanceN(3);
            return {
                value: sign === -1 ? -Infinity : Infinity,
                valueType: 'float'
            };
        }
        if (this.text.startsWith('nan', this.pos)) {
            this.advanceN(3);
            return { value: NaN, valueType: 'float' };
        }

        // Hex/Oct/Bin only allowed without sign.
        if (this.peek() === '0') {
            const next = this.peek(1);
            if (next === 'x' || next === 'o' || next === 'b') {
                if (sign === -1) {
                    this.fail(`Invalid sign on prefixed integer`);
                }
                this.advance();
                this.advance();
                const baseStart = this.pos;
                const validator =
                    next === 'x'
                        ? isHex
                        : next === 'o'
                            ? isOct
                            : isBin;
                let raw = '';
                while (!this.eof()) {
                    const ch = this.peek();
                    if (ch === '_') {
                        if (raw.length === 0 || !validator(this.peek(1))) {
                            this.fail(`Invalid underscore in number`);
                        }
                        this.advance();
                        continue;
                    }
                    if (validator(ch)) {
                        raw += ch;
                        this.advance();
                    } else {
                        break;
                    }
                }
                if (raw.length === 0) {
                    this.fail(`Empty prefixed integer`);
                }
                const radix = next === 'x' ? 16 : next === 'o' ? 8 : 2;
                return { value: parseInt(raw, radix), valueType: 'integer' };
            }
        }

        // Decimal integer or float.
        let raw = '';
        let isFloat = false;
        // Integer part — no leading zeros (except "0" itself).
        const intStart = this.pos;
        if (!isDigit(this.peek())) {
            this.fail(`Expected digit`);
        }
        while (!this.eof()) {
            const ch = this.peek();
            if (ch === '_') {
                if (raw.length === 0 || !isDigit(this.peek(1))) {
                    this.fail(`Invalid underscore in number`);
                }
                this.advance();
                continue;
            }
            if (isDigit(ch)) {
                raw += ch;
                this.advance();
            } else {
                break;
            }
        }
        if (raw.length > 1 && raw[0] === '0') {
            this.failAt({
                line: this.line,
                column: Math.max(1, this.col - raw.length)
            }, `Leading zeros not allowed`);
        }

        // Optional fractional.
        if (this.peek() === '.') {
            isFloat = true;
            raw += '.';
            this.advance();
            if (!isDigit(this.peek())) {
                this.fail(`Expected fractional digit`);
            }
            while (!this.eof()) {
                const ch = this.peek();
                if (ch === '_') {
                    if (!isDigit(this.peek(1))) this.fail(`Invalid underscore`);
                    this.advance();
                    continue;
                }
                if (isDigit(ch)) {
                    raw += ch;
                    this.advance();
                } else {
                    break;
                }
            }
        }

        // Optional exponent.
        if (this.peek() === 'e' || this.peek() === 'E') {
            isFloat = true;
            raw += 'e';
            this.advance();
            if (this.peek() === '+' || this.peek() === '-') {
                raw += this.peek();
                this.advance();
            }
            if (!isDigit(this.peek())) this.fail(`Expected exponent digit`);
            while (!this.eof()) {
                const ch = this.peek();
                if (ch === '_') {
                    if (!isDigit(this.peek(1))) this.fail(`Invalid underscore`);
                    this.advance();
                    continue;
                }
                if (isDigit(ch)) {
                    raw += ch;
                    this.advance();
                } else {
                    break;
                }
            }
        }

        const numeric = isFloat ? parseFloat(raw) : Number(raw);
        return {
            value: sign === -1 ? -numeric : numeric,
            valueType: isFloat ? 'float' : 'integer'
        };
    }

    // ----- Arrays ----------------------------------------------------------

    private parseArray(): unknown[] {
        this.expect('[');
        const out: unknown[] = [];
        // Arrays can span lines and tolerate comments + commas.
        while (!this.eof()) {
            this.skipArrayWhitespace();
            if (this.peek() === ']') {
                this.advance();
                return out;
            }
            const { value } = this.parseValue();
            out.push(value);
            this.skipArrayWhitespace();
            if (this.peek() === ',') {
                this.advance();
                continue;
            }
            this.skipArrayWhitespace();
            if (this.peek() === ']') {
                this.advance();
                return out;
            }
            this.fail(`Expected ',' or ']' in array`);
        }
        this.fail(`Unterminated array`);
    }

    private skipArrayWhitespace(): void {
        while (!this.eof()) {
            const ch = this.peek();
            if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
                this.advance();
                continue;
            }
            if (ch === '#') {
                this.skipComment();
                continue;
            }
            break;
        }
    }

    // ----- Inline tables ---------------------------------------------------

    private parseInlineTable(): Record<string, unknown> {
        this.expect('{');
        this.skipInlineWhitespace();
        const out: Record<string, unknown> = {};
        if (this.peek() === '}') {
            this.advance();
            return out;
        }
        while (!this.eof()) {
            this.skipInlineWhitespace();
            const keys = this.parseKeyPath();
            this.skipInlineWhitespace();
            this.expect('=');
            this.skipInlineWhitespace();
            const { value } = this.parseValue();
            // Walk dotted-key path inside the inline table.
            let cursor = out;
            for (let i = 0; i < keys.length - 1; i++) {
                const k = keys[i];
                let next = cursor[k];
                if (next === undefined) {
                    next = {};
                    cursor[k] = next;
                } else if (typeof next !== 'object' || next === null || Array.isArray(next)) {
                    this.fail(`Cannot extend non-table key ${k}`);
                }
                cursor = next as Record<string, unknown>;
            }
            const lastKey = keys[keys.length - 1];
            if (lastKey in cursor) this.fail(`Duplicate key '${lastKey}' in inline table`);
            cursor[lastKey] = value;
            this.skipInlineWhitespace();
            if (this.peek() === ',') {
                this.advance();
                this.skipInlineWhitespace();
                continue;
            }
            if (this.peek() === '}') {
                this.advance();
                return out;
            }
            this.fail(`Expected ',' or '}' in inline table`);
        }
        this.fail(`Unterminated inline table`);
    }

    // -----------------------------------------------------------------------
    // Whitespace / comments
    // -----------------------------------------------------------------------

    private skipWhitespaceAndComments(): void {
        while (!this.eof()) {
            const ch = this.peek();
            if (ch === ' ' || ch === '\t') {
                this.advance();
                continue;
            }
            if (ch === '#') {
                this.skipComment();
                continue;
            }
            if (ch === '\n' || ch === '\r') {
                return;
            }
            break;
        }
    }

    private skipInlineWhitespace(): void {
        while (!this.eof()) {
            const ch = this.peek();
            if (ch === ' ' || ch === '\t') {
                this.advance();
            } else {
                break;
            }
        }
    }

    private skipComment(): void {
        // Already at '#'.
        while (!this.eof()) {
            const ch = this.peek();
            if (ch === '\n' || ch === '\r') return;
            this.advance();
        }
    }

    private consumeNewline(): void {
        const ch = this.peek();
        if (ch === '\r' && this.peek(1) === '\n') {
            this.advance();
            this.advance();
        } else if (ch === '\n' || ch === '\r') {
            this.advance();
        }
    }

    private atLineEnd(): boolean {
        const ch = this.peek();
        return ch === '\n' || ch === '\r';
    }

    // -----------------------------------------------------------------------
    // Cursor
    // -----------------------------------------------------------------------

    private eof(): boolean {
        return this.pos >= this.text.length;
    }

    private peek(offset = 0): string | undefined {
        return this.text[this.pos + offset];
    }

    private advance(): string {
        const ch = this.text[this.pos];
        this.pos++;
        if (ch === '\n') {
            this.line++;
            this.col = 1;
        } else if (ch === '\r') {
            // Treat CR alone as line break for column accounting.
            if (this.text[this.pos] !== '\n') {
                this.line++;
                this.col = 1;
            }
        } else {
            this.col++;
        }
        return ch;
    }

    private advanceN(n: number): void {
        for (let i = 0; i < n; i++) this.advance();
    }

    private expect(ch: string): void {
        if (this.peek() !== ch) {
            this.fail(`Expected '${ch}'`);
        }
        this.advance();
    }

    private posSnapshot(): TomlPosition {
        return { line: this.line, column: this.col };
    }

    private fail(msg: string): never {
        throw new TomlParseError(msg, this.line, this.col);
    }

    private failAt(pos: TomlPosition, msg: string): never {
        throw new TomlParseError(msg, pos.line, pos.column);
    }
}

// ===========================================================================
// Helpers
// ===========================================================================

function isDigit(ch: string | undefined): boolean {
    return ch !== undefined && ch >= '0' && ch <= '9';
}

function isHex(ch: string | undefined): boolean {
    return (
        isDigit(ch) ||
        (ch !== undefined &&
            ((ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')))
    );
}

function isOct(ch: string | undefined): boolean {
    return ch !== undefined && ch >= '0' && ch <= '7';
}

function isBin(ch: string | undefined): boolean {
    return ch === '0' || ch === '1';
}

function hexValue(ch: string): number {
    if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
    if (ch >= 'a' && ch <= 'f') return ch.charCodeAt(0) - 87;
    if (ch >= 'A' && ch <= 'F') return ch.charCodeAt(0) - 55;
    return -1;
}

/**
 * After parsing an inline table into a JS object, also build the
 * tree-friendly `children` array on the node so the AST view can render
 * sub-keys without re-traversing the data.
 */
function populateInlineTableChildren(
    leaf: InternalNode,
    obj: Record<string, unknown>,
    pos?: TomlPosition
): void {
    leaf.children = leaf.children ?? new Map();
    for (const [k, v] of Object.entries(obj)) {
        const child = inferChildNode(k, v, pos);
        leaf.children.set(k, child);
    }
}

function inferChildNode(
    key: string,
    value: unknown,
    pos?: TomlPosition
): InternalNode {
    if (Array.isArray(value)) {
        const n = createNode(key, 'array');
        n.value = value;
        n.valueType = 'array';
        n.position = pos;
        return n;
    }
    if (value !== null && typeof value === 'object') {
        const n = createNode(key, 'inline-table');
        n.value = value;
        n.valueType = 'inline-table';
        n.position = pos;
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            n.children.set(k, inferChildNode(k, v, pos));
        }
        return n;
    }
    const leaf = createNode(key, 'scalar');
    leaf.value = value;
    leaf.valueType = inferScalarType(value);
    leaf.position = pos;
    return leaf;
}

function inferScalarType(value: unknown): TomlValueType {
    if (typeof value === 'string') return 'string';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') {
        return Number.isInteger(value) && Number.isFinite(value)
            ? 'integer'
            : 'float';
    }
    return 'string';
}
