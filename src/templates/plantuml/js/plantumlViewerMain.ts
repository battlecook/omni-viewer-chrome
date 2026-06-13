import { render as renderPlantUml } from 'puml-canvas-js';
import { ensurePlantUmlViewerStyles } from './plantumlViewerStyles';

export interface PlantUmlViewerHandle { dispose(): void; }
type ViewMode = 'diagram' | 'split' | 'source';

interface ViewerDom {
    root: HTMLElement; workspace: HTMLElement; diagram: HTMLElement; source: HTMLTextAreaElement;
    zoomLabel: HTMLElement; status: HTMLElement; message: HTMLElement; renderMode: HTMLSelectElement; saveButton: HTMLButtonElement;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;

export async function mountPlantUmlViewer(file: File, container: HTMLElement): Promise<PlantUmlViewerHandle> {
    ensurePlantUmlViewerStyles();
    container.innerHTML = '';
    container.classList.add('plantuml-viewer-host');
    const dom = buildShell(container, file);
    const cleanups: Array<() => void> = [];
    let zoom = 1;
    let renderedSvg = '';
    let savedSource = '';
    try { savedSource = await file.text(); dom.source.value = savedSource; }
    catch (error) { showMessage(dom, `Failed to read file: ${errorMessage(error)}`); return makeHandle(container, cleanups); }

    const setMode = (mode: ViewMode) => {
        dom.workspace.dataset.mode = mode;
        dom.root.querySelectorAll<HTMLButtonElement>('[data-view-mode]').forEach((button) => {
            const active = button.dataset.viewMode === mode; button.classList.toggle('is-active', active); button.setAttribute('aria-pressed', String(active));
        });
    };
    const setZoom = (value: number) => { zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value)); dom.diagram.style.transform = `scale(${zoom})`; dom.zoomLabel.textContent = `${Math.round(zoom * 100)}%`; };
    const renderDiagram = () => {
        dom.status.textContent = 'Rendering'; dom.message.hidden = true;
        try {
            const svg = renderPlantUml(dom.source.value, { document });
            if (dom.renderMode.value === 'dark') {
                svg.style.background = '#111827'; svg.style.color = '#f9fafb';
            }
            renderedSvg = new XMLSerializer().serializeToString(svg);
            dom.diagram.replaceChildren(svg); dom.status.textContent = 'Rendered'; dom.status.className = 'plantuml-status is-valid';
        } catch (error) { renderedSvg = ''; dom.diagram.replaceChildren(); showMessage(dom, errorMessage(error)); }
    };
    const save = () => { downloadText(dom.source.value, file.name, file.type || 'text/plain'); savedSource = dom.source.value; dom.saveButton.classList.remove('is-dirty'); dom.status.textContent = 'Saved'; dom.status.className = 'plantuml-status is-valid'; };
    const copy = async (value: string, message: string) => { await navigator.clipboard.writeText(value); dom.status.textContent = message; };
    const onClick = (event: Event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>('button'); if (!button) return;
        if (button.dataset.viewMode) setMode(button.dataset.viewMode as ViewMode);
        else if (button.dataset.action === 'render') renderDiagram(); else if (button.dataset.action === 'save') save();
        else if (button.dataset.action === 'zoom-out') setZoom(zoom - ZOOM_STEP); else if (button.dataset.action === 'zoom-in') setZoom(zoom + ZOOM_STEP); else if (button.dataset.action === 'zoom-reset') setZoom(1);
        else if (button.dataset.action === 'copy-svg' && renderedSvg) void copy(renderedSvg, 'SVG copied'); else if (button.dataset.action === 'copy-source') void copy(dom.source.value, 'Source copied');
    };
    const onInput = () => { dom.saveButton.classList.toggle('is-dirty', dom.source.value !== savedSource); dom.status.textContent = 'Modified'; dom.status.className = 'plantuml-status'; };
    const onKeyDown = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); } else if (event.shiftKey && event.key === 'Enter') { event.preventDefault(); renderDiagram(); } };
    const onMode = () => renderDiagram();
    dom.root.addEventListener('click', onClick); dom.source.addEventListener('input', onInput); dom.source.addEventListener('keydown', onKeyDown); dom.renderMode.addEventListener('change', onMode);
    cleanups.push(() => dom.root.removeEventListener('click', onClick), () => dom.source.removeEventListener('input', onInput), () => dom.source.removeEventListener('keydown', onKeyDown), () => dom.renderMode.removeEventListener('change', onMode));
    setMode('diagram'); setZoom(1); renderDiagram();
    return makeHandle(container, cleanups);
}

function buildShell(container: HTMLElement, file: File): ViewerDom {
    container.innerHTML = `<div class="plantuml-shell"><header class="plantuml-header"><div><div class="plantuml-title"></div><div class="plantuml-file-info"></div></div><div class="plantuml-status">Ready</div></header>
      <div class="plantuml-toolbar"><div class="plantuml-toolbar-group"><button class="plantuml-button is-active" data-view-mode="diagram" type="button">Diagram</button><button class="plantuml-button" data-view-mode="split" type="button">Split</button><button class="plantuml-button" data-view-mode="source" type="button">Source</button></div><label class="plantuml-select-field"><span>Mode</span><select class="plantuml-select" aria-label="Render mode"><option value="light">Light</option><option value="dark">Dark</option></select></label><div class="plantuml-toolbar-group"><button class="plantuml-button is-primary" data-action="render" type="button">Render</button><button class="plantuml-button" data-action="save" type="button">Save</button></div><div class="plantuml-toolbar-group"><button class="plantuml-button" data-action="zoom-out" type="button">-</button><button class="plantuml-button plantuml-zoom-label" data-action="zoom-reset" type="button">100%</button><button class="plantuml-button" data-action="zoom-in" type="button">+</button></div><div class="plantuml-toolbar-group"><button class="plantuml-button" data-action="copy-svg" type="button">Copy SVG</button><button class="plantuml-button" data-action="copy-source" type="button">Copy Source</button></div></div>
      <main class="plantuml-workspace" data-mode="diagram"><section class="plantuml-panel plantuml-diagram-panel"><div class="plantuml-panel-header"><span>Diagram</span><span>Initializing renderer</span></div><div class="plantuml-canvas"><div class="plantuml-diagram"></div></div></section><section class="plantuml-panel plantuml-source-panel"><div class="plantuml-panel-header"><span>Source</span><span>Editable</span></div><textarea class="plantuml-source" spellcheck="false" aria-label="PlantUML source"></textarea></section></main><div class="plantuml-message" hidden></div></div>`;
    requireElement<HTMLElement>(container, '.plantuml-title').textContent = file.name; requireElement<HTMLElement>(container, '.plantuml-file-info').textContent = `${formatBytes(file.size)} PlantUML diagram`;
    return { root: container, workspace: requireElement(container, '.plantuml-workspace'), diagram: requireElement(container, '.plantuml-diagram'), source: requireElement(container, '.plantuml-source'), zoomLabel: requireElement(container, '.plantuml-zoom-label'), status: requireElement(container, '.plantuml-status'), message: requireElement(container, '.plantuml-message'), renderMode: requireElement(container, '.plantuml-select'), saveButton: requireElement(container, '[data-action="save"]') };
}
function showMessage(dom: ViewerDom, message: string): void { dom.message.textContent = message; dom.message.hidden = false; dom.status.textContent = 'Invalid'; dom.status.className = 'plantuml-status is-invalid'; }
function downloadText(value: string, name: string, type: string): void { const url = URL.createObjectURL(new Blob([value], { type })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function makeHandle(container: HTMLElement, cleanups: Array<() => void>): PlantUmlViewerHandle { return { dispose(): void { cleanups.forEach((fn) => fn()); container.classList.remove('plantuml-viewer-host'); container.innerHTML = ''; } }; }
function requireElement<T extends Element>(root: ParentNode, selector: string): T { const element = root.querySelector<T>(selector); if (!element) throw new Error(`Missing PlantUML viewer element: ${selector}`); return element; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function formatBytes(bytes: number): string { if (!bytes) return '0 B'; const units = ['B', 'KB', 'MB', 'GB']; const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024))); return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`; }
