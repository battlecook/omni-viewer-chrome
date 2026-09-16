jest.mock('omni-viewer-core/viewers/gguf', () => ({
    mountGgufViewer: jest.fn()
}));
jest.mock('omni-viewer-core/i18n', () => ({
    resolveCatalogMessage: jest.fn((key: string) => key)
}));

import { mountGgufViewer } from '../templates/gguf/js/ggufViewer';

const core = jest.requireMock('omni-viewer-core/viewers/gguf') as {
    mountGgufViewer: jest.Mock;
};

describe('GGUF Chrome adapter', () => {
    const dispose = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        core.mountGgufViewer.mockResolvedValue({ dispose });
    });

    it('passes the file bytes to omni-viewer-core', async () => {
        const bytes = new Uint8Array([0x47, 0x47, 0x55, 0x46, 3, 0, 0, 0]);
        const file = new File([bytes], 'tiny.gguf', { lastModified: 1700000000000 });
        const container = document.createElement('div');

        const handle = await mountGgufViewer(file, container);

        expect(core.mountGgufViewer).toHaveBeenCalledWith(
            {
                fileName: 'tiny.gguf',
                data: bytes,
                lastModified: 1700000000000
            },
            container,
            expect.objectContaining({
                i18n: expect.objectContaining({ t: expect.any(Function) })
            })
        );
        expect(handle).toEqual({ dispose });
    });

    /**
     * The core URI overload enforces HTTP 206 range semantics that a `blob:`
     * URL cannot satisfy, which rendered every local file as "invalid".
     */
    it('never routes a local file through the core URI path', async () => {
        await mountGgufViewer(new File(['GGUF'], 'tiny.gguf'), document.createElement('div'));

        expect(core.mountGgufViewer.mock.calls[0]?.[0]).not.toHaveProperty('uri');
    });

    it('propagates core parsing failures', async () => {
        core.mountGgufViewer.mockRejectedValueOnce(new Error('parse failed'));

        await expect(
            mountGgufViewer(new File(['GGUF'], 'broken.gguf'), document.createElement('div'))
        ).rejects.toThrow('parse failed');
    });
});
