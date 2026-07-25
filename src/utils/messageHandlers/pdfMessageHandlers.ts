import { MessageTarget, WebviewMessage } from './types';

/**
 * Browser-only port of VSCode's PdfMessageHandlers.
 *
 * The original used `pdf-lib` (Node `Buffer`, `vscode.workspace.fs`) to
 * merge / re-stamp / save PDFs to disk. Issue #4 covers only the message
 * dispatch + cache plumbing — the heavy `pdf-lib` work is deferred to the
 * PDF viewer feature port (planned for a later issue) because:
 *
 *   1. `pdf-lib` is not installed in this repo and we are forbidden from
 *      touching package.json (#4 guardrail).
 *   2. The Chrome extension ships pdf.js for rendering only; the actual
 *      "save edited PDF" round-trip will be handled inside the PDF viewer
 *      template once it lands.
 *
 * For now `handleSavePdf` and `handleSelectMergePdf` echo a structured
 * response back to the caller so the message channel itself can be tested
 * end-to-end. Public method signatures match the VSCode original (minus
 * `vscode.Uri`, replaced with a `documentUri: string`).
 */
export class PdfMessageHandlers {
    private static readonly mergedPdfCache = new Map<string, string[]>();

    public static setupDocumentCacheKey(documentUri?: string): string | null {
        return documentUri ? documentUri : null;
    }

    public static resetMergedPdfCache(documentUri?: string): void {
        const key = this.setupDocumentCacheKey(documentUri);
        if (key) {
            this.mergedPdfCache.delete(key);
        }
    }

    /**
     * Cache a base64-encoded PDF to merge with the active document on save.
     * In VSCode this would pop a `showOpenDialog`; in the browser the file
     * is selected by the viewer page itself (via `<input type="file">`)
     * and forwarded here as a base64 payload on `message.data`.
     */
    public static async handleSelectMergePdf(
        message: WebviewMessage,
        documentUri?: string,
        target?: MessageTarget
    ): Promise<void> {
        try {
            if (!documentUri) {
                throw new Error('No active PDF document');
            }

            const base64 =
                typeof message.data?.base64 === 'string' ? message.data.base64 : null;
            const fileName =
                typeof message.data?.fileName === 'string'
                    ? message.data.fileName
                    : 'merged.pdf';

            if (!base64) {
                throw new Error('No merge PDF payload provided');
            }

            const cacheKey = this.setupDocumentCacheKey(documentUri);
            if (cacheKey) {
                this.mergedPdfCache.set(cacheKey, [base64]);
            }

            if (target) {
                await target.postMessage({
                    command: 'selectedMergePdf',
                    type: 'selectedMergePdf',
                    data: { base64, fileName }
                });
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            console.error('Error selecting merge PDF:', error);
            if (target) {
                await target.postMessage({
                    command: 'selectMergePdfError',
                    type: 'selectMergePdfError',
                    text: errorMessage
                });
            }
        }
    }

    /**
     * Stub for the eventual "save annotated PDF" pipeline.
     *
     * Until `pdf-lib` is brought into the Chrome build (separate issue),
     * this just acknowledges the request back to the caller so message
     * routing can be verified.
     */
    public static async handleSavePdf(
        message: WebviewMessage,
        documentUri?: string,
        target?: MessageTarget
    ): Promise<void> {
        try {
            if (!documentUri || !message.data) {
                throw new Error('No document or annotation data');
            }

            // TODO(pdf viewer port): integrate pdf-lib to merge cached PDFs,
            // apply text/signatures, and start a browser-managed download. For now we
            // simply notify the page so the UI can show a friendly message.
            this.resetMergedPdfCache(documentUri);

            if (target) {
                await target.postMessage({
                    command: 'pdfSavePending',
                    type: 'pdfSavePending',
                    text: 'PDF save pipeline is not implemented yet in the Chrome build.'
                });
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            console.error('Error saving PDF:', error);
            if (target) {
                await target.postMessage({
                    command: 'pdfSaveError',
                    type: 'pdfSaveError',
                    text: errorMessage
                });
            }
        }
    }
}
