// Tests for the JSONL hover popup helpers (issue #59).
//
// Coverage targets:
//   - clampPopupPosition: viewport edge clamping in all 4 directions,
//     plus the "flip to the left of the cursor" branch when there is no
//     room on the right.
//   - parseJsonlLine: caching shape (valid / invalid / empty) and the
//     pre-computed `formatted` payload.
//   - splitJsonlLines: CRLF normalisation, trailing newline handling,
//     interior empty lines preserved.
//   - attachPopup: scheduleShow respects debounce, hide() cancels a
//     pending schedule, dispose() removes the element + clears timers.
//
// We stay DOM-light. Where `attachPopup` is exercised we run under jsdom
// (the project default) and inject custom timers so the tests do not
// depend on real-time scheduling.

import {
    attachPopup,
    clampPopupPosition,
    parseJsonlLine,
    renderHighlightedJson,
    splitJsonlLines
} from '../templates/jsonl/js/jsonlPopup';

// ---------------------------------------------------------------------------
// clampPopupPosition.
// ---------------------------------------------------------------------------

describe('clampPopupPosition', () => {
    const VIEWPORT = { viewportW: 1000, viewportH: 800 };
    const POPUP = { popupW: 400, popupH: 300 };

    it('places the popup to the right + below the cursor when there is room', () => {
        const pos = clampPopupPosition({
            mouseX: 100,
            mouseY: 100,
            ...POPUP,
            ...VIEWPORT
        });
        // 100 + 16 default offsetX = 116
        expect(pos.left).toBe(116);
        // 100 + 12 default offsetY = 112
        expect(pos.top).toBe(112);
    });

    it('flips the popup to the left of the cursor when the right edge would overflow', () => {
        // popup width 400, default offsetX 16. Cursor at 800 → 800+16 = 816
        // 816 + 400 = 1216 > viewportW(1000) - margin(12) = 988, so flip.
        const pos = clampPopupPosition({
            mouseX: 800,
            mouseY: 100,
            ...POPUP,
            ...VIEWPORT
        });
        // Flipped: 800 - 16 - 400 = 384
        expect(pos.left).toBe(384);
    });

    it('clamps left to maxLeft when both right-of-cursor and flipped-left would overflow', () => {
        // Cursor in the middle of a viewport that cannot fit the popup at
        // the cursor on either side: 850+16+800 = 1666 > 900-12 = 888
        // (right overflow), and 850-16-800 = 34 ≥ 12 → flipped fits, so
        // we expect the flipped position rather than the maxLeft pin.
        const pos = clampPopupPosition({
            mouseX: 850,
            mouseY: 50,
            popupW: 800,
            popupH: 300,
            viewportW: 900,
            viewportH: 800
        });
        expect(pos.left).toBe(34);
    });

    it('falls back to maxLeft when neither side has enough room', () => {
        // Popup is wider than the viewport minus margins, so neither
        // "right of cursor" nor "left of cursor" fits. The clamp should
        // pin left to maxLeft (= margin in this degenerate case).
        const pos = clampPopupPosition({
            mouseX: 100,
            mouseY: 50,
            popupW: 1200,
            popupH: 300,
            viewportW: 900,
            viewportH: 800
        });
        // viewportW - popupW - margin = 900 - 1200 - 12 = -312, so
        // maxLeft = max(margin, -312) = 12.
        expect(pos.left).toBe(12);
    });

    it('shifts the popup up when the bottom edge would overflow', () => {
        // popup height 300, default offsetY 12. Cursor at 700 → 712 + 300 =
        // 1012 > 800 - 12 = 788, so shift up.
        const pos = clampPopupPosition({
            mouseX: 100,
            mouseY: 700,
            ...POPUP,
            ...VIEWPORT
        });
        // top = 800 - 300 - 12 = 488
        expect(pos.top).toBe(488);
    });

    it('clamps top to the margin when even the shifted position is above the top margin', () => {
        // Popup taller than the viewport: pinned to top margin.
        const pos = clampPopupPosition({
            mouseX: 100,
            mouseY: 100,
            popupW: 400,
            popupH: 1200,
            viewportW: 1000,
            viewportH: 800
        });
        expect(pos.top).toBe(12);
    });

    it('clamps left to the left margin when the cursor is at the left edge', () => {
        // Cursor at -50 with default offsetX 16: 16 + 400 = -34, below
        // minLeft (12). After clamping it should snap to the margin.
        const pos = clampPopupPosition({
            mouseX: -50,
            mouseY: 100,
            ...POPUP,
            ...VIEWPORT
        });
        expect(pos.left).toBe(12);
    });

    it('respects an explicit margin override', () => {
        const pos = clampPopupPosition({
            mouseX: 100,
            mouseY: 100,
            ...POPUP,
            ...VIEWPORT,
            margin: 40
        });
        // The default placement (right of cursor) still fits, so margin
        // does not change it. But maxLeft / maxTop clamp upper bounds:
        // confirm the values are still inside the wider margin.
        expect(pos.left).toBeGreaterThanOrEqual(40);
        expect(pos.top).toBeGreaterThanOrEqual(40);
    });

    it('respects a custom offset', () => {
        const pos = clampPopupPosition({
            mouseX: 100,
            mouseY: 100,
            ...POPUP,
            ...VIEWPORT,
            offsetX: 0,
            offsetY: 0
        });
        expect(pos.left).toBe(100);
        expect(pos.top).toBe(100);
    });
});

// ---------------------------------------------------------------------------
// parseJsonlLine.
// ---------------------------------------------------------------------------

describe('parseJsonlLine', () => {
    it('returns a valid result with a formatted payload for a valid object', () => {
        const r = parseJsonlLine('{"a":1,"b":2}');
        expect(r.kind).toBe('valid');
        if (r.kind !== 'valid') return;
        expect(r.value).toEqual({ a: 1, b: 2 });
        expect(r.formatted).toBe('{\n  "a": 1,\n  "b": 2\n}');
    });

    it('returns a valid result for arrays / primitives / null', () => {
        expect(parseJsonlLine('[1,2,3]').kind).toBe('valid');
        expect(parseJsonlLine('42').kind).toBe('valid');
        expect(parseJsonlLine('"hello"').kind).toBe('valid');
        const nullR = parseJsonlLine('null');
        expect(nullR.kind).toBe('valid');
        if (nullR.kind === 'valid') {
            expect(nullR.value).toBeNull();
            expect(nullR.formatted).toBe('null');
        }
    });

    it('returns an empty result for whitespace-only lines', () => {
        expect(parseJsonlLine('').kind).toBe('empty');
        expect(parseJsonlLine('   ').kind).toBe('empty');
        expect(parseJsonlLine('\t\t').kind).toBe('empty');
    });

    it('returns an invalid result with the raw text + error message', () => {
        const r = parseJsonlLine('{"unterminated":');
        expect(r.kind).toBe('invalid');
        if (r.kind !== 'invalid') return;
        expect(r.raw).toBe('{"unterminated":');
        expect(typeof r.error).toBe('string');
        expect(r.error.length).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// splitJsonlLines.
// ---------------------------------------------------------------------------

describe('splitJsonlLines', () => {
    it('returns an empty array for an empty file', () => {
        expect(splitJsonlLines('')).toEqual([]);
    });

    it('splits LF-delimited lines', () => {
        expect(splitJsonlLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
    });

    it('normalises CRLF to LF', () => {
        expect(splitJsonlLines('a\r\nb\r\nc')).toEqual(['a', 'b', 'c']);
    });

    it('drops a trailing newline (no synthetic empty entry)', () => {
        expect(splitJsonlLines('a\nb\n')).toEqual(['a', 'b']);
    });

    it('preserves interior empty lines so line numbers stay 1:1 with the source', () => {
        expect(splitJsonlLines('a\n\nb')).toEqual(['a', '', 'b']);
    });

    it('handles a single line with no newline', () => {
        expect(splitJsonlLines('only one line')).toEqual(['only one line']);
    });
});

// ---------------------------------------------------------------------------
// attachPopup — DOM + debounce.
// ---------------------------------------------------------------------------

describe('attachPopup', () => {
    type TimerCb = () => void;
    interface FakeTimer {
        id: number;
        cb: TimerCb;
        ms: number;
    }

    function makeFakeTimers() {
        const timers = new Map<number, FakeTimer>();
        let seq = 1;
        return {
            timers,
            setTimeout: (cb: TimerCb, ms: number): number => {
                const id = seq++;
                timers.set(id, { id, cb, ms });
                return id;
            },
            clearTimeout: (handle: number): void => {
                timers.delete(handle);
            },
            flush: (): void => {
                // Snapshot to avoid mutation issues if a callback enqueues
                // a new timer.
                const snapshot = Array.from(timers.values());
                timers.clear();
                for (const t of snapshot) t.cb();
            }
        };
    }

    let host: HTMLElement;

    beforeEach(() => {
        host = document.createElement('div');
        document.body.appendChild(host);
    });

    afterEach(() => {
        host.remove();
    });

    it('creates a hidden popup element on the host', () => {
        const popup = attachPopup(host);
        expect(popup.element.parentNode).toBe(host);
        expect(popup.element.style.display).toBe('none');
        expect(popup.element.getAttribute('aria-hidden')).toBe('true');
        popup.dispose();
    });

    it('show() updates content + position immediately', () => {
        const popup = attachPopup(host, {
            getViewport: () => ({ width: 1000, height: 800 })
        });
        popup.show('hello', 100, 100);
        expect(popup.element.style.display).toBe('block');
        expect(popup.element.getAttribute('aria-hidden')).toBe('false');
        expect(popup.element.textContent).toBe('hello');
        expect(popup.element.style.left).toBe('116px');
        expect(popup.element.style.top).toBe('112px');
        popup.dispose();
    });

    it('show() renders pretty JSON with syntax-highlight token spans', () => {
        const popup = attachPopup(host, {
            getViewport: () => ({ width: 1000, height: 800 })
        });
        const formatted = JSON.stringify({ name: 'ECU', rpm: 7200, active: true, note: null }, null, 2);

        popup.show(formatted, 100, 100);

        expect(popup.element.textContent).toBe(formatted);
        expect(popup.element.querySelector('.jl-tok-key')?.textContent).toBe('"name"');
        expect(popup.element.querySelector('.jl-tok-string')?.textContent).toBe('"ECU"');
        expect(popup.element.querySelector('.jl-tok-number')?.textContent).toBe('7200');
        expect(popup.element.querySelector('.jl-tok-bool')?.textContent).toBe('true');
        expect(popup.element.querySelector('.jl-tok-null')?.textContent).toBe('null');
        expect(popup.element.querySelectorAll('.jl-tok-punct').length).toBeGreaterThan(0);
        popup.dispose();
    });

    it('scheduleShow() is debounced — the popup stays hidden until the timer fires', () => {
        const fake = makeFakeTimers();
        const popup = attachPopup(host, {
            timers: { setTimeout: fake.setTimeout, clearTimeout: fake.clearTimeout },
            getViewport: () => ({ width: 1000, height: 800 })
        });

        popup.scheduleShow('payload', 100, 100, 150);
        // Before flush the popup is still hidden.
        expect(popup.element.style.display).toBe('none');
        expect(fake.timers.size).toBe(1);

        fake.flush();

        expect(popup.element.style.display).toBe('block');
        expect(popup.element.textContent).toBe('payload');
        popup.dispose();
    });

    it('rapid scheduleShow() calls debounce — only the last payload is shown', () => {
        const fake = makeFakeTimers();
        const popup = attachPopup(host, {
            timers: { setTimeout: fake.setTimeout, clearTimeout: fake.clearTimeout },
            getViewport: () => ({ width: 1000, height: 800 })
        });

        popup.scheduleShow('first', 10, 10);
        popup.scheduleShow('second', 20, 20);
        popup.scheduleShow('third', 30, 30);
        // Each call clears the previous timer, so only one is pending.
        expect(fake.timers.size).toBe(1);

        fake.flush();
        expect(popup.element.textContent).toBe('third');
        popup.dispose();
    });

    it('hide() cancels a pending scheduled show', () => {
        const fake = makeFakeTimers();
        const popup = attachPopup(host, {
            timers: { setTimeout: fake.setTimeout, clearTimeout: fake.clearTimeout },
            getViewport: () => ({ width: 1000, height: 800 })
        });

        popup.scheduleShow('payload', 100, 100);
        expect(fake.timers.size).toBe(1);
        popup.hide();
        expect(fake.timers.size).toBe(0);

        // Even if a stale timer somehow fired, hide() leaves the popup
        // hidden.
        fake.flush();
        expect(popup.element.style.display).toBe('none');
        popup.dispose();
    });

    it('hide() after show() hides immediately (no debounce on the hide side)', () => {
        const popup = attachPopup(host, {
            getViewport: () => ({ width: 1000, height: 800 })
        });
        popup.show('payload', 100, 100);
        expect(popup.element.style.display).toBe('block');
        popup.hide();
        expect(popup.element.style.display).toBe('none');
        popup.dispose();
    });

    it('dispose() removes the element and is idempotent', () => {
        const popup = attachPopup(host);
        const el = popup.element;
        popup.dispose();
        expect(el.parentNode).toBeNull();
        // Second dispose is a no-op.
        expect(() => popup.dispose()).not.toThrow();
    });

    it('post-dispose, show() / scheduleShow() are no-ops', () => {
        const fake = makeFakeTimers();
        const popup = attachPopup(host, {
            timers: { setTimeout: fake.setTimeout, clearTimeout: fake.clearTimeout },
            getViewport: () => ({ width: 1000, height: 800 })
        });
        popup.dispose();
        popup.show('x', 0, 0);
        popup.scheduleShow('y', 0, 0);
        expect(fake.timers.size).toBe(0);
    });
});

describe('renderHighlightedJson', () => {
    it('preserves pretty-print whitespace while applying JSON token classes', () => {
        const pre = document.createElement('pre');
        const formatted = '{\n  "items": [\n    1,\n    2\n  ]\n}';

        renderHighlightedJson(pre, formatted);

        expect(pre.textContent).toBe(formatted);
        expect(pre.querySelector('.jl-tok-key')?.textContent).toBe('"items"');
        expect(pre.querySelectorAll('.jl-tok-number')).toHaveLength(2);
    });
});
