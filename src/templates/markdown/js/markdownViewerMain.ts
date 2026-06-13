import { sanitizeUrl } from '@braintree/sanitize-url';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import ini from 'highlight.js/lib/languages/ini';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import shell from 'highlight.js/lib/languages/shell';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import mermaid from 'mermaid';
import { marked } from 'marked';
import { render as renderPlantUml } from 'puml-canvas-js';
import { ensureMarkdownViewerStyles } from './markdownViewerStyles';

export interface MarkdownViewerHandle { dispose(): void; }
type ViewMode = 'preview' | 'split' | 'source';

interface ViewerDom {
    root: HTMLElement;
    workspace: HTMLElement;
    previewPanel: HTMLElement;
    sourcePanel: HTMLElement;
    preview: HTMLElement;
    sourceHighlight: HTMLElement;
    source: HTMLTextAreaElement;
    status: HTMLElement;
    summary: HTMLElement;
    previewCaption: HTMLElement;
    sourceCaption: HTMLElement;
    message: HTMLElement;
    renderButton: HTMLButtonElement;
    copyHtmlButton: HTMLButtonElement;
    copySourceButton: HTMLButtonElement;
}

let languagesRegistered = false;
let mermaidInitialized = false;
let renderCounter = 0;

function initializeLibraries(): void {
    if (!languagesRegistered) {
        const languages = { bash, css, diff, ini, javascript, json, markdown, plaintext, shell, typescript, xml, yaml };
        Object.entries(languages).forEach(([name, language]) => hljs.registerLanguage(name, language));
        hljs.registerLanguage('html', xml);
        hljs.registerLanguage('js', javascript);
        hljs.registerLanguage('md', markdown);
        hljs.registerLanguage('sh', bash);
        hljs.registerLanguage('ts', typescript);
        hljs.registerLanguage('tsx', typescript);
        hljs.registerLanguage('yml', yaml);
        languagesRegistered = true;
    }
    if (!mermaidInitialized) {
        mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: 'default',
            // DOMPurify's SVG profile intentionally removes HTML nested in
            // foreignObject. Native SVG labels keep Mermaid node text visible
            // after the generated diagram is sanitized.
            htmlLabels: false
        });
        mermaidInitialized = true;
    }
}

export async function mountMarkdownViewer(file: File, container: HTMLElement): Promise<MarkdownViewerHandle> {
    ensureMarkdownViewerStyles();
    initializeLibraries();
    container.innerHTML = '';
    container.classList.add('markdown-viewer-host');
    const dom = buildShell(container, file);
    const cleanups: Array<() => void> = [];
    let source = '';
    let renderedHtml = '';
    let diagramCount = 0;

    try {
        source = await file.text();
    } catch (error) {
        showMessage(dom, `Failed to read file: ${errorMessage(error)}`);
        return makeHandle(container, cleanups);
    }
    dom.source.value = source;
    updateSourceHighlight(dom);

    const setMode = (mode: ViewMode) => {
        dom.workspace.classList.toggle('is-split', mode === 'split');
        dom.workspace.classList.toggle('is-source', mode === 'source');
        dom.previewPanel.classList.remove('is-hidden');
        dom.sourcePanel.classList.toggle('is-hidden', mode === 'preview');
        dom.root.querySelectorAll<HTMLButtonElement>('[data-view-mode]').forEach((button) => {
            const active = button.dataset.viewMode === mode;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
        });
    };

    const render = async () => {
        try {
            source = dom.source.value;
            diagramCount = 0;
            renderedHtml = DOMPurify.sanitize(await marked.parse(source, { gfm: true }), {
                USE_PROFILES: { html: true },
                ADD_ATTR: ['target', 'rel'],
                FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select'],
                FORBID_ATTR: ['style', 'srcdoc']
            });
            dom.preview.innerHTML = renderedHtml;
            hardenLinksAndImages(dom.preview);
            highlightCode(dom.preview);
            diagramCount += await renderMermaidBlocks(dom.preview);
            diagramCount += renderPlantUmlBlocks(dom.preview);
            const lines = source ? source.split(/\r?\n/).length : 0;
            const words = (source.match(/\S+/g) || []).length;
            dom.summary.textContent = `${lines} lines, ${words} words`;
            dom.previewCaption.textContent = diagramCount ? `HTML rendered, ${diagramCount} diagram(s)` : 'HTML rendered';
            dom.sourceCaption.textContent = 'Editable';
            setStatus(dom, 'Rendered', true);
            showMessage(dom, '');
        } catch (error) {
            dom.preview.textContent = '';
            renderedHtml = '';
            dom.previewCaption.textContent = 'Render failed';
            setStatus(dom, 'Invalid', false);
            showMessage(dom, errorMessage(error));
        }
    };

    const onClick = (event: Event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>('[data-view-mode]');
        if (button?.dataset.viewMode) setMode(button.dataset.viewMode as ViewMode);
    };
    const onInput = () => {
        updateSourceHighlight(dom);
        dom.renderButton.classList.add('is-dirty');
        dom.sourceCaption.textContent = 'Edited';
        setStatus(dom, 'Modified');
    };
    const onSourceScroll = () => syncSourceScroll(dom);
    const onRender = async () => { dom.renderButton.classList.remove('is-dirty'); await render(); };
    const onSave = () => {
        downloadText(dom.source.value, file.name, file.type || 'text/markdown');
        dom.sourceCaption.textContent = 'Saved';
        setStatus(dom, 'Saved', true);
    };
    const onCopyHtml = () => copyText(renderedHtml, dom, 'HTML copied');
    const onCopySource = () => copyText(dom.source.value, dom, 'Source copied');
    const onKeyDown = (event: KeyboardEvent) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            onSave();
        } else if (event.shiftKey && event.key === 'Enter') {
            event.preventDefault();
            void onRender();
        }
    };

    dom.root.addEventListener('click', onClick);
    dom.source.addEventListener('input', onInput);
    dom.source.addEventListener('scroll', onSourceScroll);
    dom.source.addEventListener('keydown', onKeyDown);
    dom.renderButton.addEventListener('click', onRender);
    dom.copyHtmlButton.addEventListener('click', onCopyHtml);
    dom.copySourceButton.addEventListener('click', onCopySource);
    cleanups.push(() => {
        dom.root.removeEventListener('click', onClick);
        dom.source.removeEventListener('input', onInput);
        dom.source.removeEventListener('scroll', onSourceScroll);
        dom.source.removeEventListener('keydown', onKeyDown);
        dom.renderButton.removeEventListener('click', onRender);
        dom.copyHtmlButton.removeEventListener('click', onCopyHtml);
        dom.copySourceButton.removeEventListener('click', onCopySource);
    });

    setMode('preview');
    await render();
    return makeHandle(container, cleanups);
}

function buildShell(container: HTMLElement, file: File): ViewerDom {
    container.innerHTML = `
        <div class="markdown-shell">
            <header class="markdown-header"><div><div class="markdown-title"></div><div class="markdown-summary"></div></div><div class="markdown-status">Ready</div></header>
            <div class="markdown-toolbar">
                <div class="markdown-toolbar-group"><button type="button" data-view-mode="preview">Preview</button><button type="button" data-view-mode="split">Split</button><button type="button" data-view-mode="source">Source</button></div>
                <div class="markdown-toolbar-group"><button type="button" class="is-primary" data-action="render">Render</button><button type="button" data-action="copy-html">Copy HTML</button><button type="button" data-action="copy-source">Copy Source</button></div>
            </div>
            <main class="markdown-workspace">
                <section class="markdown-panel markdown-preview-panel"><div class="markdown-panel-header"><span>Preview</span><span class="markdown-preview-caption">Rendering</span></div><article class="markdown-preview"></article></section>
                <section class="markdown-panel markdown-source-panel"><div class="markdown-panel-header"><span>Source</span><span class="markdown-source-caption">Editable</span></div><div class="markdown-source-editor"><pre class="markdown-source-highlight" aria-hidden="true"></pre><textarea class="markdown-source" spellcheck="false" aria-label="Markdown source"></textarea></div></section>
            </main>
            <div class="markdown-message is-hidden"></div>
        </div>`;
    requireElement<HTMLElement>(container, '.markdown-title').textContent = file.name;
    requireElement<HTMLElement>(container, '.markdown-summary').textContent = `${formatBytes(file.size)} Markdown document`;
    return {
        root: container,
        workspace: requireElement(container, '.markdown-workspace'),
        previewPanel: requireElement(container, '.markdown-preview-panel'),
        sourcePanel: requireElement(container, '.markdown-source-panel'),
        preview: requireElement(container, '.markdown-preview'),
        sourceHighlight: requireElement(container, '.markdown-source-highlight'),
        source: requireElement(container, '.markdown-source'),
        status: requireElement(container, '.markdown-status'),
        summary: requireElement(container, '.markdown-summary'),
        previewCaption: requireElement(container, '.markdown-preview-caption'),
        sourceCaption: requireElement(container, '.markdown-source-caption'),
        message: requireElement(container, '.markdown-message'),
        renderButton: requireElement(container, '[data-action="render"]'),
        copyHtmlButton: requireElement(container, '[data-action="copy-html"]'),
        copySourceButton: requireElement(container, '[data-action="copy-source"]')
    };
}

function updateSourceHighlight(dom: ViewerDom): void {
    const source = dom.source.value;
    dom.sourceHighlight.innerHTML = hljs.highlight(source, {
        language: 'markdown',
        ignoreIllegals: true
    }).value + (source.endsWith('\n') ? '\n' : '');
    syncSourceScroll(dom);
}

function syncSourceScroll(dom: ViewerDom): void {
    dom.sourceHighlight.scrollTop = dom.source.scrollTop;
    dom.sourceHighlight.scrollLeft = dom.source.scrollLeft;
}

function hardenLinksAndImages(root: HTMLElement): void {
    root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((link) => {
        const href = sanitizeUrl(link.getAttribute('href') || '');
        if (href === 'about:blank') link.removeAttribute('href');
        else { link.href = href; link.target = '_blank'; link.rel = 'noreferrer noopener'; }
    });
    root.querySelectorAll<HTMLImageElement>('img[src]').forEach((image) => {
        const src = sanitizeUrl(image.getAttribute('src') || '');
        if (src === 'about:blank') image.removeAttribute('src');
        else image.src = src;
    });
}

function languageOf(block: Element): string {
    const className = Array.from(block.classList).find((name) => name.startsWith('language-') || name.startsWith('lang-'));
    return className ? className.replace(/^(language-|lang-)/, '').toLowerCase() : '';
}

function highlightCode(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>('pre > code').forEach((block) => {
        const language = languageOf(block);
        if (['mermaid', 'plantuml', 'puml', 'uml'].includes(language)) return;
        const source = block.textContent || '';
        const result = language && hljs.getLanguage(language)
            ? hljs.highlight(source, { language, ignoreIllegals: true })
            : hljs.highlightAuto(source);
        block.innerHTML = result.value;
        block.classList.add('hljs');
    });
}

async function renderMermaidBlocks(root: HTMLElement): Promise<number> {
    const blocks = Array.from(root.querySelectorAll<HTMLElement>('pre > code.language-mermaid, pre > code.lang-mermaid'));
    await Promise.all(blocks.map(async (block) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'markdown-diagram';
        try {
            const result = await mermaid.render(`omni-md-${Date.now()}-${renderCounter++}`, block.textContent || '');
            wrapper.innerHTML = DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true } });
        } catch (error) {
            wrapper.classList.add('is-invalid');
            wrapper.textContent = errorMessage(error);
        }
        block.closest('pre')?.replaceWith(wrapper);
    }));
    return blocks.length;
}

function renderPlantUmlBlocks(root: HTMLElement): number {
    const blocks = Array.from(root.querySelectorAll<HTMLElement>('pre > code.language-plantuml, pre > code.lang-plantuml, pre > code.language-puml, pre > code.lang-puml, pre > code.language-uml, pre > code.lang-uml'));
    blocks.forEach((block) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'markdown-diagram';
        try {
            const svg = renderPlantUml(block.textContent || '', { document });
            wrapper.innerHTML = DOMPurify.sanitize(new XMLSerializer().serializeToString(svg), { USE_PROFILES: { svg: true, svgFilters: true } });
        } catch (error) {
            wrapper.classList.add('is-invalid');
            wrapper.textContent = errorMessage(error);
        }
        block.closest('pre')?.replaceWith(wrapper);
    });
    return blocks.length;
}

async function copyText(value: string, dom: ViewerDom, message: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(value);
        setStatus(dom, message, true);
    } catch (error) {
        setStatus(dom, 'Copy failed', false);
        showMessage(dom, errorMessage(error));
    }
}

function setStatus(dom: ViewerDom, value: string, valid?: boolean): void {
    dom.status.textContent = value;
    dom.status.classList.toggle('is-valid', valid === true);
    dom.status.classList.toggle('is-invalid', valid === false);
}

function showMessage(dom: ViewerDom, value: string): void {
    dom.message.textContent = value;
    dom.message.classList.toggle('is-hidden', !value);
}

function makeHandle(container: HTMLElement, cleanups: Array<() => void>): MarkdownViewerHandle {
    return { dispose(): void { cleanups.forEach((cleanup) => cleanup()); container.classList.remove('markdown-viewer-host'); container.innerHTML = ''; } };
}

function requireElement<T extends Element>(root: ParentNode, selector: string): T {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing Markdown viewer element: ${selector}`);
    return element;
}

function formatBytes(bytes: number): string {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function downloadText(value: string, fileName: string, type: string): void {
    const url = URL.createObjectURL(new Blob([value], { type }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
