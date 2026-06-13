// Orchestration layer for the archive viewer.
//
// Responsibilities (issue #55 scope only):
//   - Spawn the libarchive worker via `archiveLoader.openArchive`.
//   - Render an entry list (path tree) into the host container.
//   - On click of a file entry, request extraction and show a simple text
//     or hex preview. Per the issue note, the full preview decoder lives in
//     #57 and the additional format wiring lives in #56/#58.
//   - Surface friendly error messages for encrypted / corrupt archives.
//
// Out of scope: extension table changes, additional archive format
// detection, the rich preview decoder. This module deliberately does NOT
// branch on the file extension; libarchive auto-detects the format.

import {
    ArchiveEntryInfo,
    ArchiveHandle,
    openArchive,
} from './archiveLoader';
import { ARCHIVE_VIEWER_CSS } from './archiveViewerStyles';
import {
    ArchiveFormat,
    detectArchiveFormat,
    formatArchiveLabel,
} from '../../../utils/fileUtils/archive';
import {
    ARCHIVE_TEXT_PREVIEW_LIMIT,
    classifyArchivePreview,
} from '../../../utils/fileUtils/archivePreviewDecoder';

const STYLE_ELEMENT_ID = 'omni-viewer-archive-styles';
/**
 * Soft cap on the number of entries surfaced in the list. Archives with
 * tens of thousands of entries (e.g. APKs) will still render quickly while
 * leaving the heavyweight virtualisation work for a follow-up issue.
 */
const MAX_VISIBLE_ENTRIES = 1000;
/**
 * Bytes read for the format-label sniff. The TAR USTAR magic lives at offset
 * 257, so we need at least 262 — round up to 512 (a single TAR header block)
 * to be safe.
 */
const FORMAT_SNIFF_BYTES = 512;

export interface ArchiveViewerHandle {
    dispose(): void;
}

const VIEWER_HTML = /* html */ `
<div class="av-container" data-archive-viewer-root>
    <div class="av-header">
        <span class="av-title" data-archive-title>Archive</span>
        <span class="av-pill" data-archive-format hidden>Format: -</span>
        <span class="av-pill" data-archive-entry-count>0 entries</span>
        <span class="av-pill" data-archive-file-size>-</span>
    </div>
    <div class="av-status" data-archive-status hidden></div>
    <div class="av-body">
        <div class="av-list-pane">
            <div class="av-list-header">
                <input type="search" class="av-list-search" data-archive-search placeholder="Filter paths..." />
            </div>
            <ul class="av-list" data-archive-list></ul>
            <div class="av-empty" data-archive-empty hidden>No matching entries.</div>
        </div>
        <div class="av-preview-pane">
            <div class="av-preview-header">
                <span data-archive-preview-title>Select an entry to preview</span>
            </div>
            <div class="av-preview-meta" data-archive-preview-meta></div>
            <pre class="av-preview-content" data-archive-preview-content hidden></pre>
            <div class="av-preview-media" data-archive-preview-media hidden></div>
        </div>
    </div>
</div>
`;

function ensureStylesInjected(): void {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = ARCHIVE_VIEWER_CSS;
    document.head.appendChild(style);
}

/** Format a byte count as a short, locale-neutral string. */
function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '-';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    const precision = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

interface ViewerDom {
    root: HTMLElement;
    title: HTMLElement;
    format: HTMLElement;
    entryCount: HTMLElement;
    fileSize: HTMLElement;
    status: HTMLElement;
    search: HTMLInputElement;
    list: HTMLElement;
    empty: HTMLElement;
    previewTitle: HTMLElement;
    previewMeta: HTMLElement;
    previewContent: HTMLElement;
    previewMedia: HTMLElement;
}

function buildDom(container: HTMLElement): ViewerDom {
    container.innerHTML = VIEWER_HTML;
    const q = <T extends HTMLElement>(sel: string): T => {
        const el = container.querySelector<T>(sel);
        if (!el) {
            throw new Error(`Archive viewer DOM is missing required element: ${sel}`);
        }
        return el;
    };
    return {
        root: q('[data-archive-viewer-root]'),
        title: q('[data-archive-title]'),
        format: q('[data-archive-format]'),
        entryCount: q('[data-archive-entry-count]'),
        fileSize: q('[data-archive-file-size]'),
        status: q('[data-archive-status]'),
        search: q<HTMLInputElement>('[data-archive-search]'),
        list: q('[data-archive-list]'),
        empty: q('[data-archive-empty]'),
        previewTitle: q('[data-archive-preview-title]'),
        previewMeta: q('[data-archive-preview-meta]'),
        previewContent: q('[data-archive-preview-content]'),
        previewMedia: q('[data-archive-preview-media]'),
    };
}

/**
 * Read enough bytes off `file` to cover the format-sniff window (TAR's USTAR
 * magic lives at offset 257). Returns `null` if the slice can't be read; the
 * caller falls back to extension-only detection in that case.
 */
async function readFormatSniffBuffer(file: File): Promise<Uint8Array | null> {
    try {
        const slice = file.slice(0, Math.min(file.size, FORMAT_SNIFF_BYTES));
        const blobLike = slice as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
        if (typeof blobLike.arrayBuffer === 'function') {
            const buffer = await blobLike.arrayBuffer();
            return new Uint8Array(buffer);
        }
        if (typeof FileReader !== 'undefined') {
            return await new Promise<Uint8Array>((resolve, reject) => {
                const reader = new FileReader();
                reader.onerror = (): void => reject(reader.error ?? new Error('FileReader error'));
                reader.onload = (): void => {
                    const result = reader.result;
                    if (result instanceof ArrayBuffer) {
                        resolve(new Uint8Array(result));
                    } else {
                        reject(new Error('Unexpected FileReader result type'));
                    }
                };
                reader.readAsArrayBuffer(slice);
            });
        }
    } catch (error) {
        console.warn('[archiveViewerMain] format sniff failed:', error);
    }
    return null;
}

/**
 * Resolve a friendly format label for the header pill. We prefer the
 * magic-byte sniff so a mislabelled extension (a `.zip` that's actually 7-Zip
 * payload) shows the real container — which matches what libarchive will be
 * reading. Returns null if neither path produced a hit.
 */
export async function resolveArchiveFormatLabel(file: File): Promise<{ format: ArchiveFormat; label: string } | null> {
    const buffer = await readFormatSniffBuffer(file);
    const format = detectArchiveFormat(file.name, buffer);
    if (!format) {
        return null;
    }
    return { format, label: formatArchiveLabel(format) };
}

function setStatus(
    dom: ViewerDom,
    message: string | null,
    kind: 'info' | 'warn' | 'error' = 'info'
): void {
    if (!message) {
        dom.status.hidden = true;
        dom.status.textContent = '';
        dom.status.classList.remove('is-error', 'is-warn');
        return;
    }
    dom.status.hidden = false;
    dom.status.textContent = message;
    dom.status.classList.toggle('is-error', kind === 'error');
    dom.status.classList.toggle('is-warn', kind === 'warn');
}

function renderEntryList(
    dom: ViewerDom,
    entries: ArchiveEntryInfo[],
    selectedPath: string | null,
    onSelect: (entry: ArchiveEntryInfo) => void
): void {
    dom.list.innerHTML = '';
    if (entries.length === 0) {
        dom.empty.hidden = false;
        return;
    }
    dom.empty.hidden = true;
    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
        const li = document.createElement('li');
        li.className = 'av-list-item';
        if (entry.isDirectory) li.classList.add('is-directory');
        if (entry.path === selectedPath) li.classList.add('is-selected');
        li.dataset.entryPath = entry.path;
        li.tabIndex = 0;

        const pathSpan = document.createElement('span');
        pathSpan.className = 'av-list-item-path';
        pathSpan.textContent = entry.path;
        li.appendChild(pathSpan);

        if (!entry.isDirectory) {
            const sizeSpan = document.createElement('span');
            sizeSpan.className = 'av-list-item-size';
            sizeSpan.textContent = formatBytes(entry.size);
            li.appendChild(sizeSpan);
        }

        li.addEventListener('click', () => {
            if (!entry.isDirectory) onSelect(entry);
        });
        li.addEventListener('keydown', (event) => {
            if ((event.key === 'Enter' || event.key === ' ') && !entry.isDirectory) {
                event.preventDefault();
                onSelect(entry);
            }
        });
        fragment.appendChild(li);
    }
    dom.list.appendChild(fragment);
}

function applyFilter(
    dom: ViewerDom,
    entries: ArchiveEntryInfo[],
    selectedPath: string | null,
    onSelect: (entry: ArchiveEntryInfo) => void
): void {
    const query = dom.search.value.trim().toLowerCase();
    const filtered = query
        ? entries.filter((e) => e.path.toLowerCase().includes(query))
        : entries;
    renderEntryList(dom, filtered, selectedPath, onSelect);
}

/**
 * Translate a worker error message into a user-facing copy. We keep this
 * mapping intentionally short — the full friendly-error pass lives in #57.
 */
function describeArchiveError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    if (lower.includes('encrypt') || lower.includes('passphrase') || lower.includes('password')) {
        return 'This archive is encrypted. Password-protected archives are not supported yet.';
    }
    if (
        lower.includes('not recognized') ||
        lower.includes('unrecognized') ||
        lower.includes('truncated') ||
        lower.includes('corrupt') ||
        lower.includes('failed') ||
        lower.includes('invalid')
    ) {
        return `This archive could not be read. It may be corrupt or in an unsupported format. (${message})`;
    }
    return message;
}

/**
 * Mount the archive viewer into `container`. The returned handle is owned
 * by the caller (router) and should be disposed when the viewer is
 * replaced — `dispose()` terminates the worker and releases its wasm
 * instance.
 */
export function mountArchiveViewer(file: File, container: HTMLElement): ArchiveViewerHandle {
    ensureStylesInjected();
    const dom = buildDom(container);
    dom.title.textContent = file.name || 'Archive';
    dom.fileSize.textContent = formatBytes(file.size);
    dom.entryCount.textContent = 'Loading...';
    setStatus(dom, 'Opening archive...');

    let archive: (ArchiveHandle & { terminate(): void }) | undefined;
    let disposed = false;
    let allEntries: ArchiveEntryInfo[] = [];
    let visibleEntries: ArchiveEntryInfo[] = [];
    let selectedPath: string | null = null;
    /**
     * Monotonic counter used to ignore previews from stale clicks (e.g. user
     * clicks A, then B; A's extract resolves last and would otherwise
     * overwrite B's preview).
     */
    let previewToken = 0;
    /**
     * Tracks the ObjectURL currently held by the preview pane (if any).
     * Revoked on every fresh click so blob memory is freed promptly. Also
     * revoked on dispose so an unmount during a long playback frees the
     * underlying buffer.
     */
    let activeObjectUrl: string | null = null;

    /** Revoke the live ObjectURL (if any). Safe to call multiple times. */
    const revokeActiveObjectUrl = (): void => {
        if (activeObjectUrl) {
            try {
                URL.revokeObjectURL(activeObjectUrl);
            } catch {
                // No-op — environment may not support revoke (e.g. tests).
            }
            activeObjectUrl = null;
        }
    };

    /** Clear the preview panes and revoke any in-flight ObjectURL. */
    const resetPreviewPanes = (): void => {
        revokeActiveObjectUrl();
        dom.previewContent.textContent = '';
        dom.previewContent.classList.remove('is-hex');
        dom.previewContent.hidden = true;
        dom.previewMedia.replaceChildren();
        dom.previewMedia.hidden = true;
    };

    /** Trigger a browser download for the current entry's bytes. */
    const downloadEntryBytes = (entryPath: string, data: Uint8Array, mime: string): void => {
        const blob = new Blob([data], { type: mime });
        const url = URL.createObjectURL(blob);
        try {
            const anchor = document.createElement('a');
            anchor.href = url;
            // Use just the basename so the OS download dialog stays clean.
            const slash = entryPath.lastIndexOf('/');
            anchor.download = slash >= 0 ? entryPath.slice(slash + 1) : entryPath;
            anchor.rel = 'noopener';
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
        } finally {
            // Allow the browser a tick to start the download before revoking.
            setTimeout(() => {
                try { URL.revokeObjectURL(url); } catch { /* ignore */ }
            }, 0);
        }
    };

    const onSelect = async (entry: ArchiveEntryInfo): Promise<void> => {
        if (!archive) return;
        selectedPath = entry.path;
        const myToken = ++previewToken;
        renderEntryList(dom, visibleEntries, selectedPath, onSelect);
        dom.previewTitle.textContent = entry.path;
        dom.previewMeta.textContent = `${formatBytes(entry.size)} - extracting...`;
        // Clear the previous preview eagerly (and revoke any old ObjectURL)
        // so a slow extraction doesn't leave stale media playing.
        resetPreviewPanes();

        try {
            const data = await archive.extract(entry.path);
            if (myToken !== previewToken || disposed) return;
            if (data.length === 0) {
                dom.previewMeta.textContent = `${formatBytes(entry.size)} - empty file`;
                dom.previewContent.textContent = '';
                dom.previewContent.hidden = false;
                return;
            }

            const classification = classifyArchivePreview(entry.path, data);

            switch (classification.kind) {
            case 'text': {
                dom.previewMeta.textContent = `${formatBytes(entry.size)} - text preview`;
                dom.previewContent.textContent = classification.text ?? '';
                dom.previewContent.classList.remove('is-hex');
                dom.previewContent.hidden = false;
                return;
            }
            case 'image': {
                const mime = classification.mime ?? 'application/octet-stream';
                const blob = new Blob([data], { type: mime });
                const url = URL.createObjectURL(blob);
                activeObjectUrl = url;
                const img = document.createElement('img');
                img.alt = entry.path;
                img.src = url;
                img.className = 'av-preview-image';
                dom.previewMedia.replaceChildren(img);
                dom.previewMedia.hidden = false;
                dom.previewMeta.textContent = `${formatBytes(entry.size)} - image (${mime})`;
                return;
            }
            case 'audio': {
                const mime = classification.mime ?? 'application/octet-stream';
                const blob = new Blob([data], { type: mime });
                const url = URL.createObjectURL(blob);
                activeObjectUrl = url;
                const audio = document.createElement('audio');
                audio.controls = true;
                audio.src = url;
                audio.className = 'av-preview-audio';
                dom.previewMedia.replaceChildren(audio);
                dom.previewMedia.hidden = false;
                dom.previewMeta.textContent = `${formatBytes(entry.size)} - audio (${mime})`;
                return;
            }
            case 'video': {
                const mime = classification.mime ?? 'application/octet-stream';
                const blob = new Blob([data], { type: mime });
                const url = URL.createObjectURL(blob);
                activeObjectUrl = url;
                const video = document.createElement('video');
                video.controls = true;
                video.src = url;
                video.className = 'av-preview-video';
                dom.previewMedia.replaceChildren(video);
                dom.previewMedia.hidden = false;
                dom.previewMeta.textContent = `${formatBytes(entry.size)} - video (${mime})`;
                return;
            }
            case 'too-large': {
                dom.previewMeta.textContent =
                    `${formatBytes(entry.size)} - File too large for inline preview (>${formatBytes(ARCHIVE_TEXT_PREVIEW_LIMIT)}).`;
                const wrapper = document.createElement('div');
                wrapper.className = 'av-preview-too-large';
                const note = document.createElement('p');
                note.textContent = 'File too large for inline preview.';
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'av-preview-download';
                button.textContent = 'Download';
                button.addEventListener('click', () => {
                    downloadEntryBytes(entry.path, data, 'application/octet-stream');
                });
                wrapper.append(note, button);
                dom.previewMedia.replaceChildren(wrapper);
                dom.previewMedia.hidden = false;
                return;
            }
            case 'binary':
            default: {
                dom.previewMeta.textContent = `${formatBytes(entry.size)} - binary preview (hex dump)`;
                dom.previewContent.textContent = classification.hex ?? '';
                dom.previewContent.classList.add('is-hex');
                dom.previewContent.hidden = false;
                return;
            }
            }
        } catch (error) {
            if (myToken !== previewToken || disposed) return;
            dom.previewMeta.textContent = 'Extraction failed';
            dom.previewContent.textContent = describeArchiveError(error);
            dom.previewContent.classList.remove('is-hex');
            dom.previewContent.hidden = false;
            dom.previewMedia.hidden = true;
            dom.previewMedia.replaceChildren();
        }
    };

    dom.search.addEventListener('input', () => {
        applyFilter(dom, allEntries, selectedPath, onSelect);
    });

    // Resolve the format label as early as possible — independent of the
    // libarchive worker so the header pill renders even if `openArchive`
    // ultimately fails (e.g. encrypted/corrupt archive). Errors are
    // swallowed; the pill simply stays hidden when detection fails.
    void (async (): Promise<void> => {
        try {
            const detected = await resolveArchiveFormatLabel(file);
            if (disposed || !detected) return;
            dom.format.textContent = `Format: ${detected.label}`;
            dom.format.hidden = false;
        } catch (error) {
            console.warn('[archiveViewerMain] format label resolution failed:', error);
        }
    })();

    void (async (): Promise<void> => {
        try {
            archive = await openArchive(file);
            if (disposed) {
                archive.terminate();
                return;
            }
            allEntries = archive.entries;
            visibleEntries = allEntries.slice(0, MAX_VISIBLE_ENTRIES);
            const truncated = allEntries.length > visibleEntries.length;
            dom.entryCount.textContent = truncated
                ? `${visibleEntries.length} / ${allEntries.length} entries`
                : `${allEntries.length} entries`;

            if (truncated) {
                setStatus(
                    dom,
                    `Showing the first ${visibleEntries.length} of ${allEntries.length} entries.`,
                    'warn'
                );
            } else {
                setStatus(dom, null);
            }

            // Encryption is best-effort — libarchive only flags it once the
            // central directory is parsed. We surface a banner but still
            // render the entry list so the user sees structure.
            try {
                if (await archive.hasEncryptedData()) {
                    setStatus(
                        dom,
                        'This archive contains encrypted entries. Extraction of those entries is not supported yet.',
                        'warn'
                    );
                }
            } catch {
                // Ignore — this call sometimes throws on formats that don't
                // expose encryption state. The list still rendered.
            }

            renderEntryList(dom, visibleEntries, null, onSelect);
        } catch (error) {
            dom.entryCount.textContent = '0 entries';
            setStatus(dom, describeArchiveError(error), 'error');
            dom.previewTitle.textContent = file.name || 'Archive';
            dom.previewMeta.textContent = '';
            dom.previewContent.textContent = '';
        }
    })();

    return {
        dispose(): void {
            disposed = true;
            revokeActiveObjectUrl();
            // Drop any media nodes so their internal references release too.
            dom.previewMedia.replaceChildren();
            if (archive) {
                void archive.close();
                archive = undefined;
            }
        },
    };
}
