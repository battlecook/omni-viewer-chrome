// Browser-side type definitions for the legacy .ppt (PowerPoint 97-2003)
// binary parser (issues #48 and #78).
//
// This is a subset of the VSCode build's `pptBinaryTypes.ts` — issue #78
// brings shape bounds, picture extraction, and a `PptSlideElement[]`
// rendering path into scope. ColorSchemeAtom background inheritance is
// supported; richer master/layout element inheritance, styled text runs,
// and bullet-glyph rendering remain deferred. See `docs/ppt-parity.md`.
//
// All buffer-shaped fields use `Uint8Array` rather than Node's `Buffer`
// so this module is consumable from browser bundles (the legacy SPA
// loads the parser via the `ppt` entry chunk).

export interface CfbEntry {
    name: string;
    type: number;
    startSector: number;
    size: number;
}

export interface CfbReader {
    /**
     * Read the named stream (e.g. `"PowerPoint Document"`, `"Current User"`,
     * `"Pictures"`) out of the compound file. Returns `null` when the
     * stream is missing or the directory entry is not a stream (type !== 2).
     */
    getStream(name: string): Uint8Array | null;
    /** Used by tests / diagnostics to enumerate the streams we recognise. */
    listStreams(): Array<{ name: string; size: number }>;
}

/**
 * One PPT record header (RH) plus its payload. The .ppt binary stream is a
 * tree of these records; container records (recVer == 0x0f) hold child
 * records inside their payload, atoms hold raw data.
 */
export interface PptRecord {
    recType: number;
    recInstance: number;
    recVer: number;
    length: number;
    payloadOffset: number;
    payload: Uint8Array;
    children?: PptRecord[];
}

/**
 * Axis-aligned rectangle in raw legacy coordinates (typically master units
 * = 1/576 inch), not pixels. Issue #78 surfaces these so the renderer can
 * scale them against `PptPresentationMetrics.rawWidth / rawHeight`.
 */
export interface PptShapeBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * One text run attributed to a shape inside a slide. `bounds` is the
 * containing SpContainer's anchor rect (raw legacy coordinates); it is
 * `undefined` when the text atom is not enclosed by a shape (orphaned
 * outline text). `placeholderKind` is reserved for follow-up work — the
 * Chrome port currently sets it only when the OfficeArt walker can
 * cheaply infer it from the shape's `textType` (TextHeaderAtom 3999).
 */
export interface PptTextBlock {
    text: string;
    bounds?: PptShapeBounds;
    placeholderKind?: 'title' | 'body' | 'other';
}

/**
 * Picture asset extracted from the Pictures stream. `bytes` is the raw
 * compressed image (PNG / JPEG / DIB) — the renderer wraps it in a
 * `Blob` + `URL.createObjectURL`. EMF and WMF BLIPs are skipped (browsers
 * cannot decode them); see `docs/ppt-parity.md`.
 */
export interface PptPictureAsset {
    id: number;
    mime: 'image/png' | 'image/jpeg' | 'image/bmp';
    bytes: Uint8Array;
}

/**
 * One placed element in the full slide model. Text elements carry the
 * decoded string plus the shape bounds; picture elements carry the
 * picture index into the slide model's `pictures` array.
 */
export type PptSlideElement =
    | {
          kind: 'text';
          bounds?: PptShapeBounds;
          text: string;
          placeholderKind?: 'title' | 'body' | 'other';
      }
    | {
          kind: 'picture';
          bounds?: PptShapeBounds;
          pictureId: number;
      };

/**
 * Full slide model (issue #78). Extends the text-only `PptSlideTextModel`
 * with optional `elements` and `pictures` fields — when these are present
 * the viewer dispatches to the full-model renderer, otherwise it falls
 * back to the text-only path. This keeps the contract backward-compatible
 * with the original `texts: string[]` consumer.
 */
export interface PptSlideModel {
    slideNumber: number;
    /**
     * Legacy ColorSchemeAtom background, resolved slide-first and then from
     * the document/master scheme. Undefined keeps the historical white
     * renderer fallback for decks without colour metadata.
     */
    backgroundColor?: string;
    /**
     * One entry per extracted text run / atom. Empty array is valid (a
     * slide that contains only art-heavy shapes will surface no text).
     */
    texts: string[];
    /**
     * When the parser successfully walked shape bounds for this slide,
     * this carries per-shape text + picture references in z-order. When
     * the OfficeArt walker found nothing (text-only fallback path), this
     * is `undefined` and the viewer renders the flat `texts[]`.
     */
    elements?: PptSlideElement[];
    /**
     * Pictures referenced by `elements` for this slide. Stored on the
     * slide rather than the document so the renderer doesn't have to
     * thread the document-wide picture map through every call site.
     */
    pictures?: PptPictureAsset[];
}

/**
 * Backwards-compatible alias kept for the text-only consumer path
 * (`pptViewerMain.ts` legacy branch). Issue #78 widens the model into
 * `PptSlideModel`; the alias keeps old imports compiling without churn.
 */
export type PptSlideTextModel = PptSlideModel;

/**
 * Presentation-wide metrics extracted from the DocumentAtom (RT_DocumentAtom
 * 1001). `widthPx` / `heightPx` are converted from EMU / master units to
 * 96-DPI pixels; `rawWidth` / `rawHeight` are the unscaled coordinate-space
 * values used for normalising shape bounds. Falls back to a 720x540 default
 * when the atom can't be located — see `pptBinaryParser.ts`.
 */
export interface PptPresentationMetrics {
    widthPx: number;
    heightPx: number;
    rawWidth: number;
    rawHeight: number;
}

export interface PptParseResult {
    slides: PptSlideModel[];
    totalSlides: number;
    /**
     * Presentation-wide slide dimensions. Always populated — falls back
     * to a 720x540 px default when the DocumentAtom is missing.
     */
    metrics: PptPresentationMetrics;
    /**
     * All BLIPs successfully decoded from the Pictures stream, keyed by
     * the BStoreEntry index (1-based, matches the OfficeArt blipId
     * convention). Empty map when the stream is missing or undecodable.
     */
    pictures: Map<number, PptPictureAsset>;
}
