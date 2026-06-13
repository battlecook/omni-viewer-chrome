// Pure (DOM-free) helpers for the Chrome PDF viewer signature pad
// (issue #20).
//
// The signature pad in `annotations/signature.ts` collects raw pointer
// samples while the user is dragging on the canvas. Drawing those samples
// directly with `lineTo` produces visibly jagged ink because pointer
// events arrive at coarse intervals (~16 ms). We smooth the stroke by
// interpolating each segment with a quadratic curve whose control point
// is the previous sample and whose endpoint is the midpoint between the
// previous and current sample. This is the same approach used by the
// well-known "smoothed pen" recipe and gives a noticeably softer line
// without any external dependency.
//
// Everything in this module is intentionally pure so it can be unit
// tested without a DOM:
//   - `addPoint(prev, next)` returns the segment that should be appended
//     to the current stroke when the pointer moves from `prev` to `next`.
//   - `boundingBox(points)` returns the axis-aligned rectangle that
//     contains every supplied point (used by future PRs that crop the
//     signature to its ink and by #21 selection / move).
//   - `simplifyStroke(points, minDistance)` drops samples that arrived
//     too close together; pointer streams routinely emit duplicates and
//     near-duplicates and rendering them adds noise to the curve.
//
// Coordinate units in this file are *canvas px* (the signature canvas's
// internal coordinate space). Conversion to PDF point space is the
// caller's job once the user has confirmed the modal.

/** Single pointer sample inside the signature canvas. */
export interface SignaturePoint {
    x: number;
    y: number;
}

/**
 * One smoothed segment ready to be painted with
 * `ctx.quadraticCurveTo(controlX, controlY, endX, endY)`. We always paint
 * to the midpoint between two samples and use the *prior* sample as the
 * control, which guarantees C1 continuity across consecutive segments.
 */
export interface SignatureSegment {
    /** Control point — typically the previous sample. */
    controlX: number;
    controlY: number;
    /** End point — the midpoint of the previous and current samples. */
    endX: number;
    endY: number;
}

/** Axis-aligned rectangle in canvas-px space. */
export interface SignatureRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Default minimum distance (canvas px) between consecutive samples. */
export const DEFAULT_MIN_POINT_DISTANCE = 1.5;

/**
 * Build a smoothed segment from a previous sample (`prev`) to the
 * current one (`next`). The endpoint is the midpoint between the two
 * samples; the control point is `prev`. Callers chain successive
 * segments together to render a continuous, softened stroke.
 *
 * If `prev` and `next` coincide the returned segment is a degenerate
 * point — drawing it is a no-op but the caller can still feed it to
 * `quadraticCurveTo` without a special case.
 */
export function addPoint(
    prev: SignaturePoint,
    next: SignaturePoint
): SignatureSegment {
    const midX = (prev.x + next.x) / 2;
    const midY = (prev.y + next.y) / 2;
    return {
        controlX: prev.x,
        controlY: prev.y,
        endX: midX,
        endY: midY
    };
}

/**
 * Compute the axis-aligned bounding box for a sample list. Returns a
 * zero-sized rect anchored at the origin when the list is empty so
 * callers can rely on the shape regardless of input.
 */
export function boundingBox(points: ReadonlyArray<SignaturePoint>): SignatureRect {
    if (points.length === 0) {
        return { x: 0, y: 0, width: 0, height: 0 };
    }
    let minX = points[0].x;
    let minY = points[0].y;
    let maxX = points[0].x;
    let maxY = points[0].y;
    for (let i = 1; i < points.length; i++) {
        const p = points[i];
        if (p.x < minX) minX = p.x;
        else if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        else if (p.y > maxY) maxY = p.y;
    }
    return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY
    };
}

/**
 * Squared euclidean distance between two samples. Exported because the
 * tests for `simplifyStroke` rely on the same metric.
 */
export function distanceSquared(a: SignaturePoint, b: SignaturePoint): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
}

/**
 * Drop consecutive samples that fall within `minDistance` px of the
 * previously-kept sample. The first and last samples are always kept so
 * the stroke endpoints stay anchored. `minDistance` defaults to
 * `DEFAULT_MIN_POINT_DISTANCE`; pass a larger value to aggressively
 * decimate noisy input or `0` to keep every sample.
 */
export function simplifyStroke(
    points: ReadonlyArray<SignaturePoint>,
    minDistance: number = DEFAULT_MIN_POINT_DISTANCE
): SignaturePoint[] {
    if (points.length === 0) return [];
    if (points.length === 1) return [{ ...points[0] }];
    const threshold = Math.max(0, minDistance);
    const thresholdSq = threshold * threshold;
    const out: SignaturePoint[] = [{ ...points[0] }];
    for (let i = 1; i < points.length - 1; i++) {
        const last = out[out.length - 1];
        if (distanceSquared(last, points[i]) >= thresholdSq) {
            out.push({ ...points[i] });
        }
    }
    // Always keep the final sample so the stroke ends where the user
    // released the pointer (even if it's within the threshold).
    const finalPoint = points[points.length - 1];
    const last = out[out.length - 1];
    if (last.x !== finalPoint.x || last.y !== finalPoint.y) {
        out.push({ ...finalPoint });
    }
    return out;
}

/**
 * Pure render function for a single stroke. Invokes the supplied 2D
 * canvas-context-shaped `painter` callbacks in the same order
 * `annotations/signature.ts` uses to draw a stroke during live input.
 *
 * Exported separately so tests can verify the smoothing pipeline without
 * pulling in jsdom canvas mocks: the test passes a recorder painter and
 * asserts on the recorded call sequence.
 */
export interface SignaturePainter {
    moveTo(x: number, y: number): void;
    quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
    lineTo(x: number, y: number): void;
}

export function paintStroke(
    points: ReadonlyArray<SignaturePoint>,
    painter: SignaturePainter
): void {
    if (points.length === 0) return;
    if (points.length === 1) {
        // A single dot: render as a 0-length line so the caller's stroke
        // style (round caps) renders a pen tip at that location.
        painter.moveTo(points[0].x, points[0].y);
        painter.lineTo(points[0].x, points[0].y);
        return;
    }
    painter.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
        const segment = addPoint(points[i - 1], points[i]);
        painter.quadraticCurveTo(
            segment.controlX,
            segment.controlY,
            segment.endX,
            segment.endY
        );
    }
    // Finish on the last sample so the stroke endpoint matches where the
    // user released — without this the last segment would stop at the
    // midpoint instead.
    const last = points[points.length - 1];
    painter.lineTo(last.x, last.y);
}
