jest.mock('omni-viewer-core/viewers/mesh/self-loading', () => ({ mountSelfLoadingMeshViewer: jest.fn() }));
jest.mock('omni-viewer-core/i18n', () => ({ resolveLocalizedCatalogMessage: () => '' }));
import { createMeshDocumentAssets, mountMeshViewer } from '../templates/mesh/js/meshViewer';

const core = jest.requireMock('omni-viewer-core/viewers/mesh/self-loading');
describe('local glTF document assets', () => {
    let create: jest.Mock;
    let revoke: jest.Mock;
    beforeEach(() => {
        create = jest.fn(() => 'blob:local-resource'); revoke = jest.fn();
        Object.defineProperties(URL, {
            createObjectURL: { configurable: true, value: create },
            revokeObjectURL: { configurable: true, value: revoke }
        });
    });

    it('resolves a supplied resource and releases its URL exactly once', async () => {
        const buffer = new File(['bytes'], 'model.bin');
        const resolver = createMeshDocumentAssets(new File(['{}'], 'model.gltf'), [buffer]);
        const asset = await resolver.resolve('./model.bin');
        expect(asset?.url).toBe('blob:local-resource');
        expect(create).toHaveBeenCalledWith(buffer);
        asset?.dispose(); asset?.dispose();
        expect(revoke).toHaveBeenCalledTimes(1);
    });

    it('uses the model directory when selected files preserve their paths', async () => {
        const model = new File(['{}'], 'model.gltf');
        Object.defineProperty(model, 'webkitRelativePath', { value: 'set/model.gltf' });
        const image = new File(['image'], 'albedo.png');
        Object.defineProperty(image, 'webkitRelativePath', { value: 'set/textures/albedo.png' });
        const resolver = createMeshDocumentAssets(model, [image]);
        expect(await resolver.resolve('textures/albedo.png')).not.toBeNull();
        expect(create).toHaveBeenCalledWith(image);
    });

    it('resolves a nested reference from an unambiguous flattened picker selection', async () => {
        const image = new File(['image'], 'albedo.png');
        const resolver = createMeshDocumentAssets(new File(['{}'], 'model.gltf'), [image]);
        expect(await resolver.resolve('textures/albedo.png')).not.toBeNull();
    });

    it('does not substitute a path-preserved file from a different directory', async () => {
        const model = new File(['{}'], 'model.gltf');
        Object.defineProperty(model, 'webkitRelativePath', { value: 'set/model.gltf' });
        const buffer = new File(['unrelated'], 'mesh.bin');
        Object.defineProperty(buffer, 'webkitRelativePath', { value: 'other/mesh.bin' });
        expect(await createMeshDocumentAssets(model, [buffer]).resolve('buffers/mesh.bin')).toBeNull();
        expect(create).not.toHaveBeenCalled();
    });

    it.each(['textures/./albedo.png', './textures/./albedo.png', 'textures/%2e/albedo.png'])(
        'normalizes current-directory segments before matching %s', async (uri) => {
            const model = new File(['{}'], 'model.gltf');
            Object.defineProperty(model, 'webkitRelativePath', { value: 'set/model.gltf' });
            const image = new File(['correct'], 'albedo.png');
            Object.defineProperty(image, 'webkitRelativePath', { value: 'set/textures/albedo.png' });
            const other = new File(['unrelated'], 'albedo.png');
            Object.defineProperty(other, 'webkitRelativePath', { value: 'other/albedo.png' });
            expect(await createMeshDocumentAssets(model, [image, other]).resolve(uri)).not.toBeNull();
            expect(create).toHaveBeenCalledWith(image);
        }
    );

    it('rejects ambiguous or oversized files', async () => {
        const model = new File(['{}'], 'model.gltf');
        const duplicates = createMeshDocumentAssets(model, [new File(['a'], 'x.bin'), new File(['b'], 'x.bin')]);
        expect(await duplicates.resolve('x.bin')).toBeNull();
        const large = new File(['bytes'], 'large.bin');
        Object.defineProperty(large, 'size', { value: 64 * 1024 * 1024 + 1 });
        expect(await createMeshDocumentAssets(model, [large]).resolve('large.bin')).toBeNull();
        expect(create).not.toHaveBeenCalled();
    });

    it.each(['https://example.org/x.bin', '//example.org/x.bin', '../x.bin', '%2e%2e/x.bin', 'data:application/octet-stream,abc', 'file:///x.bin'])(
        'does not fetch or resolve an unsafe path: %s', async (path) => {
            const resolver = createMeshDocumentAssets(new File(['{}'], 'model.gltf'), [new File(['x'], 'x.bin')]);
            expect(await resolver.resolve(path)).toBeNull();
            expect(create).not.toHaveBeenCalled();
        }
    );

    it('passes SPA companion files through the mount context', async () => {
        core.mountSelfLoadingMeshViewer.mockResolvedValueOnce({ dispose: jest.fn() });
        const file = new File(['{}'], 'model.gltf');
        const buffer = new File(['bytes'], 'model.bin');
        await mountMeshViewer(file, document.createElement('div'), undefined, undefined, { companions: [buffer] });
        const context = core.mountSelfLoadingMeshViewer.mock.calls[0][2];
        expect(await context.documentAssets.resolve('model.bin')).not.toBeNull();
        expect(create).toHaveBeenCalledWith(buffer);
    });
});
