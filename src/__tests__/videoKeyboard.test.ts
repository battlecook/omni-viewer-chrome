// Unit tests for the video viewer's keyboard-shortcut router (issue #31).
//
// Coverage targets:
//   1. The router's key -> action mapping table matches the issue spec:
//        Space            -> play-toggle
//        ArrowLeft / Right -> seek -5s / +5s   (different from the ±10s buttons)
//        F                -> fullscreen-toggle
//        M                -> mute-toggle
//        + / -            -> volume ±0.1
//   2. ALL shortcuts are inert when the keyboard event originates inside a
//      form control (`<input>` / `<textarea>` / `<select>`) or a
//      contenteditable element. This is the issue #31 DoD's "must not
//      hijack typing" clause.
//   3. Keys combined with Ctrl / Alt / Meta (i.e. browser/OS shortcuts) are
//      ignored.
//   4. The supporting math helpers (`clampVolume`, `computeSeekTarget`)
//      saturate at the documented bounds.
//   5. `applyShortcutAction` performs the right side-effect on a
//      lightweight DOM stub (so we do not depend on jsdom's `<video>`
//      surface, which lacks `requestFullscreen` / `play`).
//
// The router itself (`routeKeyboardEvent`) is a pure function over
// `KeyboardEvent`, so the bulk of the file is straight value-in / value-out
// assertions. Side-effect tests construct minimal duck-typed stand-ins for
// `HTMLVideoElement` and verify the right method/property is mutated.
//
// We deliberately do NOT exercise the `mountVideoViewer` document-level
// listener here — that integration is one extra `addEventListener` call
// already covered by reading the orchestration source. The valuable
// regressions live in the pure router and the side-effect dispatcher.

import {
    ARROW_SEEK_SECONDS,
    VOLUME_STEP,
    applyShortcutAction,
    clampVolume,
    computeSeekTarget,
    isInputLikeTarget,
    routeKeyboardEvent,
    type ShortcutAction
} from '../templates/video/js/videoKeyboard';

// --- helpers -------------------------------------------------------------

/**
 * Build a `KeyboardEvent`-shaped object good enough for `routeKeyboardEvent`,
 * which only reads `key`, `target`, and the four modifier flags. We use a
 * cast-through-unknown rather than constructing a real `KeyboardEvent` so
 * the tests don't depend on jsdom's `KeyboardEvent` constructor accepting
 * every option we want to set.
 */
function makeEvent(opts: {
    key: string;
    target?: EventTarget | null;
    ctrlKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
}): KeyboardEvent {
    return {
        key: opts.key,
        target: opts.target ?? null,
        ctrlKey: !!opts.ctrlKey,
        altKey: !!opts.altKey,
        metaKey: !!opts.metaKey,
        shiftKey: !!opts.shiftKey,
        preventDefault: () => {},
        stopPropagation: () => {}
    } as unknown as KeyboardEvent;
}

/** Build a non-input element target the router should NOT skip. */
function makeDivTarget(): EventTarget {
    const el = document.createElement('div');
    return el;
}

// --- ARROW_SEEK_SECONDS / VOLUME_STEP constants --------------------------

describe('videoKeyboard — public constants', () => {
    it('arrow seek is the issue #31 ±5s value', () => {
        expect(ARROW_SEEK_SECONDS).toBe(5);
    });

    it('volume step is the issue #31 ±0.1 value', () => {
        expect(VOLUME_STEP).toBeCloseTo(0.1, 10);
    });
});

// --- isInputLikeTarget ---------------------------------------------------

describe('videoKeyboard — isInputLikeTarget', () => {
    it('returns false for a null target', () => {
        expect(isInputLikeTarget(null)).toBe(false);
    });

    it('returns false for an ordinary <div> element', () => {
        const div = document.createElement('div');
        expect(isInputLikeTarget(div)).toBe(false);
    });

    it('returns true for <input> regardless of type', () => {
        const text = document.createElement('input');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        const button = document.createElement('input');
        button.type = 'button';
        expect(isInputLikeTarget(text)).toBe(true);
        expect(isInputLikeTarget(checkbox)).toBe(true);
        expect(isInputLikeTarget(button)).toBe(true);
    });

    it('returns true for <textarea>', () => {
        const ta = document.createElement('textarea');
        expect(isInputLikeTarget(ta)).toBe(true);
    });

    it('returns true for <select>', () => {
        const sel = document.createElement('select');
        expect(isInputLikeTarget(sel)).toBe(true);
    });

    it('returns true for a contenteditable element', () => {
        const div = document.createElement('div');
        div.setAttribute('contenteditable', 'true');
        // jsdom honors `contenteditable` -> `isContentEditable`.
        expect(isInputLikeTarget(div)).toBe(true);
    });
});

// --- routeKeyboardEvent: key -> action mapping ---------------------------

describe('videoKeyboard — routeKeyboardEvent (key -> action mapping)', () => {
    it('Space maps to play-toggle', () => {
        const action = routeKeyboardEvent(
            makeEvent({ key: ' ', target: makeDivTarget() })
        );
        expect(action).toEqual({ kind: 'play-toggle' });
    });

    it('legacy Spacebar key string also maps to play-toggle', () => {
        const action = routeKeyboardEvent(
            makeEvent({ key: 'Spacebar', target: makeDivTarget() })
        );
        expect(action).toEqual({ kind: 'play-toggle' });
    });

    it('ArrowLeft maps to seek -5', () => {
        const action = routeKeyboardEvent(
            makeEvent({ key: 'ArrowLeft', target: makeDivTarget() })
        );
        expect(action).toEqual({ kind: 'seek', delta: -5 });
    });

    it('ArrowRight maps to seek +5', () => {
        const action = routeKeyboardEvent(
            makeEvent({ key: 'ArrowRight', target: makeDivTarget() })
        );
        expect(action).toEqual({ kind: 'seek', delta: +5 });
    });

    it('arrow seek delta differs from the ±10s skip-button delta', () => {
        // Documented contract from the issue: keyboard arrows are ±5s,
        // skip buttons are ±10s. This test guards against accidentally
        // unifying the two.
        const left = routeKeyboardEvent(
            makeEvent({ key: 'ArrowLeft', target: makeDivTarget() })
        );
        expect(left).not.toEqual({ kind: 'seek', delta: -10 });
        expect(left).toEqual({ kind: 'seek', delta: -ARROW_SEEK_SECONDS });
    });

    it('F (lowercase) maps to fullscreen-toggle', () => {
        const action = routeKeyboardEvent(
            makeEvent({ key: 'f', target: makeDivTarget() })
        );
        expect(action).toEqual({ kind: 'fullscreen-toggle' });
    });

    it('F (uppercase) maps to fullscreen-toggle', () => {
        const action = routeKeyboardEvent(
            makeEvent({ key: 'F', target: makeDivTarget(), shiftKey: true })
        );
        expect(action).toEqual({ kind: 'fullscreen-toggle' });
    });

    it('M (lowercase) maps to mute-toggle', () => {
        const action = routeKeyboardEvent(
            makeEvent({ key: 'm', target: makeDivTarget() })
        );
        expect(action).toEqual({ kind: 'mute-toggle' });
    });

    it('M (uppercase) maps to mute-toggle', () => {
        const action = routeKeyboardEvent(
            makeEvent({ key: 'M', target: makeDivTarget(), shiftKey: true })
        );
        expect(action).toEqual({ kind: 'mute-toggle' });
    });

    it('+ maps to volume +0.1', () => {
        const action = routeKeyboardEvent(
            makeEvent({ key: '+', target: makeDivTarget(), shiftKey: true })
        );
        expect(action).toEqual({ kind: 'volume', delta: VOLUME_STEP });
    });

    it('= (Shift not held on most layouts) maps to volume +0.1', () => {
        // On US/QWERTY, the `+` key requires Shift; treating bare `=` as
        // the same shortcut means users do not need to hold Shift to raise
        // volume. This mirrors common video-player UX.
        const action = routeKeyboardEvent(
            makeEvent({ key: '=', target: makeDivTarget() })
        );
        expect(action).toEqual({ kind: 'volume', delta: VOLUME_STEP });
    });

    it('- maps to volume -0.1', () => {
        const action = routeKeyboardEvent(
            makeEvent({ key: '-', target: makeDivTarget() })
        );
        expect(action).toEqual({ kind: 'volume', delta: -VOLUME_STEP });
    });

    it('_ (Shift+-) maps to volume -0.1', () => {
        const action = routeKeyboardEvent(
            makeEvent({ key: '_', target: makeDivTarget(), shiftKey: true })
        );
        expect(action).toEqual({ kind: 'volume', delta: -VOLUME_STEP });
    });

    it('returns null for unmapped keys', () => {
        for (const key of ['a', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'Tab']) {
            expect(
                routeKeyboardEvent(makeEvent({ key, target: makeDivTarget() }))
            ).toBeNull();
        }
    });
});

// --- routeKeyboardEvent: input-like targets ------------------------------

describe('videoKeyboard — routeKeyboardEvent (input-like targets)', () => {
    const triggers: ReadonlyArray<{ name: string; key: string }> = [
        { name: 'Space', key: ' ' },
        { name: 'ArrowLeft', key: 'ArrowLeft' },
        { name: 'ArrowRight', key: 'ArrowRight' },
        { name: 'f', key: 'f' },
        { name: 'F', key: 'F' },
        { name: 'm', key: 'm' },
        { name: 'M', key: 'M' },
        { name: '+', key: '+' },
        { name: '-', key: '-' },
        { name: '=', key: '=' }
    ];

    function expectAllInert(target: EventTarget): void {
        for (const t of triggers) {
            const action = routeKeyboardEvent(
                makeEvent({ key: t.key, target })
            );
            // `${t.name} should be inert when target is input-like`
            expect(action).toBeNull();
        }
    }

    it('returns null for ALL shortcuts when target is <input>', () => {
        expectAllInert(document.createElement('input'));
    });

    it('returns null for ALL shortcuts when target is <textarea>', () => {
        expectAllInert(document.createElement('textarea'));
    });

    it('returns null for ALL shortcuts when target is <select>', () => {
        expectAllInert(document.createElement('select'));
    });

    it('returns null for ALL shortcuts when target is contenteditable', () => {
        const div = document.createElement('div');
        div.setAttribute('contenteditable', 'true');
        expectAllInert(div);
    });
});

// --- routeKeyboardEvent: modifier policy ---------------------------------

describe('videoKeyboard — routeKeyboardEvent (modifier keys)', () => {
    it('ignores Ctrl-combinations (browser shortcuts)', () => {
        expect(
            routeKeyboardEvent(
                makeEvent({ key: 'f', target: makeDivTarget(), ctrlKey: true })
            )
        ).toBeNull();
        expect(
            routeKeyboardEvent(
                makeEvent({
                    key: 'ArrowLeft',
                    target: makeDivTarget(),
                    ctrlKey: true
                })
            )
        ).toBeNull();
    });

    it('ignores Alt-combinations', () => {
        expect(
            routeKeyboardEvent(
                makeEvent({ key: ' ', target: makeDivTarget(), altKey: true })
            )
        ).toBeNull();
    });

    it('ignores Meta (Cmd) combinations', () => {
        expect(
            routeKeyboardEvent(
                makeEvent({ key: 'm', target: makeDivTarget(), metaKey: true })
            )
        ).toBeNull();
    });

    it('still routes shifted keys (Shift+= -> +)', () => {
        const action = routeKeyboardEvent(
            makeEvent({ key: '+', target: makeDivTarget(), shiftKey: true })
        );
        expect(action).toEqual({ kind: 'volume', delta: VOLUME_STEP });
    });
});

// --- clampVolume ---------------------------------------------------------

describe('videoKeyboard — clampVolume', () => {
    it('passes through in-range values', () => {
        expect(clampVolume(0)).toBe(0);
        expect(clampVolume(0.5)).toBe(0.5);
        expect(clampVolume(1)).toBe(1);
    });

    it('clamps at 0 below zero', () => {
        expect(clampVolume(-0.1)).toBe(0);
        expect(clampVolume(-99)).toBe(0);
    });

    it('clamps at 1 above one', () => {
        expect(clampVolume(1.1)).toBe(1);
        expect(clampVolume(99)).toBe(1);
    });

    it('returns 0 for non-finite input', () => {
        expect(clampVolume(Number.NaN)).toBe(0);
        expect(clampVolume(Number.POSITIVE_INFINITY)).toBe(0);
        expect(clampVolume(Number.NEGATIVE_INFINITY)).toBe(0);
    });
});

// --- computeSeekTarget ---------------------------------------------------

describe('videoKeyboard — computeSeekTarget', () => {
    it('clamps to 0 when going negative', () => {
        expect(computeSeekTarget(2, -5, 60)).toBe(0);
    });

    it('clamps to duration when going past the end', () => {
        expect(computeSeekTarget(58, +5, 60)).toBe(60);
    });

    it('passes through values inside the playable range', () => {
        expect(computeSeekTarget(10, +5, 60)).toBe(15);
        expect(computeSeekTarget(10, -5, 60)).toBe(5);
    });

    it('treats non-finite currentTime as 0', () => {
        expect(computeSeekTarget(Number.NaN, +5, 60)).toBe(5);
    });

    it('without a known duration only clamps the lower bound', () => {
        expect(computeSeekTarget(0, -5, Number.NaN)).toBe(0);
        expect(computeSeekTarget(123, +5, Number.NaN)).toBe(128);
    });
});

// --- applyShortcutAction -------------------------------------------------

/**
 * Build a duck-typed `<video>` stub with spies on the methods our dispatcher
 * touches. jsdom's HTMLVideoElement does not implement `play` /
 * `requestFullscreen`, so we cannot use a real one.
 */
function makeVideoStub(initial: {
    paused?: boolean;
    ended?: boolean;
    currentTime?: number;
    duration?: number;
    volume?: number;
    muted?: boolean;
}): {
    video: HTMLVideoElement;
    playSpy: jest.Mock;
    pauseSpy: jest.Mock;
    requestFullscreenSpy: jest.Mock;
    exitFullscreenSpy: jest.Mock;
    state: {
        paused: boolean;
        ended: boolean;
        currentTime: number;
        duration: number;
        volume: number;
        muted: boolean;
        fullscreenElement: Element | null;
    };
} {
    const playSpy = jest.fn().mockResolvedValue(undefined);
    const pauseSpy = jest.fn();
    const requestFullscreenSpy = jest.fn().mockResolvedValue(undefined);
    const exitFullscreenSpy = jest.fn().mockResolvedValue(undefined);

    const state = {
        paused: initial.paused ?? true,
        ended: initial.ended ?? false,
        currentTime: initial.currentTime ?? 0,
        duration: initial.duration ?? 60,
        volume: initial.volume ?? 1,
        muted: initial.muted ?? false,
        fullscreenElement: null as Element | null
    };

    const video: Partial<HTMLVideoElement> & {
        ownerDocument: Document;
    } = {
        get paused() {
            return state.paused;
        },
        get ended() {
            return state.ended;
        },
        get currentTime() {
            return state.currentTime;
        },
        set currentTime(v: number) {
            state.currentTime = v;
        },
        get duration() {
            return state.duration;
        },
        get volume() {
            return state.volume;
        },
        set volume(v: number) {
            state.volume = v;
        },
        get muted() {
            return state.muted;
        },
        set muted(v: boolean) {
            state.muted = v;
        },
        play: playSpy as unknown as HTMLVideoElement['play'],
        pause: pauseSpy as unknown as HTMLVideoElement['pause'],
        requestFullscreen:
            requestFullscreenSpy as unknown as HTMLVideoElement['requestFullscreen'],
        ownerDocument: {
            get fullscreenElement() {
                return state.fullscreenElement;
            },
            exitFullscreen: exitFullscreenSpy
        } as unknown as Document
    };

    return {
        video: video as HTMLVideoElement,
        playSpy,
        pauseSpy,
        requestFullscreenSpy,
        exitFullscreenSpy,
        state
    };
}

describe('videoKeyboard — applyShortcutAction', () => {
    it('play-toggle calls play() when paused', () => {
        const stub = makeVideoStub({ paused: true });
        applyShortcutAction({ kind: 'play-toggle' }, stub.video);
        expect(stub.playSpy).toHaveBeenCalledTimes(1);
        expect(stub.pauseSpy).not.toHaveBeenCalled();
    });

    it('play-toggle calls play() when ended', () => {
        const stub = makeVideoStub({ paused: false, ended: true });
        applyShortcutAction({ kind: 'play-toggle' }, stub.video);
        expect(stub.playSpy).toHaveBeenCalledTimes(1);
    });

    it('play-toggle calls pause() when playing', () => {
        const stub = makeVideoStub({ paused: false, ended: false });
        applyShortcutAction({ kind: 'play-toggle' }, stub.video);
        expect(stub.pauseSpy).toHaveBeenCalledTimes(1);
        expect(stub.playSpy).not.toHaveBeenCalled();
    });

    it('seek mutates currentTime by delta and clamps', () => {
        const stub = makeVideoStub({ currentTime: 10, duration: 60 });
        applyShortcutAction({ kind: 'seek', delta: +5 }, stub.video);
        expect(stub.state.currentTime).toBe(15);

        applyShortcutAction({ kind: 'seek', delta: -100 }, stub.video);
        expect(stub.state.currentTime).toBe(0);

        applyShortcutAction({ kind: 'seek', delta: +999 }, stub.video);
        expect(stub.state.currentTime).toBe(60);
    });

    it('mute-toggle flips the muted flag', () => {
        const stub = makeVideoStub({ muted: false });
        applyShortcutAction({ kind: 'mute-toggle' }, stub.video);
        expect(stub.state.muted).toBe(true);
        applyShortcutAction({ kind: 'mute-toggle' }, stub.video);
        expect(stub.state.muted).toBe(false);
    });

    it('volume +0.1 raises and clamps at 1', () => {
        const stub = makeVideoStub({ volume: 0.5 });
        applyShortcutAction({ kind: 'volume', delta: +0.1 }, stub.video);
        expect(stub.state.volume).toBeCloseTo(0.6, 10);

        // Force-clamp at 1.
        for (let i = 0; i < 50; i++) {
            applyShortcutAction({ kind: 'volume', delta: +0.1 }, stub.video);
        }
        expect(stub.state.volume).toBe(1);
    });

    it('volume -0.1 lowers and clamps at 0', () => {
        const stub = makeVideoStub({ volume: 0.2 });
        applyShortcutAction({ kind: 'volume', delta: -0.1 }, stub.video);
        expect(stub.state.volume).toBeCloseTo(0.1, 10);

        for (let i = 0; i < 50; i++) {
            applyShortcutAction({ kind: 'volume', delta: -0.1 }, stub.video);
        }
        expect(stub.state.volume).toBe(0);
    });

    it('volume + while muted implicitly unmutes once volume rises above zero', () => {
        const stub = makeVideoStub({ volume: 0.3, muted: true });
        applyShortcutAction({ kind: 'volume', delta: +0.1 }, stub.video);
        expect(stub.state.muted).toBe(false);
        expect(stub.state.volume).toBeCloseTo(0.4, 10);
    });

    it('volume - while muted does NOT unmute', () => {
        const stub = makeVideoStub({ volume: 0.3, muted: true });
        applyShortcutAction({ kind: 'volume', delta: -0.1 }, stub.video);
        expect(stub.state.muted).toBe(true);
    });

    it('fullscreen-toggle calls requestFullscreen when not in fullscreen', () => {
        const stub = makeVideoStub({});
        applyShortcutAction({ kind: 'fullscreen-toggle' }, stub.video);
        expect(stub.requestFullscreenSpy).toHaveBeenCalledTimes(1);
        expect(stub.exitFullscreenSpy).not.toHaveBeenCalled();
    });

    it('fullscreen-toggle calls exitFullscreen when already in fullscreen', () => {
        const stub = makeVideoStub({});
        // Pretend the video element itself is the active fullscreen element.
        stub.state.fullscreenElement = stub.video as unknown as Element;
        applyShortcutAction({ kind: 'fullscreen-toggle' }, stub.video);
        expect(stub.exitFullscreenSpy).toHaveBeenCalledTimes(1);
        expect(stub.requestFullscreenSpy).not.toHaveBeenCalled();
    });
});

// --- Sanity: full event -> action -> side-effect path --------------------

describe('videoKeyboard — end-to-end key event lands the right side-effect', () => {
    it('Space on a non-input target ultimately calls play()', () => {
        const stub = makeVideoStub({ paused: true });
        const e = makeEvent({ key: ' ', target: makeDivTarget() });
        const action = routeKeyboardEvent(e);
        expect(action).not.toBeNull();
        applyShortcutAction(action as ShortcutAction, stub.video);
        expect(stub.playSpy).toHaveBeenCalledTimes(1);
    });

    it('Space typed into an <input> does NOT call play()', () => {
        const stub = makeVideoStub({ paused: true });
        const input = document.createElement('input');
        const e = makeEvent({ key: ' ', target: input });
        const action = routeKeyboardEvent(e);
        expect(action).toBeNull();
        // No dispatch -> no side-effect.
        expect(stub.playSpy).not.toHaveBeenCalled();
        expect(stub.pauseSpy).not.toHaveBeenCalled();
    });
});
