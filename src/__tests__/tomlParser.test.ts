// Unit tests for the browser-side TOML parser (issue #65).
//
// Coverage strategy:
//   - Spec-by-spec smoke tests for every value type TOML 1.0 supports
//     (strings, ints, floats, booleans, dates, arrays, tables, AOT, inline).
//   - Real-world fixtures: cargo.toml-shape and pyproject.toml-shape.
//   - Negative tests for the obvious malformed cases (duplicates, bad
//     escapes, unterminated strings, leading zeros, dotted-key collisions).
//
// We assert both the data view (`parseToml`) and, for a representative
// selection, the AST view (`parseTomlAst`).

import {
    parseToml,
    parseTomlAst,
    TomlParseError
} from '../utils/tomlParser';

describe('parseToml — bare key/value', () => {
    it('parses an empty document', () => {
        expect(parseToml('')).toEqual({});
    });

    it('parses a simple key = value', () => {
        expect(parseToml('key = "value"')).toEqual({ key: 'value' });
    });

    it('strips a UTF-8 BOM', () => {
        const bom = '﻿';
        expect(parseToml(`${bom}key = 1`)).toEqual({ key: 1 });
    });

    it('ignores comments and blank lines', () => {
        const input = `
# top comment
key1 = 1

  # indented comment
key2 = 2  # trailing comment
`;
        expect(parseToml(input)).toEqual({ key1: 1, key2: 2 });
    });

    it('rejects unknown content after a value', () => {
        expect(() => parseToml('key = 1 stray')).toThrow(TomlParseError);
    });

    it('rejects a missing equals sign', () => {
        expect(() => parseToml('key 1')).toThrow(TomlParseError);
    });
});

describe('parseToml — keys', () => {
    it('parses bare keys with letters, digits, underscores, dashes', () => {
        const input = `key_1 = 1\nkey-2 = 2\nKEY3 = 3`;
        expect(parseToml(input)).toEqual({ key_1: 1, 'key-2': 2, KEY3: 3 });
    });

    it('parses quoted keys', () => {
        const input = `"127.0.0.1" = "value"\n'literal key' = "lv"`;
        expect(parseToml(input)).toEqual({
            '127.0.0.1': 'value',
            'literal key': 'lv'
        });
    });

    it('parses dotted keys into nested tables', () => {
        const input = `physical.color = "orange"\nphysical.shape = "round"`;
        expect(parseToml(input)).toEqual({
            physical: { color: 'orange', shape: 'round' }
        });
    });

    it('rejects duplicate top-level keys', () => {
        expect(() => parseToml(`a = 1\na = 2`)).toThrow(TomlParseError);
    });

    it('rejects redefining a dotted-key prefix', () => {
        // `apple.type = "fruit"` creates `apple` as an implicit table; the
        // following `apple.smooth = true` is fine, but a *bare* `apple = ...`
        // collides.
        expect(() =>
            parseToml(`apple.type = "fruit"\napple = "x"`)
        ).toThrow(TomlParseError);
    });
});

describe('parseToml — strings', () => {
    it('parses basic strings with escapes', () => {
        expect(parseToml(`s = "line\\nbreak\\t!"`)).toEqual({
            s: 'line\nbreak\t!'
        });
    });

    it('parses unicode escapes', () => {
        expect(parseToml(`s = "\\u00e9"`)).toEqual({ s: 'é' });
        expect(parseToml(`s = "\\U0001F600"`)).toEqual({ s: '😀' });
    });

    it('parses literal strings (no escapes)', () => {
        expect(parseToml(`s = 'C:\\Users\\me'`)).toEqual({
            s: 'C:\\Users\\me'
        });
    });

    it('parses multi-line basic strings and trims initial newline', () => {
        const input =
            's = """\nfirst\nsecond"""';
        expect(parseToml(input)).toEqual({ s: 'first\nsecond' });
    });

    it('parses multi-line basic string with line-ending backslash', () => {
        const input = 's = """\\\n    foo \\\n    bar\\\n"""';
        expect(parseToml(input)).toEqual({ s: 'foo bar' });
    });

    it('parses multi-line literal strings preserving everything', () => {
        const input = "s = '''\nraw\\n''' ";
        expect(parseToml(input)).toEqual({ s: 'raw\\n' });
    });

    it('rejects unterminated basic strings', () => {
        expect(() => parseToml(`s = "no end`)).toThrow(TomlParseError);
    });

    it('rejects invalid escape sequences', () => {
        expect(() => parseToml(`s = "bad \\x"`)).toThrow(TomlParseError);
    });
});

describe('parseToml — integers', () => {
    it('parses positive, negative, and zero', () => {
        expect(parseToml(`a = 0\nb = 42\nc = -17\nd = +99`)).toEqual({
            a: 0,
            b: 42,
            c: -17,
            d: 99
        });
    });

    it('parses underscores as digit separators', () => {
        expect(parseToml(`a = 1_000_000`)).toEqual({ a: 1_000_000 });
    });

    it('parses hex / octal / binary literals', () => {
        expect(parseToml(`a = 0xDEAD_BEEF\nb = 0o755\nc = 0b1011`)).toEqual({
            a: 0xdeadbeef,
            b: 0o755,
            c: 0b1011
        });
    });

    it('rejects leading zeros on decimal integers', () => {
        expect(() => parseToml(`a = 0123`)).toThrow(TomlParseError);
    });

    it('rejects empty hex literal', () => {
        expect(() => parseToml(`a = 0x`)).toThrow(TomlParseError);
    });

    it('rejects underscore at the start or after another underscore', () => {
        expect(() => parseToml(`a = _1`)).toThrow(TomlParseError);
        expect(() => parseToml(`a = 1__2`)).toThrow(TomlParseError);
    });
});

describe('parseToml — floats', () => {
    it('parses simple floats', () => {
        expect(parseToml(`a = 3.14\nb = -0.5\nc = 1e10\nd = 6.022e23`)).toEqual({
            a: 3.14,
            b: -0.5,
            c: 1e10,
            d: 6.022e23
        });
    });

    it('parses inf and nan', () => {
        const out = parseToml(`a = inf\nb = -inf\nc = +inf\nd = nan`);
        expect(out.a).toBe(Infinity);
        expect(out.b).toBe(-Infinity);
        expect(out.c).toBe(Infinity);
        expect(Number.isNaN(out.d as number)).toBe(true);
    });

    it('parses underscores in floats', () => {
        expect(parseToml(`a = 9_224_617.445_991_228`)).toEqual({
            a: 9224617.445991228
        });
    });
});

describe('parseToml — booleans', () => {
    it('parses true / false', () => {
        expect(parseToml(`a = true\nb = false`)).toEqual({
            a: true,
            b: false
        });
    });

    it('rejects mixed case booleans', () => {
        expect(() => parseToml(`a = True`)).toThrow(TomlParseError);
    });
});

describe('parseToml — date-time', () => {
    it('parses RFC 3339 offset date-time', () => {
        expect(parseToml(`a = 1979-05-27T07:32:00Z`)).toEqual({
            a: '1979-05-27T07:32:00Z'
        });
        expect(parseToml(`a = 1979-05-27T00:32:00-07:00`)).toEqual({
            a: '1979-05-27T00:32:00-07:00'
        });
    });

    it('parses local date-time and accepts a space separator', () => {
        expect(parseToml(`a = 1979-05-27T07:32:00`)).toEqual({
            a: '1979-05-27T07:32:00'
        });
        expect(parseToml(`a = 1979-05-27 07:32:00`)).toEqual({
            a: '1979-05-27 07:32:00'
        });
    });

    it('parses local date and local time alone', () => {
        expect(parseToml(`a = 1979-05-27`)).toEqual({ a: '1979-05-27' });
        expect(parseToml(`a = 07:32:00`)).toEqual({ a: '07:32:00' });
    });

    it('parses fractional seconds', () => {
        expect(parseToml(`a = 1979-05-27T07:32:00.999999Z`)).toEqual({
            a: '1979-05-27T07:32:00.999999Z'
        });
    });
});

describe('parseToml — arrays', () => {
    it('parses simple arrays', () => {
        expect(parseToml(`a = [1, 2, 3]`)).toEqual({ a: [1, 2, 3] });
    });

    it('parses heterogeneous arrays (TOML 1.0)', () => {
        expect(parseToml(`a = [1, "two", true]`)).toEqual({
            a: [1, 'two', true]
        });
    });

    it('parses nested arrays', () => {
        expect(parseToml(`a = [[1, 2], [3, 4]]`)).toEqual({
            a: [[1, 2], [3, 4]]
        });
    });

    it('parses arrays spanning multiple lines with trailing commas', () => {
        const input = `a = [\n  1,\n  2,\n  3,\n]`;
        expect(parseToml(input)).toEqual({ a: [1, 2, 3] });
    });

    it('parses arrays of strings', () => {
        expect(parseToml(`a = ["red", "green", "blue"]`)).toEqual({
            a: ['red', 'green', 'blue']
        });
    });

    it('rejects unterminated arrays', () => {
        expect(() => parseToml(`a = [1, 2`)).toThrow(TomlParseError);
    });
});

describe('parseToml — tables', () => {
    it('parses a single table header', () => {
        expect(
            parseToml(`[server]\nip = "127.0.0.1"\nport = 80`)
        ).toEqual({ server: { ip: '127.0.0.1', port: 80 } });
    });

    it('parses dotted table headers', () => {
        expect(
            parseToml(`[a.b.c]\nx = 1`)
        ).toEqual({ a: { b: { c: { x: 1 } } } });
    });

    it('rejects redefining the same table', () => {
        expect(() =>
            parseToml(`[a]\nx = 1\n[a]\ny = 2`)
        ).toThrow(TomlParseError);
    });

    it('allows defining sibling subtables in any order', () => {
        const input = `[a.b]\nx = 1\n[a.c]\ny = 2`;
        expect(parseToml(input)).toEqual({
            a: { b: { x: 1 }, c: { y: 2 } }
        });
    });
});

describe('parseToml — array of tables', () => {
    it('parses multiple [[product]] frames', () => {
        const input = `
[[products]]
name = "A"
sku = 1

[[products]]
name = "B"
sku = 2
`;
        expect(parseToml(input)).toEqual({
            products: [
                { name: 'A', sku: 1 },
                { name: 'B', sku: 2 }
            ]
        });
    });

    it('parses subtables under array of tables', () => {
        const input = `
[[fruits]]
name = "apple"

[fruits.physical]
color = "red"

[[fruits]]
name = "banana"
`;
        expect(parseToml(input)).toEqual({
            fruits: [
                { name: 'apple', physical: { color: 'red' } },
                { name: 'banana' }
            ]
        });
    });

    it('rejects redefining a [[a]] as a [a]', () => {
        const input = `[[a]]\nx = 1\n[a]\ny = 2`;
        expect(() => parseToml(input)).toThrow(TomlParseError);
    });
});

describe('parseToml — inline tables', () => {
    it('parses an empty inline table', () => {
        expect(parseToml(`a = {}`)).toEqual({ a: {} });
    });

    it('parses a flat inline table', () => {
        expect(parseToml(`pt = { x = 1, y = 2 }`)).toEqual({
            pt: { x: 1, y: 2 }
        });
    });

    it('parses dotted keys inside inline tables', () => {
        expect(parseToml(`pt = { a.b = 1 }`)).toEqual({
            pt: { a: { b: 1 } }
        });
    });

    it('parses arrays of inline tables', () => {
        const input = `points = [{ x = 1, y = 2 }, { x = 3, y = 4 }]`;
        expect(parseToml(input)).toEqual({
            points: [
                { x: 1, y: 2 },
                { x: 3, y: 4 }
            ]
        });
    });

    it('rejects extending an inline table from a header', () => {
        const input = `a = { x = 1 }\n[a]\ny = 2`;
        expect(() => parseToml(input)).toThrow(TomlParseError);
    });
});

describe('parseToml — real-world fixtures', () => {
    it('parses a Cargo.toml-shape document', () => {
        const input = `
[package]
name = "omni-viewer"
version = "0.1.0"
edition = "2021"
description = "Rust port of the Chrome viewer"
authors = ["Alice <a@example.com>", "Bob <b@example.com>"]

[dependencies]
serde = { version = "1.0", features = ["derive"] }
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
log = "0.4"

[[bin]]
name = "omni-cli"
path = "src/cli.rs"

[[bin]]
name = "omni-server"
path = "src/server.rs"

[profile.release]
opt-level = 3
lto = true
`;
        const data = parseToml(input);
        expect(data.package).toMatchObject({
            name: 'omni-viewer',
            version: '0.1.0',
            edition: '2021',
            authors: ['Alice <a@example.com>', 'Bob <b@example.com>']
        });
        expect(data.dependencies).toMatchObject({
            serde: { version: '1.0', features: ['derive'] },
            tokio: {
                version: '1',
                features: ['macros', 'rt-multi-thread']
            },
            log: '0.4'
        });
        expect(data.bin).toEqual([
            { name: 'omni-cli', path: 'src/cli.rs' },
            { name: 'omni-server', path: 'src/server.rs' }
        ]);
        expect(data.profile).toEqual({
            release: { 'opt-level': 3, lto: true }
        });
    });

    it('parses a pyproject.toml-shape document', () => {
        const input = `
[project]
name = "omni"
version = "0.1.0"
description = "Sample"
requires-python = ">=3.10"
dependencies = [
    "requests>=2.31",
    "pydantic>=2.0",
]

[project.optional-dependencies]
dev = ["pytest", "ruff"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.ruff]
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "W"]
`;
        const data = parseToml(input) as Record<string, any>;
        expect(data.project.name).toBe('omni');
        expect(data.project.dependencies).toEqual([
            'requests>=2.31',
            'pydantic>=2.0'
        ]);
        expect(data.project['optional-dependencies'].dev).toEqual([
            'pytest',
            'ruff'
        ]);
        expect(data['build-system']).toEqual({
            requires: ['hatchling'],
            'build-backend': 'hatchling.build'
        });
        expect(data.tool.ruff['line-length']).toBe(100);
        expect(data.tool.ruff.lint.select).toEqual(['E', 'F', 'W']);
    });
});

describe('parseTomlAst', () => {
    it('produces a root node with children', () => {
        const ast = parseTomlAst(`a = 1\nb = "two"`);
        expect(ast.nodeType).toBe('table');
        expect(ast.children).toHaveLength(2);
        expect(ast.children![0]).toMatchObject({
            key: 'a',
            nodeType: 'scalar',
            valueType: 'integer',
            value: 1
        });
        expect(ast.children![1]).toMatchObject({
            key: 'b',
            nodeType: 'scalar',
            valueType: 'string',
            value: 'two'
        });
    });

    it('renders array-of-tables as numbered frames', () => {
        const ast = parseTomlAst(`[[x]]\na = 1\n[[x]]\na = 2`);
        const xNode = ast.children!.find((c) => c.key === 'x')!;
        expect(xNode.nodeType).toBe('array-of-tables');
        expect(xNode.children).toHaveLength(2);
        expect(xNode.children![0].key).toBe('[0]');
        expect(xNode.children![1].key).toBe('[1]');
    });

    it('renders inline tables as nested children', () => {
        const ast = parseTomlAst(`pt = { x = 1, y = 2 }`);
        const pt = ast.children!.find((c) => c.key === 'pt')!;
        expect(pt.nodeType).toBe('inline-table');
        expect(pt.children).toBeDefined();
        expect(pt.children!.map((c) => c.key)).toEqual(['x', 'y']);
        expect(pt.children![0]).toMatchObject({
            valueType: 'integer',
            value: 1
        });
    });

    it('records position info on table nodes', () => {
        const ast = parseTomlAst(`# comment\n[server]\nport = 80`);
        const server = ast.children!.find((c) => c.key === 'server')!;
        expect(server.position).toBeDefined();
        expect(server.position!.line).toBe(2);
    });

    it('preserves original date-time text on the AST value', () => {
        const ast = parseTomlAst(`a = 1979-05-27T07:32:00Z`);
        const a = ast.children![0];
        expect(a.valueType).toBe('datetime-offset');
        expect(a.value).toBe('1979-05-27T07:32:00Z');
    });
});

describe('parseToml — robustness', () => {
    it('throws TomlParseError with line/column on malformed input', () => {
        try {
            parseToml(`a = 1\nb = ?`);
            fail('expected throw');
        } catch (err) {
            expect(err).toBeInstanceOf(TomlParseError);
            const e = err as TomlParseError;
            expect(e.line).toBe(2);
            expect(e.column).toBeGreaterThanOrEqual(5);
        }
    });

    it('parses CRLF line endings the same as LF', () => {
        const input = `a = 1\r\nb = 2\r\n`;
        expect(parseToml(input)).toEqual({ a: 1, b: 2 });
    });

    it('handles a comment-only document', () => {
        expect(parseToml(`# nothing here\n# really\n`)).toEqual({});
    });
});
