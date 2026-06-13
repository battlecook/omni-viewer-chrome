jest.mock('mermaid', () => ({
    __esModule: true,
    default: {
        initialize: jest.fn(),
        render: jest.fn(async () => ({ svg: '<svg><text>diagram</text></svg>' }))
    }
}));

jest.mock('puml-canvas-js', () => ({
    render: jest.fn(() => {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'text'));
        return svg;
    })
}), { virtual: true });

jest.mock('marked', () => ({
    marked: {
        parse: jest.fn(async (source: string) => {
            if (source === '# After') return '<h1>After</h1>';
            return '<h1>Hello</h1><table><tr><td>1</td></tr></table>' +
                '<script>window.bad = true</script><a href="javascript:alert(1)">unsafe</a>' +
                '<pre><code class="language-js">const answer = 42;</code></pre>' +
                '<pre><code class="language-mermaid">graph TD; A--&gt;B;</code></pre>';
        })
    }
}));

import { mountMarkdownViewer } from '../templates/markdown/js/markdownViewerMain';
import { MARKDOWN_VIEWER_CSS } from '../templates/markdown/js/markdownViewerStyles';
import mermaid from 'mermaid';

function markdownFile(source: string): File {
    return {
        name: 'README.md',
        size: source.length,
        type: 'text/markdown',
        text: jest.fn(async () => source)
    } as unknown as File;
}

describe('Markdown viewer', () => {
    it('keeps every view mode at the full workspace height', async () => {
        expect(MARKDOWN_VIEWER_CSS).toContain('grid-template-rows:minmax(0,1fr)');
        const container = document.createElement('div');
        await mountMarkdownViewer(markdownFile('# Preview height'), container);

        container.querySelector<HTMLButtonElement>('[data-view-mode="source"]')?.click();
        const workspace = container.querySelector('.markdown-workspace')!;
        const previewPanel = container.querySelector('.markdown-preview-panel')!;
        expect(workspace.classList.contains('is-source')).toBe(true);
        expect(previewPanel.classList.contains('is-hidden')).toBe(false);
    });

    it('renders GFM, highlights code, diagrams, and sanitizes unsafe markup', async () => {
        const container = document.createElement('div');
        const handle = await mountMarkdownViewer(markdownFile([
            '# Hello',
            '',
            '| A | B |',
            '| - | - |',
            '| 1 | 2 |',
            '',
            '<script>window.bad = true</script>',
            '[unsafe](javascript:alert(1))',
            '',
            '```js',
            'const answer = 42;',
            '```',
            '',
            '```mermaid',
            'graph TD; A-->B;',
            '```'
        ].join('\n')), container);

        expect(container.querySelector('.markdown-preview h1')?.textContent).toBe('Hello');
        expect(container.querySelector('.markdown-preview table')).not.toBeNull();
        expect(container.querySelector('.markdown-preview script')).toBeNull();
        expect(container.querySelector('.markdown-preview a')?.hasAttribute('href')).toBe(false);
        expect(container.querySelector('code.hljs')).not.toBeNull();
        expect(container.querySelector('.markdown-diagram svg')).not.toBeNull();
        expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({
            htmlLabels: false,
            securityLevel: 'strict'
        }));

        container.querySelector<HTMLButtonElement>('[data-view-mode="split"]')?.click();
        expect(container.querySelector('.markdown-workspace')?.classList.contains('is-split')).toBe(true);
        handle.dispose();
        expect(container.innerHTML).toBe('');
    });

    it('re-renders edited source', async () => {
        const container = document.createElement('div');
        await mountMarkdownViewer(markdownFile('# Before'), container);
        const source = container.querySelector<HTMLTextAreaElement>('.markdown-source')!;
        source.value = '# After';
        source.dispatchEvent(new Event('input', { bubbles: true }));
        container.querySelector<HTMLButtonElement>('[data-action="render"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(container.querySelector('.markdown-preview h1')?.textContent).toBe('After');
    });

    it('highlights Markdown source and keeps the overlay scroll position in sync', async () => {
        const container = document.createElement('div');
        await mountMarkdownViewer(markdownFile('# Heading\n\n**bold**'), container);
        const source = container.querySelector<HTMLTextAreaElement>('.markdown-source')!;
        const highlight = container.querySelector<HTMLElement>('.markdown-source-highlight')!;

        expect(highlight.textContent).toBe(source.value);
        expect(highlight.querySelector('.hljs-section')).not.toBeNull();
        source.value = '## Changed';
        source.dispatchEvent(new Event('input', { bubbles: true }));
        expect(highlight.textContent).toBe('## Changed');

        source.scrollTop = 24;
        source.scrollLeft = 12;
        source.dispatchEvent(new Event('scroll'));
        expect(highlight.scrollTop).toBe(24);
        expect(highlight.scrollLeft).toBe(12);
    });
});
