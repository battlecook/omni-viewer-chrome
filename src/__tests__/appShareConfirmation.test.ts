import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TextDecoder as NodeTextDecoder } from 'util';

describe('share upload confirmation', () => {
    let launch: (params: { files: Array<{ getFile(): Promise<File> }> }) => Promise<void>;

    beforeEach(async () => {
        document.body.innerHTML = readFileSync(resolve(__dirname, '../../viewer.html'), 'utf8');
        Object.defineProperty(globalThis, 'TextDecoder', { configurable: true, value: NodeTextDecoder });
        Object.defineProperty(window, 'launchQueue', {
            configurable: true,
            value: { setConsumer: (consumer: typeof launch) => { launch = consumer; } }
        });
        // jsdom does not implement native dialog methods.
        HTMLDialogElement.prototype.showModal = function () { this.open = true; };
        HTMLDialogElement.prototype.close = function (value = '') {
            this.returnValue = value;
            this.open = false;
            this.dispatchEvent(new Event('close'));
        };
        (chrome.storage.local.get as jest.Mock).mockResolvedValue({});
        (globalThis as any).__omniLocaleMessages = {};
        jest.isolateModules(() => { require('../app.js'); });
        await openFile('private.bin');
        (global.fetch as jest.Mock).mockClear();
    });

    afterEach(() => { jest.restoreAllMocks(); });

    async function openFile(name: string) {
        const file = {
            name, size: 1, type: 'application/octet-stream',
            slice: () => ({ arrayBuffer: async () => new Uint8Array([0]).buffer })
        } as unknown as File;
        await launch({ files: [{ getFile: async () => file }] });
    }

    const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
    const dialog = () => document.querySelector('dialog') as HTMLDialogElement;

    it.each(['shareCurrentFile', 'shareViewerFile'])('%s waits for consent and allows cancellation or Escape', async (id) => {
        for (const result of ['cancel', '']) {
            const previousStatus = document.getElementById('status')!.textContent;
            button(id).click();
            expect(dialog().open).toBe(true);
            expect(dialog().textContent).toContain('private.bin');
            expect(dialog().textContent).toContain('encrypted and uploaded to the server');
            expect(dialog().textContent).toContain('5 minutes');
            expect(dialog().querySelector('[autofocus]')?.getAttribute('value')).toBe('cancel');
            expect(global.fetch).not.toHaveBeenCalled();
            expect(document.getElementById('status')!.textContent).toBe(previousStatus);
            dialog().close(result);
            await Promise.resolve();
            expect(document.querySelector('dialog')).toBeNull();
            expect(global.fetch).not.toHaveBeenCalled();
            expect(document.getElementById('status')!.textContent).toBe(previousStatus);
            expect(button(id).disabled).toBe(false);
        }
    });

    it('opens only one dialog for repeated clicks', async () => {
        button('shareCurrentFile').click();
        button('shareViewerFile').click();
        expect(document.querySelectorAll('dialog')).toHaveLength(1);
        dialog().close('cancel');
        await Promise.resolve();
    });

    it('starts the upload flow only after explicit confirmation', async () => {
        // Dynamic ESM imports are unavailable in this Jest runtime; observe the
        // transition into uploading before the existing module loader runs.
        jest.spyOn(console, 'error').mockImplementation(() => {});
        button('shareCurrentFile').click();
        dialog().close('upload');
        await Promise.resolve();
        expect(document.getElementById('status')!.textContent).toBe('Uploading private.bin...');
        expect(button('shareCurrentFile').disabled).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it('does not upload a different file opened while confirmation was pending', async () => {
        button('shareCurrentFile').click();
        await openFile('replacement.bin');
        dialog().close('upload');
        await Promise.resolve();
        expect(global.fetch).not.toHaveBeenCalled();
        expect(document.getElementById('status')!.textContent).not.toContain('Uploading');
    });
});
