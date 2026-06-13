// Pure-helper tests for the PDF save / merge pipeline (issue #23).
//
// We can't load the real `pdf-lib` UMD bundle in jsdom — it's a 200kB
// minified blob that touches `Uint8Array.prototype` extensions and is
// keyed off `window.PDFLib`. Instead, the helpers under test are pure
// math (`hexToRgbTriple`, `defaultSavedFilename`, the y-flip helpers,
// `dataUrlPngToBytes`) plus two orchestration helpers
// (`applyPageOrderToDoc`, `composeAppendedDoc`) that we exercise with
// hand-rolled mock pdf-lib namespaces.

import {
    applyPageOrderToDoc,
    dataUrlPngToBytes,
    defaultSavedFilename,
    hexToRgbTriple,
    imageTopLeftYToPdfY,
    textTopLeftYToPdfY
} from '../templates/pdf/js/save';
import { composeAppendedDoc } from '../templates/pdf/js/merge';
import { resetOrder } from '../templates/pdf/js/pageOrder';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------- hexToRgbTriple --------------------------------------

describe('hexToRgbTriple', () => {
    it('parses a 6-digit hex with leading #', () => {
        const t = hexToRgbTriple('#ff8000');
        expect(t.r).toBeCloseTo(1, 5);
        expect(t.g).toBeCloseTo(128 / 255, 5);
        expect(t.b).toBeCloseTo(0, 5);
    });

    it('parses a 6-digit hex without leading #', () => {
        const t = hexToRgbTriple('00ff00');
        expect(t.r).toBeCloseTo(0, 5);
        expect(t.g).toBeCloseTo(1, 5);
        expect(t.b).toBeCloseTo(0, 5);
    });

    it('expands a 3-digit shorthand', () => {
        const t = hexToRgbTriple('#0f0');
        expect(t.r).toBeCloseTo(0, 5);
        expect(t.g).toBeCloseTo(1, 5);
        expect(t.b).toBeCloseTo(0, 5);
    });

    it('falls back to black on garbage', () => {
        expect(hexToRgbTriple('zzzzzz')).toEqual({ r: 0, g: 0, b: 0 });
        expect(hexToRgbTriple(undefined)).toEqual({ r: 0, g: 0, b: 0 });
        expect(hexToRgbTriple('')).toEqual({ r: 0, g: 0, b: 0 });
    });
});

// ---------- y-flip helpers --------------------------------------

describe('coordinate flip helpers', () => {
    it('textTopLeftYToPdfY flips top-left y to pdf-lib bottom-left baseline', () => {
        // A 16pt text annotation 50pt from the top of an 800pt page
        // should land at baseline y = 800 - 50 - 16 = 734.
        expect(textTopLeftYToPdfY(800, 50, 16)).toBe(734);
    });

    it('imageTopLeftYToPdfY flips top-left y to pdf-lib bottom-left bottom-edge', () => {
        // A 60pt-tall signature 100pt from the top of an 800pt page
        // should land at bottom y = 800 - 100 - 60 = 640.
        expect(imageTopLeftYToPdfY(800, 100, 60)).toBe(640);
    });

    it('handles zero offsets cleanly', () => {
        expect(textTopLeftYToPdfY(842, 0, 12)).toBe(830);
        expect(imageTopLeftYToPdfY(842, 0, 0)).toBe(842);
    });
});

// ---------- defaultSavedFilename --------------------------------

describe('defaultSavedFilename', () => {
    it('appends -edited to the bare name', () => {
        expect(defaultSavedFilename('report.pdf')).toBe('report-edited.pdf');
    });

    it('strips a case-insensitive .PDF extension', () => {
        expect(defaultSavedFilename('Report.PDF')).toBe('Report-edited.pdf');
    });

    it('handles names without a .pdf suffix', () => {
        expect(defaultSavedFilename('notes')).toBe('notes-edited.pdf');
    });

    it('falls back to a generic default on undefined / blank input', () => {
        expect(defaultSavedFilename(undefined)).toBe('document-edited.pdf');
        expect(defaultSavedFilename('   ')).toBe('document-edited.pdf');
    });
});

// ---------- dataUrlPngToBytes -----------------------------------

describe('dataUrlPngToBytes', () => {
    it('decodes a known base64 PNG payload', () => {
        // Trivially decodable payload: "Hi!" → "SGkh".
        const url = 'data:image/png;base64,SGkh';
        const bytes = dataUrlPngToBytes(url);
        expect(Array.from(bytes)).toEqual(['H', 'i', '!'].map((c) => c.charCodeAt(0)));
    });

    it('rejects non-PNG dataUrls', () => {
        expect(() => dataUrlPngToBytes('data:image/jpeg;base64,abc')).toThrow();
        expect(() => dataUrlPngToBytes('not-a-data-url')).toThrow();
    });
});

// ---------- applyPageOrderToDoc --------------------------------

interface MockPage {
    id: number;
}

function makeMockPdfLib(): {
    PDFLib: any;
    /** Pages added to the most recently created doc, in order. */
    getLastDocPages(): MockPage[];
} {
    let lastDoc: { pages: MockPage[] } | undefined;
    const PDFLib: any = {
        StandardFonts: { Helvetica: 'Helvetica' },
        rgb: (r: number, g: number, b: number) => ({ r, g, b }),
        PDFDocument: {
            create: async () => {
                const doc: any = {
                    pages: [] as MockPage[],
                    getPageCount(): number {
                        return doc.pages.length;
                    },
                    getPages(): MockPage[] {
                        return doc.pages.slice();
                    },
                    addPage(page: MockPage) {
                        doc.pages.push(page);
                        return page;
                    },
                    copyPages: async (
                        src: any,
                        indices: number[]
                    ): Promise<MockPage[]> => {
                        return indices.map((i) => ({
                            id: src.pages[i].id
                        }));
                    },
                    embedFont: async (f: any) => f,
                    embedPng: async (b: any) => ({ kind: 'png', size: b.length }),
                    save: async (): Promise<Uint8Array> => {
                        const ids = doc.pages.map((p: MockPage) => p.id);
                        return new Uint8Array(ids);
                    }
                };
                lastDoc = doc;
                return doc;
            },
            load: async (bytes: Uint8Array) => {
                // Each byte is a "page id" — handy for round-trip assertions.
                const pages: MockPage[] = Array.from(bytes).map((b) => ({ id: b }));
                const doc: any = {
                    pages,
                    getPageCount(): number {
                        return pages.length;
                    },
                    getPages(): MockPage[] {
                        return pages.slice();
                    },
                    addPage() {
                        // unused on a loaded doc in our tests
                    },
                    copyPages: async (
                        src: any,
                        indices: number[]
                    ): Promise<MockPage[]> => {
                        return indices.map((i) => ({ id: src.pages[i].id }));
                    },
                    embedFont: async (f: any) => f,
                    embedPng: async (b: any) => ({ kind: 'png', size: b.length }),
                    save: async (): Promise<Uint8Array> => {
                        const ids = pages.map((p) => p.id);
                        return new Uint8Array(ids);
                    }
                };
                return doc;
            }
        }
    };
    return {
        PDFLib,
        getLastDocPages(): MockPage[] {
            return lastDoc ? lastDoc.pages.slice() : [];
        }
    };
}

describe('applyPageOrderToDoc', () => {
    it('copies the visible pages in the specified order', async () => {
        const { PDFLib, getLastDocPages } = makeMockPdfLib();
        const src = await PDFLib.PDFDocument.load(new Uint8Array([10, 20, 30, 40]));
        // Rearrange + drop a page: order = [3, 1, 4] (1-based).
        const { doc, originalPageNumberByNewIndex } = await applyPageOrderToDoc(
            PDFLib,
            src,
            [3, 1, 4]
        );
        expect(doc.getPageCount()).toBe(3);
        expect(getLastDocPages().map((p) => p.id)).toEqual([30, 10, 40]);
        // Mapping back to original page numbers preserves the 1-based ids.
        expect(originalPageNumberByNewIndex).toEqual([3, 1, 4]);
    });

    it('drops out-of-range and duplicate entries gracefully', async () => {
        const { PDFLib, getLastDocPages } = makeMockPdfLib();
        const src = await PDFLib.PDFDocument.load(new Uint8Array([1, 2, 3]));
        const { doc, originalPageNumberByNewIndex } = await applyPageOrderToDoc(
            PDFLib,
            src,
            [2, 99, 2, 1] // 99 out-of-range, second 2 deduped
        );
        expect(doc.getPageCount()).toBe(2);
        expect(getLastDocPages().map((p) => p.id)).toEqual([2, 1]);
        expect(originalPageNumberByNewIndex).toEqual([2, 1]);
    });

    it('falls back to identity when no valid pages remain', async () => {
        const { PDFLib, getLastDocPages } = makeMockPdfLib();
        const src = await PDFLib.PDFDocument.load(new Uint8Array([7, 8]));
        const { doc, originalPageNumberByNewIndex } = await applyPageOrderToDoc(
            PDFLib,
            src,
            [99] // entirely invalid
        );
        expect(doc.getPageCount()).toBe(2);
        expect(getLastDocPages().map((p) => p.id)).toEqual([7, 8]);
        expect(originalPageNumberByNewIndex).toEqual([1, 2]);
    });

    it('plays nicely with an identity pageOrder from resetOrder()', async () => {
        const { PDFLib, getLastDocPages } = makeMockPdfLib();
        const src = await PDFLib.PDFDocument.load(new Uint8Array([5, 6, 7]));
        const state = resetOrder(3);
        const { doc } = await applyPageOrderToDoc(PDFLib, src, state.order);
        expect(doc.getPageCount()).toBe(3);
        expect(getLastDocPages().map((p) => p.id)).toEqual([5, 6, 7]);
    });
});

// ---------- composeAppendedDoc (merge) --------------------------

describe('composeAppendedDoc', () => {
    it('appends every page of the second doc after the first', async () => {
        const { PDFLib, getLastDocPages } = makeMockPdfLib();
        const a = await PDFLib.PDFDocument.load(new Uint8Array([1, 2, 3]));
        const b = await PDFLib.PDFDocument.load(new Uint8Array([4, 5]));
        const out = await composeAppendedDoc(PDFLib.PDFDocument.create, a, b);
        expect(getLastDocPages().map((p) => p.id)).toEqual([1, 2, 3, 4, 5]);
        // `save()` on the mock concatenates the page ids into a Uint8Array.
        expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
    });

    it('produces an empty document when both inputs are empty', async () => {
        const { PDFLib, getLastDocPages } = makeMockPdfLib();
        const a = await PDFLib.PDFDocument.load(new Uint8Array([]));
        const b = await PDFLib.PDFDocument.load(new Uint8Array([]));
        const out = await composeAppendedDoc(PDFLib.PDFDocument.create, a, b);
        expect(getLastDocPages()).toEqual([]);
        expect(out.length).toBe(0);
    });

    it('matches the expected page count after merge', async () => {
        const { PDFLib } = makeMockPdfLib();
        const a = await PDFLib.PDFDocument.load(new Uint8Array(new Array(10).fill(0)));
        const b = await PDFLib.PDFDocument.load(new Uint8Array(new Array(7).fill(0)));
        const out = await composeAppendedDoc(PDFLib.PDFDocument.create, a, b);
        expect(out.length).toBe(17);
    });
});
