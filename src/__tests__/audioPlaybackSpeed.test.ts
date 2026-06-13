// Tests for the playback-speed select wiring added in issue #25.
//
// We instantiate EventManager directly with a hand-rolled state +
// minimal stub managers, then dispatch DOM events to confirm the select
// routes the correct numeric rate to the WaveSurfer-side setter. The
// WaveSurferManager dependency is stubbed to a recording double so we can
// assert on the rate that gets propagated.

import { EventManager } from '../templates/audio/js/AudioController/managers/EventManager';
import type { AudioControllerState } from '../templates/audio/js/AudioController/managers/types';

/**
 * Build a fragment that holds a `js-playback-speed` select pre-populated
 * with the eight options the issue specifies. Returning the live element
 * keeps the assertions readable — the test changes its `.value` and fires
 * the event, like the user would.
 */
function buildSelect(): HTMLSelectElement {
    const select = document.createElement('select');
    select.className = 'js-playback-speed';
    select.id = 'playbackSpeed';
    ['0.25', '0.5', '0.75', '1', '1.25', '1.5', '2', '4'].forEach((value) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = `${value}x`;
        if (value === '1') opt.selected = true;
        select.appendChild(opt);
    });
    document.body.appendChild(select);
    return select;
}

interface StubState {
    state: AudioControllerState;
    select: HTMLSelectElement;
    rateCalls: number[];
}

function buildState(): StubState {
    const select = buildSelect();
    const rateCalls: number[] = [];
    const wavesurfer = {
        // Only the methods touched by the playback-speed code path matter;
        // anything else would throw if accessed, surfacing accidental wiring.
        setPlaybackRate: (rate: number, _preservePitch?: boolean) => {
            rateCalls.push(rate);
        }
    };
    const elements = {
        playPause: null,
        stop: null,
        volume: null,
        loopEnabled: null,
        loopControls: null,
        visualizationMode: null,
        visualizationModeButtons: [],
        spectrogramScaleGroup: null,
        spectrogramScale: null,
        playbackSpeed: select,
        loading: null,
        error: null,
        waveform: null,
        spectrogram: null,
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
        contextMenu: null
    };
    const state = {
        wavesurfer: wavesurfer as unknown as AudioControllerState['wavesurfer'],
        spectrogramPlugin: null,
        timelinePlugin: null,
        regionsPlugin: null,
        spectrogramSplitChannels: false,
        visualizationMode: 'waveform' as const,
        isPlaying: false,
        loopEnabled: false,
        isSetupComplete: true,
        audioContextInitialized: true,
        selectedRegionId: null,
        regionStartOverlay: null,
        regionEndOverlay: null,
        regionDurationOverlay: null,
        loadTimeoutId: null,
        elements,
        root: document.body,
        regionManager: {
            showControls: () => undefined,
            hideControls: () => undefined,
            clearAllRegions: () => undefined,
            clearRegionsFromDOM: () => undefined,
            getSelectedRegion: () => null,
            createOverlays: () => undefined,
            updateSelectedRegionOverlays: () => undefined
        }
    } as unknown as AudioControllerState;
    return { state, select, rateCalls };
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('EventManager.setupPlaybackSpeed', () => {
    it('routes select changes through the WaveSurferManager when provided', () => {
        const { state, select, rateCalls } = buildState();
        // Stub manager — only the method used by the wiring is implemented.
        const wsManagerCalls: number[] = [];
        const wsManager = {
            setPlaybackRate: (rate: number) => {
                wsManagerCalls.push(rate);
            }
        };
        const evt = new EventManager(
            state,
            // AudioContextManager + RegionManager aren't touched by this path.
            { initialize: () => Promise.resolve(), getWaveSurferAudioContext: () => null, checkState: () => undefined } as unknown as ConstructorParameters<typeof EventManager>[1],
            state.regionManager as unknown as ConstructorParameters<typeof EventManager>[2],
            wsManager as unknown as ConstructorParameters<typeof EventManager>[3]
        );
        evt.setupPlaybackSpeed();

        select.value = '2';
        select.dispatchEvent(new Event('change'));
        select.value = '0.25';
        select.dispatchEvent(new Event('change'));
        select.value = '4';
        select.dispatchEvent(new Event('change'));

        expect(wsManagerCalls).toEqual([2, 0.25, 4]);
        // The fallback-direct path on `wavesurfer.setPlaybackRate` must NOT
        // fire when a manager is present, otherwise rate changes would
        // double-apply.
        expect(rateCalls).toEqual([]);
    });

    it('falls back to wavesurfer.setPlaybackRate when no manager is given', () => {
        const { state, select, rateCalls } = buildState();
        const evt = new EventManager(
            state,
            { initialize: () => Promise.resolve(), getWaveSurferAudioContext: () => null, checkState: () => undefined } as unknown as ConstructorParameters<typeof EventManager>[1],
            state.regionManager as unknown as ConstructorParameters<typeof EventManager>[2]
        );
        evt.setupPlaybackSpeed();

        select.value = '1.5';
        select.dispatchEvent(new Event('change'));

        expect(rateCalls).toEqual([1.5]);
    });

    it('ignores changes that would resolve to a non-positive rate', () => {
        const { state, select, rateCalls } = buildState();
        // Inject a hostile option after the fact to simulate a corrupt DOM.
        const bogus = document.createElement('option');
        bogus.value = 'not-a-number';
        select.appendChild(bogus);

        const evt = new EventManager(
            state,
            { initialize: () => Promise.resolve(), getWaveSurferAudioContext: () => null, checkState: () => undefined } as unknown as ConstructorParameters<typeof EventManager>[1],
            state.regionManager as unknown as ConstructorParameters<typeof EventManager>[2]
        );
        evt.setupPlaybackSpeed();

        select.value = 'not-a-number';
        select.dispatchEvent(new Event('change'));

        expect(rateCalls).toEqual([]);
    });

    it('handles all eight canonical playback rates from the spec', () => {
        const { state, select, rateCalls } = buildState();
        const evt = new EventManager(
            state,
            { initialize: () => Promise.resolve(), getWaveSurferAudioContext: () => null, checkState: () => undefined } as unknown as ConstructorParameters<typeof EventManager>[1],
            state.regionManager as unknown as ConstructorParameters<typeof EventManager>[2]
        );
        evt.setupPlaybackSpeed();

        const rates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4];
        rates.forEach((r) => {
            select.value = String(r);
            select.dispatchEvent(new Event('change'));
        });

        expect(rateCalls).toEqual(rates);
    });
});
