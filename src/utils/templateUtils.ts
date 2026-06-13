import { escapeJsonForHtmlScriptTag } from './htmlEscaping';

/**
 * Browser/Chrome MV3 port of VSCode's `TemplateUtils`.
 *
 * Differences vs the VSCode original:
 *
 *   - `vscode.workspace.fs.readFile(...)` → `fetch(chrome.runtime.getURL(...))`.
 *     Templates ship as static assets under `dist/templates/...` and are
 *     read via the extension's own URL.
 *   - The `{{omniShareButtons}}` placeholder resolves to **empty string by
 *     default** in this build. Real share UI arrives in #66/#67. The
 *     `enableShare` option is wired up so #66/#67 can flip it on without
 *     reshaping the public API.
 *   - The "memoize acquireVsCodeApi" script block is dropped — there is no
 *     VSCode webview API in Chrome.
 *   - Inlining of external CSS/JS uses `fetch` rather than `fs.readFile`.
 *
 * Public API (mirrors the VSCode shape, minus `vscode.ExtensionContext`):
 *
 *   TemplateUtils.renderTemplate(htmlPath, vars)        // primary, per #4
 *   TemplateUtils.loadTemplate(templateName, vars)      // legacy alias
 *   TemplateUtils.escapeJsonForHtmlScriptTag(json)
 */
export interface RenderTemplateOptions {
    /**
     * When true, `{{omniShareButtons}}` is replaced with the share toolbar
     * markup. Defaults to false; real share UI ships in #66/#67.
     */
    enableShare?: boolean;
    /**
     * Override the asset resolver used to fetch templates and inlined
     * CSS/JS dependencies. Useful for tests.
     */
    resolveUrl?: (resourcePath: string) => string;
    /**
     * Override the fetch implementation. Useful for tests.
     */
    fetchImpl?: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

export class TemplateUtils {
    public static escapeJsonForHtmlScriptTag(json: string): string {
        return escapeJsonForHtmlScriptTag(json);
    }

    /**
     * Render an HTML template.
     *
     * @param htmlPath  Path to the template, relative to the extension root
     *                  (e.g. `templates/image/image.html`). Resolved via
     *                  `chrome.runtime.getURL` unless `options.resolveUrl`
     *                  is provided.
     * @param variables Map of `{{name}}` → replacement string.
     * @param options   Optional overrides (see {@link RenderTemplateOptions}).
     */
    public static async renderTemplate(
        htmlPath: string,
        variables: { [key: string]: string } = {},
        options: RenderTemplateOptions = {}
    ): Promise<string> {
        const resolveUrl = options.resolveUrl || this.defaultResolveUrl;
        const fetchImpl = options.fetchImpl || this.defaultFetch;
        const enableShare = options.enableShare === true;

        const templateUrl = resolveUrl(htmlPath);

        let template: string;
        try {
            const response = await fetchImpl(templateUrl);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            template = await response.text();
        } catch (error) {
            console.error(`Error loading template ${htmlPath}:`, error);
            throw new Error(`Failed to load template: ${htmlPath}`);
        }

        template = await this.inlineExternalFiles(htmlPath, template, resolveUrl, fetchImpl);

        for (const [key, value] of Object.entries(variables)) {
            const placeholder = `{{${key}}}`;
            const safeValue = value === null || value === undefined ? '' : String(value);
            // split/join avoids `$` having replace semantics in String.replace.
            template = template.split(placeholder).join(safeValue);
        }

        template = this.injectOmniShareAssets(template, enableShare);
        return template;
    }

    /**
     * Legacy alias mirroring the VSCode signature `loadTemplate(context, templateName, variables)`.
     * Resolves `templates/<templateName>` relative to the extension root.
     */
    public static loadTemplate(
        templateName: string,
        variables: { [key: string]: string } = {},
        options: RenderTemplateOptions = {}
    ): Promise<string> {
        const path = templateName.startsWith('templates/')
            ? templateName
            : `templates/${templateName}`;
        return this.renderTemplate(path, variables, options);
    }

    private static readonly OMNI_SHARE_BUTTONS_HTML = `<div class="omni-header-actions">
    <button type="button" class="omni-header-action-btn" data-omni-action="share" title="Share with Omni Viewer" aria-label="Share with Omni Viewer">Share</button>
    <button type="button" class="omni-header-action-btn" data-omni-action="open-shared-link" title="Open shared link" aria-label="Open shared link">Open Link</button>
</div>`;

    private static readonly OMNI_SHARE_STYLE = `<style>
.omni-header-actions {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
}
.omni-header-action-btn {
    appearance: none;
    border: 1px solid transparent;
    border-radius: 6px;
    background: #3a3d41;
    color: #d4d4d4;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    line-height: 1;
    padding: 6px 10px;
    transition: background 140ms ease;
    white-space: nowrap;
}
.omni-header-action-btn:hover {
    background: #45494e;
}
.omni-header-action-btn:active {
    transform: translateY(1px);
}
</style>`;

    private static readonly OMNI_SHARE_WIRE_SCRIPT = `<script>
(function () {
    function send(type) {
        try {
            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
                chrome.runtime.sendMessage({ type: type, command: type });
            }
        } catch (e) { /* ignored */ }
    }
    function bind() {
        document.querySelectorAll('[data-omni-action="share"]').forEach(function (el) {
            el.addEventListener('click', function () { send('omniViewerShare'); });
        });
        document.querySelectorAll('[data-omni-action="open-shared-link"]').forEach(function (el) {
            el.addEventListener('click', function () { send('omniViewerOpenSharedLink'); });
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();
</script>`;

    private static injectOmniShareAssets(html: string, enableShare: boolean): string {
        // Per #4 DoD: `{{omniShareButtons}}` resolves to empty string when
        // share is disabled (default). The full markup + style + wiring
        // ships only when explicitly enabled (#66/#67).
        if (!enableShare) {
            return html.split('{{omniShareButtons}}').join('');
        }

        html = html.split('{{omniShareButtons}}').join(TemplateUtils.OMNI_SHARE_BUTTONS_HTML);

        if (html.includes('</head>')) {
            html = html.replace('</head>', `${TemplateUtils.OMNI_SHARE_STYLE}\n</head>`);
        } else {
            html = TemplateUtils.OMNI_SHARE_STYLE + html;
        }

        if (html.includes('</body>')) {
            html = html.replace(
                '</body>',
                `${TemplateUtils.OMNI_SHARE_WIRE_SCRIPT}\n</body>`
            );
        } else {
            html += TemplateUtils.OMNI_SHARE_WIRE_SCRIPT;
        }

        return html;
    }

    private static async inlineExternalFiles(
        templatePath: string,
        html: string,
        resolveUrl: (p: string) => string,
        fetchImpl: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>
    ): Promise<string> {
        const templateDir = TemplateUtils.dirname(templatePath);

        const cssMatches = html.match(/<link[^>]*href="([^"]*\.css)"[^>]*>/g);
        if (cssMatches) {
            for (const linkTag of cssMatches) {
                const hrefMatch = linkTag.match(/href="([^"]*\.css)"/);
                if (!hrefMatch) {
                    continue;
                }
                const cssRelativePath = hrefMatch[1];
                if (TemplateUtils.isExternalUrl(cssRelativePath)) {
                    continue;
                }
                const cssPath = TemplateUtils.joinPath(templateDir, cssRelativePath);
                try {
                    const response = await fetchImpl(resolveUrl(cssPath));
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                    const cssContent = await response.text();
                    const styleTag = `<style>\n${cssContent}\n</style>`;
                    html = html.split(linkTag).join(styleTag);
                } catch (error) {
                    console.error(`Failed to inline required CSS file ${cssRelativePath}:`, error);
                    throw new Error(`Required CSS asset could not be loaded: ${cssRelativePath}`);
                }
            }
        }

        const jsMatches = html.match(/<script[^>]*src="([^"]*\.js)"[^>]*><\/script>/g);
        if (jsMatches) {
            for (const scriptTag of jsMatches) {
                const srcMatch = scriptTag.match(/src="([^"]*\.js)"/);
                if (!srcMatch) {
                    continue;
                }
                const jsRelativePath = srcMatch[1];
                if (TemplateUtils.isExternalUrl(jsRelativePath)) {
                    continue;
                }
                const jsPath = TemplateUtils.joinPath(templateDir, jsRelativePath);
                try {
                    const response = await fetchImpl(resolveUrl(jsPath));
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                    const jsContent = await response.text();
                    const inlineScriptTag = `<script>\n${jsContent}\n</script>`;
                    html = html.split(scriptTag).join(inlineScriptTag);
                } catch (error) {
                    console.error(`Failed to inline required JavaScript file ${jsRelativePath}:`, error);
                    throw new Error(
                        `Required JavaScript asset could not be loaded: ${jsRelativePath}`
                    );
                }
            }
        }

        return html;
    }

    /* ----------------------------- helpers ------------------------------ */

    private static defaultResolveUrl(resourcePath: string): string {
        if (
            typeof chrome !== 'undefined' &&
            chrome.runtime &&
            typeof chrome.runtime.getURL === 'function'
        ) {
            return chrome.runtime.getURL(resourcePath);
        }
        return resourcePath;
    }

    private static defaultFetch(
        url: string
    ): Promise<{ ok: boolean; status: number; text(): Promise<string> }> {
        if (typeof fetch !== 'function') {
            throw new Error('fetch is not available in the current runtime');
        }
        return fetch(url) as unknown as Promise<{
            ok: boolean;
            status: number;
            text(): Promise<string>;
        }>;
    }

    private static dirname(p: string): string {
        const idx = p.lastIndexOf('/');
        return idx <= 0 ? '' : p.slice(0, idx);
    }

    private static joinPath(dir: string, rel: string): string {
        if (TemplateUtils.isAbsoluteOrRoot(rel)) {
            return rel.replace(/^\//, '');
        }
        if (!dir) {
            return rel;
        }
        const segments = `${dir}/${rel}`.split('/');
        const stack: string[] = [];
        for (const seg of segments) {
            if (seg === '' || seg === '.') {
                continue;
            }
            if (seg === '..') {
                stack.pop();
                continue;
            }
            stack.push(seg);
        }
        return stack.join('/');
    }

    private static isExternalUrl(url: string): boolean {
        return /^(https?:)?\/\//i.test(url);
    }

    private static isAbsoluteOrRoot(url: string): boolean {
        return url.startsWith('/');
    }
}
