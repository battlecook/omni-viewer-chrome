import { AutomotiveViewerModel, parseAutomotiveFile } from './automotiveParsers';
import { DbcMessage, DbcSignal, DbcViewerModel, parseDbc } from './dbcParser';
import { ensureAutomotiveViewerStyles } from './automotiveViewerStyles';

export interface AutomotiveViewerHandle { dispose(): void; }

export async function mountAutomotiveViewer(file: File, container: HTMLElement): Promise<AutomotiveViewerHandle> {
    ensureAutomotiveViewerStyles();
    container.innerHTML = '';
    container.classList.add('automotive-viewer-host');
    const cleanups: Array<() => void> = [];
    try {
        if (extensionOf(file.name) === '.dbc') {
            mountDbcWorkbench(container, file, await readBlobText(file), cleanups);
        } else {
            mountTableViewer(container, file, await parseAutomotiveFile(file), cleanups);
        }
    } catch (error) {
        container.innerHTML = `<div class="automotive-error">Failed to inspect ${escapeHtml(file.name)}: ${escapeHtml(errorMessage(error))}</div>`;
    }
    return { dispose(): void { cleanups.forEach((cleanup) => cleanup()); container.classList.remove('automotive-viewer-host'); container.innerHTML = ''; } };
}

function mountTableViewer(container: HTMLElement, file: File, model: AutomotiveViewerModel, cleanups: Array<() => void>): void {
    container.innerHTML = `
        <div class="automotive-app">
            <header class="automotive-topbar"><div><div class="automotive-eyebrow automotive-kind"></div><h1></h1><div class="automotive-subtitle"></div></div></header>
            <section class="automotive-summary-grid"></section>
            <div class="automotive-table-toolbar"><input type="search" placeholder="Search tables..." aria-label="Search tables"><div class="automotive-tabs"></div><button type="button" data-action="copy-json">Copy JSON</button></div>
            <section class="automotive-warning-panel is-hidden"></section>
            <main class="automotive-content"><section class="automotive-table-panel"></section><section class="automotive-raw-panel is-hidden"><pre></pre></section></main>
        </div>`;
    setText(container, '.automotive-eyebrow', model.format || 'Automotive');
    setText(container, 'h1', file.name);
    setText(container, '.automotive-subtitle', `${model.title} · ${model.fileSize}`);
    const summary = requireElement(container, '.automotive-summary-grid');
    summary.innerHTML = model.summary.map((item) => `<div class="automotive-summary-item"><div class="automotive-summary-value">${escapeHtml(item.value)}</div><div class="automotive-summary-label">${escapeHtml(item.label)}</div></div>`).join('');
    const warning = requireElement(container, '.automotive-warning-panel');
    if (model.warnings.length) { warning.classList.remove('is-hidden'); warning.innerHTML = model.warnings.map((item) => `<div>${escapeHtml(item)}</div>`).join(''); }
    const search = requireElement<HTMLInputElement>(container, 'input[type="search"]');
    const tabs = requireElement(container, '.automotive-tabs');
    const tablePanel = requireElement(container, '.automotive-table-panel');
    const rawPanel = requireElement(container, '.automotive-raw-panel');
    const rawPreview = requireElement(container, '.automotive-raw-panel pre');
    const copyButton = requireElement<HTMLButtonElement>(container, '[data-action="copy-json"]');
    let active = 'table-0';
    const renderTabs = () => {
        tabs.innerHTML = '';
        model.tables.forEach((table, index) => tabs.appendChild(tabButton(`table-${index}`, table.title)));
        if (model.rawPreview) tabs.appendChild(tabButton('raw', 'Raw Preview'));
    };
    const tabButton = (id: string, label: string): HTMLButtonElement => {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.classList.toggle('is-active', id === active);
        button.addEventListener('click', () => { active = id; renderTabs(); render(); }); return button;
    };
    const render = () => {
        if (active === 'raw') { tablePanel.classList.add('is-hidden'); rawPanel.classList.remove('is-hidden'); rawPreview.textContent = model.rawPreview || ''; return; }
        rawPanel.classList.add('is-hidden'); tablePanel.classList.remove('is-hidden');
        const table = model.tables[Number(active.replace('table-', '')) || 0];
        if (!table) { tablePanel.innerHTML = '<div class="automotive-empty">No data available.</div>'; return; }
        const query = search.value.trim().toLowerCase();
        const rows = query ? table.rows.filter((row) => row.some((cell) => String(cell ?? '').toLowerCase().includes(query))) : table.rows;
        const visible = rows.slice(0, 1000);
        tablePanel.innerHTML = `<div class="automotive-panel-header"><h2>${escapeHtml(table.title)}</h2><span>${visible.length}${rows.length > visible.length ? ` / ${rows.length}` : ''} matching rows</span></div><div class="automotive-table-wrap"><table><thead><tr>${table.headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${visible.map((row) => `<tr>${row.map((cell) => `<td title="${escapeHtml(cell)}">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    };
    const onSearch = () => render();
    const onCopy = async () => { await copyText(JSON.stringify(model, null, 2)); copyButton.textContent = 'Copied'; window.setTimeout(() => { copyButton.textContent = 'Copy JSON'; }, 1200); };
    search.addEventListener('input', onSearch); copyButton.addEventListener('click', onCopy);
    cleanups.push(() => { search.removeEventListener('input', onSearch); copyButton.removeEventListener('click', onCopy); });
    renderTabs(); render();
}

function mountDbcWorkbench(container: HTMLElement, file: File, source: string, cleanups: Array<() => void>): void {
    const model = parseDbc(source);
    let selectedMessage: DbcMessage | null = model.messages[0] || null;
    let selectedSignal: DbcSignal | null = selectedMessage?.signals[0] || null;
    let activeTab = 'signals';
    container.innerHTML = `
        <div class="dbc-shell">
            <header class="dbc-header"><div><div class="dbc-title"></div><div class="dbc-subtitle"></div></div><div class="dbc-status"></div></header>
            <section class="dbc-summary"></section>
            <section class="dbc-toolbar"><input class="dbc-search" type="search" placeholder="Search messages, signals, comments..."><label>Node <select class="dbc-node-filter"><option value="">All nodes</option></select></label><button type="button" data-action="copy-message">Copy Message JSON</button><button type="button" data-action="copy-source">Copy Source</button></section>
            <main class="dbc-workspace"><section class="dbc-message-panel"><div class="dbc-panel-header"><span>Messages</span><span class="dbc-message-caption"></span></div><div class="dbc-message-list"></div></section>
            <section class="dbc-detail-panel"><div class="dbc-detail-header"><div><div class="dbc-detail-title"></div><div class="dbc-detail-subtitle"></div></div><div class="dbc-message-meta"></div></div><div class="dbc-tabs"><button data-tab="signals">Signals</button><button data-tab="raw">Raw DBC</button><button data-tab="nodes">Nodes</button></div><div class="dbc-signals-tab"><div class="dbc-comment is-hidden"></div><div class="dbc-table-wrap"><table><thead><tr><th>Name</th><th>Start</th><th>Length</th><th>Endian</th><th>Type</th><th>Scale</th><th>Offset</th><th>Range</th><th>Unit</th><th>Receivers</th></tr></thead><tbody></tbody></table></div><div class="dbc-signal-detail is-hidden"></div></div><textarea class="dbc-source is-hidden" readonly></textarea><div class="dbc-nodes is-hidden"></div></section></main>
            <section class="dbc-warnings is-hidden"></section>
        </div>`;
    setText(container, '.dbc-title', file.name); setText(container, '.dbc-subtitle', `${formatSize(file.size)} · DBC network database`);
    setText(container, '.dbc-status', model.warnings.length ? `${model.warnings.length} warning(s)` : 'DBC ready');
    requireElement(container, '.dbc-status').classList.toggle('is-warning', model.warnings.length > 0);
    requireElement(container, '.dbc-summary').innerHTML = summaryCards(model);
    const search = requireElement<HTMLInputElement>(container, '.dbc-search');
    const nodeFilter = requireElement<HTMLSelectElement>(container, '.dbc-node-filter');
    model.nodes.forEach((node) => { const option = document.createElement('option'); option.value = node; option.textContent = node; nodeFilter.appendChild(option); });
    const sourceView = requireElement<HTMLTextAreaElement>(container, '.dbc-source'); sourceView.value = source;
    requireElement(container, '.dbc-nodes').innerHTML = model.nodes.length ? model.nodes.map((node) => `<span class="dbc-chip">${escapeHtml(node)}</span>`).join('') : '<div class="automotive-empty">No nodes declared.</div>';
    const warnings = requireElement(container, '.dbc-warnings'); if (model.warnings.length) { warnings.classList.remove('is-hidden'); warnings.innerHTML = model.warnings.map((item) => `<div>${escapeHtml(item)}</div>`).join(''); }

    const renderMessages = () => {
        const query = search.value.trim().toLowerCase(); const node = nodeFilter.value;
        const visible = model.messages.filter((message) => matchesMessage(message, query, node));
        setText(container, '.dbc-message-caption', `${visible.length} visible`);
        const list = requireElement(container, '.dbc-message-list'); list.innerHTML = '';
        if (!visible.length) { list.innerHTML = '<div class="automotive-empty">No messages match the current filter.</div>'; return; }
        visible.forEach((message) => { const row = document.createElement('button'); row.type = 'button'; row.className = `dbc-message-row${selectedMessage?.id === message.id ? ' is-selected' : ''}`; row.innerHTML = `<span class="dbc-message-name">${escapeHtml(message.name)}</span><span>${message.idHex}</span><span class="dbc-message-extra">DLC ${message.dlc} | ${message.signals.length} signal(s) | ${escapeHtml(message.transmitter)}</span>`; row.addEventListener('click', () => { selectedMessage = message; selectedSignal = message.signals[0] || null; renderMessages(); renderDetail(); }); list.appendChild(row); });
    };
    const renderSignals = () => {
        const body = requireElement<HTMLTableSectionElement>(container, '.dbc-table-wrap tbody'); body.innerHTML = '';
        if (!selectedMessage?.signals.length) { body.innerHTML = '<tr><td colspan="10">No signals defined for this message.</td></tr>'; return; }
        selectedMessage.signals.forEach((signal) => { const row = document.createElement('tr'); row.classList.toggle('is-selected', selectedSignal?.name === signal.name); row.innerHTML = `<td>${escapeHtml(signal.name)}${signal.multiplexer ? ` <span class="dbc-chip">${signal.multiplexer}</span>` : ''}</td><td>${signal.startBit}</td><td>${signal.length}</td><td>${signal.byteOrder === 'little_endian' ? 'Intel' : 'Motorola'}</td><td>${signal.valueType}</td><td>${signal.factor}</td><td>${signal.offset}</td><td>${signal.minimum}..${signal.maximum}</td><td>${escapeHtml(signal.unit || '-')}</td><td>${escapeHtml(signal.receivers.join(', ') || '-')}</td>`; row.addEventListener('click', () => { selectedSignal = signal; renderSignals(); renderSignalDetail(); }); body.appendChild(row); });
    };
    const renderSignalDetail = () => {
        const detail = requireElement(container, '.dbc-signal-detail'); detail.classList.toggle('is-hidden', !selectedSignal); if (!selectedSignal) return;
        detail.innerHTML = `<div><strong>${escapeHtml(selectedSignal.name)}</strong> | raw bits ${selectedSignal.startBit}-${selectedSignal.startBit + selectedSignal.length - 1} | physical = raw * ${selectedSignal.factor} + ${selectedSignal.offset}</div>${selectedSignal.values.length ? `<div><strong>Values</strong><div>${selectedSignal.values.map((value) => `<span class="dbc-chip">${value.value}: ${escapeHtml(value.label)}</span>`).join('')}</div></div>` : ''}${selectedSignal.comment ? `<div><strong>Comment</strong><div>${escapeHtml(selectedSignal.comment)}</div></div>` : ''}`;
    };
    const renderDetail = () => {
        setText(container, '.dbc-detail-title', selectedMessage?.name || 'No message selected'); setText(container, '.dbc-detail-subtitle', selectedMessage ? `Frame ${selectedMessage.id} (${selectedMessage.idHex}) at line ${selectedMessage.line}` : 'Select a message to inspect signals');
        requireElement(container, '.dbc-message-meta').innerHTML = selectedMessage ? `<span class="dbc-chip">DLC ${selectedMessage.dlc}</span><span class="dbc-chip">${escapeHtml(selectedMessage.transmitter)}</span><span class="dbc-chip">${selectedMessage.signals.length} signal(s)</span>` : '';
        const comment = requireElement(container, '.dbc-comment'); comment.classList.toggle('is-hidden', !selectedMessage?.comment); comment.textContent = selectedMessage?.comment || '';
        renderSignals(); renderSignalDetail();
    };
    const setTab = (tab: string) => { activeTab = tab; container.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => button.classList.toggle('is-active', button.dataset.tab === tab)); requireElement(container, '.dbc-signals-tab').classList.toggle('is-hidden', tab !== 'signals'); sourceView.classList.toggle('is-hidden', tab !== 'raw'); requireElement(container, '.dbc-nodes').classList.toggle('is-hidden', tab !== 'nodes'); };
    const onSearch = () => renderMessages(); const onNode = () => renderMessages();
    search.addEventListener('input', onSearch); nodeFilter.addEventListener('change', onNode);
    container.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => button.addEventListener('click', () => setTab(button.dataset.tab || 'signals')));
    requireElement<HTMLButtonElement>(container, '[data-action="copy-message"]').addEventListener('click', () => selectedMessage && void copyText(JSON.stringify(selectedMessage, null, 2)));
    requireElement<HTMLButtonElement>(container, '[data-action="copy-source"]').addEventListener('click', () => void copyText(source));
    cleanups.push(() => { search.removeEventListener('input', onSearch); nodeFilter.removeEventListener('change', onNode); });
    renderMessages(); renderDetail(); setTab(activeTab);
}

function summaryCards(model: DbcViewerModel): string { return [['Messages', model.stats.messageCount], ['Signals', model.stats.signalCount], ['Nodes', model.stats.nodeCount], ['Max DLC', model.stats.maxDlc], ['Version', model.version || '-']].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join(''); }
function matchesMessage(message: DbcMessage, query: string, node: string): boolean { if (node && message.transmitter !== node && !message.signals.some((signal) => signal.receivers.includes(node))) return false; if (!query) return true; return [message.name, message.id, message.idHex, message.transmitter, message.comment || '', ...message.signals.flatMap((signal) => [signal.name, signal.unit, signal.comment || '', ...signal.receivers])].join(' ').toLowerCase().includes(query); }
async function copyText(text: string): Promise<void> { if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text); }
function setText(root: ParentNode, selector: string, value: unknown): void { requireElement<HTMLElement>(root, selector).textContent = String(value ?? ''); }
function requireElement<T extends Element = HTMLElement>(root: ParentNode, selector: string): T { const element = root.querySelector<T>(selector); if (!element) throw new Error(`Missing automotive viewer element: ${selector}`); return element; }
function escapeHtml(value: unknown): string { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char)); }
function extensionOf(name: string): string { const index = name.lastIndexOf('.'); return index < 0 ? '' : name.slice(index).toLowerCase(); }
function formatSize(bytes: number): string { if (!bytes) return '0 B'; const units = ['B', 'KB', 'MB', 'GB']; const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024))); return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
async function readBlobText(blob: Blob): Promise<string> {
    const candidate = blob as Blob & { text?: () => Promise<string> };
    if (typeof candidate.text === 'function') return candidate.text();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error('Failed to read text file.'));
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.readAsText(blob);
    });
}
