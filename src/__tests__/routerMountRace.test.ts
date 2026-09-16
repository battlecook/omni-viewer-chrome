import { mountViewerForFile } from '../router';
import { VIEWER_REGISTRATIONS } from '../viewerRegistry';
import { disposeAllMountedViewers, type ChromeViewerProvider } from '../viewerProviderUtils';

describe('router async mount lifecycle', () => {
    const registration = VIEWER_REGISTRATIONS.find(
        (item) => item.viewType === 'omni-viewer.tfliteViewer'
    )!;
    const originalFactory = registration.createProvider;

    afterEach(() => {
        disposeAllMountedViewers();
        registration.createProvider = originalFactory;
    });

    it('does not let a stale mount of the same file dispose the replacement', async () => {
        let finishFirst!: () => void;
        const firstDispose = jest.fn();
        const secondDispose = jest.fn();
        const first: ChromeViewerProvider = {
            render: jest.fn(() => new Promise<void>((resolve) => {
                finishFirst = resolve;
            })),
            dispose: firstDispose
        };
        const second: ChromeViewerProvider = {
            render: jest.fn((_file, container) => {
                container.textContent = 'current viewer';
            }),
            dispose: secondDispose
        };
        registration.createProvider = jest.fn()
            .mockReturnValueOnce(first)
            .mockReturnValueOnce(second);

        const file = new File(['model'], 'same-model.tflite');
        const container = document.createElement('div');
        const staleResult = mountViewerForFile(file, container);
        await Promise.resolve();
        const currentResult = mountViewerForFile(file, container);
        await currentResult;
        finishFirst();

        await expect(staleResult).resolves.toBeUndefined();
        expect(firstDispose).toHaveBeenCalled();
        expect(secondDispose).not.toHaveBeenCalled();
        expect(container.textContent).toBe('current viewer');
    });

    it('does not return a successful route after explicit teardown', async () => {
        let finishRender!: () => void;
        const dispose = jest.fn();
        registration.createProvider = jest.fn(() => ({
            render: jest.fn(() => new Promise<void>((resolve) => {
                finishRender = resolve;
            })),
            dispose
        }));

        const result = mountViewerForFile(
            new File(['model'], 'pending-model.tflite'),
            document.createElement('div')
        );
        await Promise.resolve();
        disposeAllMountedViewers();
        finishRender();

        await expect(result).resolves.toBeUndefined();
        expect(dispose).toHaveBeenCalledTimes(1);
    });
});
