import { Hdf5Parser } from '../../../utils/hdf5Parser';
import { ensureAutomotiveViewerStyles } from '../../automotive/js/automotiveViewerStyles';
import type { AutomotiveViewerHandle } from '../../automotive/js/automotiveViewerMain';

export type Hdf5ViewerHandle = AutomotiveViewerHandle;

export async function mountHdf5Viewer(file: File, container: HTMLElement): Promise<Hdf5ViewerHandle> {
    ensureAutomotiveViewerStyles();
    container.innerHTML = '';
    container.classList.add('automotive-viewer-host');

    try {
        const bytes = new Uint8Array(await readBlobBuffer(file));
        const model = Hdf5Parser.parse(bytes, formatSize(file.size));
        mountHdf5TableViewer(container, file, model);
    } catch (error) {
        container.innerHTML = `<div class="automotive-error">Failed to inspect ${escapeHtml(file.name)}: ${escapeHtml(errorMessage(error))}</div>`;
    }

    return {
        dispose(): void {
            container.classList.remove('automotive-viewer-host');
            container.innerHTML = '';
        },
    };
}

function mountHdf5TableViewer(container: HTMLElement, file: File, model: ReturnType<typeof Hdf5Parser.parse>): void {
    container.innerHTML = `
        <div class="automotive-app">
            <header class="automotive-topbar"><div><div class="automotive-eyebrow automotive-kind"></div><h1></h1><div class="automotive-subtitle"></div></div></header>
            <section class="automotive-summary-grid"></section>
            <div class="automotive-table-toolbar"><input type="search" placeholder="Search HDF5 metadata..." aria-label="Search HDF5 metadata"><div class="automotive-tabs"></div><button type="button" data-action="copy-json">Copy JSON</button></div>
            <section class="automotive-warning-panel is-hidden"></section>
            <main class="automotive-content"><section class="automotive-table-panel"></section><section class="automotive-raw-panel is-hidden"><pre></pre></section></main>
        </div>`;

    setText(container, '.automotive-eyebrow', model.format || 'HDF5');
    setText(container, 'h1', file.name);
    setText(container, '.automotive-subtitle', `${model.title} | ${model.fileSize}`);

    const summary = requireElement(container, '.automotive-summary-grid');
    summary.innerHTML = model.summary.map((item) => `<div class="automotive-summary-item"><div class="automotive-summary-value">${escapeHtml(item.value)}</div><div class="automotive-summary-label">${escapeHtml(item.label)}</div></div>`).join('');

    const warning = requireElement(container, '.automotive-warning-panel');
    if (model.warnings.length) {
        warning.classList.remove('is-hidden');
        warning.innerHTML = model.warnings.map((item) => `<div>${escapeHtml(item)}</div>`).join('');
    }

    const search = requireElement<HTMLInputElement>(container, 'input[type="search"]');
    const tabs = requireElement(container, '.automotive-tabs');
    const tablePanel = requireElement(container, '.automotive-table-panel');
    const rawPanel = requireElement(container, '.automotive-raw-panel');
    const rawPreview = requireElement(container, '.automotive-raw-panel pre');
    const copyButton = requireElement<HTMLButtonElement>(container, '[data-action="copy-json"]');
    let active = 'table-0';

    const tabButton = (id: string, label: string): HTMLButtonElement => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.classList.toggle('is-active', id === active);
        button.addEventListener('click', () => {
            active = id;
            renderTabs();
            render();
        });
        return button;
    };

    const renderTabs = () => {
        tabs.innerHTML = '';
        model.tables.forEach((table, index) => tabs.appendChild(tabButton(`table-${index}`, table.title)));
        if (model.rawPreview) tabs.appendChild(tabButton('raw', 'Tree Preview'));
    };

    const render = () => {
        if (active === 'raw') {
            tablePanel.classList.add('is-hidden');
            rawPanel.classList.remove('is-hidden');
            rawPreview.textContent = model.rawPreview || '';
            return;
        }
        rawPanel.classList.add('is-hidden');
        tablePanel.classList.remove('is-hidden');
        const table = model.tables[Number(active.replace('table-', '')) || 0];
        if (!table) {
            tablePanel.innerHTML = '<div class="automotive-empty">No data available.</div>';
            return;
        }
        const query = search.value.trim().toLowerCase();
        const rows = query ? table.rows.filter((row) => row.some((cell) => String(cell ?? '').toLowerCase().includes(query))) : table.rows;
        const visible = rows.slice(0, 1000);
        tablePanel.innerHTML = `<div class="automotive-panel-header"><h2>${escapeHtml(table.title)}</h2><span>${visible.length}${rows.length > visible.length ? ` / ${rows.length}` : ''} matching rows</span></div><div class="automotive-table-wrap"><table><thead><tr>${table.headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${visible.map((row) => `<tr>${row.map((cell) => `<td title="${escapeHtml(cell)}">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    };

    search.addEventListener('input', render);
    copyButton.addEventListener('click', () => {
        void copyText(JSON.stringify(model, null, 2));
        copyButton.textContent = 'Copied';
        window.setTimeout(() => { copyButton.textContent = 'Copy JSON'; }, 1200);
    });

    renderTabs();
    render();
}

async function readBlobBuffer(blob: Blob): Promise<ArrayBuffer> {
    const candidate = blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
    if (typeof candidate.arrayBuffer === 'function') return candidate.arrayBuffer();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error('Failed to read binary file.'));
        reader.onload = () => {
            if (reader.result instanceof ArrayBuffer) resolve(reader.result);
            else reject(new Error('Unexpected binary reader result.'));
        };
        reader.readAsArrayBuffer(blob);
    });
}

async function copyText(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
}

function formatSize(bytes: number): string {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function setText(root: ParentNode, selector: string, value: unknown): void {
    requireElement<HTMLElement>(root, selector).textContent = String(value ?? '');
}

function requireElement<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing HDF5 viewer element: ${selector}`);
    return element;
}

function escapeHtml(value: unknown): string {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
