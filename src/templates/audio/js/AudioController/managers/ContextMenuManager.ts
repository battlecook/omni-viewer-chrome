// ContextMenuManager — right-click menu over the waveform/spectrogram
// (issue #27).
//
// Responsibilities:
//   1. Build + render the menu DOM into the `js-context-menu` shell that
//      lives in the viewer's HTML.
//   2. Attach `contextmenu` listeners on the waveform and spectrogram so
//      they intercept the native browser menu and show ours instead.
//   3. Position the menu so it stays inside the viewport (clamped on the
//      right + bottom edges).
//   4. Close on outside-click or `Escape`.
//
// The 7 menu items required by the issue are:
//   - Copy region          (region-specific; clipboard write)
//   - Export region        (region-specific; download as WAV)
//   - Toggle loop          (region-specific; flips loop checkbox)
//   - Set A                (always; marks the region start at the cursor)
//   - Set B                (always; marks the region end at the cursor)
//   - Clear A-B            (always; clears the active region)
//   - Delete region        (region-specific; removes the active region)
//
// "Region-specific items first" means: when the user right-clicks while a
// region is selected, the menu places `Copy / Export / Toggle loop / Delete
// region` ahead of the unconditional `Set A / Set B / Clear A-B` items.
// When no region exists, only the always-on items render — but `Set A` is
// shown first (and Delete / Toggle-loop / Copy / Export are omitted) since
// they don't apply.

import type { AudioControllerState, RegionLike } from './types';

interface MenuItem {
    /** Visible label. */
    label: string;
    /** Stable key for tests + telemetry. */
    id: AudioContextMenuId;
    /** Invoked when the user clicks the item. The menu auto-closes after. */
    onSelect: () => void;
}

/**
 * Stable identifiers for the 7 menu items, exported so unit tests + future
 * shortcut overlays can refer to them without typo'ing the label string.
 */
export type AudioContextMenuId =
    | 'copy-region'
    | 'export-region'
    | 'toggle-loop'
    | 'set-a'
    | 'set-b'
    | 'clear-ab'
    | 'delete-region';

export interface ContextMenuOpenEvent {
    /** Viewport-relative click coordinates (clientX/clientY semantics). */
    x: number;
    y: number;
    /** The active region, or null if no region was right-clicked. */
    region: RegionLike | null;
    /** Time (seconds) at the click position, computed from waveform geometry. */
    timeAtClick: number;
}

/**
 * Clamp `(x, y)` so the menu rectangle (width × height) stays inside a
 * viewport of `(viewportWidth × viewportHeight)`. Exported for tests; this
 * is the only piece of geometry we want to pin down without spinning up
 * jsdom's full layout engine.
 *
 * Behaviour:
 *   - The right edge of the menu sits at most `viewportWidth - 4`px in.
 *   - The bottom edge similarly; the 4px margin keeps the menu off the
 *     viewport edge so a 1px shadow stays visible.
 *   - Negative `x`/`y` clamp to 0 (defensive — the browser normally gives
 *     us non-negative click coordinates).
 */
export function clampMenuPosition(
    x: number,
    y: number,
    width: number,
    height: number,
    viewportWidth: number,
    viewportHeight: number
): { left: number; top: number } {
    const margin = 4;
    let left = Math.max(0, x);
    let top = Math.max(0, y);
    if (left + width + margin > viewportWidth) {
        left = Math.max(0, viewportWidth - width - margin);
    }
    if (top + height + margin > viewportHeight) {
        top = Math.max(0, viewportHeight - height - margin);
    }
    return { left, top };
}

/**
 * Build the ordered list of menu items for a given open event. Pure
 * function over the open event + a callback bag, exported so the tests
 * can verify the item ordering without rendering the DOM.
 */
export function buildMenuItems(
    event: ContextMenuOpenEvent,
    handlers: ContextMenuHandlers
): MenuItem[] {
    const items: MenuItem[] = [];
    const region = event.region;

    // Region-specific items — only meaningful when a region exists.
    if (region) {
        items.push({
            id: 'copy-region',
            label: 'Copy region',
            onSelect: () => handlers.onCopyRegion(region)
        });
        items.push({
            id: 'export-region',
            label: 'Export region',
            onSelect: () => handlers.onExportRegion(region)
        });
        items.push({
            id: 'toggle-loop',
            label: 'Toggle loop',
            onSelect: () => handlers.onToggleLoop()
        });
        items.push({
            id: 'delete-region',
            label: 'Delete region',
            onSelect: () => handlers.onDeleteRegion(region)
        });
    }

    // Always-available items — Set A / Set B / Clear A-B.
    items.push({
        id: 'set-a',
        label: 'Set A',
        onSelect: () => handlers.onSetA(event.timeAtClick)
    });
    items.push({
        id: 'set-b',
        label: 'Set B',
        onSelect: () => handlers.onSetB(event.timeAtClick)
    });
    items.push({
        id: 'clear-ab',
        label: 'Clear A-B',
        onSelect: () => handlers.onClearAB()
    });

    return items;
}

/**
 * Callback bag that the manager hands to `buildMenuItems`. Each callback
 * is invoked when the corresponding menu item is selected. Kept narrow so
 * the unit tests can stub each one with a `jest.fn()`.
 */
export interface ContextMenuHandlers {
    onCopyRegion: (region: RegionLike) => void;
    onExportRegion: (region: RegionLike) => void;
    onToggleLoop: () => void;
    onDeleteRegion: (region: RegionLike) => void;
    onSetA: (timeAtClick: number) => void;
    onSetB: (timeAtClick: number) => void;
    onClearAB: () => void;
}

export class ContextMenuManager {
    private readonly state: AudioControllerState;
    private mounted = false;
    private cleanups: Array<() => void> = [];
    private currentItems: MenuItem[] = [];

    constructor(state: AudioControllerState) {
        this.state = state;
    }

    /**
     * Wire up `contextmenu`/`click`/`keydown` listeners against the live
     * waveform + spectrogram + document. Idempotent: calling it twice is
     * a no-op so re-mount paths (mode switches) don't double-bind.
     */
    mountContextMenu(): void {
        if (this.mounted) return;
        this.mounted = true;

        const waveform = this.state.elements.waveform;
        const spectrogram = this.state.elements.spectrogram;

        // --- waveform contextmenu ---
        if (waveform) {
            const onContextMenu = (e: Event): void => {
                this.handleContextMenuEvent(e as MouseEvent, waveform);
            };
            waveform.addEventListener('contextmenu', onContextMenu);
            this.cleanups.push(() => waveform.removeEventListener('contextmenu', onContextMenu));
        }

        // --- spectrogram contextmenu (mirrors PluginManager's existing wiring) ---
        if (spectrogram) {
            const onContextMenu = (e: Event): void => {
                this.handleContextMenuEvent(e as MouseEvent, spectrogram);
            };
            spectrogram.addEventListener('contextmenu', onContextMenu);
            this.cleanups.push(() => spectrogram.removeEventListener('contextmenu', onContextMenu));
        }

        // --- document click closes the menu ---
        const onDocumentClick = (e: MouseEvent): void => {
            const menu = this.state.elements.contextMenu;
            const target = e.target as Node | null;
            if (menu && target && !menu.contains(target)) {
                this.hide();
            }
        };
        document.addEventListener('click', onDocumentClick);
        this.cleanups.push(() => document.removeEventListener('click', onDocumentClick));

        // --- ESC closes the menu ---
        const onKeyDown = (e: KeyboardEvent): void => {
            if (e.key === 'Escape' && this.isVisible()) {
                this.hide();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        this.cleanups.push(() => document.removeEventListener('keydown', onKeyDown));
    }

    /**
     * Tear down all event listeners. Called on viewer dispose so a fresh
     * file load doesn't leak dangling handlers.
     */
    dispose(): void {
        for (const cleanup of this.cleanups) {
            try {
                cleanup();
            } catch (err) {
                console.warn('ContextMenuManager cleanup failed:', err);
            }
        }
        this.cleanups = [];
        this.mounted = false;
        this.currentItems = [];
        this.hide();
    }

    /** True when the menu is currently rendered and visible. */
    isVisible(): boolean {
        const menu = this.state.elements.contextMenu;
        return !!(menu && menu.style.display !== 'none' && menu.style.display !== '');
    }

    /** Hide the menu without losing the wired listeners. */
    hide(): void {
        const menu = this.state.elements.contextMenu;
        if (!menu) return;
        menu.style.display = 'none';
        menu.innerHTML = '';
        this.currentItems = [];
    }

    /**
     * Expose the items currently rendered in the menu. Used by the test
     * suite to verify the spec'd ordering (region items first, etc.) and
     * exercise individual handlers without dispatching a synthetic click.
     */
    getCurrentItems(): ReadonlyArray<{ id: AudioContextMenuId; label: string }> {
        return this.currentItems.map((item) => ({ id: item.id, label: item.label }));
    }

    private handleContextMenuEvent(event: MouseEvent, surface: HTMLElement): void {
        // Don't intercept clicks on the inline region inputs (they have
        // their own native menus the user expects).
        const target = event.target as HTMLElement | null;
        const isInputOverlay = !!(
            target?.closest('.region-input-overlay') ||
            target?.classList?.contains('region-input-overlay') ||
            target?.classList?.contains('region-start-input') ||
            target?.classList?.contains('region-end-input') ||
            target?.classList?.contains('region-duration-input')
        );
        if (isInputOverlay) return;

        event.preventDefault();

        const region = this.state.regionManager.getSelectedRegion();
        const timeAtClick = this.computeTimeAtClick(event, surface);
        this.open({
            x: event.clientX,
            y: event.clientY,
            region,
            timeAtClick
        });
    }

    /**
     * Render the menu at the supplied click coordinates. Public so the
     * unit tests (and any future hotkey "show menu at cursor" path) can
     * drive it directly without synthesizing a real `MouseEvent`.
     */
    open(event: ContextMenuOpenEvent): void {
        const menu = this.state.elements.contextMenu;
        if (!menu) {
            console.warn('ContextMenuManager: js-context-menu element not found');
            return;
        }

        const items = buildMenuItems(event, this.buildHandlers());
        this.currentItems = items;
        menu.innerHTML = '';
        items.forEach((item) => {
            const el = document.createElement('div');
            el.className = 'context-menu-item';
            el.dataset.menuId = item.id;
            el.textContent = item.label;
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                try {
                    item.onSelect();
                } catch (err) {
                    console.error(`Context menu item ${item.id} threw:`, err);
                }
                this.hide();
            });
            menu.appendChild(el);
        });

        // Render so we can measure, then clamp into viewport.
        menu.style.left = '0px';
        menu.style.top = '0px';
        menu.style.display = 'block';

        const width = menu.offsetWidth || 200;
        const height = menu.offsetHeight || items.length * 32;
        const vw =
            typeof window !== 'undefined' ? window.innerWidth || document.documentElement.clientWidth : 1024;
        const vh =
            typeof window !== 'undefined' ? window.innerHeight || document.documentElement.clientHeight : 768;

        const clamped = clampMenuPosition(event.x, event.y, width, height, vw, vh);
        menu.style.left = `${clamped.left}px`;
        menu.style.top = `${clamped.top}px`;
    }

    /** Pixel→time conversion at the click X-coordinate. */
    private computeTimeAtClick(event: MouseEvent, surface: HTMLElement): number {
        const ws = this.state.wavesurfer;
        if (!ws) return 0;
        try {
            const rect = surface.getBoundingClientRect();
            const width = rect.width || 1;
            const offsetX = Math.max(0, Math.min(width, event.clientX - rect.left));
            const ratio = offsetX / width;
            const duration = typeof ws.getDuration === 'function' ? ws.getDuration() : 0;
            if (!Number.isFinite(duration) || duration <= 0) return 0;
            return ratio * duration;
        } catch {
            return 0;
        }
    }

    /** Build the handlers bag tied to the live state. */
    private buildHandlers(): ContextMenuHandlers {
        return {
            onCopyRegion: (region) => this.copyRegion(region),
            onExportRegion: (region) => {
                void this.state.audioController?.extractAndDownloadRegion?.(region);
            },
            onToggleLoop: () => this.toggleLoop(),
            onDeleteRegion: (region) => this.deleteRegion(region),
            onSetA: (time) => this.setRegionStart(time),
            onSetB: (time) => this.setRegionEnd(time),
            onClearAB: () => this.state.regionManager.clearAllRegions()
        };
    }

    /**
     * Copy the region's start/end timestamps to the clipboard. Falls back
     * to a no-op when the Async Clipboard API is unavailable (e.g. older
     * browsers, jsdom).
     */
    private copyRegion(region: RegionLike): void {
        const text = `${region.start.toFixed(3)}-${region.end.toFixed(3)}s`;
        try {
            const nav = (typeof navigator !== 'undefined' ? navigator : null) as Navigator | null;
            if (nav?.clipboard?.writeText) {
                void nav.clipboard.writeText(text).catch((err) => {
                    console.warn('Clipboard write failed:', err);
                });
            }
        } catch (err) {
            console.warn('Clipboard unavailable:', err);
        }
    }

    /** Flip the loop checkbox + propagate to `state.loopEnabled`. */
    private toggleLoop(): void {
        const checkbox = this.state.elements.loopEnabled;
        if (!checkbox) {
            this.state.loopEnabled = !this.state.loopEnabled;
            return;
        }
        checkbox.checked = !checkbox.checked;
        this.state.loopEnabled = checkbox.checked;
        // Fire a `change` event so any other listeners (RegionManager UI,
        // future telemetry) react identically to a manual click.
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /** Remove the supplied region. */
    private deleteRegion(region: RegionLike): void {
        try {
            region.remove();
        } catch (err) {
            console.warn('Failed to remove region:', err);
        }
        if (this.state.selectedRegionId === region.id) {
            this.state.selectedRegionId = null;
            this.state.regionManager.hideControls();
        }
    }

    /**
     * Set the active region's start ("A") to `time`. If no region exists
     * we create one at `[time, time + minimumNudge]` so the user gets a
     * visible handle they can drag to extend.
     */
    private setRegionStart(time: number): void {
        const plugin = this.state.regionsPlugin;
        if (!plugin) return;
        const ws = this.state.wavesurfer;
        const duration = ws?.getDuration?.() ?? 0;
        if (!Number.isFinite(duration) || duration <= 0) return;

        const start = Math.max(0, Math.min(duration, time));
        const existing = this.state.regionManager.getSelectedRegion();
        if (existing) {
            const end = Math.max(start + 0.05, Math.min(duration, existing.end));
            this.recreateRegion(start, end);
        } else {
            const end = Math.min(duration, start + 0.5);
            this.recreateRegion(start, Math.max(start + 0.05, end));
        }
    }

    /**
     * Set the active region's end ("B") to `time`. If no region exists we
     * create one starting at the playhead (or `0`) and ending at `time`.
     */
    private setRegionEnd(time: number): void {
        const plugin = this.state.regionsPlugin;
        if (!plugin) return;
        const ws = this.state.wavesurfer;
        const duration = ws?.getDuration?.() ?? 0;
        if (!Number.isFinite(duration) || duration <= 0) return;

        const end = Math.max(0, Math.min(duration, time));
        const existing = this.state.regionManager.getSelectedRegion();
        if (existing) {
            const start = Math.max(0, Math.min(end - 0.05, existing.start));
            this.recreateRegion(start, end);
        } else {
            const playhead = ws?.getCurrentTime?.() ?? 0;
            const start = Math.max(0, Math.min(end - 0.05, playhead));
            this.recreateRegion(start, end);
        }
    }

    /**
     * Replace any existing regions with one spanning `[start, end]`. We
     * route through the regions plugin (not RegionManager) so the existing
     * `region-created` event fires and the overlays + selection state
     * update via the same path drag-selection uses.
     */
    private recreateRegion(start: number, end: number): void {
        const plugin = this.state.regionsPlugin;
        if (!plugin) return;
        try {
            if (plugin.getRegions) {
                const regions = plugin.getRegions();
                Object.values(regions).forEach((existing) => existing.remove());
            }
            if (plugin.addRegion) {
                const created = plugin.addRegion({
                    start,
                    end,
                    color: 'rgba(255, 0, 0, 0.1)'
                });
                this.state.selectedRegionId = created.id;
            }
        } catch (err) {
            console.warn('Failed to recreate region:', err);
        }
    }
}
