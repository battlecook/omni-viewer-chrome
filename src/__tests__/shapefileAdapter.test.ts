jest.mock('omni-viewer-core/viewers/shapefile/self-loading', () => ({
    mountSelfLoadingShapefileViewer: jest.fn()
}));
jest.mock('omni-viewer-core/i18n', () => ({
    resolveLocalizedCatalogMessage: jest.fn(
        (locale: string, key: string, args?: Record<string, string | number>) =>
            `${locale}:${key}:${args?.features ?? ''}`
    )
}));

import { TextDecoder as NodeTextDecoder } from 'util';

import {
    findSidecar,
    mountShapefileViewer,
    sidecarName
} from '../templates/shapefile/js/shapefileViewer';
import { VIEWER_REGISTRATIONS } from '../viewerRegistry';

const core = jest.requireMock('omni-viewer-core/viewers/shapefile/self-loading') as {
    mountSelfLoadingShapefileViewer: jest.Mock;
};
const i18n = jest.requireMock('omni-viewer-core/i18n') as {
    resolveLocalizedCatalogMessage: jest.Mock;
};

/** A 100-byte `.shp` header: file code 9994 big-endian, version 1000 little. */
function shpBytes(): Uint8Array {
    const bytes = new Uint8Array(100);
    const view = new DataView(bytes.buffer);
    view.setInt32(0, 9994, false);
    view.setInt32(28, 1000, true);
    view.setInt32(32, 5, true); // Polygon
    return bytes;
}

const WGS84_WKT = 'GEOGCS["WGS 84",DATUM["WGS_1984"]]';

function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A remount reads the picked companion through FileReader, so it settles over
 *  several ticks rather than one microtask drain. */
async function waitForMounts(count: number): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
        if (core.mountSelfLoadingShapefileViewer.mock.calls.length >= count) return;
        await flush();
    }
    throw new Error(
        `expected ${count} mounts, saw ${core.mountSelfLoadingShapefileViewer.mock.calls.length}`
    );
}

describe('Shapefile Chrome adapter', () => {
    const dispose = jest.fn();
    const mounted: Array<{ dispose(): void }> = [];

    /** Mounts and registers the handle for teardown — an adapter left alive
     *  keeps remounting into the next test and eats its queued mock behaviour. */
    async function mount(
        ...args: Parameters<typeof mountShapefileViewer>
    ): Promise<{ dispose(): void }> {
        const handle = await mountShapefileViewer(...args);
        mounted.push(handle);
        return handle;
    }

    beforeEach(() => {
        jest.clearAllMocks();
        core.mountSelfLoadingShapefileViewer.mockResolvedValue({ dispose });
        Object.assign(chrome, {
            i18n: {
                getMessage: jest.fn(() => ''),
                getUILanguage: jest.fn(() => 'en-US')
            }
        });
        document.documentElement.lang = 'ko-KR';
        // jsdom under Jest ships no global TextDecoder; Chrome always has one.
        Object.defineProperty(globalThis, 'TextDecoder', {
            configurable: true,
            value: NodeTextDecoder
        });
    });

    afterEach(() => {
        while (mounted.length > 0) mounted.pop()?.dispose();
    });

    it('passes the geometry bytes to the self-loading core entry', async () => {
        const bytes = shpBytes();
        const file = new File([bytes], 'districts.shp', { lastModified: 1700000000000 });
        const container = document.createElement('div');

        await mount(file, container);

        expect(core.mountSelfLoadingShapefileViewer).toHaveBeenCalledWith(
            {
                fileName: 'districts.shp',
                data: bytes,
                lastModified: 1700000000000
            },
            // The core takes its container over with a shadow root, so the bar
            // above it has to live outside the element the core receives; the
            // assertions below pin where that host element sits.
            expect.any(HTMLDivElement),
            expect.objectContaining({
                i18n: expect.objectContaining({ t: expect.any(Function) })
            }),
            { signal: undefined }
        );
        const host = core.mountSelfLoadingShapefileViewer.mock.calls[0][1] as HTMLElement;
        expect(host.parentElement).toBe(container);
        expect(host.previousElementSibling?.className).toBe('omni-shapefile-sidecars');
    });

    it('hands over both companions when the host already paired them', async () => {
        const dbf = new File([new Uint8Array([0x03, 0x00, 0x00, 0x00])], 'districts.dbf');
        const prj = new File([WGS84_WKT], 'districts.prj');

        await mount(
            new File([shpBytes()], 'districts.shp'),
            document.createElement('div'),
            undefined,
            undefined,
            { sidecars: { dbf, prj } }
        );

        const options = core.mountSelfLoadingShapefileViewer.mock.calls[0][3];
        expect(options.sidecars.dbf).toEqual(new Uint8Array([0x03, 0x00, 0x00, 0x00]));
        expect(options.sidecars.prj).toBe(WGS84_WKT);
    });

    it('mounts a lone .shp without a sidecars option at all', async () => {
        await mount(
            new File([shpBytes()], 'districts.shp'),
            document.createElement('div')
        );

        const options = core.mountSelfLoadingShapefileViewer.mock.calls[0][3];
        expect(options).not.toHaveProperty('sidecars');
    });

    it('names each missing companion in the bar and remounts once one is attached', async () => {
        const container = document.createElement('div');
        await mount(
            new File([shpBytes()], 'districts.shp'),
            container
        );

        const rows = container.querySelectorAll('.omni-shapefile-sidecar');
        expect(rows).toHaveLength(2);
        expect(rows[0].textContent).toContain('districts.dbf');
        expect(rows[1].textContent).toContain('districts.prj');
        expect(rows[0].querySelector('button')?.textContent).toBe('Attach .dbf…');

        const picker = rows[0].querySelector('input[type="file"]') as HTMLInputElement;
        const picked = new File([new Uint8Array([0x03])], 'attrs.dbf');
        Object.defineProperty(picker, 'files', { configurable: true, value: [picked] });
        picker.dispatchEvent(new Event('change'));
        await waitForMounts(2);

        expect(core.mountSelfLoadingShapefileViewer).toHaveBeenCalledTimes(2);
        const options = core.mountSelfLoadingShapefileViewer.mock.calls[1][3];
        expect(options.sidecars.dbf).toEqual(new Uint8Array([0x03]));
        expect(rows[0].textContent).toContain('attrs.dbf');
        expect(rows[0].querySelector('button')?.textContent).toBe('Replace .dbf…');
    });

    it('keeps the previous view and reports why a rejected companion was dropped', async () => {
        const container = document.createElement('div');
        const prj = new File([WGS84_WKT], 'districts.prj');
        await mount(
            new File([shpBytes()], 'districts.shp'),
            container,
            undefined,
            undefined,
            { sidecars: { prj } }
        );

        core.mountSelfLoadingShapefileViewer.mockRejectedValueOnce(
            new Error('unsupported projection')
        );
        const row = container.querySelectorAll('.omni-shapefile-sidecar')[1];
        const picker = row.querySelector('input[type="file"]') as HTMLInputElement;
        const picked = new File(['PROJCS["broken"'], 'broken.prj');
        Object.defineProperty(picker, 'files', { configurable: true, value: [picked] });
        picker.dispatchEvent(new Event('change'));
        await waitForMounts(3);
        await flush();

        // Three mounts: the initial one, the rejected attempt, the restore.
        expect(core.mountSelfLoadingShapefileViewer).toHaveBeenCalledTimes(3);
        expect(core.mountSelfLoadingShapefileViewer.mock.calls[2][3].sidecars.prj).toBe(WGS84_WKT);
        expect(row.textContent).toContain("Couldn't apply broken.prj: unsupported projection");
        expect(row.querySelector('span')?.className).toContain('__error');
    });

    it('prefers the app-selected document locale for core catalog fallbacks', async () => {
        await mount(
            new File([shpBytes()], 'districts.shp'),
            document.createElement('div')
        );
        const viewerContext = core.mountSelfLoadingShapefileViewer.mock.calls[0][2];

        expect(viewerContext.i18n.t('shapefile.features', { features: 318 })).toBe(
            'ko-KR:shapefile.features:318'
        );
        expect(i18n.resolveLocalizedCatalogMessage).toHaveBeenCalledWith(
            'ko-KR',
            'shapefile.features',
            { features: 318 }
        );
    });

    it('clears the bar and the core handle on dispose', async () => {
        const container = document.createElement('div');
        const handle = await mount(
            new File([shpBytes()], 'districts.shp'),
            container
        );

        handle.dispose();

        expect(dispose).toHaveBeenCalledTimes(1);
        expect(container.childElementCount).toBe(0);
    });

    it('aborts and disposes a mount that completes after provider disposal', async () => {
        let resolveMount!: (handle: { dispose: jest.Mock }) => void;
        const lateDispose = jest.fn();
        core.mountSelfLoadingShapefileViewer.mockReturnValueOnce(new Promise((resolve) => {
            resolveMount = resolve;
        }));
        const registration = VIEWER_REGISTRATIONS.find(
            (item) => item.viewType === 'omni-viewer.shapefileViewer'
        );
        const provider = registration!.createProvider();
        const rendering = provider.render(
            new File([shpBytes()], 'slow.shp'),
            document.createElement('div')
        );
        // The adapter reads the file bytes before it mounts, and under jsdom
        // that read runs through FileReader — so disposal has to wait until the
        // core mount it is meant to outrace has actually been entered.
        await waitForMounts(1);
        provider.dispose?.();
        resolveMount({ dispose: lateDispose });
        await rendering;

        const options = core.mountSelfLoadingShapefileViewer.mock.calls[0][3];
        expect(options.signal.aborted).toBe(true);
        expect(lateDispose).toHaveBeenCalledTimes(1);
    });

    it('propagates core parsing failures after cleaning the container', async () => {
        const container = document.createElement('div');
        core.mountSelfLoadingShapefileViewer.mockRejectedValue(
            new Error('Invalid Shapefile file code.')
        );

        await expect(
            mountShapefileViewer(new File(['not a shapefile'], 'broken.shp'), container)
        ).rejects.toThrow('Invalid Shapefile file code.');
        expect(container.childElementCount).toBe(0);
    });

    describe('companion naming', () => {
        it('derives each sidecar name from the .shp stem', () => {
            expect(sidecarName('districts.SHP', 'dbf')).toBe('districts.dbf');
            expect(sidecarName('districts.shp', 'prj')).toBe('districts.prj');
        });

        it('pairs the companion whose stem matches', () => {
            const shp = { name: 'districts.shp' };
            const match = new File([''], 'districts.dbf');
            const other = new File([''], 'rivers.dbf');
            expect(findSidecar(shp, [match, other], 'dbf')).toBe(match);
        });

        it('takes the only file of that extension when no stem matches', () => {
            const shp = { name: 'districts.shp' };
            const lone = new File([''], 'attributes.dbf');
            expect(findSidecar(shp, [lone], 'dbf')).toBe(lone);
        });

        it('refuses to guess between several unmatched candidates', () => {
            const shp = { name: 'districts.shp' };
            const files = [new File([''], 'a.dbf'), new File([''], 'b.dbf')];
            expect(findSidecar(shp, files, 'dbf')).toBeUndefined();
        });
    });
});
