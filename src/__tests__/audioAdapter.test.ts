// Chrome audio adapter wiring over omni-viewer-core (`viewers/audio`).
//
// The adapter itself owns three things worth pinning: the asset paths the
// core's WASM engine resolves through AssetService, the worker-backed engine
// it injects, and the disposal of that engine (the core disposes only what it
// created, so a leaked worker would be the adapter's bug).

jest.mock('omni-viewer-core/viewers/audio', () => ({
    mountAudioViewer: jest.fn(),
    createWorkerAudioEngine: jest.fn()
}));
jest.mock('omni-viewer-core/i18n', () => ({
    resolveCatalogMessage: (key: string) => key
}));

import { mountAudioViewer as mountChromeAudioViewer } from '../templates/audio/js/audioViewer';
import { VIEWER_REGISTRATIONS } from '../viewerRegistry';

const core = jest.requireMock('omni-viewer-core/viewers/audio') as {
    mountAudioViewer: jest.Mock;
    createWorkerAudioEngine: jest.Mock;
};

interface MountCall {
    input: { fileName: string; data: Uint8Array };
    ctx: {
        assets: { resolveAssetUrl(path: string): Promise<string> };
        i18n: { t(key: string): string };
        logger: { log(level: string, message: string): void };
    };
    options: { deps: { loadWaveform(): Promise<unknown>; engine?: unknown } };
}

function lastMountCall(): MountCall {
    const [input, , ctx, options] = core.mountAudioViewer.mock.calls.at(-1) as [
        MountCall['input'], HTMLElement, MountCall['ctx'], MountCall['options']
    ];
    return { input, ctx, options };
}

function audioFile(name = 'clip.wav'): File {
    return {
        name,
        lastModified: 7,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
    } as File;
}

describe('Audio Chrome adapter', () => {
    let coreDispose: jest.Mock;
    let engineDispose: jest.Mock;

    beforeEach(() => {
        coreDispose = jest.fn();
        engineDispose = jest.fn();
        core.mountAudioViewer.mockReset().mockResolvedValue({ dispose: coreDispose });
        core.createWorkerAudioEngine.mockReset().mockReturnValue({
            decode: jest.fn(),
            analyze: jest.fn(),
            dispose: engineDispose
        });
    });

    it('mounts the core viewer with the file bytes and a waveform loader', async () => {
        await mountChromeAudioViewer(audioFile(), document.createElement('div'));

        const { input, options } = lastMountCall();
        expect(input.fileName).toBe('clip.wav');
        expect(Array.from(input.data)).toEqual([1, 2, 3]);
        expect(typeof options.deps.loadWaveform).toBe('function');
    });

    it('resolves the core engine asset keys under the web-accessible assets/ root', async () => {
        await mountChromeAudioViewer(audioFile(), document.createElement('div'));
        const { ctx } = lastMountCall();

        // The core addresses the engine as `audio-engine/*`; webpack copies it
        // to dist/assets/audio-engine/.
        await expect(ctx.assets.resolveAssetUrl('audio-engine/audio_engine_worker.mjs')).resolves.toBe(
            'chrome-extension://omni-viewer-test/assets/audio-engine/audio_engine_worker.mjs'
        );
        // Keys that already carry the prefix (pdf.js style) pass through once.
        await expect(ctx.assets.resolveAssetUrl('assets/audio-engine/audio_engine.wasm')).resolves.toBe(
            'chrome-extension://omni-viewer-test/assets/audio-engine/audio_engine.wasm'
        );
    });

    it('injects a worker-backed engine and disposes it with the viewer', async () => {
        // jsdom has no Worker; the extension page does.
        const globalWithWorker = globalThis as { Worker?: unknown };
        globalWithWorker.Worker = class {};
        try {
            const handle = await mountChromeAudioViewer(audioFile(), document.createElement('div'));
            expect(core.createWorkerAudioEngine).toHaveBeenCalledTimes(1);
            expect(lastMountCall().options.deps.engine).toBeDefined();

            handle.dispose();
            expect(coreDispose).toHaveBeenCalledTimes(1);
            expect(engineDispose).toHaveBeenCalledTimes(1);
        } finally {
            delete globalWithWorker.Worker;
        }
    });

    it('mounts without an engine when the host has no Worker', async () => {
        const handle = await mountChromeAudioViewer(audioFile(), document.createElement('div'));
        expect(core.createWorkerAudioEngine).not.toHaveBeenCalled();
        expect(lastMountCall().options.deps.engine).toBeUndefined();

        handle.dispose();
        expect(coreDispose).toHaveBeenCalledTimes(1);
    });

    it('replaces the registry placeholder with the real audio provider', () => {
        const entry = VIEWER_REGISTRATIONS.find((r) => r.viewType === 'omni-viewer.audioViewer');
        const provider = entry?.createProvider();
        expect(typeof provider?.render).toBe('function');
        expect(typeof provider?.dispose).toBe('function');
    });
});
