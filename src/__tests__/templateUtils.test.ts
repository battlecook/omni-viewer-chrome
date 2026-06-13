// Test execution is deferred to issue #7 (jest setup). Compilation is
// already verified via `npm run build` (TypeScript is checked by ts-loader
// in transpile-only mode, but the symbols and types referenced here also
// exist in the production build).
import { escapeJsonForHtmlScriptTag } from '../utils/htmlEscaping';
import { TemplateUtils } from '../utils/templateUtils';

describe('escapeJsonForHtmlScriptTag', () => {
    it('escapes HTML-significant characters so script tags cannot terminate JSON blocks', () => {
        const raw = JSON.stringify({
            text: '<script>alert(1)</script><!--x-->&'
        });

        const escaped = escapeJsonForHtmlScriptTag(raw);

        expect(escaped).not.toContain('<script>');
        expect(escaped).not.toContain('</script>');
        expect(escaped).not.toContain('<!--');
        expect(escaped).toContain('\\u003Cscript\\u003E');
        expect(escaped).toContain('\\u003C/script\\u003E');
        expect(escaped).toContain('\\u003C!--x--\\u003E');
        expect(JSON.parse(escaped)).toEqual({
            text: '<script>alert(1)</script><!--x-->&'
        });
    });
});

interface FakeAsset {
    body: string;
}

const buildFakeFetch = (assets: Record<string, FakeAsset>) => {
    return async (url: string) => {
        const asset = assets[url];
        if (!asset) {
            return {
                ok: false,
                status: 404,
                text: async () => ''
            };
        }
        return {
            ok: true,
            status: 200,
            text: async () => asset.body
        };
    };
};

describe('TemplateUtils.renderTemplate', () => {
    const resolveUrl = (p: string) => `chrome-extension://test/${p}`;

    it('substitutes simple {{var}} placeholders', async () => {
        const fetchImpl = buildFakeFetch({
            'chrome-extension://test/templates/demo/demo.html': {
                body: '<html><body><h1>{{title}}</h1><p>{{body}}</p></body></html>'
            }
        });

        const out = await TemplateUtils.renderTemplate(
            'templates/demo/demo.html',
            { title: 'Hello', body: 'World $1 & friends' },
            { resolveUrl, fetchImpl }
        );

        expect(out).toContain('<h1>Hello</h1>');
        // split/join keeps `$1` literal — String.replace would interpret it.
        expect(out).toContain('<p>World $1 & friends</p>');
    });

    it('replaces {{omniShareButtons}} with empty string when share is disabled (default)', async () => {
        const fetchImpl = buildFakeFetch({
            'chrome-extension://test/templates/demo/demo.html': {
                body: '<html><head></head><body><div>{{omniShareButtons}}</div></body></html>'
            }
        });

        const out = await TemplateUtils.renderTemplate(
            'templates/demo/demo.html',
            {},
            { resolveUrl, fetchImpl }
        );

        expect(out).not.toContain('{{omniShareButtons}}');
        expect(out).not.toContain('omni-header-actions');
        expect(out).not.toContain('data-omni-action="share"');
        expect(out).toContain('<div></div>');
    });

    it('injects the share toolbar markup, style, and wiring when share is enabled', async () => {
        const fetchImpl = buildFakeFetch({
            'chrome-extension://test/templates/demo/demo.html': {
                body: '<html><head></head><body><div>{{omniShareButtons}}</div></body></html>'
            }
        });

        const out = await TemplateUtils.renderTemplate(
            'templates/demo/demo.html',
            {},
            { resolveUrl, fetchImpl, enableShare: true }
        );

        expect(out).toContain('omni-header-actions');
        expect(out).toContain('data-omni-action="share"');
        expect(out).toContain('data-omni-action="open-shared-link"');
        // style block injected before </head>
        expect(out).toMatch(/<style>[\s\S]*omni-header-actions[\s\S]*<\/style>\s*<\/head>/);
        // wiring script injected before </body>
        expect(out).toMatch(/chrome\.runtime\.sendMessage[\s\S]*<\/body>/);
    });

    it('inlines local CSS link tags via fetch', async () => {
        const fetchImpl = buildFakeFetch({
            'chrome-extension://test/templates/demo/demo.html': {
                body:
                    '<html><head><link rel="stylesheet" href="css/demo.css"></head>' +
                    '<body><h1>Hi</h1></body></html>'
            },
            'chrome-extension://test/templates/demo/css/demo.css': {
                body: '.demo { color: red; }'
            }
        });

        const out = await TemplateUtils.renderTemplate(
            'templates/demo/demo.html',
            {},
            { resolveUrl, fetchImpl }
        );

        expect(out).toContain('<style>');
        expect(out).toContain('.demo { color: red; }');
        expect(out).not.toContain('<link');
    });

    it('inlines local script tags but leaves external CDN scripts alone', async () => {
        const fetchImpl = buildFakeFetch({
            'chrome-extension://test/templates/demo/demo.html': {
                body:
                    '<html><body>' +
                    '<script src="js/demo.js"></script>' +
                    '<script src="https://cdn.example/lib.js"></script>' +
                    '</body></html>'
            },
            'chrome-extension://test/templates/demo/js/demo.js': {
                body: 'console.log("demo");'
            }
        });

        const out = await TemplateUtils.renderTemplate(
            'templates/demo/demo.html',
            {},
            { resolveUrl, fetchImpl }
        );

        expect(out).toContain('console.log("demo");');
        expect(out).toContain('<script src="https://cdn.example/lib.js"></script>');
    });

    it('treats null/undefined variable values as empty string', async () => {
        const fetchImpl = buildFakeFetch({
            'chrome-extension://test/x.html': {
                body: '[{{a}}][{{b}}][{{c}}]'
            }
        });

        const out = await TemplateUtils.renderTemplate(
            'x.html',
            { a: 'A', b: undefined as unknown as string, c: null as unknown as string },
            { resolveUrl, fetchImpl }
        );

        expect(out).toBe('[A][][]');
    });

    it('throws a descriptive error when the template URL is not reachable', async () => {
        const fetchImpl = buildFakeFetch({});

        await expect(
            TemplateUtils.renderTemplate('missing.html', {}, { resolveUrl, fetchImpl })
        ).rejects.toThrow(/Failed to load template: missing\.html/);
    });

    it('exposes escapeJsonForHtmlScriptTag as a static helper', () => {
        const raw = JSON.stringify({ x: '</script>' });
        const escaped = TemplateUtils.escapeJsonForHtmlScriptTag(raw);
        expect(escaped).not.toContain('</script>');
        expect(JSON.parse(escaped)).toEqual({ x: '</script>' });
    });
});
