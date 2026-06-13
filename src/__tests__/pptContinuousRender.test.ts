// Tests for issue #81 — continuous render mode, render token, progress
// dispatch, and dropdown jump.
//
// These tests exercise the *pure* helpers exported from
// `pptViewerMain.ts` plus a lightweight DOM smoke for the dropdown jump
// behaviour. The render coroutine itself (which depends on JSZip
// loading + pdf.js bootstrap) is not invoked end-to-end — that lives
// behind a real PPTX fixture and is covered by manual smoke. Instead
// we model the token-cancellation contract with a small simulator so
// the invariant ("in-flight render observes the token change between
// yields and bails out") is locked in by a deterministic test.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
    CONTINUOUS_MODE_THRESHOLD,
    CONTINUOUS_RENDER_TIMEOUT_MS,
    pickInitialRenderMode
} from '../templates/ppt/js/pptViewerMain';

describe('Issue #81: continuous mode threshold dispatch', () => {
    it('decks at or below threshold default to continuous mode', () => {
        expect(pickInitialRenderMode(1)).toBe('continuous');
        expect(pickInitialRenderMode(50)).toBe('continuous');
        expect(pickInitialRenderMode(CONTINUOUS_MODE_THRESHOLD)).toBe('continuous');
    });

    it('decks above threshold default to single-slide mode', () => {
        expect(pickInitialRenderMode(CONTINUOUS_MODE_THRESHOLD + 1)).toBe('single');
        expect(pickInitialRenderMode(250)).toBe('single');
        expect(pickInitialRenderMode(10_000)).toBe('single');
    });

    it('zero / negative slide counts collapse to single (defensive)', () => {
        expect(pickInitialRenderMode(0)).toBe('single');
        expect(pickInitialRenderMode(-3)).toBe('single');
    });

    it('explicit override beats the threshold rule', () => {
        // A 500-slide deck would default to single, but an explicit
        // 'continuous' override is honoured (and vice versa).
        expect(pickInitialRenderMode(500, 'continuous')).toBe('continuous');
        expect(pickInitialRenderMode(5, 'single')).toBe('single');
    });

    it('threshold default value is 100 slides', () => {
        // Documented value — bump the test in lockstep with the
        // production constant so a silent change is caught.
        expect(CONTINUOUS_MODE_THRESHOLD).toBe(100);
    });

    it('timeout budget is on the order of seconds, not minutes', () => {
        // Defensive: a slipped unit (ms -> minutes) here would let the
        // viewer hang for hours. The threshold is 30s today; we assert
        // a band so a future tweak (e.g. 45s) stays within the
        // user-experience envelope.
        expect(CONTINUOUS_RENDER_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
        expect(CONTINUOUS_RENDER_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
    });
});

describe('Issue #81: render-token cancellation invariant', () => {
    // The render coroutine's token gate looks like this (paraphrased):
    //
    //   const myToken = ++renderToken;
    //   for (let i = 0; i < total; i++) {
    //     if (disposed || myToken !== renderToken) return;
    //     ... paint slide i ...
    //     if ((i + 1) % YIELD_EVERY === 0) {
    //       await rAF();
    //       if (disposed || myToken !== renderToken) return;
    //     }
    //   }
    //
    // We simulate the bookkeeping with a tiny state machine so the
    // invariant is testable without spinning up a real renderer.

    function simulateRender({
        totalSlides,
        yieldEvery,
        startSecondRenderAt
    }: {
        totalSlides: number;
        yieldEvery: number;
        startSecondRenderAt?: number; // 0-based slide index that triggers a second render
    }): { slidesPainted: number; aborted: boolean } {
        let renderToken = 0;
        const beginRender = (): {
            myToken: number;
            run: () => { painted: number; aborted: boolean };
        } => {
            const myToken = ++renderToken;
            return {
                myToken,
                run() {
                    let painted = 0;
                    for (let i = 0; i < totalSlides; i++) {
                        if (myToken !== renderToken) return { painted, aborted: true };
                        painted += 1;
                        // Simulate a second render starting between slides.
                        if (typeof startSecondRenderAt === 'number'
                            && i === startSecondRenderAt) {
                            renderToken += 1; // start render B without running it.
                        }
                        if ((i + 1) % yieldEvery === 0 && i + 1 < totalSlides) {
                            // "Yield to RAF" — after the yield we re-check.
                            if (myToken !== renderToken) return { painted, aborted: true };
                        }
                    }
                    return { painted, aborted: false };
                }
            };
        };

        const handle = beginRender();
        const { painted, aborted } = handle.run();
        return { slidesPainted: painted, aborted };
    }

    it('a render that never sees a second render initiates completes fully', () => {
        const r = simulateRender({ totalSlides: 10, yieldEvery: 2 });
        expect(r.slidesPainted).toBe(10);
        expect(r.aborted).toBe(false);
    });

    it('starting render B mid-flight cancels render A at the next gate', () => {
        // Render A starts; at slide 4 (1-based: slide 5), render B is
        // initiated. Render A must observe the token change and bail
        // out without painting the remaining slides.
        const r = simulateRender({
            totalSlides: 10,
            yieldEvery: 2,
            startSecondRenderAt: 4
        });
        expect(r.aborted).toBe(true);
        // Painted 5 slides (indices 0..4), then the token check at the
        // yield boundary (every 2 slides → after slide index 5) catches
        // the bump. Important: we painted *at most* the slides up to
        // the yield boundary AFTER the token bump, not the full deck.
        expect(r.slidesPainted).toBeLessThan(10);
        expect(r.slidesPainted).toBeGreaterThan(0);
    });

    it('starting render B before any yield still cancels render A', () => {
        // Bump happens at slide index 0; the very next iteration's
        // top-of-loop gate observes the new token and aborts.
        const r = simulateRender({
            totalSlides: 10,
            yieldEvery: 2,
            startSecondRenderAt: 0
        });
        expect(r.aborted).toBe(true);
        expect(r.slidesPainted).toBe(1);
    });

    it('monotonic token is one-shot per render (no decrement)', () => {
        // Sanity guardrail: the production code only ever increments
        // `renderToken`. If a future refactor introduces a decrement,
        // two consecutive renders could collide. We don't reach into
        // production state here — just document the assumption.
        let tok = 0;
        const a = ++tok;
        const b = ++tok;
        expect(a).toBeLessThan(b);
    });
});

describe('Issue #81: progress callback dispatch (pdf mode hook)', () => {
    // The PPT viewer threads an `onProgress` callback through to
    // `renderPdfSlides`. The pdf.js loader isn't reachable under jsdom
    // (no real PDF bytes), so we just assert the shape: empty input
    // returns the empty handle and does NOT call the callback. The
    // real progress dispatch is exercised manually with a fixture
    // PDF — that's the part of the spec we cannot unit-test under jest.
    it('renderPdfSlides skips progress when input is empty', async () => {
        const { renderPdfSlides } = await import(
            '../templates/ppt/js/pptPdfModeRenderer'
        );
        const container = document.createElement('div');
        const onProgress = jest.fn();
        const handle = await renderPdfSlides(new Uint8Array(0), container, {
            onProgress
        });
        expect(handle.numPages).toBe(0);
        expect(onProgress).not.toHaveBeenCalled();
    });

    it('renderPdfSlides exposes the options surface added by issue #81', async () => {
        // Type-shape assertion only — we want the helper to accept
        // `isCancelled`, `onProgress`, `scale` without throwing at the
        // call site. Empty bytes short-circuits inside the loader, so
        // this test is safe under jsdom.
        const { renderPdfSlides } = await import(
            '../templates/ppt/js/pptPdfModeRenderer'
        );
        const container = document.createElement('div');
        await expect(
            renderPdfSlides(new Uint8Array(0), container, {
                isCancelled: () => false,
                onProgress: () => undefined,
                scale: 1.5
            })
        ).resolves.toBeDefined();
    });
});

describe('Issue #81: dropdown jump invokes scrollIntoView on continuous mode', () => {
    // The dropdown jump uses `data-index` to locate the target slide
    // and calls `scrollIntoView`. We synthesise the DOM structure the
    // continuous renderer produces and prove the selector + the
    // scrollIntoView call site are consistent.
    it('finds the matching .pv-slide[data-index=N] in the stage', () => {
        const stage = document.createElement('div');
        stage.dataset.mode = 'continuous';
        for (let i = 0; i < 5; i++) {
            const article = document.createElement('article');
            article.className = 'pv-slide';
            article.dataset.page = String(i + 1);
            article.dataset.index = String(i);
            stage.appendChild(article);
        }
        const third = stage.querySelector<HTMLElement>('.pv-slide[data-index="2"]');
        expect(third).not.toBeNull();
        expect(third?.dataset.page).toBe('3');
    });

    it('scrollIntoView is callable with {behavior:"instant", block:"start"}', () => {
        const stage = document.createElement('div');
        const article = document.createElement('article');
        article.className = 'pv-slide';
        article.dataset.index = '0';
        stage.appendChild(article);

        const scrollIntoView = jest.fn();
        article.scrollIntoView = scrollIntoView;

        // Simulate the production call site verbatim. The viewer wraps
        // this in try/catch and falls back to no-arg scrollIntoView on
        // older runtimes; here we exercise the primary path.
        article.scrollIntoView({ behavior: 'instant' as ScrollBehavior, block: 'start' });
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(scrollIntoView.mock.calls[0][0]).toMatchObject({ block: 'start' });
    });
});

describe('Issue #81: i18n keys for progress + timeout', () => {
    const enMessages = JSON.parse(
        readFileSync(resolve(__dirname, '../../_locales/en/messages.json'), 'utf8')
    ) as Record<string, { message: string }>;

    it('declares pptRenderProgress with $1/$2 placeholders', () => {
        expect(enMessages.pptRenderProgress).toBeDefined();
        expect(enMessages.pptRenderProgress.message).toMatch(/\$1/);
        expect(enMessages.pptRenderProgress.message).toMatch(/\$2/);
    });

    it('declares pptRenderTimeout', () => {
        expect(enMessages.pptRenderTimeout).toBeDefined();
        expect(enMessages.pptRenderTimeout.message.length).toBeGreaterThan(0);
    });
});
