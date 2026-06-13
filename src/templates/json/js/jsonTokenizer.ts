// Pure JSON tokenizer (issue #63).
//
// Scans an arbitrary JSON document text into a flat list of tokens
// suitable for syntax highlighting. The tokenizer is intentionally
// DOM-free and never throws — malformed input falls through to a
// trailing `unknown` token so the caller can render whatever rest
// of the document parsed cleanly without crashing the viewer.
//
// Design notes:
//   - Single-pass cursor over the input string. NO regex with
//     backtracking; we walk character-by-character and only ever
//     consume forward, which keeps the worst case linear in the
//     length of the input.
//   - The "key vs. string" distinction is handled with a tiny
//     lookahead: after emitting a string token, we peek past any
//     whitespace; if the next non-whitespace character is `:`, we
//     retroactively re-tag the just-pushed token as `'key'`. This
//     keeps the single-pass invariant intact.
//   - Whitespace is preserved verbatim as `'whitespace'` tokens so
//     callers can faithfully reconstruct the input by joining
//     `tokens.map(t => t.text)`.
//   - This module is shared with the JSONL viewer (#61). It must
//     not import anything from the JSON viewer's DOM layer.

/**
 * Token kinds emitted by `tokenizeJson`. The `unknown` kind is the
 * tokenizer's safety net: any byte sequence the scanner cannot
 * classify (e.g. malformed input, trailing garbage, an unterminated
 * string literal) is emitted as a single trailing `unknown` token
 * so callers can still render the prefix that scanned cleanly.
 */
export type JsonTokenKind =
    | 'key'
    | 'string'
    | 'number'
    | 'bool'
    | 'null'
    | 'punct'
    | 'whitespace'
    | 'unknown';

export interface JsonToken {
    kind: JsonTokenKind;
    text: string;
}

/**
 * Tokenize a JSON document. Always returns; never throws. The sum
 * of `token.text` is guaranteed to equal the input string, so the
 * caller can re-render the original text by concatenating the
 * `text` fields in order.
 */
export function tokenizeJson(input: string): JsonToken[] {
    const tokens: JsonToken[] = [];
    if (typeof input !== 'string' || input.length === 0) {
        return tokens;
    }

    const len = input.length;
    let i = 0;

    while (i < len) {
        const ch = input.charCodeAt(i);

        // Whitespace run.
        if (isWhitespace(ch)) {
            const start = i;
            i++;
            while (i < len && isWhitespace(input.charCodeAt(i))) i++;
            tokens.push({ kind: 'whitespace', text: input.slice(start, i) });
            continue;
        }

        // Punctuation: { } [ ] , :
        if (
            ch === 0x7b /* { */ ||
            ch === 0x7d /* } */ ||
            ch === 0x5b /* [ */ ||
            ch === 0x5d /* ] */ ||
            ch === 0x2c /* , */ ||
            ch === 0x3a /* : */
        ) {
            tokens.push({ kind: 'punct', text: input[i] });
            i++;
            continue;
        }

        // String / key.
        if (ch === 0x22 /* " */) {
            const consumed = scanString(input, i);
            const text = input.slice(i, i + consumed.length);
            i += consumed.length;
            if (consumed.terminated) {
                // Lookahead past whitespace to decide key vs. string.
                let j = i;
                while (j < len && isWhitespace(input.charCodeAt(j))) j++;
                const isKey = j < len && input.charCodeAt(j) === 0x3a; /* : */
                tokens.push({ kind: isKey ? 'key' : 'string', text });
            } else {
                // Unterminated string — emit as unknown so the caller
                // doesn't lose the rest of the document.
                tokens.push({ kind: 'unknown', text });
            }
            continue;
        }

        // Literal: true / false / null.
        if (ch === 0x74 /* t */ && input.startsWith('true', i)) {
            tokens.push({ kind: 'bool', text: 'true' });
            i += 4;
            continue;
        }
        if (ch === 0x66 /* f */ && input.startsWith('false', i)) {
            tokens.push({ kind: 'bool', text: 'false' });
            i += 5;
            continue;
        }
        if (ch === 0x6e /* n */ && input.startsWith('null', i)) {
            tokens.push({ kind: 'null', text: 'null' });
            i += 4;
            continue;
        }

        // Number: optional `-`, integer part, optional fraction, optional exponent.
        if (ch === 0x2d /* - */ || isDigit(ch)) {
            const consumed = scanNumber(input, i);
            if (consumed > 0) {
                tokens.push({ kind: 'number', text: input.slice(i, i + consumed) });
                i += consumed;
                continue;
            }
        }

        // Anything else: collect a contiguous run of unrecognised
        // characters into a single `unknown` token. We stop at the
        // next character that COULD start a real token so the rest
        // of the document still tokenizes correctly.
        const start = i;
        i++;
        while (i < len && !canStartToken(input.charCodeAt(i))) i++;
        tokens.push({ kind: 'unknown', text: input.slice(start, i) });
    }

    return tokens;
}

// ---------------------------------------------------------------------------
// Scanning helpers.
// ---------------------------------------------------------------------------

interface StringScan {
    /** Number of characters consumed (including both quotes when terminated). */
    length: number;
    /** True iff the closing `"` was found before EOF. */
    terminated: boolean;
}

/**
 * Scan a JSON string literal starting at `start` (which MUST point at
 * the opening `"`). Returns the number of characters consumed and
 * whether the literal was terminated. Honours `\\` escaping so an
 * escaped quote does not end the string.
 */
function scanString(input: string, start: number): StringScan {
    const len = input.length;
    let i = start + 1; // skip opening quote
    while (i < len) {
        const c = input.charCodeAt(i);
        if (c === 0x5c /* \ */) {
            // Skip escape character + the escaped char (if present).
            i += 2;
            continue;
        }
        if (c === 0x22 /* " */) {
            return { length: i - start + 1, terminated: true };
        }
        i++;
    }
    return { length: len - start, terminated: false };
}

/**
 * Scan a JSON number starting at `start`. Returns the number of
 * characters that form a valid number literal, or 0 if the input
 * does not begin with one. Accepts integers, decimals, scientific
 * notation, and a leading minus sign per RFC 8259.
 */
function scanNumber(input: string, start: number): number {
    const len = input.length;
    let i = start;

    // Optional leading minus.
    if (i < len && input.charCodeAt(i) === 0x2d /* - */) i++;

    // Integer part: 0 OR [1-9][0-9]*
    if (i >= len) return 0;
    const c = input.charCodeAt(i);
    if (c === 0x30 /* 0 */) {
        i++;
    } else if (c >= 0x31 /* 1 */ && c <= 0x39 /* 9 */) {
        i++;
        while (i < len && isDigit(input.charCodeAt(i))) i++;
    } else {
        return 0; // not a number after the optional minus
    }

    // Fraction part.
    if (i < len && input.charCodeAt(i) === 0x2e /* . */) {
        i++;
        const fracStart = i;
        while (i < len && isDigit(input.charCodeAt(i))) i++;
        if (i === fracStart) return 0; // dot with no digits → reject
    }

    // Exponent part.
    if (i < len) {
        const e = input.charCodeAt(i);
        if (e === 0x65 /* e */ || e === 0x45 /* E */) {
            i++;
            if (i < len) {
                const sign = input.charCodeAt(i);
                if (sign === 0x2b /* + */ || sign === 0x2d /* - */) i++;
            }
            const expStart = i;
            while (i < len && isDigit(input.charCodeAt(i))) i++;
            if (i === expStart) return 0; // exponent marker with no digits
        }
    }

    return i - start;
}

function isWhitespace(ch: number): boolean {
    // JSON whitespace: space, tab, LF, CR. We additionally accept FF
    // and VT so editors that paste odd line endings still tokenize
    // cleanly — they all collapse into the same `whitespace` token.
    return (
        ch === 0x20 ||
        ch === 0x09 ||
        ch === 0x0a ||
        ch === 0x0d ||
        ch === 0x0b ||
        ch === 0x0c
    );
}

function isDigit(ch: number): boolean {
    return ch >= 0x30 && ch <= 0x39;
}

/**
 * Returns true if `ch` could legitimately begin a real JSON token.
 * Used by the unknown-run scanner to decide where to stop merging
 * unrecognised characters so we don't accidentally swallow valid
 * tokens that follow malformed input.
 */
function canStartToken(ch: number): boolean {
    if (isWhitespace(ch)) return true;
    if (isDigit(ch)) return true;
    if (
        ch === 0x7b || // {
        ch === 0x7d || // }
        ch === 0x5b || // [
        ch === 0x5d || // ]
        ch === 0x2c || // ,
        ch === 0x3a || // :
        ch === 0x22 || // "
        ch === 0x2d || // -
        ch === 0x74 || // t
        ch === 0x66 || // f
        ch === 0x6e //   n
    ) {
        return true;
    }
    return false;
}
