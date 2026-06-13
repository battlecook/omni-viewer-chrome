// Annotation store for the Chrome PDF viewer.
//
// Generic per-document state for issues #19 (text), #20 (signature image),
// and #21 (selection / move). The store is intentionally narrow — it only
// owns the in-memory data; rendering, persistence, and PDF-lib write-back
// (issue #23) are layered on top by callers.
//
// Coordinate model (locked by issue #19):
//   - `x` / `y` are in PDF page-space (PDF point units, top-left origin).
//   - When rendering at a given pdf.js scale `s`, the screen px coordinates
//     are `screenX = x * s`, `screenY = y * s`.
//   - This keeps annotations stable across zoom changes and lets #23 hand
//     coordinates straight to pdf-lib's draw APIs (after a y-flip to PDF's
//     bottom-left origin) without re-projecting through screen space.
//
// The store is keyed by a stable string id (`<kind>-<counter>-<random>`) so
// callers can safely take references for selection / drag interactions
// without worrying about array re-indexing.

/**
 * Discriminated annotation kinds. `text` is the only kind populated in this
 * issue; `signature` lands in #20 and shares the same store so `#21` (move
 * / select) doesn't have to special-case kinds.
 */
export type PdfAnnotationKind = 'text' | 'signature';

/** Common fields every annotation carries. */
export interface PdfAnnotationBase {
    id: string;
    kind: PdfAnnotationKind;
    /** 0-based page index. */
    pageIndex: number;
    /** PDF point coordinates, top-left origin. See file header. */
    x: number;
    y: number;
}

/** Text annotation payload (issue #19). */
export interface PdfTextAnnotation extends PdfAnnotationBase {
    kind: 'text';
    text: string;
    /** Font size in PDF points. */
    size: number;
    /** CSS color string (`#rrggbb`). */
    color: string;
}

/**
 * Signature annotation payload (issue #20). Defined here so the store stays
 * shape-stable across issues; #19 never instantiates it.
 */
export interface PdfSignatureAnnotation extends PdfAnnotationBase {
    kind: 'signature';
    /** Data URL (`data:image/png;base64,...`) of the rendered signature. */
    dataUrl: string;
    /** Render width in PDF points. */
    width: number;
    /** Render height in PDF points. */
    height: number;
}

export type PdfAnnotation = PdfTextAnnotation | PdfSignatureAnnotation;

/** Input shape for `addAnnotation`: id is generated, the rest is supplied. */
export type PdfAnnotationInput =
    | Omit<PdfTextAnnotation, 'id'>
    | Omit<PdfSignatureAnnotation, 'id'>;

export interface PdfAnnotationStore {
    /** Insert an annotation. Returns the assigned id. */
    addAnnotation(input: PdfAnnotationInput): string;
    /** Remove by id. Returns true if a record was deleted. */
    removeAnnotation(id: string): boolean;
    /** Patch an existing annotation. Returns true if it was found. */
    updateAnnotation(id: string, patch: Partial<PdfAnnotationBase> & Partial<Omit<PdfTextAnnotation, keyof PdfAnnotationBase | 'kind'>> & Partial<Omit<PdfSignatureAnnotation, keyof PdfAnnotationBase | 'kind'>>): boolean;
    /** Get a snapshot copy of every annotation on `pageIndex`. */
    listAnnotations(pageIndex: number): PdfAnnotation[];
    /** Snapshot copy of every annotation in insertion order. */
    listAll(): PdfAnnotation[];
    /** Look up by id; returns a copy or undefined. */
    getAnnotation(id: string): PdfAnnotation | undefined;
    /** Subscribe to change events. Returns an unsubscribe fn. */
    onChange(listener: (event: PdfAnnotationChangeEvent) => void): () => void;
    /** Drop everything. */
    clear(): void;
}

export interface PdfAnnotationChangeEvent {
    type: 'add' | 'remove' | 'update' | 'clear';
    /** The id of the affected annotation, or undefined for `clear`. */
    id?: string;
    /** Page index of the affected annotation, when known. */
    pageIndex?: number;
}

/**
 * Build a stable id generator. Format: `<kind>-<counter>-<rand>`. The
 * counter monotonically increases inside one store instance; `rand` adds a
 * couple of bytes so two stores in the same page don't collide if their
 * outputs are ever merged (e.g. a future "session restore" feature).
 */
export function createAnnotationIdFactory(): (kind: PdfAnnotationKind) => string {
    let counter = 0;
    return (kind) => {
        counter += 1;
        const rand = Math.floor(Math.random() * 0xffff)
            .toString(16)
            .padStart(4, '0');
        return `${kind}-${counter}-${rand}`;
    };
}

/**
 * Build an empty annotation store. Each call returns a fresh, isolated
 * instance — there is no module-level singleton on purpose so multi-tab /
 * multi-viewer setups stay independent.
 */
export function createPdfAnnotationStore(opts?: {
    /** Override the id generator. Used by tests for deterministic ids. */
    idFactory?: (kind: PdfAnnotationKind) => string;
}): PdfAnnotationStore {
    const idFactory = opts?.idFactory ?? createAnnotationIdFactory();
    const records = new Map<string, PdfAnnotation>();
    const listeners = new Set<(event: PdfAnnotationChangeEvent) => void>();

    const emit = (event: PdfAnnotationChangeEvent): void => {
        for (const l of listeners) {
            try {
                l(event);
            } catch {
                // Listeners must not throw into the store.
            }
        }
    };

    const cloneAnnotation = (record: PdfAnnotation): PdfAnnotation => {
        // Spread copy is enough — every field is a primitive.
        return { ...record } as PdfAnnotation;
    };

    return {
        addAnnotation(input: PdfAnnotationInput): string {
            const id = idFactory(input.kind);
            const record = { ...input, id } as PdfAnnotation;
            records.set(id, record);
            emit({ type: 'add', id, pageIndex: record.pageIndex });
            return id;
        },

        removeAnnotation(id: string): boolean {
            const existing = records.get(id);
            if (!existing) return false;
            records.delete(id);
            emit({ type: 'remove', id, pageIndex: existing.pageIndex });
            return true;
        },

        updateAnnotation(id, patch): boolean {
            const existing = records.get(id);
            if (!existing) return false;
            // The `kind` discriminator is locked at creation time — strip it
            // out of any incoming patch so callers can't bend a text
            // annotation into a signature by mistake.
            const safePatch = { ...patch } as Record<string, unknown>;
            delete safePatch.id;
            delete safePatch.kind;
            const merged = { ...existing, ...safePatch } as PdfAnnotation;
            records.set(id, merged);
            emit({ type: 'update', id, pageIndex: merged.pageIndex });
            return true;
        },

        listAnnotations(pageIndex: number): PdfAnnotation[] {
            const out: PdfAnnotation[] = [];
            for (const record of records.values()) {
                if (record.pageIndex === pageIndex) {
                    out.push(cloneAnnotation(record));
                }
            }
            return out;
        },

        listAll(): PdfAnnotation[] {
            const out: PdfAnnotation[] = [];
            for (const record of records.values()) {
                out.push(cloneAnnotation(record));
            }
            return out;
        },

        getAnnotation(id: string): PdfAnnotation | undefined {
            const record = records.get(id);
            return record ? cloneAnnotation(record) : undefined;
        },

        onChange(listener): () => void {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },

        clear(): void {
            if (records.size === 0) return;
            records.clear();
            emit({ type: 'clear' });
        }
    };
}

/**
 * Pure helper: project a PDF-point coordinate to screen px at a given
 * pdf.js scale. Mirrors the formula in the file header. Exported so the
 * coordinate-conversion math has a single source of truth across #19 / #20
 * / #21 and is unit-testable in isolation.
 */
export function pdfPointToScreenPx(point: number, scale: number): number {
    return point * scale;
}

/**
 * Inverse of `pdfPointToScreenPx`: convert a screen-px offset (relative to
 * a page wrapper's top-left) back into PDF points. Used when the user
 * clicks on a page to drop a new annotation.
 */
export function screenPxToPdfPoint(px: number, scale: number): number {
    if (scale === 0) return 0;
    return px / scale;
}
