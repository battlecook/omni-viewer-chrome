import { MediaMessageHandlers } from './mediaMessageHandlers';
import { WebviewMessage } from './types';

/**
 * Browser-only port of VSCode's TextMessageHandlers.
 *
 * VSCode wrote saved text back to the original `vscode.Uri` via
 * `vscode.workspace.fs.writeFile`. In the browser we don't have permission
 * to overwrite arbitrary files, so saves are routed through the standard
 * download path (handled by `MediaMessageHandlers.triggerDownload`).
 *
 * The pure formatting helper `convertToDelimitedString` is reused as-is —
 * it has no I/O dependency and the existing tests cover the same logic.
 *
 * Per-line edit operations (`updateLine`, `deleteLine`, etc.) used to
 * round-trip through the source file. In the browser the viewer holds the
 * authoritative buffer in memory, so these handlers operate on the content
 * the viewer sends in `message.data.lines` (or `message.text`) and return
 * the updated buffer to the caller via the optional `target` parameter.
 */
export class TextMessageHandlers {
    public static async handleSaveChanges(
        message: WebviewMessage,
        documentUri?: string
    ): Promise<void> {
        try {
            if (!message.data && !message.text) {
                throw new Error('No data provided for saving');
            }

            const fileName = this.deriveFileName(message, documentUri);

            if (message.data?.headers && message.data?.rows) {
                const delimiter = message.data.delimiter || this.getDelimiterForFile(fileName);
                const csvContent = this.convertToDelimitedString(
                    message.data.headers,
                    message.data.rows,
                    delimiter
                );
                await this.saveText(fileName, csvContent, this.guessTextMime(fileName));
                return;
            }

            const content =
                typeof message.data?.content === 'string'
                    ? message.data.content
                    : (message.text ?? '');

            if (!content && content !== '') {
                throw new Error('No content provided for saving');
            }

            await this.saveText(fileName, content, this.guessTextMime(fileName));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            console.error('Error saving file:', error);
            this.notifyError(`Failed to save file: ${errorMessage}`);
        }
    }

    public static handleUpdateLine(message: WebviewMessage): string[] {
        return this.updateLines(message, (lines) => {
            if (!message.lineNumber || message.content === undefined) {
                throw new Error('Line number and content are required');
            }

            const lineIndex = message.lineNumber - 1;
            if (lineIndex < 0 || lineIndex >= lines.length) {
                throw new Error(
                    `Line ${message.lineNumber} is out of range (file has ${lines.length} lines)`
                );
            }

            lines[lineIndex] = message.content;
            return lines;
        }, 'update line');
    }

    public static handleDeleteLine(message: WebviewMessage): string[] {
        return this.updateLines(message, (lines) => {
            if (!message.lineNumber) {
                throw new Error('Line number is required');
            }

            const lineIndex = message.lineNumber - 1;
            if (lineIndex < 0 || lineIndex >= lines.length) {
                throw new Error(`Line ${message.lineNumber} is out of range`);
            }

            lines.splice(lineIndex, 1);
            return lines;
        }, 'delete line');
    }

    public static handleInsertLine(message: WebviewMessage): string[] {
        return this.updateLines(message, (lines) => {
            if (!message.lineNumber || message.content === undefined) {
                throw new Error('Line number and content are required');
            }

            const lineIndex = message.lineNumber - 1;
            if (lineIndex < 0 || lineIndex > lines.length) {
                throw new Error(`Line ${message.lineNumber} is out of range`);
            }

            lines.splice(lineIndex, 0, message.content);
            return lines;
        }, 'insert line');
    }

    public static handleInsertMultipleLines(message: WebviewMessage): string[] {
        return this.updateLines(message, (lines) => {
            if (
                !message.data ||
                message.data.afterLineNumber === undefined ||
                !Array.isArray(message.data.lines)
            ) {
                throw new Error('After line number and lines array are required');
            }

            const insertIndex = message.data.afterLineNumber as number;
            if (insertIndex < 0 || insertIndex > lines.length) {
                throw new Error(`Line ${message.data.afterLineNumber} is out of range`);
            }

            lines.splice(insertIndex, 0, ...(message.data.lines as string[]));
            return lines;
        }, 'insert lines');
    }

    public static handleDeleteMultipleLines(message: WebviewMessage): string[] {
        return this.updateLines(message, (lines) => {
            if (!message.data || !Array.isArray(message.data.lineNumbers)) {
                throw new Error('Line numbers array is required');
            }

            const sortedLineNumbers = [...(message.data.lineNumbers as number[])].sort(
                (a, b) => b - a
            );
            sortedLineNumbers.forEach((lineNumber) => {
                const lineIndex = lineNumber - 1;
                if (lineIndex >= 0 && lineIndex < lines.length) {
                    lines.splice(lineIndex, 1);
                }
            });

            return lines;
        }, 'delete lines');
    }

    public static convertToDelimitedString(
        headers: string[],
        rows: string[][],
        delimiter = ','
    ): string {
        const escapeDelimitedValue = (value: string): string => {
            if (value === null || value === undefined) {
                return '';
            }

            const stringValue = String(value);
            if (
                stringValue.includes(delimiter) ||
                stringValue.includes('"') ||
                stringValue.includes('\n')
            ) {
                return `"${stringValue.replace(/"/g, '""')}"`;
            }

            return stringValue;
        };

        const headerLine = headers.map(escapeDelimitedValue).join(delimiter);
        const rowLines = rows.map((row) => row.map(escapeDelimitedValue).join(delimiter));
        return [headerLine, ...rowLines].join('\n');
    }

    /* ----------------------------- helpers ------------------------------ */

    private static updateLines(
        message: WebviewMessage,
        updater: (lines: string[]) => string[],
        operation: string
    ): string[] {
        try {
            const sourceLines = this.extractSourceLines(message);
            return updater(sourceLines);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            console.error(`Error during ${operation}:`, error);
            this.notifyError(`Failed to ${operation}: ${errorMessage}`);
            throw error;
        }
    }

    private static extractSourceLines(message: WebviewMessage): string[] {
        if (Array.isArray(message.data?.sourceLines)) {
            return [...(message.data.sourceLines as string[])];
        }
        if (typeof message.data?.sourceContent === 'string') {
            return (message.data.sourceContent as string).split('\n');
        }
        if (typeof message.text === 'string') {
            return message.text.split('\n');
        }
        throw new Error(
            'Source content is required (provide message.data.sourceLines, message.data.sourceContent, or message.text)'
        );
    }

    private static deriveFileName(message: WebviewMessage, documentUri?: string): string {
        if (message.fileName) {
            return MediaMessageHandlers.sanitizeFileName(message.fileName);
        }
        if (documentUri) {
            const cleaned = documentUri.split('?')[0].split('#')[0];
            const parts = cleaned.split(/[\\/]/);
            const last = parts[parts.length - 1] || 'document.txt';
            return MediaMessageHandlers.sanitizeFileName(last);
        }
        return 'document.txt';
    }

    private static getDelimiterForFile(fileName: string): string {
        const ext = fileName.split('.').pop()?.toLowerCase();
        if (ext === 'tsv') {
            return '\t';
        }
        return ',';
    }

    private static guessTextMime(fileName: string): string {
        const ext = fileName.split('.').pop()?.toLowerCase();
        switch (ext) {
            case 'csv':
                return 'text/csv';
            case 'tsv':
                return 'text/tab-separated-values';
            case 'json':
            case 'jsonl':
                return 'application/json';
            case 'yaml':
            case 'yml':
                return 'application/x-yaml';
            case 'toml':
                return 'application/toml';
            default:
                return 'text/plain';
        }
    }

    private static async saveText(fileName: string, content: string, mime: string): Promise<void> {
        const encoder = new TextEncoder();
        const bytes = encoder.encode(content);
        await MediaMessageHandlers.triggerDownload(fileName, bytes, mime);
    }

    private static notifyError(message: string): void {
        console.error(message);
        if (typeof window !== 'undefined' && typeof window.alert === 'function') {
            try {
                window.alert(message);
            } catch {
                /* ignored */
            }
        }
    }
}
