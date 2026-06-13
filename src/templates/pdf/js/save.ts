// PDF save / save-as composite. Issue #23.
//
// Pipeline
// --------
// 1. Load the original bytes into a pdf-lib `PDFDocument`.
// 2. Apply the page-order state (`pageOrder.ts`) by copying only the
//    visible pages — in their current visual order — into a new
//    document. This handles both deletes (missing 1-based page numbers)
//    and reorders (non-identity sequence) in one step.
// 3. For each annotation in the store, draw it on the matching page:
//      - text   → `page.drawText` with Helvetica + RGB fill
//      - signature → `embedPng(dataUrl bytes)` then `page.drawImage`
// 4. Serialize → `Blob('application/pdf')`.
//
// Coordinate model
// ----------------
// Annotations are stored in PDF point space with a *top-left* origin
// (the convention chosen back in #19 / #20 so screen-space rendering is
// trivial). pdf-lib operates in PDF's native *bottom-left* origin, so
// every annotation gets a y-flip:
//
//   pdfY = pageHeight - annotation.y - annotation.size       (text)
//   pdfY = pageHeight - annotation.y - annotation.height    (signature)
//
// The "- size" / "- height" correction places the *baseline* of the text
// (and the bottom of the signature image) such that the annotation's
// top-left visually matches the on-screen overlay.
//
// File output
// -----------
// We prefer the File System Access API's `showSaveFilePicker` (Chrome
// 86+ in extension contexts) so the user picks the destination once,
// then a regular `<a download>` fallback. `Save` and `Save As` differ
// only in the suggested filename; the picker is always invoked because
// extension pages do not have a "current path" to overwrite.

import {
    PdfAnnotation,
    PdfAnnotationStore,
    PdfTextAnnotation,
    PdfSignatureAnnotation
} from './pdfAnnotationStore';
import { PageOrderState } from './pageOrder';
import {
    PdfLibDocument,
    PdfLibNamespace,
    PdfLibPage,
    loadPdfLib
} from './pdfLibLoader';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SaveOptions {
    /** Original PDF bytes (pre-modification). */
    bytes: Uint8Array;
    /** Page-order state from `pageOrder.ts`. */
    pageOrder: PageOrderState;
    /** Live annotation store. Snapshot taken at save time. */
    store: PdfAnnotationStore;
}

export interface RgbTriple {
    r: number;
    g: number;
    b: number;
}

/**
 * Translate an HTML hex color (`#rrggbb` / `#rgb`) to a 0..1 RGB triple.
 * Matches `pdfMessageHandlers.hexToRgb` from the VSCode original so the
 * saved colors match across both apps. Bad input falls back to black.
 */
export function hexToRgbTriple(hex?: string): RgbTriple {
    if (!hex || typeof hex !== 'string') return { r: 0, g: 0, b: 0 };
    const normalized = hex.trim().replace('#', '');
    const fullHex =
        normalized.length === 3
            ? normalized.split('').map((c) => c + c).join('')
            : normalized;
    if (!/^[0-9a-fA-F]{6}$/.test(fullHex)) return { r: 0, g: 0, b: 0 };
    const intVal = parseInt(fullHex, 16);
    return {
        r: ((intVal >> 16) & 255) / 255,
        g: ((intVal >> 8) & 255) / 255,
        b: (intVal & 255) / 255
    };
}

/**
 * Convert a top-left-origin annotation y to pdf-lib's bottom-left y for
 * a text annotation. `size` is the font size in PDF points.
 */
export function textTopLeftYToPdfY(
    pageHeight: number,
    yTopLeft: number,
    size: number
): number {
    return pageHeight - yTopLeft - size;
}

/**
 * Same flip but for an image annotation (signature). `height` is the
 * image's render height in PDF points.
 */
export function imageTopLeftYToPdfY(
    pageHeight: number,
    yTopLeft: number,
    height: number
): number {
    return pageHeight - yTopLeft - height;
}

/**
 * Decode a `data:image/png;base64,...` URL to its raw bytes. Throws if
 * the URL is not a base64 PNG (signatures are always emitted as PNG by
 * `signaturePad.ts`).
 */
export function dataUrlPngToBytes(dataUrl: string): Uint8Array {
    const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
    if (!match) {
        throw new Error('save: signature dataUrl is not a base64 PNG');
    }
    const binary = atob(match[1]);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

/**
 * Build the new pdf-lib document by copying the original's *visible*
 * pages in their current visual order. Returns the new document plus
 * the array `originalIndexByNewPage[i] = (1-based original page number)`
 * so callers can map annotations (which still reference the original
 * page index) onto the new page indices.
 *
 * `pageOrder.order` is 1-based original page numbers. We convert each to
 * 0-based for `copyPages` and remember the mapping so annotations can
 * reach their new homes.
 */
export async function applyPageOrderToDoc(
    PDFLib: PdfLibNamespace,
    src: PdfLibDocument,
    order: readonly number[]
): Promise<{
    doc: PdfLibDocument;
    originalPageNumberByNewIndex: number[];
}> {
    const totalPages = src.getPageCount();
    const seen = new Set<number>();
    const zeroBased: number[] = [];
    const originalPageNumberByNewIndex: number[] = [];
    for (const oneBased of order) {
        const idx = Number(oneBased) - 1;
        if (!Number.isInteger(idx) || idx < 0 || idx >= totalPages) continue;
        if (seen.has(idx)) continue;
        seen.add(idx);
        zeroBased.push(idx);
        originalPageNumberByNewIndex.push(idx + 1);
    }
    if (zeroBased.length === 0) {
        // Defensive: never produce a 0-page PDF. Fall back to the source
        // pages in their original order.
        for (let i = 0; i < totalPages; i++) {
            zeroBased.push(i);
            originalPageNumberByNewIndex.push(i + 1);
        }
    }
    const doc = await PDFLib.PDFDocument.create();
    const copied = await doc.copyPages(src, zeroBased);
    copied.forEach((page) => doc.addPage(page));
    return { doc, originalPageNumberByNewIndex };
}

/**
 * Stamp every annotation onto its corresponding *new* page (post page
 * reorder). Pure(ish): only mutates `doc` via pdf-lib draw calls.
 */
export async function stampAnnotations(
    PDFLib: PdfLibNamespace,
    doc: PdfLibDocument,
    annotations: PdfAnnotation[],
    originalPageNumberByNewIndex: number[]
): Promise<void> {
    if (annotations.length === 0) return;
    const helvetica = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const pages = doc.getPages();

    // Reverse the mapping: original 1-based page number → array of new
    // 0-based page indices (a page may, in theory, appear multiple times
    // after reorder; we draw the annotation on every occurrence).
    const newIndicesByOriginal = new Map<number, number[]>();
    originalPageNumberByNewIndex.forEach((origPageNum, newIdx) => {
        const arr = newIndicesByOriginal.get(origPageNum);
        if (arr) arr.push(newIdx);
        else newIndicesByOriginal.set(origPageNum, [newIdx]);
    });

    for (const ann of annotations) {
        // Annotations were created with a 0-based page index; convert to
        // the 1-based key used by the page-order state.
        const originalPageNumber = ann.pageIndex + 1;
        const targets = newIndicesByOriginal.get(originalPageNumber);
        if (!targets) continue; // page was deleted — skip
        for (const newIdx of targets) {
            const page = pages[newIdx];
            if (!page) continue;
            if (ann.kind === 'text') {
                drawTextAnnotation(PDFLib, page, ann, helvetica);
            } else if (ann.kind === 'signature') {
                await drawSignatureAnnotation(doc, page, ann);
            }
        }
    }
}

function drawTextAnnotation(
    PDFLib: PdfLibNamespace,
    page: PdfLibPage,
    ann: PdfTextAnnotation,
    font: any
): void {
    const { r, g, b } = hexToRgbTriple(ann.color);
    const pageHeight = page.getHeight();
    const pdfY = textTopLeftYToPdfY(pageHeight, ann.y, ann.size);
    page.drawText(ann.text, {
        x: ann.x,
        y: pdfY,
        size: ann.size,
        font,
        color: PDFLib.rgb(r, g, b)
    });
}

async function drawSignatureAnnotation(
    doc: PdfLibDocument,
    page: PdfLibPage,
    ann: PdfSignatureAnnotation
): Promise<void> {
    const pngBytes = dataUrlPngToBytes(ann.dataUrl);
    const image = await doc.embedPng(pngBytes);
    const pageHeight = page.getHeight();
    const pdfY = imageTopLeftYToPdfY(pageHeight, ann.y, ann.height);
    page.drawImage(image, {
        x: ann.x,
        y: pdfY,
        width: ann.width,
        height: ann.height
    });
}

/**
 * Compose the saved PDF. Returns the final byte stream as a `Blob` so
 * the caller can hand it straight to `showSaveFilePicker` /
 * `<a download>`.
 */
export async function buildSavedPdfBlob(opts: SaveOptions): Promise<Blob> {
    const PDFLib = await loadPdfLib();
    const src = await PDFLib.PDFDocument.load(opts.bytes);
    const { doc, originalPageNumberByNewIndex } = await applyPageOrderToDoc(
        PDFLib,
        src,
        opts.pageOrder.order
    );
    const annotations = opts.store.listAll();
    await stampAnnotations(PDFLib, doc, annotations, originalPageNumberByNewIndex);
    const out = await doc.save();
    return new Blob([out], { type: 'application/pdf' });
}

/**
 * Build a sensible default filename for the save dialog. Strips the
 * trailing `.pdf` (case-insensitive) from the source name and appends
 * `-edited.pdf`. Called by both Save and Save As; Save also uses it for
 * the fallback `<a download>` path.
 */
export function defaultSavedFilename(sourceName: string | undefined): string {
    const safe = (sourceName ?? '').trim() || 'document.pdf';
    const withoutExt = safe.replace(/\.pdf$/i, '');
    return `${withoutExt}-edited.pdf`;
}

interface ShowSaveFilePickerOptions {
    suggestedName?: string;
    types?: Array<{
        description?: string;
        accept: Record<string, string[]>;
    }>;
}

interface FileSystemWritableFileStreamLike {
    write(data: Blob | ArrayBuffer | Uint8Array): Promise<void>;
    close(): Promise<void>;
}

interface FileSystemFileHandleLike {
    createWritable(): Promise<FileSystemWritableFileStreamLike>;
}

interface ShowSaveFilePickerWindow extends Window {
    showSaveFilePicker?(options: ShowSaveFilePickerOptions): Promise<FileSystemFileHandleLike>;
}

/**
 * Persist `blob` to disk via the File System Access API when available,
 * otherwise fall back to a synthetic `<a download>` click. Both paths
 * resolve `true` on success and `false` if the user cancelled the
 * picker. Throws on actual write failure.
 */
export async function persistBlobToDisk(
    blob: Blob,
    suggestedName: string
): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    const w = window as ShowSaveFilePickerWindow;
    if (typeof w.showSaveFilePicker === 'function') {
        try {
            const handle = await w.showSaveFilePicker({
                suggestedName,
                types: [
                    {
                        description: 'PDF document',
                        accept: { 'application/pdf': ['.pdf'] }
                    }
                ]
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            return true;
        } catch (err) {
            // AbortError: user cancelled — treat as a benign no-op.
            const name = (err as { name?: string } | null)?.name;
            if (name === 'AbortError') return false;
            throw err;
        }
    }
    // Fallback path — anchor download.
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on next tick so the click has a chance to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
}

/**
 * Top-level "Save" / "Save As" entry point. Composes the modified PDF
 * and writes it through `persistBlobToDisk`. Returns `false` if the user
 * cancelled the save picker.
 */
export async function saveWithAnnotations(
    opts: SaveOptions & { suggestedName?: string }
): Promise<boolean> {
    const blob = await buildSavedPdfBlob(opts);
    const name = opts.suggestedName ?? defaultSavedFilename(undefined);
    return persistBlobToDisk(blob, name);
}
