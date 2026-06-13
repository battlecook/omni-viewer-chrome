// PDF merge: append every page of a second PDF to a first PDF and
// produce a new byte stream. Issue #23.
//
// Approach
// --------
// We build a *new* `PDFDocument` and copy every page of the current PDF
// followed by every page of the appended PDF into it. This mirrors the
// VSCode original (`pdfMessageHandlers.ts#handleSavePdf` accumulates
// `sourceDocs` and copies indices in order).
//
// In-place re-mount
// -----------------
// The viewer can't simply "patch" the live pdf.js render; merged bytes
// shift the page count, page objects, and any internal cross-references.
// The toolbar's Merge handler therefore:
//
//   1. Calls `mergePdf(currentBytes, addedBytes)` to obtain merged bytes,
//   2. Disposes the current viewer handle (which tears down pdf.js and
//      our overlay layers),
//   3. Re-mounts the viewer with a synthetic `File` carrying the merged
//      bytes.
//
// This keeps `pageOrder.ts` honest: after re-mount the page-order state
// is reset to identity for the new (n + m) page count, and any existing
// annotations are reset along with the document (they're tied to the
// previous pdf.js page indices, which the merge invalidates).

import { loadPdfLib, PdfLibDocument } from './pdfLibLoader';

export interface MergePdfOptions {
    /** Bytes of the document currently shown in the viewer. */
    currentBytes: Uint8Array;
    /** Bytes of the PDF the user picked to append. */
    addBytes: Uint8Array;
}

/**
 * Merge `currentBytes` followed by `addBytes` into a single PDF and
 * return the new byte stream. Throws on malformed PDFs (pdf-lib will
 * raise its own error which we let propagate).
 */
export async function mergePdf(opts: MergePdfOptions): Promise<Uint8Array> {
    const PDFLib = await loadPdfLib();
    const baseDoc = await PDFLib.PDFDocument.load(opts.currentBytes);
    const addDoc = await PDFLib.PDFDocument.load(opts.addBytes);
    return composeAppendedDoc(PDFLib.PDFDocument.create, baseDoc, addDoc);
}

/**
 * Pure-ish helper carved out so tests can substitute mock `PDFDocument`s
 * without spinning up the real pdf-lib. Builds a fresh document and
 * copies every page of `base` then every page of `addition` into it.
 */
export async function composeAppendedDoc(
    create: () => Promise<PdfLibDocument>,
    base: PdfLibDocument,
    addition: PdfLibDocument
): Promise<Uint8Array> {
    const merged = await create();
    const baseIndices = base.getPages().map((_, i) => i);
    const addIndices = addition.getPages().map((_, i) => i);
    const basePages = await merged.copyPages(base, baseIndices);
    basePages.forEach((p) => merged.addPage(p));
    const addPages = await merged.copyPages(addition, addIndices);
    addPages.forEach((p) => merged.addPage(p));
    return merged.save();
}

/**
 * Open a hidden `<input type="file">` and resolve with the picked PDF
 * bytes (or `undefined` if the user cancelled the picker). The element
 * is appended to `document.body` so picker focus is not blocked by an
 * orphaned input on browsers that gate it.
 */
export function pickPdfBytes(): Promise<Uint8Array | undefined> {
    return new Promise<Uint8Array | undefined>((resolve) => {
        if (typeof document === 'undefined') {
            resolve(undefined);
            return;
        }
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/pdf,.pdf';
        input.style.display = 'none';
        let resolved = false;
        const finalize = (value: Uint8Array | undefined): void => {
            if (resolved) return;
            resolved = true;
            try {
                input.remove();
            } catch {
                // ignore
            }
            resolve(value);
        };
        input.addEventListener('change', () => {
            const file = input.files && input.files[0];
            if (!file) {
                finalize(undefined);
                return;
            }
            file.arrayBuffer()
                .then((buf) => finalize(new Uint8Array(buf)))
                .catch(() => finalize(undefined));
        });
        // Best-effort cancellation detection: when focus returns to the
        // window without a file selected the picker was cancelled. We
        // schedule a delayed `undefined` resolution so the change handler
        // wins if it fires.
        const onFocus = (): void => {
            window.removeEventListener('focus', onFocus);
            setTimeout(() => {
                if (!resolved && (!input.files || input.files.length === 0)) {
                    finalize(undefined);
                }
            }, 300);
        };
        window.addEventListener('focus', onFocus);
        document.body.appendChild(input);
        input.click();
    });
}
