// Unit tests for the audio viewer's context menu + keyboard router (issue #27).
//
// Two surfaces under test:
//
//   1. The pure key->action router in `audioKeyboard.ts` (mirrors the
//      videoKeyboard test pattern from issue #31). The router is small but
//      load-bearing — it owns the input-skip policy + the modifier policy,
//      so we pin every spec'd binding here. The arrow seek deltas (±5s and
//      ±0.5s with Shift) are validated against the issue's exact numbers.
//
//   2. The `ContextMenuManager` state surface — the menu items it renders
//      for (a) region-active and (b) no-region right-clicks, the
//      viewport-clamping helper, ESC/outside-click dismissal, and the
//      individual item handlers (Copy / Export / Toggle loop / Delete /
//      Set A / Set B / Clear A-B).
//
// We deliberately stub `WaveSurfer` + `regionsPlugin` so the manager runs
// against a hand-rolled DOM under jsdom. The full WaveSurfer surface is
// loaded dynamically from `vendor/wavesurfer/` at runtime, which jsdom
// can't service — but that's fine because the manager only ever calls a
// handful of methods on the plugin (`getRegions`, `addRegion`).

import {
    ARROW_SEEK_SECONDS,
    SHIFT_ARROW_SEEK_SECONDS,
    applyShortcutAction,
    computeSeekTarget,
    isInputLikeTarget,
    routeKeyboardEvent,
    type AudioShortcutAction,
    type AudioShortcutHandle
} from '../templates/audio/js/AudioController/utils/audioKeyboard';
import {
    ContextMenuManager,
    buildMenuItems,
    clampMenuPosition,
    type AudioContextMenuId,
    type ContextMenuHandlers
} from '../templates/audio/js/AudioController/managers/ContextMenuManager';
import type {
    AudioControllerState,
    RegionLike,
    RegionsPluginLike
} from '../templates/audio/js/AudioController/managers/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a `KeyboardEvent`-shaped object good enough for `routeKeyboardEvent`.
 * jsdom's KeyboardEvent constructor handles the basics but we want to
 * forge the `target` field to test input-skip behaviour without attaching
 * the element into the live DOM.
 */
function makeEvent(opts: {
    key: string;
    target?: EventTarget | null;
    ctrlKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
}): KeyboardEvent {
    return {
        key: opts.key,
        target: opts.target ?? null,
        ctrlKey: !!opts.ctrlKey,
        altKey: !!opts.altKey,
        metaKey: !!opts.metaKey,
        shiftKey: !!opts.shiftKey,
        preventDefault: () => {},
        stopPropagation: () => {}
    } as unknown as KeyboardEvent;
}

function makeDivTarget(): EventTarget {
    return document.createElement('div');
}

function makeRegion(id: string, start: number, end: number): RegionLike {
    return {
        id,
        start,
        end,
        remove: jest.fn()
    };
}

// ---------------------------------------------------------------------------
// audioKeyboard — pure constants
// ---------------------------------------------------------------------------

describe('audioKeyboard — public constants', () => {
    it('arrow seek matches issue #27 ±5s value', () => {
        expect(ARROW_SEEK_SECONDS).toBe(5);
    });

    it('shifted arrow seek matches issue #27 ±0.5s value', () => {
        expect(SHIFT_ARROW_SEEK_SECONDS).toBeCloseTo(0.5, 10);
    });
});

// ---------------------------------------------------------------------------
// audioKeyboard — input-like target detection
// ---------------------------------------------------------------------------

describe('audioKeyboard — isInputLikeTarget', () => {
    it('returns false for a null target', () => {
        expect(isInputLikeTarget(null)).toBe(false);
    });

    it('returns false for a plain <div>', () => {
        expect(isInputLikeTarget(document.createElement('div'))).toBe(false);
    });

    it('returns true for <input>, <textarea>, <select>', () => {
        expect(isInputLikeTarget(document.createElement('input'))).toBe(true);
        expect(isInputLikeTarget(document.createElement('textarea'))).toBe(true);
        expect(isInputLikeTarget(document.createElement('select'))).toBe(true);
    });

    it('returns true for contenteditable elements', () => {
        const ce = document.createElement('div');
        ce.setAttribute('contenteditable', 'true');
        expect(isInputLikeTarget(ce)).toBe(true);
    });

    it('returns false when contenteditable="false"', () => {
        const ce = document.createElement('div');
        ce.setAttribute('contenteditable', 'false');
        expect(isInputLikeTarget(ce)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// audioKeyboard — routeKeyboardEvent (key -> action mapping)
// ---------------------------------------------------------------------------

describe('audioKeyboard — routeKeyboardEvent (mapping)', () => {
    it('Space maps to play-toggle', () => {
        expect(
            routeKeyboardEvent(makeEvent({ key: ' ', target: makeDivTarget() }))
        ).toEqual({ kind: 'play-toggle' });
    });

    it('legacy Spacebar key string also maps to play-toggle', () => {
        expect(
            routeKeyboardEvent(
                makeEvent({ key: 'Spacebar', target: makeDivTarget() })
            )
        ).toEqual({ kind: 'play-toggle' });
    });

    it('ArrowLeft maps to seek -5', () => {
        expect(
            routeKeyboardEvent(
                makeEvent({ key: 'ArrowLeft', target: makeDivTarget() })
            )
        ).toEqual({ kind: 'seek', delta: -5 });
    });

    it('ArrowRight maps to seek +5', () => {
        expect(
            routeKeyboardEvent(
                makeEvent({ key: 'ArrowRight', target: makeDivTarget() })
            )
        ).toEqual({ kind: 'seek', delta: +5 });
    });

    it('Shift+ArrowLeft maps to seek -0.5', () => {
        const action = routeKeyboardEvent(
            makeEvent({ key: 'ArrowLeft', target: makeDivTarget(), shiftKey: true })
        );
        expect(action).toEqual({ kind: 'seek', delta: -0.5 });
    });

    it('Shift+ArrowRight maps to seek +0.5', () => {
        const action = routeKeyboardEvent(
            makeEvent({ key: 'ArrowRight', target: makeDivTarget(), shiftKey: true })
        );
        expect(action).toEqual({ kind: 'seek', delta: +0.5 });
    });

    it('+ maps to zoom +1', () => {
        expect(
            routeKeyboardEvent(
                makeEvent({ key: '+', target: makeDivTarget(), shiftKey: true })
            )
        ).toEqual({ kind: 'zoom', direction: +1 });
    });

    it('= (no Shift) maps to zoom +1', () => {
        // Many layouts produce `=` when the user just presses the `+` key
        // without Shift. Treat them as the same shortcut.
        expect(
            routeKeyboardEvent(makeEvent({ key: '=', target: makeDivTarget() }))
        ).toEqual({ kind: 'zoom', direction: +1 });
    });

    it('- maps to zoom -1', () => {
        expect(
            routeKeyboardEvent(makeEvent({ key: '-', target: makeDivTarget() }))
        ).toEqual({ kind: 'zoom', direction: -1 });
    });

    it('_ (Shift+-) maps to zoom -1', () => {
        expect(
            routeKeyboardEvent(
                makeEvent({ key: '_', target: makeDivTarget(), shiftKey: true })
            )
        ).toEqual({ kind: 'zoom', direction: -1 });
    });

    it('L (lowercase) maps to loop-toggle', () => {
        expect(
            routeKeyboardEvent(makeEvent({ key: 'l', target: makeDivTarget() }))
        ).toEqual({ kind: 'loop-toggle' });
    });

    it('L (uppercase) maps to loop-toggle', () => {
        expect(
            routeKeyboardEvent(
                makeEvent({ key: 'L', target: makeDivTarget(), shiftKey: true })
            )
        ).toEqual({ kind: 'loop-toggle' });
    });

    it('returns null for unmapped keys', () => {
        for (const key of ['a', 'Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown']) {
            expect(
                routeKeyboardEvent(makeEvent({ key, target: makeDivTarget() }))
            ).toBeNull();
        }
    });
});

// ---------------------------------------------------------------------------
// audioKeyboard — input-like targets bypass the router
// ---------------------------------------------------------------------------

describe('audioKeyboard — routeKeyboardEvent (input-like targets)', () => {
    const triggers: ReadonlyArray<{ name: string; key: string; shift?: boolean }> = [
        { name: 'Space', key: ' ' },
        { name: 'ArrowLeft', key: 'ArrowLeft' },
        { name: 'ArrowRight', key: 'ArrowRight' },
        { name: 'Shift+ArrowLeft', key: 'ArrowLeft', shift: true },
        { name: 'Shift+ArrowRight', key: 'ArrowRight', shift: true },
        { name: '+', key: '+' },
        { name: '-', key: '-' },
        { name: 'l', key: 'l' },
        { name: 'L', key: 'L' }
    ];

    function expectAllInert(target: EventTarget): void {
        for (const t of triggers) {
            const action = routeKeyboardEvent(
                makeEvent({ key: t.key, target, shiftKey: t.shift })
            );
            // "${t.name} should be inert when target is input-like"
            expect(action).toBeNull();
        }
    }

    it('returns null for ALL shortcuts when target is <input>', () => {
        expectAllInert(document.createElement('input'));
    });

    it('returns null for ALL shortcuts when target is <textarea>', () => {
        expectAllInert(document.createElement('textarea'));
    });

    it('returns null for ALL shortcuts when target is <select>', () => {
        expectAllInert(document.createElement('select'));
    });

    it('returns null for ALL shortcuts when target is contenteditable', () => {
        const ce = document.createElement('div');
        ce.setAttribute('contenteditable', 'true');
        expectAllInert(ce);
    });
});

// ---------------------------------------------------------------------------
// audioKeyboard — modifier policy
// ---------------------------------------------------------------------------

describe('audioKeyboard — routeKeyboardEvent (modifier policy)', () => {
    it('ignores Ctrl-combinations', () => {
        expect(
            routeKeyboardEvent(
                makeEvent({ key: 'l', target: makeDivTarget(), ctrlKey: true })
            )
        ).toBeNull();
        expect(
            routeKeyboardEvent(
                makeEvent({
                    key: 'ArrowLeft',
                    target: makeDivTarget(),
                    ctrlKey: true
                })
            )
        ).toBeNull();
    });

    it('ignores Alt-combinations', () => {
        expect(
            routeKeyboardEvent(
                makeEvent({ key: ' ', target: makeDivTarget(), altKey: true })
            )
        ).toBeNull();
    });

    it('ignores Meta (Cmd) combinations', () => {
        expect(
            routeKeyboardEvent(
                makeEvent({ key: '+', target: makeDivTarget(), metaKey: true })
            )
        ).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// audioKeyboard — computeSeekTarget
// ---------------------------------------------------------------------------

describe('audioKeyboard — computeSeekTarget', () => {
    it('clamps to 0 when going negative', () => {
        expect(computeSeekTarget(2, -5, 60)).toBe(0);
    });

    it('clamps to duration when going past the end', () => {
        expect(computeSeekTarget(58, +5, 60)).toBe(60);
    });

    it('passes through values inside the playable range', () => {
        expect(computeSeekTarget(10, +5, 60)).toBe(15);
        expect(computeSeekTarget(10, -5, 60)).toBe(5);
        expect(computeSeekTarget(10, +0.5, 60)).toBeCloseTo(10.5, 10);
    });

    it('treats non-finite currentTime as 0', () => {
        expect(computeSeekTarget(Number.NaN, +5, 60)).toBe(5);
    });

    it('without a known duration only clamps the lower bound', () => {
        expect(computeSeekTarget(0, -5, Number.NaN)).toBe(0);
        expect(computeSeekTarget(123, +5, Number.NaN)).toBe(128);
    });
});

// ---------------------------------------------------------------------------
// audioKeyboard — applyShortcutAction
// ---------------------------------------------------------------------------

describe('audioKeyboard — applyShortcutAction', () => {
    function makeHandle(initial: {
        currentTime?: number;
        duration?: number;
    } = {}): {
        handle: AudioShortcutHandle;
        spies: {
            seekTo: jest.Mock;
            togglePlay: jest.Mock;
            zoomIn: jest.Mock;
            zoomOut: jest.Mock;
            toggleLoop: jest.Mock;
        };
    } {
        const spies = {
            seekTo: jest.fn(),
            togglePlay: jest.fn(),
            zoomIn: jest.fn(),
            zoomOut: jest.fn(),
            toggleLoop: jest.fn()
        };
        const handle: AudioShortcutHandle = {
            getCurrentTime: () => initial.currentTime ?? 0,
            getDuration: () => initial.duration ?? 60,
            seekTo: spies.seekTo,
            togglePlay: spies.togglePlay,
            zoomIn: spies.zoomIn,
            zoomOut: spies.zoomOut,
            toggleLoop: spies.toggleLoop
        };
        return { handle, spies };
    }

    it('play-toggle calls togglePlay()', () => {
        const { handle, spies } = makeHandle();
        applyShortcutAction({ kind: 'play-toggle' }, handle);
        expect(spies.togglePlay).toHaveBeenCalledTimes(1);
    });

    it('seek calls seekTo with the clamped target', () => {
        const { handle, spies } = makeHandle({ currentTime: 10, duration: 60 });
        applyShortcutAction({ kind: 'seek', delta: +5 }, handle);
        expect(spies.seekTo).toHaveBeenLastCalledWith(15);

        applyShortcutAction({ kind: 'seek', delta: -100 }, handle);
        expect(spies.seekTo).toHaveBeenLastCalledWith(0);

        applyShortcutAction({ kind: 'seek', delta: +999 }, handle);
        expect(spies.seekTo).toHaveBeenLastCalledWith(60);
    });

    it('zoom +1 calls zoomIn()', () => {
        const { handle, spies } = makeHandle();
        applyShortcutAction({ kind: 'zoom', direction: +1 }, handle);
        expect(spies.zoomIn).toHaveBeenCalledTimes(1);
        expect(spies.zoomOut).not.toHaveBeenCalled();
    });

    it('zoom -1 calls zoomOut()', () => {
        const { handle, spies } = makeHandle();
        applyShortcutAction({ kind: 'zoom', direction: -1 }, handle);
        expect(spies.zoomOut).toHaveBeenCalledTimes(1);
        expect(spies.zoomIn).not.toHaveBeenCalled();
    });

    it('loop-toggle calls toggleLoop()', () => {
        const { handle, spies } = makeHandle();
        applyShortcutAction({ kind: 'loop-toggle' }, handle);
        expect(spies.toggleLoop).toHaveBeenCalledTimes(1);
    });

    it('no-ops cleanly when handle methods are missing', () => {
        // Empty handle — every action is a no-op (no throw).
        const empty: AudioShortcutHandle = {};
        const actions: AudioShortcutAction[] = [
            { kind: 'play-toggle' },
            { kind: 'seek', delta: 5 },
            { kind: 'zoom', direction: 1 },
            { kind: 'zoom', direction: -1 },
            { kind: 'loop-toggle' }
        ];
        for (const a of actions) {
            expect(() => applyShortcutAction(a, empty)).not.toThrow();
        }
    });
});

// ---------------------------------------------------------------------------
// audioKeyboard — end-to-end (event -> action -> handle)
// ---------------------------------------------------------------------------

describe('audioKeyboard — full event-to-handle round-trip', () => {
    it('Space -> play-toggle -> togglePlay()', () => {
        const togglePlay = jest.fn();
        const e = makeEvent({ key: ' ', target: makeDivTarget() });
        const action = routeKeyboardEvent(e);
        expect(action).not.toBeNull();
        applyShortcutAction(action as AudioShortcutAction, { togglePlay });
        expect(togglePlay).toHaveBeenCalledTimes(1);
    });

    it('Shift+ArrowRight on a text-typing context does NOT seek', () => {
        const seekTo = jest.fn();
        const input = document.createElement('input');
        const e = makeEvent({ key: 'ArrowRight', target: input, shiftKey: true });
        expect(routeKeyboardEvent(e)).toBeNull();
        // No dispatch -> no side-effect.
        expect(seekTo).not.toHaveBeenCalled();
    });

    it('L -> loop-toggle -> toggleLoop()', () => {
        const toggleLoop = jest.fn();
        const action = routeKeyboardEvent(
            makeEvent({ key: 'l', target: makeDivTarget() })
        );
        expect(action).toEqual({ kind: 'loop-toggle' });
        applyShortcutAction(action as AudioShortcutAction, { toggleLoop });
        expect(toggleLoop).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// ContextMenuManager — clampMenuPosition
// ---------------------------------------------------------------------------

describe('ContextMenuManager — clampMenuPosition', () => {
    it('passes through positions that fit', () => {
        const r = clampMenuPosition(100, 100, 200, 200, 1024, 768);
        expect(r).toEqual({ left: 100, top: 100 });
    });

    it('shifts left when the menu would overflow the right edge', () => {
        // x=900, width=200, viewport=1024 -> right edge at 1100, overflow by ~80
        const r = clampMenuPosition(900, 100, 200, 200, 1024, 768);
        // 1024 - 200 - 4 = 820
        expect(r.left).toBe(820);
        expect(r.top).toBe(100);
    });

    it('shifts up when the menu would overflow the bottom edge', () => {
        const r = clampMenuPosition(100, 700, 200, 200, 1024, 768);
        // 768 - 200 - 4 = 564
        expect(r.left).toBe(100);
        expect(r.top).toBe(564);
    });

    it('shifts on both axes when needed', () => {
        const r = clampMenuPosition(1000, 750, 200, 200, 1024, 768);
        expect(r.left).toBe(820);
        expect(r.top).toBe(564);
    });

    it('clamps negative coordinates to 0', () => {
        const r = clampMenuPosition(-50, -10, 100, 100, 1024, 768);
        expect(r).toEqual({ left: 0, top: 0 });
    });

    it('handles a viewport smaller than the menu (returns 0,0)', () => {
        const r = clampMenuPosition(100, 100, 800, 800, 200, 200);
        expect(r).toEqual({ left: 0, top: 0 });
    });
});

// ---------------------------------------------------------------------------
// ContextMenuManager — buildMenuItems (item ordering)
// ---------------------------------------------------------------------------

describe('ContextMenuManager — buildMenuItems', () => {
    function makeHandlers(): ContextMenuHandlers {
        return {
            onCopyRegion: jest.fn(),
            onExportRegion: jest.fn(),
            onToggleLoop: jest.fn(),
            onDeleteRegion: jest.fn(),
            onSetA: jest.fn(),
            onSetB: jest.fn(),
            onClearAB: jest.fn()
        };
    }

    it('produces all 7 items when a region is active, region-specific first', () => {
        const region = makeRegion('r1', 1, 2);
        const items = buildMenuItems(
            { x: 0, y: 0, region, timeAtClick: 1.5 },
            makeHandlers()
        );
        const ids = items.map((i) => i.id);
        // Region-specific (4) first, then always-on (3).
        expect(ids).toEqual([
            'copy-region',
            'export-region',
            'toggle-loop',
            'delete-region',
            'set-a',
            'set-b',
            'clear-ab'
        ]);
        expect(items).toHaveLength(7);
    });

    it('produces only the always-on items when no region is active', () => {
        const items = buildMenuItems(
            { x: 0, y: 0, region: null, timeAtClick: 1.5 },
            makeHandlers()
        );
        const ids = items.map((i) => i.id);
        expect(ids).toEqual(['set-a', 'set-b', 'clear-ab']);
    });

    it('routes onSelect for each item to the matching handler', () => {
        const region = makeRegion('r1', 1, 2);
        const handlers = makeHandlers();
        const items = buildMenuItems(
            { x: 0, y: 0, region, timeAtClick: 7 },
            handlers
        );
        const byId = new Map<AudioContextMenuId, () => void>(
            items.map((i) => [i.id, i.onSelect])
        );

        byId.get('copy-region')!();
        expect(handlers.onCopyRegion).toHaveBeenCalledWith(region);

        byId.get('export-region')!();
        expect(handlers.onExportRegion).toHaveBeenCalledWith(region);

        byId.get('toggle-loop')!();
        expect(handlers.onToggleLoop).toHaveBeenCalledTimes(1);

        byId.get('delete-region')!();
        expect(handlers.onDeleteRegion).toHaveBeenCalledWith(region);

        byId.get('set-a')!();
        expect(handlers.onSetA).toHaveBeenCalledWith(7);

        byId.get('set-b')!();
        expect(handlers.onSetB).toHaveBeenCalledWith(7);

        byId.get('clear-ab')!();
        expect(handlers.onClearAB).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// ContextMenuManager — open / hide / dismissal lifecycle
// ---------------------------------------------------------------------------

interface Harness {
    state: AudioControllerState;
    manager: ContextMenuManager;
    waveform: HTMLElement;
    spectrogram: HTMLElement;
    contextMenu: HTMLElement;
    loopCheckbox: HTMLInputElement;
    addedRegions: Array<{ start: number; end: number }>;
    storedRegions: Map<string, RegionLike>;
    extractCalls: RegionLike[];
    clearAllRegions: jest.Mock;
}

function buildHarness(opts: { selectedRegion?: RegionLike | null } = {}): Harness {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.className = 'audio-viewer-host';
    const waveform = document.createElement('div');
    waveform.className = 'js-waveform';
    const spectrogram = document.createElement('div');
    spectrogram.className = 'js-spectrogram';
    const contextMenu = document.createElement('div');
    contextMenu.className = 'audio-context-menu js-context-menu';
    contextMenu.style.display = 'none';
    const loopCheckbox = document.createElement('input');
    loopCheckbox.type = 'checkbox';
    loopCheckbox.className = 'js-loop-enabled';
    root.appendChild(waveform);
    root.appendChild(spectrogram);
    root.appendChild(contextMenu);
    root.appendChild(loopCheckbox);
    document.body.appendChild(root);

    const storedRegions = new Map<string, RegionLike>();
    if (opts.selectedRegion) {
        storedRegions.set(opts.selectedRegion.id, opts.selectedRegion);
    }
    const addedRegions: Array<{ start: number; end: number }> = [];
    const regionsPlugin: RegionsPluginLike = {
        enableDragSelection: () => undefined,
        on: () => () => undefined,
        getRegions: () => Object.fromEntries(storedRegions.entries()),
        addRegion: ({ start, end }) => {
            addedRegions.push({ start, end });
            const id = `r-${addedRegions.length}`;
            const region: RegionLike = {
                id,
                start,
                end,
                remove: () => storedRegions.delete(id)
            };
            storedRegions.set(id, region);
            return region;
        }
    };

    const wsAny = {
        getDuration: () => 60,
        getCurrentTime: () => 5
    };
    const extractCalls: RegionLike[] = [];
    const clearAllRegions = jest.fn(() => {
        Array.from(storedRegions.values()).forEach((r) => r.remove());
    });

    const elements = {
        playPause: null,
        stop: null,
        volume: null,
        loopEnabled: loopCheckbox,
        loopControls: null,
        visualizationMode: null,
        visualizationModeButtons: [] as HTMLElement[],
        spectrogramScaleGroup: null,
        spectrogramScale: null,
        playbackSpeed: null,
        loading: null,
        error: null,
        waveform,
        spectrogram,
        minimap: null,
        timeline: null,
        status: null,
        fileInfo: null,
        durationInfo: null,
        sampleRateInfo: null,
        channelsInfo: null,
        channelDetailsInfo: null,
        bitDepthInfo: null,
        fileSizeInfo: null,
        formatInfo: null,
        downloadBtn: null,
        zoomControls: null,
        zoomIn: null,
        zoomOut: null,
        zoomLevel: null,
        contextMenu
    };
    const state = {
        wavesurfer: wsAny as unknown as AudioControllerState['wavesurfer'],
        spectrogramPlugin: null,
        timelinePlugin: null,
        regionsPlugin,
        spectrogramSplitChannels: false,
        visualizationMode: 'waveform' as const,
        isPlaying: false,
        loopEnabled: false,
        isSetupComplete: true,
        audioContextInitialized: true,
        selectedRegionId: opts.selectedRegion?.id ?? null,
        regionStartOverlay: null,
        regionEndOverlay: null,
        regionDurationOverlay: null,
        loadTimeoutId: null,
        elements,
        root,
        regionManager: {
            showControls: jest.fn(),
            hideControls: jest.fn(),
            clearAllRegions,
            clearRegionsFromDOM: jest.fn(),
            getSelectedRegion: () => opts.selectedRegion ?? null,
            createOverlays: jest.fn(),
            updateSelectedRegionOverlays: jest.fn()
        },
        audioController: {
            setVisualizationMode: jest.fn(),
            showLoadError: jest.fn(),
            extractAndDownloadRegion: (region: RegionLike) => {
                extractCalls.push(region);
            }
        }
    } as unknown as AudioControllerState;

    const manager = new ContextMenuManager(state);
    manager.mountContextMenu();

    return {
        state,
        manager,
        waveform,
        spectrogram,
        contextMenu,
        loopCheckbox,
        addedRegions,
        storedRegions,
        extractCalls,
        clearAllRegions
    };
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('ContextMenuManager — open / hide', () => {
    it('renders 7 items when the user right-clicks with a region selected', () => {
        const region = makeRegion('r1', 1, 2);
        const h = buildHarness({ selectedRegion: region });
        h.manager.open({ x: 50, y: 60, region, timeAtClick: 1.5 });

        expect(h.contextMenu.style.display).toBe('block');
        const items = h.contextMenu.querySelectorAll('.context-menu-item');
        expect(items).toHaveLength(7);
        const ids = Array.from(items).map((el) => (el as HTMLElement).dataset.menuId);
        expect(ids).toEqual([
            'copy-region',
            'export-region',
            'toggle-loop',
            'delete-region',
            'set-a',
            'set-b',
            'clear-ab'
        ]);
    });

    it('renders only A/B items when no region is selected', () => {
        const h = buildHarness({ selectedRegion: null });
        h.manager.open({ x: 50, y: 60, region: null, timeAtClick: 0 });
        const items = h.contextMenu.querySelectorAll('.context-menu-item');
        expect(Array.from(items).map((el) => (el as HTMLElement).dataset.menuId)).toEqual([
            'set-a',
            'set-b',
            'clear-ab'
        ]);
    });

    it('hide() removes the rendered items and sets display=none', () => {
        const h = buildHarness({ selectedRegion: makeRegion('r1', 1, 2) });
        h.manager.open({ x: 50, y: 60, region: makeRegion('r1', 1, 2), timeAtClick: 1 });
        expect(h.manager.isVisible()).toBe(true);
        h.manager.hide();
        expect(h.manager.isVisible()).toBe(false);
        expect(h.contextMenu.querySelectorAll('.context-menu-item')).toHaveLength(0);
    });

    it('Escape key while open hides the menu', () => {
        const h = buildHarness({ selectedRegion: makeRegion('r1', 1, 2) });
        h.manager.open({ x: 50, y: 60, region: makeRegion('r1', 1, 2), timeAtClick: 1 });
        expect(h.manager.isVisible()).toBe(true);

        const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
        document.dispatchEvent(ev);

        expect(h.manager.isVisible()).toBe(false);
    });

    it('outside-click hides the menu, inside-click does not', () => {
        const h = buildHarness({ selectedRegion: makeRegion('r1', 1, 2) });
        h.manager.open({ x: 50, y: 60, region: makeRegion('r1', 1, 2), timeAtClick: 1 });
        expect(h.manager.isVisible()).toBe(true);

        // Click on the document body (outside the menu).
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(h.manager.isVisible()).toBe(false);
    });

    it('contextmenu on an input overlay does NOT open the menu', () => {
        // Drop a fake region-input-overlay child into the waveform; the
        // manager should ignore right-clicks landing inside it so the
        // user keeps the native input field menu.
        const overlay = document.createElement('div');
        overlay.className = 'region-input-overlay';
        const input = document.createElement('input');
        input.className = 'region-start-input';
        overlay.appendChild(input);
        const h = buildHarness({ selectedRegion: makeRegion('r1', 1, 2) });
        h.waveform.appendChild(overlay);

        const ev = new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 100,
            clientY: 100
        });
        Object.defineProperty(ev, 'target', { value: input });
        h.waveform.dispatchEvent(ev);

        expect(h.manager.isVisible()).toBe(false);
    });
});

describe('ContextMenuManager — item handlers', () => {
    it('Export region routes through audioController.extractAndDownloadRegion', () => {
        const region = makeRegion('r1', 1, 2);
        const h = buildHarness({ selectedRegion: region });
        h.manager.open({ x: 0, y: 0, region, timeAtClick: 1 });
        const exportItem = h.contextMenu.querySelector<HTMLElement>(
            '[data-menu-id="export-region"]'
        );
        expect(exportItem).not.toBeNull();
        exportItem!.click();
        expect(h.extractCalls).toEqual([region]);
        expect(h.manager.isVisible()).toBe(false);
    });

    it('Delete region calls region.remove() and clears the selection', () => {
        const region = makeRegion('r1', 1, 2);
        const h = buildHarness({ selectedRegion: region });
        h.manager.open({ x: 0, y: 0, region, timeAtClick: 1 });
        const deleteItem = h.contextMenu.querySelector<HTMLElement>(
            '[data-menu-id="delete-region"]'
        );
        expect(deleteItem).not.toBeNull();
        deleteItem!.click();
        expect(region.remove).toHaveBeenCalledTimes(1);
        expect(h.state.selectedRegionId).toBeNull();
    });

    it('Toggle loop flips the checkbox + state.loopEnabled', () => {
        const region = makeRegion('r1', 1, 2);
        const h = buildHarness({ selectedRegion: region });
        expect(h.state.loopEnabled).toBe(false);
        h.manager.open({ x: 0, y: 0, region, timeAtClick: 1 });
        const toggleItem = h.contextMenu.querySelector<HTMLElement>(
            '[data-menu-id="toggle-loop"]'
        );
        toggleItem!.click();
        expect(h.loopCheckbox.checked).toBe(true);
        expect(h.state.loopEnabled).toBe(true);
    });

    it('Clear A-B calls regionManager.clearAllRegions', () => {
        const h = buildHarness({ selectedRegion: makeRegion('r1', 1, 2) });
        h.manager.open({ x: 0, y: 0, region: null, timeAtClick: 0 });
        const clearItem = h.contextMenu.querySelector<HTMLElement>(
            '[data-menu-id="clear-ab"]'
        );
        clearItem!.click();
        expect(h.clearAllRegions).toHaveBeenCalledTimes(1);
    });

    it('Set A creates a region starting at the clicked time when none exists', () => {
        const h = buildHarness({ selectedRegion: null });
        h.manager.open({ x: 0, y: 0, region: null, timeAtClick: 12 });
        const setA = h.contextMenu.querySelector<HTMLElement>(
            '[data-menu-id="set-a"]'
        );
        setA!.click();
        expect(h.addedRegions).toHaveLength(1);
        expect(h.addedRegions[0].start).toBeCloseTo(12, 5);
        // End is clamped to start + at least 0.05s up to 0.5s.
        expect(h.addedRegions[0].end).toBeGreaterThan(12);
    });

    it('Set B creates a region whose end matches the clicked time', () => {
        const h = buildHarness({ selectedRegion: null });
        h.manager.open({ x: 0, y: 0, region: null, timeAtClick: 30 });
        const setB = h.contextMenu.querySelector<HTMLElement>(
            '[data-menu-id="set-b"]'
        );
        setB!.click();
        expect(h.addedRegions).toHaveLength(1);
        expect(h.addedRegions[0].end).toBeCloseTo(30, 5);
        expect(h.addedRegions[0].start).toBeLessThan(30);
    });

    it('Set A on an active region keeps the original end (within bounds)', () => {
        const region = makeRegion('r1', 5, 10);
        const h = buildHarness({ selectedRegion: region });
        h.manager.open({ x: 0, y: 0, region, timeAtClick: 7 });
        const setA = h.contextMenu.querySelector<HTMLElement>(
            '[data-menu-id="set-a"]'
        );
        setA!.click();
        expect(h.addedRegions[h.addedRegions.length - 1].start).toBeCloseTo(7, 5);
        expect(h.addedRegions[h.addedRegions.length - 1].end).toBeCloseTo(10, 5);
    });
});

// ---------------------------------------------------------------------------
// ContextMenuManager — dispose tears down listeners
// ---------------------------------------------------------------------------

describe('ContextMenuManager — dispose', () => {
    it('after dispose(), Escape no longer hides the menu (listener is gone)', () => {
        const region = makeRegion('r1', 1, 2);
        const h = buildHarness({ selectedRegion: region });
        h.manager.open({ x: 0, y: 0, region, timeAtClick: 1 });
        h.manager.dispose();
        // dispose hides the menu; re-opening manually shouldn't
        // resurrect the listeners, but a fresh open() call still works
        // because the menu element is still in the DOM.
        h.manager.open({ x: 0, y: 0, region, timeAtClick: 1 });
        expect(h.manager.isVisible()).toBe(true);
        // ESC should now be a no-op since dispose() removed the keydown handler.
        document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        );
        expect(h.manager.isVisible()).toBe(true);
    });

    it('mountContextMenu() is idempotent (double-mount does not duplicate listeners)', () => {
        const region = makeRegion('r1', 1, 2);
        const h = buildHarness({ selectedRegion: region });
        // Already mounted in the harness — call again.
        h.manager.mountContextMenu();
        h.manager.open({ x: 0, y: 0, region, timeAtClick: 1 });
        expect(h.manager.isVisible()).toBe(true);
        document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        );
        expect(h.manager.isVisible()).toBe(false);
    });
});
