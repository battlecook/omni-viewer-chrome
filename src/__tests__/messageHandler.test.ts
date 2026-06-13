// Test execution is deferred to issue #7 (jest setup). The shape of these
// tests mirrors the VSCode original (`vscode-omni-viewer/src/__tests__/
// messageHandler.test.ts`), retargeted onto the Chrome MV3 dispatcher.

import { MessageHandler } from '../utils/messageHandler';
import { MediaMessageHandlers } from '../utils/messageHandlers/mediaMessageHandlers';
import type { MessageTarget, WebviewMessage } from '../utils/messageHandlers/types';

describe('MessageHandler delimited save formatting', () => {
    it('serializes TSV data with tabs instead of commas', () => {
        const output = MessageHandler.convertToDelimitedString(
            ['name', 'note'],
            [
                ['Alice', 'A\tB'],
                ['Bob', 'Hello, world']
            ],
            '\t'
        );

        expect(output).toBe('name\tnote\nAlice\t"A\tB"\nBob\tHello, world');
    });

    it('quotes CSV cells that contain commas, quotes, or newlines', () => {
        const output = MessageHandler.convertToDelimitedString(
            ['a', 'b', 'c'],
            [['plain', 'with, comma', 'with "quote"\nand newline']]
        );
        expect(output).toBe(
            'a,b,c\nplain,"with, comma","with ""quote""\nand newline"'
        );
    });
});

describe('MessageHandler.handleWebviewMessage routing', () => {
    let triggerSpy: jest.SpyInstance;

    beforeEach(() => {
        triggerSpy = jest
            .spyOn(MediaMessageHandlers, 'triggerDownload')
            .mockResolvedValue(undefined);
    });

    afterEach(() => {
        triggerSpy.mockRestore();
        jest.restoreAllMocks();
    });

    it('routes saveFilteredImage to MediaMessageHandlers.triggerDownload', async () => {
        // base64 for "abc" — small payload so the handler runs synchronously.
        await MessageHandler.handleWebviewMessage({
            command: 'saveFilteredImage',
            fileName: 'edited.png',
            imageData: 'YWJj'
        });

        expect(triggerSpy).toHaveBeenCalledTimes(1);
        const [fileName, bytes, mime] = triggerSpy.mock.calls[0];
        expect(fileName).toBe('edited.png');
        expect(mime).toBe('image/png');
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(Array.from(bytes as Uint8Array)).toEqual([97, 98, 99]);
    });

    it('routes saveRegionFile to MediaMessageHandlers.triggerDownload with the inferred mime', async () => {
        await MessageHandler.handleWebviewMessage(
            {
                command: 'saveRegionFile',
                fileName: 'guide1_1.04s-1.89s.wav',
                blob: 'YWJj'
            },
            '/Users/a14688/audio/guide1.wav'
        );

        expect(triggerSpy).toHaveBeenCalledTimes(1);
        const [fileName, , mime] = triggerSpy.mock.calls[0];
        expect(fileName).toBe('guide1_1.04s-1.89s.wav');
        expect(mime).toBe('audio/wav');
    });

    it('logs unknown message types without throwing', async () => {
        const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        await expect(
            MessageHandler.handleWebviewMessage({ command: 'totallyUnknown' })
        ).resolves.toBeUndefined();
        expect(consoleLog).toHaveBeenCalledWith('Unknown message type:', 'totallyUnknown');
    });

    it('treats omniViewerShare as a stub until #66/#67 lands', async () => {
        const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        await MessageHandler.handleWebviewMessage({ command: 'omniViewerShare' });
        expect(consoleLog).toHaveBeenCalledWith(
            expect.stringContaining('Omni share message ignored (stub)')
        );
    });

    it('replies via the supplied MessageTarget for selectMergePdf', async () => {
        const replies: WebviewMessage[] = [];
        const target: MessageTarget = {
            postMessage(msg) {
                replies.push(msg);
            }
        };

        await MessageHandler.handleWebviewMessage(
            {
                command: 'selectMergePdf',
                data: { base64: 'AAA', fileName: 'merge.pdf' }
            },
            'chrome-extension://test/file.pdf',
            target
        );

        expect(replies.length).toBe(1);
        expect(replies[0].command).toBe('selectedMergePdf');
        expect(replies[0].data).toEqual({ base64: 'AAA', fileName: 'merge.pdf' });
    });
});

describe('MessageHandler.setupWindowListener', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('dispatches window.postMessage events through the standard router', async () => {
        const triggerSpy = jest
            .spyOn(MediaMessageHandlers, 'triggerDownload')
            .mockResolvedValue(undefined);

        const disposable = MessageHandler.setupWindowListener();
        try {
            const event = new MessageEvent('message', {
                data: {
                    command: 'saveFilteredImage',
                    fileName: 'r.png',
                    imageData: 'YWJj'
                } as WebviewMessage
            });
            window.dispatchEvent(event);

            // Allow the async handler to resolve.
            await new Promise((r) => setTimeout(r, 0));

            expect(triggerSpy).toHaveBeenCalled();
        } finally {
            disposable.dispose();
        }
    });

    it('honours customHandlers ahead of the default router', async () => {
        const customHandler = jest.fn();
        const triggerSpy = jest
            .spyOn(MediaMessageHandlers, 'triggerDownload')
            .mockResolvedValue(undefined);

        const disposable = MessageHandler.setupWindowListener(undefined, {
            customCmd: customHandler
        });
        try {
            window.dispatchEvent(
                new MessageEvent('message', {
                    data: { command: 'customCmd', text: 'hi' } as WebviewMessage
                })
            );
            await new Promise((r) => setTimeout(r, 0));

            expect(customHandler).toHaveBeenCalledWith(
                expect.objectContaining({ command: 'customCmd', text: 'hi' })
            );
            expect(triggerSpy).not.toHaveBeenCalled();
        } finally {
            disposable.dispose();
        }
    });
});

describe('MessageHandler.sendToBackground', () => {
    afterEach(() => {
        // Clean up our globalThis.chrome stub between tests.
        delete (globalThis as any).chrome;
    });

    it('forwards messages to chrome.runtime.sendMessage and resolves with the response', async () => {
        const sendMessage = jest.fn(
            (
                _msg: WebviewMessage,
                cb: (response?: any) => void
            ) => {
                cb({ ok: true, value: 42 });
            }
        );

        (globalThis as any).chrome = {
            runtime: {
                sendMessage,
                lastError: undefined
            }
        };

        const response = await MessageHandler.sendToBackground({ command: 'ping' });
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(response).toEqual({ ok: true, value: 42 });
    });

    it('rejects when chrome.runtime.lastError is set', async () => {
        const sendMessage = jest.fn(
            (
                _msg: WebviewMessage,
                cb: (response?: any) => void
            ) => {
                (globalThis as any).chrome.runtime.lastError = { message: 'no receiver' };
                cb(undefined);
            }
        );

        (globalThis as any).chrome = {
            runtime: {
                sendMessage,
                lastError: undefined
            }
        };

        await expect(
            MessageHandler.sendToBackground({ command: 'ping' })
        ).rejects.toThrow(/no receiver/);
    });

    it('throws when chrome.runtime is not available', async () => {
        await expect(
            MessageHandler.sendToBackground({ command: 'ping' })
        ).rejects.toThrow(/chrome\.runtime\.sendMessage is not available/);
    });
});
