import {
    ConfigSourceToken,
    tokenizeTomlSource,
    tokenizeYamlSource
} from '../utils/configSourceTokenizer';

function reconstruct(tokens: ConfigSourceToken[]): string {
    return tokens.map((token) => token.text).join('');
}

describe('config source syntax highlighting', () => {
    it('highlights YAML keys and scalar values without changing the source', () => {
        const source = 'server:\n  host: "localhost"\n  port: 8080\n  enabled: true # dev\n- item\n';
        const tokens = tokenizeYamlSource(source);

        expect(reconstruct(tokens)).toBe(source);
        expect(tokens.filter((token) => token.kind === 'key').map((token) => token.text))
            .toEqual(['server', 'host', 'port', 'enabled']);
        expect(tokens.some((token) => token.kind === 'string' && token.text === '"localhost"')).toBe(true);
        expect(tokens.some((token) => token.kind === 'number' && token.text === '8080')).toBe(true);
        expect(tokens.some((token) => token.kind === 'boolean' && token.text === 'true')).toBe(true);
        expect(tokens.some((token) => token.kind === 'comment' && token.text === '# dev')).toBe(true);
        expect(tokens.some((token) => token.kind === 'value' && token.text === 'item')).toBe(true);
    });

    it('keeps YAML syntax characters inside strings as part of the value', () => {
        const source = 'url: "https://example.com/#anchor"\n';
        const tokens = tokenizeYamlSource(source);

        expect(reconstruct(tokens)).toBe(source);
        expect(tokens.filter((token) => token.kind === 'comment')).toHaveLength(0);
        expect(tokens.find((token) => token.kind === 'string')?.text)
            .toBe('"https://example.com/#anchor"');
    });

    it('highlights TOML keys, values, table headers, and comments losslessly', () => {
        const source = '[server]\nhost = "localhost"\nport = 8080\nenabled = true # dev\n';
        const tokens = tokenizeTomlSource(source);

        expect(reconstruct(tokens)).toBe(source);
        expect(tokens.filter((token) => token.kind === 'key').map((token) => token.text))
            .toEqual(['server', 'host', 'port', 'enabled']);
        expect(tokens.some((token) => token.kind === 'string' && token.text === '"localhost"')).toBe(true);
        expect(tokens.some((token) => token.kind === 'number' && token.text === '8080')).toBe(true);
        expect(tokens.some((token) => token.kind === 'boolean' && token.text === 'true')).toBe(true);
        expect(tokens.some((token) => token.kind === 'comment' && token.text === '# dev')).toBe(true);
    });

    it('keeps TOML syntax characters inside strings as part of the value', () => {
        const source = 'query = "a=b#c"\n';
        const tokens = tokenizeTomlSource(source);

        expect(reconstruct(tokens)).toBe(source);
        expect(tokens.filter((token) => token.kind === 'comment')).toHaveLength(0);
        expect(tokens.find((token) => token.kind === 'string')?.text).toBe('"a=b#c"');
    });
});
