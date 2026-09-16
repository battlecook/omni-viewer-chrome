import { TextDecoder as NodeTextDecoder } from 'util';

describe('legacy SPA file-open lifecycle', () => {
    it('waits for the saved locale before rendering a launched file', async () => {
        document.body.innerHTML = `
            <button id="shareCurrentFile"></button>
            <button id="openSharedLink"></button>
            <select id="languageSelect"></select>
            <input id="fileInput" type="file">
            <div id="dropZone"></div>
            <div id="viewer"></div>
            <div id="status"></div>
            <div id="fileMeta"></div>
            <div id="shareToast"></div>
            <a id="shareToastLink"></a>
        `;
        Object.defineProperty(globalThis, 'TextDecoder', {
            configurable: true,
            value: NodeTextDecoder
        });

        let launchConsumer!: (
            params: { files: Array<{ getFile(): Promise<File> }> }
        ) => Promise<void>;
        Object.defineProperty(window, 'launchQueue', {
            configurable: true,
            value: {
                setConsumer: jest.fn((consumer) => {
                    launchConsumer = consumer;
                })
            }
        });
        let finishLocaleRead!: (value: { locale: string }) => void;
        const localeRead = new Promise<{ locale: string }>((resolve) => {
            finishLocaleRead = resolve;
        });
        (chrome.storage.local.get as jest.Mock).mockReturnValueOnce(localeRead);
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => ({})
        });
        const file = {
            name: 'localized.bin',
            size: 1,
            type: 'application/octet-stream',
            lastModified: 1,
            slice: jest.fn(() => ({
                arrayBuffer: () => Promise.resolve(new Uint8Array([0]).buffer)
            }))
        } as unknown as File;

        jest.isolateModules(() => {
            require('../app.js');
        });
        const launch = launchConsumer({ files: [{ getFile: async () => file }] });
        await Promise.resolve();
        await Promise.resolve();
        expect(document.querySelector('#fileMeta')?.textContent).toBe('');

        finishLocaleRead({ locale: 'ko' });
        await launch;

        expect(document.documentElement.lang).toBe('ko');
        expect(document.querySelector('#fileMeta')?.textContent).toContain('localized.bin');
    });

    it('ignores a stale type-detection result after a newer file opens', async () => {
        document.body.innerHTML = `
            <button id="shareCurrentFile"></button>
            <button id="openSharedLink"></button>
            <select id="languageSelect"></select>
            <input id="fileInput" type="file">
            <div id="dropZone"></div>
            <div id="viewer"></div>
            <div id="status"></div>
            <div id="fileMeta"></div>
            <div id="shareToast"></div>
            <a id="shareToastLink"></a>
        `;
        Object.defineProperty(globalThis, 'TextDecoder', {
            configurable: true,
            value: NodeTextDecoder
        });

        let launchConsumer!: (
            params: { files: Array<{ getFile(): Promise<File> }> }
        ) => Promise<void>;
        Object.defineProperty(window, 'launchQueue', {
            configurable: true,
            value: {
                setConsumer: jest.fn((consumer) => {
                    launchConsumer = consumer;
                })
            }
        });

        let finishOldDetection!: (value: ArrayBuffer) => void;
        const oldHead = new Promise<ArrayBuffer>((resolve) => {
            finishOldDetection = resolve;
        });
        const oldFile = {
            name: 'old.bin',
            size: 8,
            type: 'application/octet-stream',
            lastModified: 1,
            slice: jest.fn(() => ({ arrayBuffer: () => oldHead }))
        } as unknown as File;
        const currentFile = {
            name: 'current.bin',
            size: 8,
            type: 'application/octet-stream',
            lastModified: 2,
            slice: jest.fn(() => ({
                arrayBuffer: () => Promise.resolve(new Uint8Array(8).buffer)
            }))
        } as unknown as File;

        jest.isolateModules(() => {
            require('../app.js');
        });
        launchConsumer({ files: [{ getFile: async () => oldFile }] });
        await Promise.resolve();
        launchConsumer({ files: [{ getFile: async () => currentFile }] });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(document.querySelector('#fileMeta')?.textContent).toContain('current.bin');

        finishOldDetection(new Uint8Array(8).buffer);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(document.querySelector('#fileMeta')?.textContent).toContain('current.bin');
        expect(document.querySelector('#fileMeta')?.textContent).not.toContain('old.bin');
    });

    it('claims launch intent before awaiting FileSystemFileHandle.getFile()', async () => {
        document.body.innerHTML = `
            <button id="shareCurrentFile"></button>
            <button id="openSharedLink"></button>
            <select id="languageSelect"></select>
            <input id="fileInput" type="file">
            <div id="dropZone"></div>
            <div id="viewer"></div>
            <div id="status"></div>
            <div id="fileMeta"></div>
            <div id="shareToast"></div>
            <a id="shareToastLink"></a>
        `;
        Object.defineProperty(globalThis, 'TextDecoder', {
            configurable: true,
            value: NodeTextDecoder
        });

        let launchConsumer!: (
            params: { files: Array<{ getFile(): Promise<File> }> }
        ) => Promise<void>;
        Object.defineProperty(window, 'launchQueue', {
            configurable: true,
            value: {
                setConsumer: jest.fn((consumer) => {
                    launchConsumer = consumer;
                })
            }
        });
        const makeFile = (name: string, lastModified: number) => ({
            name,
            size: 8,
            type: 'application/octet-stream',
            lastModified,
            slice: jest.fn(() => ({
                arrayBuffer: () => Promise.resolve(new Uint8Array(8).buffer)
            }))
        } as unknown as File);
        let finishOldGetFile!: (file: File) => void;
        const oldGetFile = new Promise<File>((resolve) => {
            finishOldGetFile = resolve;
        });

        jest.isolateModules(() => {
            require('../app.js');
        });
        const oldLaunch = launchConsumer({ files: [{ getFile: () => oldGetFile }] });
        const currentLaunch = launchConsumer({
            files: [{ getFile: async () => makeFile('current.bin', 2) }]
        });
        await currentLaunch;
        expect(document.querySelector('#fileMeta')?.textContent).toContain('current.bin');

        finishOldGetFile(makeFile('old.bin', 1));
        await oldLaunch;

        expect(document.querySelector('#fileMeta')?.textContent).toContain('current.bin');
        expect(document.querySelector('#fileMeta')?.textContent).not.toContain('old.bin');
    });
});
