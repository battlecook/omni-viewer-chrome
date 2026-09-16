jest.mock('omni-viewer-core/viewers/onnx', () => ({
    mountOnnxViewer: jest.fn()
}));
jest.mock('omni-viewer-core/i18n', () => ({
    resolveCatalogMessage: jest.fn((key: string) => key)
}));

import { mountOnnxViewer } from '../templates/onnx/js/onnxViewer';

const core = jest.requireMock('omni-viewer-core/viewers/onnx') as {
    mountOnnxViewer: jest.Mock;
};

describe('ONNX Chrome adapter', () => {
    const dispose = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        core.mountOnnxViewer.mockResolvedValue({ dispose });
    });

    it('passes the file bytes to omni-viewer-core', async () => {
        // ir_version = 7 (field 1 varint), then producer_name (field 2).
        const bytes = new Uint8Array([0x08, 0x07, 0x12, 0x04]);
        const file = new File([bytes], 'tiny.onnx', { lastModified: 1700000000000 });
        const container = document.createElement('div');

        const handle = await mountOnnxViewer(file, container);

        expect(core.mountOnnxViewer).toHaveBeenCalledWith(
            {
                fileName: 'tiny.onnx',
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

    it('propagates core parsing failures', async () => {
        core.mountOnnxViewer.mockRejectedValueOnce(new Error('parse failed'));

        await expect(
            mountOnnxViewer(new File(['nope'], 'broken.onnx'), document.createElement('div'))
        ).rejects.toThrow('parse failed');
    });
});
