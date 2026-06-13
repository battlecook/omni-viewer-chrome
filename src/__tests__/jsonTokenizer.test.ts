// Tests for the pure JSON tokenizer (issue #63).
//
// The tokenizer is shared with the JSONL viewer (#61), so these tests
// verify the data-only contract — there is NO DOM here. We cover:
//
//   - Every emitted kind: key / string / number / bool / null / punct
//     / whitespace / unknown.
//   - "Key" is only used when a string is immediately followed (after
//     optional whitespace) by `:`. All other strings are `string`.
//   - Number scanner accepts integers, decimals, scientific notation,
//     leading minus.
//   - Strings honour `\\` escaping so an escaped quote does not end
//     the string.
//   - Nested arrays / objects retain proper key tagging.
//   - Leading / trailing whitespace is preserved as `whitespace`.
//   - Concatenating `tokens.map(t => t.text)` MUST reconstruct the
//     input verbatim — this is the contract callers depend on.
//   - Malformed input never throws and produces an `unknown` token.

import { tokenizeJson, JsonToken } from '../templates/json/js/jsonTokenizer';

function kinds(tokens: JsonToken[]): string[] {
    return tokens.map((t) => t.kind);
}

function texts(tokens: JsonToken[]): string[] {
    return tokens.map((t) => t.text);
}

function reconstruct(tokens: JsonToken[]): string {
    return tokens.map((t) => t.text).join('');
}

describe('tokenizeJson — basic kinds', () => {
    it('returns an empty list for an empty string', () => {
        expect(tokenizeJson('')).toEqual([]);
    });

    it('tokenizes a single number', () => {
        const tokens = tokenizeJson('42');
        expect(kinds(tokens)).toEqual(['number']);
        expect(tokens[0].text).toBe('42');
    });

    it('tokenizes a single string', () => {
        const tokens = tokenizeJson('"hello"');
        expect(kinds(tokens)).toEqual(['string']);
        expect(tokens[0].text).toBe('"hello"');
    });

    it('tokenizes booleans and null', () => {
        expect(kinds(tokenizeJson('true'))).toEqual(['bool']);
        expect(kinds(tokenizeJson('false'))).toEqual(['bool']);
        expect(kinds(tokenizeJson('null'))).toEqual(['null']);
    });

    it('tokenizes punctuation as one token per character', () => {
        const tokens = tokenizeJson('{}[],:');
        expect(kinds(tokens)).toEqual([
            'punct',
            'punct',
            'punct',
            'punct',
            'punct',
            'punct'
        ]);
        expect(texts(tokens)).toEqual(['{', '}', '[', ']', ',', ':']);
    });
});

describe('tokenizeJson — key vs. string', () => {
    it('classifies a string followed by `:` as a key', () => {
        const tokens = tokenizeJson('"name":"alice"');
        expect(kinds(tokens)).toEqual(['key', 'punct', 'string']);
        expect(tokens[0].text).toBe('"name"');
        expect(tokens[2].text).toBe('"alice"');
    });

    it('treats whitespace between string and `:` as still being a key', () => {
        const tokens = tokenizeJson('"name"  : 1');
        // "name" / spaces / : / space / 1
        expect(kinds(tokens)).toEqual([
            'key',
            'whitespace',
            'punct',
            'whitespace',
            'number'
        ]);
    });

    it('classifies array string elements as `string`, not `key`', () => {
        const tokens = tokenizeJson('["a","b"]');
        expect(kinds(tokens)).toEqual([
            'punct',
            'string',
            'punct',
            'string',
            'punct'
        ]);
    });

    it('handles nested objects with proper key tagging', () => {
        const tokens = tokenizeJson('{"a":{"b":1}}');
        expect(kinds(tokens)).toEqual([
            'punct',
            'key',
            'punct',
            'punct',
            'key',
            'punct',
            'number',
            'punct',
            'punct'
        ]);
    });
});

describe('tokenizeJson — strings with escapes', () => {
    it('keeps escaped double quotes inside the string token', () => {
        const tokens = tokenizeJson('"a\\"b"');
        expect(kinds(tokens)).toEqual(['string']);
        expect(tokens[0].text).toBe('"a\\"b"');
    });

    it('handles escaped backslashes followed by a real quote', () => {
        // "\\" — the backslash is escaped, then the closing quote ends the string.
        const tokens = tokenizeJson('"\\\\"');
        expect(kinds(tokens)).toEqual(['string']);
        expect(tokens[0].text).toBe('"\\\\"');
    });

    it('handles \\u escape sequences', () => {
        const tokens = tokenizeJson('"\\u00e9"');
        expect(kinds(tokens)).toEqual(['string']);
        expect(tokens[0].text).toBe('"\\u00e9"');
    });
});

describe('tokenizeJson — numbers', () => {
    it('parses negative numbers', () => {
        const tokens = tokenizeJson('-7');
        expect(kinds(tokens)).toEqual(['number']);
        expect(tokens[0].text).toBe('-7');
    });

    it('parses decimals', () => {
        const tokens = tokenizeJson('3.14');
        expect(kinds(tokens)).toEqual(['number']);
        expect(tokens[0].text).toBe('3.14');
    });

    it('parses scientific notation (lowercase e)', () => {
        const tokens = tokenizeJson('1.5e10');
        expect(kinds(tokens)).toEqual(['number']);
        expect(tokens[0].text).toBe('1.5e10');
    });

    it('parses scientific notation with explicit sign and uppercase E', () => {
        const tokens = tokenizeJson('-2.5E-3');
        expect(kinds(tokens)).toEqual(['number']);
        expect(tokens[0].text).toBe('-2.5E-3');
    });

    it('does not fold a number into a string colour', () => {
        const tokens = tokenizeJson('{"n":42}');
        const numberToken = tokens.find((t) => t.text === '42');
        expect(numberToken?.kind).toBe('number');
    });
});

describe('tokenizeJson — whitespace', () => {
    it('preserves leading whitespace as a whitespace token', () => {
        const tokens = tokenizeJson('   42');
        expect(kinds(tokens)).toEqual(['whitespace', 'number']);
        expect(tokens[0].text).toBe('   ');
    });

    it('preserves trailing newline as whitespace', () => {
        const tokens = tokenizeJson('42\n');
        expect(kinds(tokens)).toEqual(['number', 'whitespace']);
        expect(tokens[1].text).toBe('\n');
    });

    it('collapses mixed whitespace runs into one token', () => {
        const tokens = tokenizeJson('\t \n\r 1');
        expect(kinds(tokens)).toEqual(['whitespace', 'number']);
        expect(tokens[0].text).toBe('\t \n\r ');
    });
});

describe('tokenizeJson — composite documents', () => {
    it('round-trips a complex document by concatenation', () => {
        const input =
            '{\n  "a": [1, "two", true, null],\n  "b": {"nested": -3.14e2}\n}\n';
        const tokens = tokenizeJson(input);
        expect(reconstruct(tokens)).toBe(input);
    });

    it('emits the expected kind sequence for a nested array', () => {
        const tokens = tokenizeJson('[1,[2,[3]]]');
        expect(kinds(tokens)).toEqual([
            'punct',
            'number',
            'punct',
            'punct',
            'number',
            'punct',
            'punct',
            'number',
            'punct',
            'punct',
            'punct'
        ]);
    });

    it('keys after nested arrays still detect correctly', () => {
        const tokens = tokenizeJson('{"a":[1],"b":2}');
        const keyTokens = tokens.filter((t) => t.kind === 'key');
        expect(keyTokens.map((t) => t.text)).toEqual(['"a"', '"b"']);
    });
});

describe('tokenizeJson — malformed input', () => {
    it('does not throw on garbage input', () => {
        expect(() => tokenizeJson('@@@')).not.toThrow();
        const tokens = tokenizeJson('@@@');
        expect(tokens.length).toBeGreaterThan(0);
        expect(tokens[tokens.length - 1].kind).toBe('unknown');
    });

    it('emits an unknown token for an unterminated string', () => {
        const tokens = tokenizeJson('"oops');
        expect(tokens).toHaveLength(1);
        expect(tokens[0].kind).toBe('unknown');
        expect(tokens[0].text).toBe('"oops');
    });

    it('keeps tokenizing valid tail after an unknown run', () => {
        const tokens = tokenizeJson('@@@ 42');
        // The leading `@@@` is unknown, the space is whitespace, then
        // we recover and emit the number cleanly.
        const reconstructed = reconstruct(tokens);
        expect(reconstructed).toBe('@@@ 42');
        const numberToken = tokens.find((t) => t.text === '42');
        expect(numberToken?.kind).toBe('number');
    });

    it('rejects stray dot as not-a-number and emits unknown', () => {
        // `.` alone is not a valid number per RFC 8259. The tokenizer
        // must not crash and must not classify it as `number`.
        const tokens = tokenizeJson('.');
        expect(() => tokenizeJson('.')).not.toThrow();
        expect(tokens.every((t) => t.kind !== 'number')).toBe(true);
    });

    it('reconstructs the input verbatim even with malformed tail', () => {
        const input = '{"a": "unterminated';
        const tokens = tokenizeJson(input);
        expect(reconstruct(tokens)).toBe(input);
    });
});

describe('tokenizeJson — non-string input safety', () => {
    it('returns an empty array if input is not a string', () => {
        // Defensive: tokenizer must not crash even if a caller hands
        // it a non-string by mistake (e.g. forgot `await file.text()`).
        expect(tokenizeJson(undefined as unknown as string)).toEqual([]);
        expect(tokenizeJson(null as unknown as string)).toEqual([]);
    });
});
