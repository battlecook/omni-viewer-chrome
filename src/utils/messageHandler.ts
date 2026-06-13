import { MediaMessageHandlers } from './messageHandlers/mediaMessageHandlers';
import { PdfMessageHandlers } from './messageHandlers/pdfMessageHandlers';
import { TextMessageHandlers } from './messageHandlers/textMessageHandlers';
import {
    MessageDisposable,
    MessageTarget,
    WebviewMessage
} from './messageHandlers/types';

export type {
    MessageDisposable,
    MessageTarget,
    WebviewMessage
} from './messageHandlers/types';

type CustomHandlerMap = { [command: string]: (message: WebviewMessage) => void };

/**
 * Central dispatcher ported from VSCode's `MessageHandler`.
 *
 * Two channels are supported:
 *
 *  (a) **Viewer-internal module-to-module dispatch (in-page).** The viewer
 *      can call `MessageHandler.handleWebviewMessage(msg)` directly from
 *      any module — useful for tests and for cases where the page itself
 *      handles the message without crossing process boundaries.
 *
 *  (b) **Viewer ↔ background service worker.** Use `setupRuntimeListener`
 *      from the background to receive messages from any viewer page via
 *      `chrome.runtime.onMessage`, and `sendToBackground` from the viewer
 *      side to push messages with `chrome.runtime.sendMessage`. This
 *      replaces VSCode's `webview.postMessage` / `webview.onDidReceiveMessage`.
 *
 * The original `omniViewerShare` / `omniViewerOpenSharedLink` cases are
 * retained as inert stubs — real share UI lands in #66/#67.
 */
export class MessageHandler {
    private static runtimeListener:
        | ((
              message: any,
              sender: chrome.runtime.MessageSender,
              sendResponse: (response?: any) => void
          ) => boolean | undefined)
        | null = null;

    public static async handleWebviewMessage(
        message: WebviewMessage,
        documentUri?: string,
        target?: MessageTarget
    ): Promise<void> {
        const messageType = message.type || message.command;

        switch (messageType) {
            case 'log':
                console.log('Webview:', message.text);
                break;
            case 'error':
                console.error('Webview Error:', message.text);
                break;
            case 'info':
                console.info('Webview:', message.text);
                break;
            case 'warning':
                console.warn('Webview:', message.text);
                break;
            case 'saveFilteredImage':
                await MediaMessageHandlers.handleSaveFilteredImage(message);
                break;
            case 'saveRegionFile':
                await MediaMessageHandlers.handleSaveRegionFile(message, documentUri);
                break;
            case 'saveChanges':
                await TextMessageHandlers.handleSaveChanges(message, documentUri);
                break;
            case 'updateLine':
                TextMessageHandlers.handleUpdateLine(message);
                break;
            case 'deleteLine':
                TextMessageHandlers.handleDeleteLine(message);
                break;
            case 'insertLine':
                TextMessageHandlers.handleInsertLine(message);
                break;
            case 'insertMultipleLines':
                TextMessageHandlers.handleInsertMultipleLines(message);
                break;
            case 'deleteMultipleLines':
                TextMessageHandlers.handleDeleteMultipleLines(message);
                break;
            case 'downloadFile':
                await MediaMessageHandlers.handleDownloadFile(message, documentUri);
                break;
            case 'savePdf':
            case 'savePdfAs':
                await PdfMessageHandlers.handleSavePdf(message, documentUri, target);
                break;
            case 'selectMergePdf':
                await PdfMessageHandlers.handleSelectMergePdf(message, documentUri, target);
                break;
            case 'resetMergePdfCache':
                PdfMessageHandlers.resetMergedPdfCache(documentUri);
                break;
            case 'omniViewerShare':
            case 'omniViewerOpenSharedLink':
                // Real share/open implementation arrives in #66/#67.
                console.log(`Omni share message ignored (stub): ${messageType}`);
                break;
            default:
                console.log('Unknown message type:', messageType);
        }
    }

    public static convertToDelimitedString(
        headers: string[],
        rows: string[][],
        delimiter = ','
    ): string {
        return TextMessageHandlers.convertToDelimitedString(headers, rows, delimiter);
    }

    /* ----------------------------- channel (a) -------------------------- */

    /**
     * Wrap an arbitrary message-target into the {@link MessageTarget} shape
     * so handlers can reply without knowing the underlying transport.
     */
    public static wrapWindowTarget(targetWindow: Window): MessageTarget {
        return {
            postMessage(message: WebviewMessage) {
                targetWindow.postMessage(message, '*');
            }
        };
    }

    /**
     * Listen for in-page `window.postMessage` events. Mirrors VSCode's
     * `webview.onDidReceiveMessage` semantics for the viewer-internal case.
     */
    public static setupWindowListener(
        documentUri?: string,
        customHandlers?: CustomHandlerMap
    ): MessageDisposable {
        const handler = async (event: MessageEvent) => {
            const data = event.data as WebviewMessage | undefined;
            if (!data || typeof data !== 'object') {
                return;
            }
            const command = data.command || data.type;
            if (customHandlers && command && customHandlers[command]) {
                customHandlers[command](data);
                return;
            }
            await this.handleWebviewMessage(data, documentUri);
        };
        window.addEventListener('message', handler);
        return {
            dispose: () => window.removeEventListener('message', handler)
        };
    }

    /* ----------------------------- channel (b) -------------------------- */

    /**
     * Send a message from a viewer page to the background service worker.
     * Replaces VSCode's `vscode.postMessage(...)` from the webview side.
     */
    public static async sendToBackground(message: WebviewMessage): Promise<any> {
        if (
            typeof chrome === 'undefined' ||
            !chrome.runtime ||
            typeof chrome.runtime.sendMessage !== 'function'
        ) {
            throw new Error('chrome.runtime.sendMessage is not available');
        }
        return new Promise((resolve, reject) => {
            try {
                chrome.runtime.sendMessage(message, (response) => {
                    const lastError = chrome.runtime.lastError;
                    if (lastError) {
                        reject(new Error(lastError.message));
                        return;
                    }
                    resolve(response);
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Install a `chrome.runtime.onMessage` listener (intended for the
     * background service worker). Replaces VSCode's
     * `webview.onDidReceiveMessage` for the cross-process case.
     *
     * Custom handlers take precedence; otherwise the default
     * {@link handleWebviewMessage} dispatcher is invoked. Handlers may
     * return a response by calling `sendResponse` (the listener returns
     * `true` to keep the channel open for async replies).
     */
    public static setupRuntimeListener(
        getDocumentUri?: (sender: chrome.runtime.MessageSender) => string | undefined,
        customHandlers?: CustomHandlerMap
    ): MessageDisposable {
        if (
            typeof chrome === 'undefined' ||
            !chrome.runtime ||
            !chrome.runtime.onMessage ||
            typeof chrome.runtime.onMessage.addListener !== 'function'
        ) {
            throw new Error('chrome.runtime.onMessage is not available');
        }

        // Tear down any previously-registered listener so re-running setup
        // (e.g. on hot reload) doesn't double-dispatch.
        if (this.runtimeListener) {
            try {
                chrome.runtime.onMessage.removeListener(this.runtimeListener);
            } catch {
                /* ignored */
            }
            this.runtimeListener = null;
        }

        const listener = (
            message: any,
            sender: chrome.runtime.MessageSender,
            sendResponse: (response?: any) => void
        ) => {
            const data = message as WebviewMessage;
            if (!data || typeof data !== 'object') {
                return undefined;
            }

            const command = data.command || data.type;
            const documentUri = getDocumentUri ? getDocumentUri(sender) : undefined;
            const target: MessageTarget | undefined =
                sender.tab?.id !== undefined
                    ? {
                          postMessage: (msg) => {
                              try {
                                  chrome.tabs.sendMessage(sender.tab!.id!, msg);
                              } catch (error) {
                                  console.error('Failed to reply to viewer tab:', error);
                              }
                          }
                      }
                    : undefined;

            const run = async () => {
                if (customHandlers && command && customHandlers[command]) {
                    customHandlers[command](data);
                    sendResponse({ ok: true });
                    return;
                }
                try {
                    await this.handleWebviewMessage(data, documentUri, target);
                    sendResponse({ ok: true });
                } catch (error) {
                    const errorMessage =
                        error instanceof Error ? error.message : String(error);
                    sendResponse({ ok: false, error: errorMessage });
                }
            };
            void run();
            // Returning true keeps the message channel open so sendResponse
            // can be called asynchronously.
            return true;
        };

        chrome.runtime.onMessage.addListener(listener);
        this.runtimeListener = listener;

        return {
            dispose: () => {
                try {
                    chrome.runtime.onMessage.removeListener(listener);
                } catch {
                    /* ignored */
                }
                if (this.runtimeListener === listener) {
                    this.runtimeListener = null;
                }
            }
        };
    }
}
