import mermaid from 'mermaid';
import { ensureMermaidViewerStyles } from './mermaidViewerStyles';

export interface MermaidViewerHandle { dispose(): void; }
type ViewMode = 'diagram' | 'split' | 'source';
type MermaidTheme = 'default' | 'dark' | 'forest' | 'neutral';

interface ViewerDom {
    root: HTMLElement;
    workspace: HTMLElement;
    diagramPanel: HTMLElement;
    sourcePanel: HTMLElement;
    diagram: HTMLElement;
    source: HTMLTextAreaElement;
    zoomLabel: HTMLElement;
    status: HTMLElement;
    message: HTMLElement;
    theme: HTMLSelectElement;
    renderButton: HTMLButtonElement;
    saveButton: HTMLButtonElement;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;
let renderCounter = 0;

export async function mountMermaidViewer(file: File, container: HTMLElement): Promise<MermaidViewerHandle> {
    ensureMermaidViewerStyles();
    container.innerHTML = '';
    container.classList.add('mermaid-viewer-host');
    const dom = buildShell(container, file);
    const cleanups: Array<() => void> = [];
    let zoom = 1;
    let renderedSvg = '';
    let savedSource = '';

    try {
        savedSource = await file.text();
        dom.source.value = savedSource;
    } catch (error) {
        showMessage(dom, `Failed to read file: ${errorMessage(error)}`, false);
        return makeHandle(container, cleanups);
    }

    const setMode = (mode: ViewMode) => {
        dom.workspace.dataset.mode = mode;
        dom.root.querySelectorAll<HTMLButtonElement>('[data-view-mode]').forEach((button) => {
            const active = button.dataset.viewMode === mode;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
        });
    };
    const setZoom = (value: number) => {
        zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
        dom.diagram.style.transform = `scale(${zoom})`;
        dom.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    };
    const renderDiagram = async () => {
        dom.status.textContent = 'Rendering';
        dom.message.hidden = true;
        try {
            mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dom.theme.value as MermaidTheme });
            const result = await mermaid.render(`omni-mermaid-${Date.now()}-${renderCounter++}`, dom.source.value);
            renderedSvg = result.svg;
            dom.diagram.innerHTML = result.svg;
            dom.status.textContent = 'Rendered';
            dom.status.className = 'mermaid-status is-valid';
        } catch (error) {
            renderedSvg = '';
            dom.diagram.replaceChildren();
            showMessage(dom, errorMessage(error), false);
        }
    };
    const save = () => {
        downloadText(dom.source.value, file.name, file.type || 'text/plain');
        savedSource = dom.source.value;
        dom.saveButton.classList.remove('is-dirty');
        dom.status.textContent = 'Saved';
        dom.status.className = 'mermaid-status is-valid';
    };
    const copy = async (value: string, message: string) => {
        await navigator.clipboard.writeText(value);
        dom.status.textContent = message;
    };
    const onClick = (event: Event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>('button');
        if (!button) return;
        if (button.dataset.viewMode) setMode(button.dataset.viewMode as ViewMode);
        else if (button.dataset.action === 'render') void renderDiagram();
        else if (button.dataset.action === 'save') save();
        else if (button.dataset.action === 'zoom-out') setZoom(zoom - ZOOM_STEP);
        else if (button.dataset.action === 'zoom-in') setZoom(zoom + ZOOM_STEP);
        else if (button.dataset.action === 'zoom-reset') setZoom(1);
        else if (button.dataset.action === 'copy-svg' && renderedSvg) void copy(renderedSvg, 'SVG copied');
        else if (button.dataset.action === 'copy-source') void copy(dom.source.value, 'Source copied');
    };
    const onInput = () => {
        dom.saveButton.classList.toggle('is-dirty', dom.source.value !== savedSource);
        dom.status.textContent = 'Modified';
        dom.status.className = 'mermaid-status';
    };
    const onKeyDown = (event: KeyboardEvent) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            save();
        } else if (event.shiftKey && event.key === 'Enter') {
            event.preventDefault();
            void renderDiagram();
        }
    };
    const onTheme = () => void renderDiagram();

    dom.root.addEventListener('click', onClick);
    dom.source.addEventListener('input', onInput);
    dom.source.addEventListener('keydown', onKeyDown);
    dom.theme.addEventListener('change', onTheme);
    cleanups.push(() => dom.root.removeEventListener('click', onClick));
    cleanups.push(() => dom.source.removeEventListener('input', onInput));
    cleanups.push(() => dom.source.removeEventListener('keydown', onKeyDown));
    cleanups.push(() => dom.theme.removeEventListener('change', onTheme));

    setMode('diagram');
    setZoom(1);
    await renderDiagram();
    return makeHandle(container, cleanups);
}

function buildShell(container: HTMLElement, file: File): ViewerDom {
    container.innerHTML = `
      <div class="mermaid-shell">
        <header class="mermaid-header"><div><div class="mermaid-title"></div><div class="mermaid-file-info"></div></div><div class="mermaid-status">Ready</div></header>
        <div class="mermaid-toolbar">
          <div class="mermaid-toolbar-group"><button class="mermaid-button is-active" data-view-mode="diagram" type="button">Diagram</button><button class="mermaid-button" data-view-mode="split" type="button">Split</button><button class="mermaid-button" data-view-mode="source" type="button">Source</button></div>
          <label class="mermaid-select-field"><span>Theme</span><select class="mermaid-select" aria-label="Theme"><option value="default">Default</option><option value="dark">Dark</option><option value="forest">Forest</option><option value="neutral">Neutral</option></select></label>
          <div class="mermaid-toolbar-group"><button class="mermaid-button is-primary" data-action="render" type="button">Render</button><button class="mermaid-button" data-action="save" type="button">Save</button></div>
          <div class="mermaid-toolbar-group"><button class="mermaid-button" data-action="zoom-out" type="button">-</button><button class="mermaid-button mermaid-zoom-label" data-action="zoom-reset" type="button">100%</button><button class="mermaid-button" data-action="zoom-in" type="button">+</button></div>
          <div class="mermaid-toolbar-group"><button class="mermaid-button" data-action="copy-svg" type="button">Copy SVG</button><button class="mermaid-button" data-action="copy-source" type="button">Copy Source</button></div>
        </div>
        <main class="mermaid-workspace" data-mode="diagram"><section class="mermaid-panel mermaid-diagram-panel"><div class="mermaid-panel-header"><span>Diagram</span><span>Rendering</span></div><div class="mermaid-canvas"><div class="mermaid-diagram"></div></div></section><section class="mermaid-panel mermaid-source-panel"><div class="mermaid-panel-header"><span>Source</span><span>Editable</span></div><textarea class="mermaid-source" spellcheck="false" aria-label="Mermaid source"></textarea></section></main>
        <div class="mermaid-message" hidden></div>
      </div>`;
    requireElement<HTMLElement>(container, '.mermaid-title').textContent = file.name;
    requireElement<HTMLElement>(container, '.mermaid-file-info').textContent = `${formatBytes(file.size)} Mermaid diagram`;
    return {
        root: container, workspace: requireElement(container, '.mermaid-workspace'),
        diagramPanel: requireElement(container, '.mermaid-diagram-panel'), sourcePanel: requireElement(container, '.mermaid-source-panel'),
        diagram: requireElement(container, '.mermaid-diagram'), source: requireElement(container, '.mermaid-source'), zoomLabel: requireElement(container, '.mermaid-zoom-label'),
        status: requireElement(container, '.mermaid-status'), message: requireElement(container, '.mermaid-message'), theme: requireElement(container, '.mermaid-select'),
        renderButton: requireElement(container, '[data-action="render"]'), saveButton: requireElement(container, '[data-action="save"]')
    };
}

function showMessage(dom: ViewerDom, message: string, valid: boolean): void {
    dom.message.textContent = message; dom.message.hidden = false;
    dom.status.textContent = valid ? 'Ready' : 'Invalid'; dom.status.className = `mermaid-status ${valid ? 'is-valid' : 'is-invalid'}`;
}
function downloadText(value: string, name: string, type: string): void { const url = URL.createObjectURL(new Blob([value], { type })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function makeHandle(container: HTMLElement, cleanups: Array<() => void>): MermaidViewerHandle { return { dispose(): void { cleanups.forEach((fn) => fn()); container.classList.remove('mermaid-viewer-host'); container.innerHTML = ''; } }; }
function requireElement<T extends Element>(root: ParentNode, selector: string): T { const element = root.querySelector<T>(selector); if (!element) throw new Error(`Missing Mermaid viewer element: ${selector}`); return element; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function formatBytes(bytes: number): string { if (!bytes) return '0 B'; const units = ['B', 'KB', 'MB', 'GB']; const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024))); return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`; }
