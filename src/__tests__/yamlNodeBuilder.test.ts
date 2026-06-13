// Tests for the YAML node-builder (issue #64).
//
// We exercise both the pure tree mutators (mirrors the JSON viewer's
// reducer tests) and the YAML-specific anchor / alias preservation.
// The vendored `js-yaml` is loaded at runtime in the browser, but for
// tests we `require` the npm copy from node_modules — both 3.x and 4.x
// support the `listener` parser hook + the same alias-resolution
// semantics, so the same `parseYamlSource` shim works against either.

import {
    YamlTreeNode,
    JsYamlLike,
    parseYamlSource,
    buildYamlTree,
    expand,
    collapse,
    toggle,
    expandAncestorsOf,
    isContainer,
    nextMatchIndex,
    prevMatchIndex,
    search,
    walk
} from '../utils/yamlNodeBuilder';

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
const jsyaml: JsYamlLike = require('js-yaml');

function build(text: string, opts?: { expandRoot?: boolean }): YamlTreeNode {
    const parsed = parseYamlSource(text, jsyaml);
    expect(parsed.error).toBeNull();
    return buildYamlTree(parsed, opts);
}

describe('parseYamlSource', () => {
    it('returns a single document for a simple mapping', () => {
        const parsed = parseYamlSource('a: 1\nb: 2\n', jsyaml);
        expect(parsed.error).toBeNull();
        expect(parsed.documents).toHaveLength(1);
        expect(parsed.documents[0]).toEqual({ a: 1, b: 2 });
        expect(parsed.multiDocument).toBe(false);
    });

    it('parses multi-document YAML when --- separators are present', () => {
        const text = '---\na: 1\n---\nb: 2\n';
        const parsed = parseYamlSource(text, jsyaml);
        expect(parsed.error).toBeNull();
        expect(parsed.multiDocument).toBe(true);
        expect(parsed.documents).toHaveLength(2);
        expect(parsed.documents[0]).toEqual({ a: 1 });
        expect(parsed.documents[1]).toEqual({ b: 2 });
    });

    it('captures anchor names via the listener hook', () => {
        const text = 'defaults: &base\n  retries: 3\nrun: *base\n';
        const parsed = parseYamlSource(text, jsyaml);
        expect(parsed.error).toBeNull();
        const baseValue = parsed.anchors.get('base');
        expect(baseValue).toEqual({ retries: 3 });
    });

    it('reports parse errors without throwing', () => {
        // Unbalanced flow mapping — js-yaml throws YAMLException, which we
        // convert into a structured error. The tree-builder still gets a
        // (possibly empty) document list to work with.
        const parsed = parseYamlSource('a: { b: 1', jsyaml);
        expect(parsed.error).not.toBeNull();
        expect(parsed.error!.message.length).toBeGreaterThan(0);
    });
});

describe('buildYamlTree — primitive scalars', () => {
    it('builds a string root', () => {
        const root = build('"hello"\n');
        expect(root.kind).toBe('string');
        expect(root.primitive).toBe('"hello"');
    });

    it('builds a number root', () => {
        const root = build('42\n');
        expect(root.kind).toBe('number');
        expect(root.primitive).toBe('42');
    });

    it('builds a boolean root', () => {
        const root = build('true\n');
        expect(root.kind).toBe('boolean');
        expect(root.primitive).toBe('true');
    });

    it('builds a null root for ~', () => {
        const root = build('~\n');
        expect(root.kind).toBe('null');
        expect(root.primitive).toBe('null');
    });

    it('builds a null root for empty input', () => {
        const root = build('');
        expect(root.kind).toBe('null');
    });
});

describe('buildYamlTree — mapping / sequence', () => {
    it('builds nested mappings preserving key order', () => {
        const root = build('b: 1\na: 2\nc: 3\n');
        expect(root.kind).toBe('object');
        expect(root.children!.map((c) => c.key)).toEqual(['b', 'a', 'c']);
    });

    it('builds sequences with numeric indices', () => {
        const root = build('- one\n- two\n- three\n');
        expect(root.kind).toBe('array');
        expect(root.children!.map((c) => c.key)).toEqual(['0', '1', '2']);
        expect(root.children!.map((c) => c.primitive)).toEqual(
            ['"one"', '"two"', '"three"']
        );
    });

    it('records path for nested values', () => {
        const root = build('a:\n  b:\n    - 10\n    - 20\n');
        const a = root.children![0];
        const b = a.children![0];
        const item0 = b.children![0];
        expect(item0.path).toEqual(['a', 'b', 0]);
        expect(item0.primitive).toBe('10');
    });

    it('wires parent back-references', () => {
        const root = build('a:\n  b: 1\n');
        const a = root.children![0];
        const b = a.children![0];
        expect(a.parent).toBe(root);
        expect(b.parent).toBe(a);
        expect(root.parent).toBeNull();
    });
});

describe('buildYamlTree — anchors / aliases', () => {
    it('marks the anchor source with the anchor name', () => {
        // The first occurrence carries `&base`; the alias carries `*base`.
        const text = 'defaults: &base\n  retries: 3\n  timeout: 30\nrun: *base\n';
        const root = build(text);
        const defaults = root.children!.find((c) => c.key === 'defaults')!;
        expect(defaults.kind).toBe('object');
        expect(defaults.anchor).toBe('base');
        expect(defaults.children).toBeDefined();
    });

    it('represents alias references as leaf nodes (no recursion)', () => {
        const text = 'defaults: &base\n  retries: 3\nrun: *base\n';
        const root = build(text);
        const run = root.children!.find((c) => c.key === 'run')!;
        // The aliased mapping is rendered as a leaf with `kind: 'alias'`,
        // so deep / cyclic structures stay finite in the viewer.
        expect(run.kind).toBe('alias');
        expect(run.alias).toBe('base');
        expect(run.children).toBeUndefined();
        expect(run.primitive).toBe('*base');
    });

    it('handles aliased sequences', () => {
        const text = 'common: &items\n  - 1\n  - 2\nuses: *items\n';
        const root = build(text);
        const common = root.children!.find((c) => c.key === 'common')!;
        const uses = root.children!.find((c) => c.key === 'uses')!;
        expect(common.kind).toBe('array');
        expect(common.anchor).toBe('items');
        expect(uses.kind).toBe('alias');
        expect(uses.alias).toBe('items');
    });

    it('handles multiple aliases pointing at one anchor', () => {
        const text =
            'first: &shared\n  k: v\nsecond: *shared\nthird: *shared\n';
        const root = build(text);
        const first = root.children!.find((c) => c.key === 'first')!;
        const second = root.children!.find((c) => c.key === 'second')!;
        const third = root.children!.find((c) => c.key === 'third')!;
        expect(first.anchor).toBe('shared');
        expect(second.alias).toBe('shared');
        expect(third.alias).toBe('shared');
        expect(second.kind).toBe('alias');
        expect(third.kind).toBe('alias');
    });
});

describe('buildYamlTree — multi-document', () => {
    it('synthesizes a documents wrapper for multi-doc YAML', () => {
        const text = '---\na: 1\n---\nb: 2\n';
        const parsed = parseYamlSource(text, jsyaml);
        const root = buildYamlTree(parsed);
        expect(root.kind).toBe('array');
        expect(root.children).toHaveLength(2);
        expect(root.children![0].key).toBe('document 0');
        expect(root.children![1].key).toBe('document 1');
        expect(root.children![0].documentIndex).toBe(0);
        expect(root.children![1].documentIndex).toBe(1);
    });

    it('keeps each document independent in multi-doc trees', () => {
        // Container anchors / aliases work across documents; scalar
        // anchors (e.g. &a 1) don't carry a unique JS-identity, so we
        // intentionally only track containers for alias detection.
        const text =
            '---\nshared: &cfg\n  retries: 3\nrun: *cfg\n---\nz: 2\n';
        const parsed = parseYamlSource(text, jsyaml);
        const root = buildYamlTree(parsed);
        const doc0 = root.children![0];
        const doc1 = root.children![1];
        const shared = doc0.children!.find((c) => c.key === 'shared')!;
        const run = doc0.children!.find((c) => c.key === 'run')!;
        expect(shared.anchor).toBe('cfg');
        expect(run.alias).toBe('cfg');
        expect(doc1.children!.map((c) => c.key)).toEqual(['z']);
    });
});

describe('expand / collapse / toggle / isContainer', () => {
    it('expand is a no-op for primitives + aliases', () => {
        const root = build('defaults: &base\n  k: v\nrun: *base\n');
        const run = root.children!.find((c) => c.key === 'run')!;
        const before = run.expanded;
        expand(run);
        expect(run.expanded).toBe(before);
        expect(isContainer(run)).toBe(false);
    });

    it('toggle flips containers and returns new state', () => {
        const root = build('a: { b: 1 }\n');
        const next = toggle(root);
        expect(next).toBe(false); // root was expanded by default
        const next2 = toggle(root);
        expect(next2).toBe(true);
    });

    it('collapse closes containers', () => {
        const root = build('a: 1\n');
        collapse(root);
        expect(root.expanded).toBe(false);
    });
});

describe('expandAncestorsOf', () => {
    it('expands every container on the path from root to a match', () => {
        const root = build('a:\n  b:\n    c: leaf\n');
        const a = root.children![0];
        const b = a.children![0];
        const c = b.children![0];
        expect(a.expanded).toBe(false);
        expect(b.expanded).toBe(false);
        const changed = expandAncestorsOf([c]);
        expect(a.expanded).toBe(true);
        expect(b.expanded).toBe(true);
        expect(changed.has(a)).toBe(true);
        expect(changed.has(b)).toBe(true);
        expect(c.expanded).toBe(false); // match itself is not auto-expanded
    });
});

describe('search', () => {
    const yamlText = [
        'users:',
        '  - name: Alice',
        '    age: 30',
        '  - name: Bob',
        '    age: 25',
        'meta:',
        '  source: alice-import',
        ''
    ].join('\n');

    it('matches keys case-insensitively', () => {
        const root = build(yamlText);
        const result = search(root, 'NAME');
        const matchedKeys = result.matches.map((n) => n.key);
        expect(matchedKeys).toEqual(['name', 'name']);
    });

    it('matches primitive values case-insensitively', () => {
        const root = build(yamlText);
        const result = search(root, 'alice');
        const primitives = result.matches.map((n) => n.primitive);
        expect(primitives).toContain('"Alice"');
        expect(primitives).toContain('"alice-import"');
    });

    it('matches anchor + alias names', () => {
        const root = build('defaults: &base\n  k: v\nrun: *base\n');
        const result = search(root, 'base');
        // The anchor source AND the alias leaf both surface as matches.
        const tags = result.matches
            .map((n) => n.anchor || n.alias)
            .filter(Boolean);
        expect(tags).toContain('base');
        expect(result.matches.length).toBeGreaterThanOrEqual(2);
    });

    it('clears matches on an empty query', () => {
        const root = build(yamlText);
        search(root, 'alice');
        search(root, '');
        let any = false;
        walk(root, (n) => {
            if (n.matched) any = true;
        });
        expect(any).toBe(false);
    });

    it('returns matches in DFS order', () => {
        const root = build('a:\n  x: hit\nb: hit\nc:\n  d: hit\n');
        const result = search(root, 'hit');
        const paths = result.matches.map((n) => n.path.join('.'));
        expect(paths).toEqual(['a.x', 'b', 'c.d']);
    });
});

describe('nextMatchIndex / prevMatchIndex', () => {
    it('wraps forward at the end', () => {
        expect(nextMatchIndex(2, 3)).toBe(0);
    });
    it('wraps backward at the start', () => {
        expect(prevMatchIndex(0, 3)).toBe(2);
    });
    it('returns -1 when there are no matches', () => {
        expect(nextMatchIndex(-1, 0)).toBe(-1);
        expect(prevMatchIndex(-1, 0)).toBe(-1);
    });
    it('starts at 0 / last when current is -1', () => {
        expect(nextMatchIndex(-1, 4)).toBe(0);
        expect(prevMatchIndex(-1, 4)).toBe(3);
    });
});
