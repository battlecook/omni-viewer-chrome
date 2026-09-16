jest.mock('omni-viewer-core/viewers/openvino', () => ({
    mountOpenVinoViewer: jest.fn()
}));
jest.mock('omni-viewer-core/i18n', () => ({
    resolveLocalizedCatalogMessage: jest.fn(
        (locale: string, key: string, args?: Record<string, string | number>) =>
            `${locale}:${key}:${args?.version ?? ''}`
    )
}));

import {
    findSidecarBin,
    mountOpenVinoViewer,
    sidecarBinName
} from '../templates/openvino/js/openvinoViewer';
import { VIEWER_REGISTRATIONS } from '../viewerRegistry';

const core = jest.requireMock('omni-viewer-core/viewers/openvino') as {
    mountOpenVinoViewer: jest.Mock;
};
const i18n = jest.requireMock('omni-viewer-core/i18n') as {
    resolveLocalizedCatalogMessage: jest.Mock;
};

const IR = '<?xml version="1.0"?><net name="tiny" version="11"><layers/><edges/></net>';
const XML_BYTES = Uint8Array.from(IR, (char) => char.charCodeAt(0));
const BIN_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

function xmlFile(): File {
    return new File([XML_BYTES], 'tiny.xml', { lastModified: 1700000000000 });
}

function binFile(name = 'tiny.bin'): File {
    return new File([BIN_BYTES], name);
}

// The attach flow reads the .bin through jsdom's File.arrayBuffer() before it
// reaches the core mock, and how many ticks that takes depends on machine load,
// so wait for the observable outcome rather than a fixed number of timers.
async function settle(until: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200 && !until(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

describe('OpenVINO IR Chrome adapter', () => {
    const dispose = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        core.mountOpenVinoViewer.mockResolvedValue({ dispose });
        Object.assign(chrome, {
            i18n: {
                getMessage: jest.fn(() => ''),
                getUILanguage: jest.fn(() => 'en-US')
            }
        });
        document.documentElement.lang = 'ko-KR';
    });

    it('mounts the topology into its own host and reports the missing .bin', async () => {
        const container = document.createElement('div');

        await mountOpenVinoViewer(xmlFile(), container);

        const [input, host, ctx, options] = core.mountOpenVinoViewer.mock.calls[0];
        expect(input).toEqual({ fileName: 'tiny.xml', data: XML_BYTES, lastModified: 1700000000000 });
        // The core takes its container over with a shadow root, so the bar
        // has to live beside the host rather than inside it.
        expect(host).not.toBe(container);
        expect(host.parentElement).toBe(container);
        expect(ctx.i18n.t).toEqual(expect.any(Function));
        expect(options).toEqual({ signal: undefined });
        const bar = container.querySelector('.omni-openvino-sidecar')!;
        expect(bar.textContent).toContain('tiny.bin');
        expect(bar.querySelector('button')?.textContent).toBe('Attach .bin…');
    });

    it('passes a paired .bin through as the core sidecar', async () => {
        const container = document.createElement('div');

        await mountOpenVinoViewer(xmlFile(), container, undefined, undefined, {
            sidecars: { bin: binFile() }
        });

        expect(core.mountOpenVinoViewer.mock.calls[0][3]).toEqual({
            signal: undefined,
            sidecars: { bin: BIN_BYTES }
        });
        const bar = container.querySelector('.omni-openvino-sidecar')!;
        expect(bar.textContent).toContain('tiny.bin');
        expect(bar.textContent).toContain('8 B');
        expect(bar.querySelector('button')?.textContent).toBe('Replace .bin…');
    });

    it('remounts with the weights once a .bin is attached from the bar', async () => {
        const container = document.createElement('div');
        await mountOpenVinoViewer(xmlFile(), container);
        const picker = container.querySelector<HTMLInputElement>('input[type=file]')!;
        expect(picker.accept).toBe('.bin');

        Object.defineProperty(picker, 'files', { configurable: true, value: [binFile('weights.bin')] });
        picker.dispatchEvent(new Event('change'));
        await settle(() => container.querySelector('.omni-openvino-sidecar')!.textContent!.includes('8 B'));

        expect(dispose).toHaveBeenCalledTimes(1); // the weightless mount went away
        expect(core.mountOpenVinoViewer).toHaveBeenCalledTimes(2);
        expect(core.mountOpenVinoViewer.mock.calls[1][3]).toEqual({
            signal: undefined,
            sidecars: { bin: BIN_BYTES }
        });
        expect(container.querySelector('.omni-openvino-sidecar')!.textContent).toContain('weights.bin');
    });

    it('keeps the previous weights when a picked .bin is rejected by the core', async () => {
        const container = document.createElement('div');
        await mountOpenVinoViewer(xmlFile(), container);
        core.mountOpenVinoViewer.mockRejectedValueOnce(new Error('bin too short'));

        const picker = container.querySelector<HTMLInputElement>('input[type=file]')!;
        Object.defineProperty(picker, 'files', { configurable: true, value: [binFile('wrong.bin')] });
        picker.dispatchEvent(new Event('change'));
        await settle(() => container.querySelector('.omni-openvino-sidecar')!.textContent!.includes('bin too short'));

        expect(core.mountOpenVinoViewer).toHaveBeenCalledTimes(3);
        expect(core.mountOpenVinoViewer.mock.calls[2][3]).toEqual({ signal: undefined });
        const bar = container.querySelector('.omni-openvino-sidecar')!;
        expect(bar.textContent).toContain('wrong.bin');
        expect(bar.textContent).toContain('bin too short');
        expect(bar.querySelector('button')?.textContent).toBe('Attach .bin…');
    });

    it('tears the bar and host down on dispose', async () => {
        const container = document.createElement('div');
        const handle = await mountOpenVinoViewer(xmlFile(), container);

        handle.dispose();

        expect(dispose).toHaveBeenCalledTimes(1);
        expect(container.childElementCount).toBe(0);
    });

    it('prefers the app-selected document locale for core catalog fallbacks', async () => {
        await mountOpenVinoViewer(xmlFile(), document.createElement('div'));
        const viewerContext = core.mountOpenVinoViewer.mock.calls[0][2];

        expect(viewerContext.i18n.t('openvino.irVersion', { version: 11 })).toBe(
            'ko-KR:openvino.irVersion:11'
        );
        expect(i18n.resolveLocalizedCatalogMessage).toHaveBeenCalledWith(
            'ko-KR',
            'openvino.irVersion',
            { version: 11 }
        );
    });

    it('aborts and disposes a mount that completes after provider disposal', async () => {
        let resolveMount!: (handle: { dispose: jest.Mock }) => void;
        const lateDispose = jest.fn();
        core.mountOpenVinoViewer.mockReturnValueOnce(new Promise((resolve) => {
            resolveMount = resolve;
        }));
        const registration = VIEWER_REGISTRATIONS.find(
            (item) => item.viewType === 'omni-viewer.openvinoViewer'
        );
        const provider = registration!.createProvider();
        const container = document.createElement('div');
        const rendering = provider.render(xmlFile(), container);
        await settle(() => core.mountOpenVinoViewer.mock.calls.length === 1);
        provider.dispose?.();
        resolveMount({ dispose: lateDispose });
        await rendering;

        const options = core.mountOpenVinoViewer.mock.calls[0][3];
        expect(options.signal.aborted).toBe(true);
        expect(lateDispose).toHaveBeenCalledTimes(1);
        expect(container.childElementCount).toBe(0);
    });

    it('propagates core parsing failures and leaves nothing behind', async () => {
        core.mountOpenVinoViewer.mockRejectedValueOnce(new Error('parse failed'));
        const container = document.createElement('div');

        await expect(mountOpenVinoViewer(xmlFile(), container)).rejects.toThrow('parse failed');
        expect(container.childElementCount).toBe(0);
    });

    describe('sidecar pairing', () => {
        it('names the .bin the serializer writes beside the .xml', () => {
            expect(sidecarBinName('models/resnet50.xml')).toBe('models/resnet50.bin');
            expect(sidecarBinName('Model.XML')).toBe('Model.bin');
        });

        it('picks the same-stem .bin out of a batch', () => {
            const xml = xmlFile();
            const other = binFile('other.bin');
            const match = binFile('TINY.bin');
            expect(findSidecarBin(xml, [other, xml, match])).toBe(match);
        });

        it('accepts a lone .bin whatever it is called', () => {
            const xml = xmlFile();
            const only = binFile('weights.bin');
            expect(findSidecarBin(xml, [xml, only, new File([], 'notes.txt')])).toBe(only);
        });

        it('refuses to guess between several unmatched .bin files', () => {
            const xml = xmlFile();
            expect(findSidecarBin(xml, [xml, binFile('a.bin'), binFile('b.bin')])).toBeUndefined();
        });
    });
});
