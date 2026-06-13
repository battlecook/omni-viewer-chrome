// Thumbnail sidebar for the Chrome PDF viewer (issue #17).
//
// Click-to-jump, drag-to-reorder, and `x` delete (issue #22). The actual
// PDF mutation happens at save time (#23); the reorder / delete only
// affects the *visible* order via the `PageOrderState` reducer hosted by
// `pdfViewerMain.ts`.
//
// Memory model: a fixed-height "slot" per page acts as a virtual placeholder
// inside an absolutely-positioned spacer. On scroll we recompute which
// slots intersect the viewport (± a buffer), mount canvases for the new
// range, and tear down canvases that left the range. So peak DOM canvas
// count is bounded by `(visible + 2 * buffer)` regardless of `numPages`.

import type { PdfPageProxy } from './pdfRenderer';

export const THUMB_TARGET_WIDTH_PX = 90;
export const THUMB_SLOT_HEIGHT_PX = 140;
export const THUMB_VIRTUAL_BUFFER = 2;

export interface VisibleWindow {
    startIndex: number;
    endIndex: number; // inclusive
}

/**
 * Compute which slot indices are visible in the sidebar's scrollport,
 * given the scroll position and dimensions. Pure function — used both at
 * runtime (sidebar scroll handler) and in tests.
 */
export function computeVisibleWindow(opts: {
    scrollTop: number;
    viewportHeight: number;
    slotHeight: number;
    totalCount: number;
    buffer?: number;
}): VisibleWindow {
    const { scrollTop, viewportHeight, slotHeight, totalCount } = opts;
    const buffer = opts.buffer ?? THUMB_VIRTUAL_BUFFER;
    if (totalCount <= 0 || slotHeight <= 0) {
        return { startIndex: 0, endIndex: -1 };
    }
    const safeScrollTop = Math.max(0, scrollTop);
    const safeViewportHeight = Math.max(0, viewportHeight);
    const firstVisible = Math.floor(safeScrollTop / slotHeight);
    const lastVisible = Math.floor(
        (safeScrollTop + safeViewportHeight) / slotHeight
    );
    const start = Math.max(0, firstVisible - buffer);
    const end = Math.min(totalCount - 1, lastVisible + buffer);
    return { startIndex: start, endIndex: end };
}

export interface MountThumbnailsOptions {
    sidebar: HTMLElement;
    /** Optional content host inside the scrollable sidebar. */
    list?: HTMLElement;
    /** The scrollable document pane (.pv-pdf-container). Used for click-to-navigate. */
    scrollContainer: HTMLElement;
    pagesContainer: HTMLElement;
    numPages: number;
    /** Borrow the cached page proxy. Returns undefined when out-of-range. */
    getPage: (pageNumber: number) => PdfPageProxy | undefined;
    /** Optional override for the slot height (used in tests). */
    slotHeight?: number;
    /** Optional override for thumbnail width in CSS px (used in tests). */
    targetWidth?: number;
    /**
     * Returns the *current* visible order — an array of 1-based original
     * page numbers. Slot at index `i` displays `getOrder()[i]`. Defaults
     * to the identity order `[1, 2, …, numPages]`.
     *
     * When the host wants to reflect a reorder / delete, it mutates the
     * underlying order state and calls `handle.refresh()`.
     */
    getOrder?: () => readonly number[];
    /**
     * Issue #22 — drag-and-drop reorder. Called when the user drops a
     * thumbnail; both indices are 0-based positions in the visible
     * order. The host is responsible for updating the order state and
     * calling `handle.refresh()`.
     */
    onReorder?: (fromIdx: number, toIdx: number) => void;
    /**
     * Issue #22 — delete a page from the visible order. `idx` is the
     * 0-based position in `getOrder()`. The host enforces the
     * "last-page" guard (the reducer refuses) and is responsible for
     * `handle.refresh()`.
     */
    onDelete?: (idx: number) => void;
}

export interface ThumbnailHandle {
    /** Mark page N as the active thumbnail (call from page-change listener). */
    setActivePage(pageNumber: number): void;
    /** Re-paint the sidebar — call after `getOrder()` changes. */
    refresh(): void;
    /** Unmount + remove listeners. */
    dispose(): void;
}

/**
 * Mount the thumbnail sidebar. Returns synchronously with a handle whose
 * `dispose()` clears state. The first render frame paints whatever
 * thumbnails fall in the initial viewport.
 */
export function mountThumbnails(opts: MountThumbnailsOptions): ThumbnailHandle {
    const sidebar = opts.sidebar;
    const list = opts.list ?? sidebar;
    const slotHeight = opts.slotHeight ?? THUMB_SLOT_HEIGHT_PX;
    const targetWidth = opts.targetWidth ?? THUMB_TARGET_WIDTH_PX;
    const numPages = opts.numPages;

    // The visible order is sourced from a callback so the host
    // (`pdfViewerMain.ts`) can mutate the `PageOrderState` reducer and
    // call `handle.refresh()` to repaint. Defaults to identity.
    const defaultOrder = Array.from({ length: numPages }, (_, i) => i + 1);
    const getOrder = (): readonly number[] => opts.getOrder?.() ?? defaultOrder;

    list.innerHTML = '';
    sidebar.classList.add('pv-thumbnail-sidebar');
    sidebar.classList.add('is-active');

    // The spacer establishes the total scrollable height so slots can be
    // absolutely-positioned by index without DOM bloat for unmounted pages.
    const spacer = document.createElement('div');
    spacer.className = 'pv-thumbnail-spacer';
    spacer.style.position = 'relative';
    spacer.style.height = `${getOrder().length * slotHeight}px`;
    list.appendChild(spacer);

    interface SlotState {
        item: HTMLElement;
        canvas: HTMLCanvasElement | undefined;
        /** The 1-based original page number this slot is currently rendering. */
        pageNumber: number;
        rendered: boolean;
        rendering: boolean;
        cancelCurrent: (() => void) | undefined;
    }
    const slots = new Map<number, SlotState>();

    // --- drag-and-drop visual indicator state -----------------------
    // Declared above `buildItem` so the closure capture is obvious;
    // the callbacks attached inside `buildItem` only fire after the
    // initial `refreshWindow()` has populated `slots`.
    let dragSourceIndex = -1;
    const clearDropIndicator = (): void => {
        for (const slot of slots.values()) {
            slot.item.classList.remove('pv-thumbnail-drop-before');
            slot.item.classList.remove('pv-thumbnail-drop-after');
        }
    };
    const setDropIndicator = (visIdx: number, before: boolean): void => {
        for (const [idx, slot] of slots) {
            const isTarget = idx === visIdx;
            slot.item.classList.toggle(
                'pv-thumbnail-drop-before',
                isTarget && before
            );
            slot.item.classList.toggle(
                'pv-thumbnail-drop-after',
                isTarget && !before
            );
        }
    };

    const buildItem = (index: number, pageNumber: number): HTMLElement => {
        // We use a non-button element so nested controls (the `x` delete
        // button) don't violate the "no interactive descendants of
        // <button>" HTML rule. A `div` with role=button + tabindex=0
        // gives us the same a11y affordances.
        const item = document.createElement('div');
        item.setAttribute('role', 'button');
        item.tabIndex = 0;
        item.className = 'pv-thumbnail-item';
        item.dataset.pageNumber = String(pageNumber);
        item.dataset.visibleIndex = String(index);
        item.draggable = true;
        item.style.position = 'absolute';
        item.style.top = `${index * slotHeight}px`;
        item.style.left = '0';
        item.style.right = '0';
        item.style.height = `${slotHeight}px`;

        const label = document.createElement('div');
        label.className = 'pv-thumbnail-label';
        label.textContent = String(index + 1);
        item.appendChild(label);

        if (opts.onDelete) {
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'pv-thumbnail-delete';
            del.title = 'Delete page';
            del.setAttribute('aria-label', `Delete page ${index + 1}`);
            del.textContent = '×'; // ×
            del.addEventListener('mousedown', (ev) => {
                // Prevent native drag pickup when the user grabs the X.
                ev.stopPropagation();
            });
            del.addEventListener('click', (ev) => {
                ev.stopPropagation();
                ev.preventDefault();
                const visIdx = Number(item.dataset.visibleIndex);
                if (Number.isInteger(visIdx)) {
                    opts.onDelete?.(visIdx);
                }
            });
            item.appendChild(del);
        }

        const onActivate = (): void => {
            const pn = Number(item.dataset.pageNumber);
            if (!Number.isInteger(pn)) return;
            const target = opts.pagesContainer.querySelector<HTMLElement>(
                `.pv-page-wrapper[data-page-number="${pn}"]`
            );
            if (target) {
                // Scroll only the document pane, not the outer page body.
                const sc = opts.scrollContainer;
                const targetTop = target.getBoundingClientRect().top
                    - sc.getBoundingClientRect().top
                    + sc.scrollTop;
                sc.scrollTo({ top: targetTop, behavior: 'smooth' });
            }
            activePage = pn;
            applyActiveClass();
        };
        item.addEventListener('click', onActivate);
        item.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                onActivate();
            }
        });

        // --- drag-and-drop wiring (issue #22) ----------------------------
        item.addEventListener('dragstart', (ev) => {
            const visIdx = Number(item.dataset.visibleIndex);
            if (!Number.isInteger(visIdx)) return;
            if (ev.dataTransfer) {
                ev.dataTransfer.effectAllowed = 'move';
                // Some browsers require setData to enable drop.
                try {
                    ev.dataTransfer.setData('text/plain', String(visIdx));
                } catch {
                    // best-effort
                }
            }
            dragSourceIndex = visIdx;
            item.classList.add('pv-thumbnail-dragging');
        });
        item.addEventListener('dragend', () => {
            item.classList.remove('pv-thumbnail-dragging');
            clearDropIndicator();
            dragSourceIndex = -1;
        });
        item.addEventListener('dragover', (ev) => {
            if (dragSourceIndex < 0) return;
            ev.preventDefault();
            if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
            const rect = item.getBoundingClientRect();
            const before = ev.clientY < rect.top + rect.height / 2;
            const visIdx = Number(item.dataset.visibleIndex);
            if (!Number.isInteger(visIdx)) return;
            setDropIndicator(visIdx, before);
        });
        item.addEventListener('drop', (ev) => {
            if (dragSourceIndex < 0) return;
            ev.preventDefault();
            const targetIdx = Number(item.dataset.visibleIndex);
            const rect = item.getBoundingClientRect();
            const before = ev.clientY < rect.top + rect.height / 2;
            const fromIdx = dragSourceIndex;
            dragSourceIndex = -1;
            clearDropIndicator();
            if (!Number.isInteger(targetIdx)) return;
            // "Drop before target" → toIdx = target. "Drop after" → +1.
            // Adjust for self-removal when fromIdx < toIdx.
            let toIdx = before ? targetIdx : targetIdx + 1;
            if (fromIdx < toIdx) toIdx -= 1;
            if (fromIdx === toIdx) return;
            opts.onReorder?.(fromIdx, toIdx);
        });

        return item;
    };

    const renderThumbCanvas = async (
        index: number,
        slot: SlotState
    ): Promise<void> => {
        if (slot.rendered || slot.rendering) return;
        const page = opts.getPage(slot.pageNumber);
        if (!page) return;
        slot.rendering = true;
        try {
            const baseViewport = page.getViewport({ scale: 1 });
            const scale = targetWidth / baseViewport.width;
            const viewport = page.getViewport({ scale });

            const canvas = document.createElement('canvas');
            canvas.className = 'pv-thumbnail-canvas';
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            canvas.style.width = `${viewport.width}px`;
            canvas.style.height = `${viewport.height}px`;

            const ctx = canvas.getContext('2d');
            if (!ctx) {
                slot.rendering = false;
                return;
            }
            slot.item.insertBefore(canvas, slot.item.firstChild);
            slot.canvas = canvas;

            const renderTask = page.render({ canvasContext: ctx, viewport });
            slot.cancelCurrent = renderTask.cancel
                ? renderTask.cancel.bind(renderTask)
                : undefined;
            await renderTask.promise;
            slot.rendered = true;
        } catch (err) {
            const name = (err as { name?: string } | null)?.name;
            if (name !== 'RenderingCancelledException' && name !== 'AbortException') {
                // eslint-disable-next-line no-console
                console.warn('[pdf-thumb] render failed', slot.pageNumber, err);
            }
        } finally {
            slot.rendering = false;
            slot.cancelCurrent = undefined;
        }
    };

    const tearDownSlot = (index: number): void => {
        const slot = slots.get(index);
        if (!slot) return;
        if (slot.cancelCurrent) {
            try {
                slot.cancelCurrent();
            } catch {
                // best-effort
            }
        }
        slot.item.remove();
        slots.delete(index);
    };

    const ensureSlot = (index: number, pageNumber: number): SlotState => {
        const existing = slots.get(index);
        if (existing) {
            // Visible index → page-number mapping may have changed
            // (after a reorder / delete). If so, recycle the slot.
            if (existing.pageNumber !== pageNumber) {
                tearDownSlot(index);
            } else {
                return existing;
            }
        }
        const item = buildItem(index, pageNumber);
        const slot: SlotState = {
            item,
            canvas: undefined,
            pageNumber,
            rendered: false,
            rendering: false,
            cancelCurrent: undefined
        };
        spacer.appendChild(item);
        slots.set(index, slot);
        return slot;
    };

    let activePage = 1;
    const applyActiveClass = (): void => {
        for (const slot of slots.values()) {
            slot.item.classList.toggle(
                'is-active-thumb',
                slot.pageNumber === activePage
            );
        }
    };

    const refreshWindow = (): void => {
        const order = getOrder();
        const visibleCount = order.length;
        // Keep the spacer height in sync with the (possibly shrunk) order.
        spacer.style.height = `${visibleCount * slotHeight}px`;

        const listTop = list === sidebar ? 0 : list.offsetTop;
        const window = computeVisibleWindow({
            scrollTop: sidebar.scrollTop - listTop,
            viewportHeight: sidebar.clientHeight,
            slotHeight,
            totalCount: visibleCount
        });

        // Tear down slots that fell out of range.
        for (const index of Array.from(slots.keys())) {
            if (index < window.startIndex || index > window.endIndex) {
                tearDownSlot(index);
            }
        }

        // Build / render slots in range.
        for (let i = window.startIndex; i <= window.endIndex; i++) {
            const pageNumber = order[i];
            if (pageNumber === undefined) continue;
            const slot = ensureSlot(i, pageNumber);
            if (!slot.rendered && !slot.rendering) {
                void renderThumbCanvas(i, slot);
            }
        }

        applyActiveClass();
    };

    const onScroll = (): void => {
        refreshWindow();
    };
    const onResize = (): void => {
        refreshWindow();
    };

    sidebar.addEventListener('scroll', onScroll, { passive: true });
    if (typeof window !== 'undefined') {
        window.addEventListener('resize', onResize);
    }

    // First-frame paint.
    refreshWindow();

    return {
        setActivePage(pageNumber: number): void {
            if (pageNumber === activePage) return;
            activePage = pageNumber;
            applyActiveClass();
            // Scroll sidebar so active thumbnail stays visible.
            const order = getOrder();
            const activeIndex = order.indexOf(pageNumber);
            if (activeIndex >= 0) {
                const listTop = list === sidebar ? 0 : list.offsetTop;
                const thumbTop = listTop + activeIndex * slotHeight;
                const thumbBottom = thumbTop + slotHeight;
                const visTop = sidebar.scrollTop;
                const visBottom = visTop + sidebar.clientHeight;
                if (thumbTop < visTop || thumbBottom > visBottom) {
                    sidebar.scrollTo({
                        top: thumbTop - sidebar.clientHeight / 2 + slotHeight / 2,
                        behavior: 'smooth',
                    });
                }
            }
        },
        refresh(): void {
            // The visible order may have changed — tear down every slot
            // and let `refreshWindow()` rebuild them with their new
            // page-number mapping. Slots are cheap (a handful at any
            // time, bounded by the viewport buffer).
            for (const index of Array.from(slots.keys())) {
                tearDownSlot(index);
            }
            refreshWindow();
        },
        dispose(): void {
            sidebar.removeEventListener('scroll', onScroll);
            if (typeof window !== 'undefined') {
                window.removeEventListener('resize', onResize);
            }
            for (const index of Array.from(slots.keys())) {
                tearDownSlot(index);
            }
            list.innerHTML = '';
            sidebar.classList.remove('is-active');
        }
    };
}
