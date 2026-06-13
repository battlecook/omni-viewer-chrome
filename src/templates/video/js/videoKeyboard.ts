// Keyboard-shortcut routing for the video viewer (issue #31).
//
// The video viewer's shortcut surface is small but has two failure modes worth
// keeping pure-testable:
//
//   1. Shortcuts must NOT fire when the user is typing in a form control or a
//      contenteditable element. The video viewer itself ships no inputs today,
//      but it can be embedded inside hosts that do (split panes, search bars,
//      etc.), and the contract for #31 explicitly forbids hijacking those
//      keystrokes.
//   2. The mapping from physical key -> logical action needs to stay in sync
//      with the issue spec (Space / Arrow / F / M / + / -).
//
// Both concerns are handled by `routeKeyboardEvent`, which is a pure function
// over `KeyboardEvent` -> `ShortcutAction | null` that the orchestration layer
// (`videoViewerMain.ts`) wires to a document-level `keydown` listener. The
// side-effects (play/pause, fullscreen, mute, volume, seek) live in
// `applyShortcutAction` and are exercised at runtime against a real
// `HTMLVideoElement` — never inside this module's pure router so that
// `videoKeyboard.test.ts` can run under jest+jsdom without mocking the media
// pipeline.
//
// Intentional non-goals:
//   - This module does not own any state. Volume / mute toggling reads & writes
//     the `<video>` element directly. The orchestration layer owns the
//     volume slider; it stays in sync via the `volumechange` event the
//     `<video>` element fires natively.
//   - Repeat-key handling is intentionally not deduped: holding `+` should
//     keep ramping volume up, holding `→` should keep seeking. The browser's
//     native key-repeat cadence is fine for both.

/**
 * Logical actions emitted by the keyboard router. The orchestration layer
 * decides what each one does on the live `<video>` element.
 *
 * `seek` carries a `delta` in seconds (positive = forward). `volume` carries
 * a `delta` in 0..1 increments (positive = louder). All other actions are
 * parameterless toggles.
 */
export type ShortcutAction =
    | { kind: 'play-toggle' }
    | { kind: 'seek'; delta: number }
    | { kind: 'fullscreen-toggle' }
    | { kind: 'mute-toggle' }
    | { kind: 'volume'; delta: number };

/** Forward / backward arrow seek size, in seconds (issue #31 spec: ±5s). */
export const ARROW_SEEK_SECONDS = 5;

/** `+` / `-` volume step, in 0..1 (issue #31 spec: ±0.1). */
export const VOLUME_STEP = 0.1;

/**
 * Returns true when the keyboard event originated from a form control or a
 * contenteditable element. Such targets must completely bypass the video
 * shortcut router (issue #31 DoD).
 *
 * The check looks at:
 *   - `<input>` (any type — including buttons; we'd rather over-skip than
 *     accidentally hijack a focused button's space key)
 *   - `<textarea>`
 *   - `<select>`
 *   - any element with `contenteditable=""` / `"true"` (also descendants
 *     inherit via `isContentEditable`)
 *
 * Exported for unit tests in `videoKeyboard.test.ts`.
 */
export function isInputLikeTarget(target: EventTarget | null): boolean {
    if (!target) return false;
    // `EventTarget` has no `nodeType`; we need an Element for tag inspection.
    // Duck-type instead of `instanceof HTMLElement` so the function works
    // when called from a different realm (jsdom, iframes).
    const el = target as Partial<HTMLElement> & {
        tagName?: string;
        isContentEditable?: boolean;
        getAttribute?: (name: string) => string | null;
    };
    const tag = (el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        return true;
    }
    // Real browsers expose `isContentEditable` as a derived boolean. jsdom
    // doesn't implement it for elements that pick up editability via the
    // `contenteditable` attribute, so we also check the attribute directly.
    // The attribute string is `""` (shorthand for `true`) or `"true"` when
    // editing is enabled; `"false"` / `"inherit"` / missing means not.
    if (el.isContentEditable === true) {
        return true;
    }
    if (typeof el.getAttribute === 'function') {
        const attr = el.getAttribute('contenteditable');
        if (attr !== null && attr !== 'false' && attr !== 'inherit') {
            return true;
        }
    }
    return false;
}

/**
 * Pure routing: classify a `KeyboardEvent` into a `ShortcutAction`, or return
 * `null` when the event should be ignored (input-like target, or an unmapped
 * key, or a key combined with a modifier).
 *
 * Modifier policy: shortcuts are only handled with bare keys. Holding Ctrl /
 * Alt / Meta means the user is invoking a browser / OS shortcut and the
 * router stays out of the way. Shift is allowed for the `+` key (which on
 * many layouts is `Shift + =`).
 */
export function routeKeyboardEvent(e: KeyboardEvent): ShortcutAction | null {
    if (isInputLikeTarget(e.target)) return null;

    // Don't trample browser/OS shortcuts. Shift is permissively allowed
    // because `+` on US/QWERTY is literally `Shift+=`.
    if (e.ctrlKey || e.altKey || e.metaKey) return null;

    switch (e.key) {
        case ' ':
        case 'Spacebar': // legacy IE/Edge name; harmless to keep
            return { kind: 'play-toggle' };
        case 'ArrowLeft':
            return { kind: 'seek', delta: -ARROW_SEEK_SECONDS };
        case 'ArrowRight':
            return { kind: 'seek', delta: +ARROW_SEEK_SECONDS };
        case 'f':
        case 'F':
            return { kind: 'fullscreen-toggle' };
        case 'm':
        case 'M':
            return { kind: 'mute-toggle' };
        case '+':
        case '=': // many keyboards produce `=` without Shift; treat as +
            return { kind: 'volume', delta: +VOLUME_STEP };
        case '-':
        case '_':
            return { kind: 'volume', delta: -VOLUME_STEP };
        default:
            return null;
    }
}

/**
 * Clamp a 0..1 volume value, defending against floating-point drift after
 * repeated +0.1 / -0.1 increments. Exported so the tests can pin down the
 * boundary behaviour.
 */
export function clampVolume(v: number): number {
    if (!Number.isFinite(v)) return 0;
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
}

/**
 * Compute the new time after a seek, clamped into `[0, duration]`. Exported
 * so the tests can verify the clamp without a real `<video>` element.
 *
 * Mirrors `clampTime` in `videoUtils.ts` but is local to this module so the
 * router stays self-contained (and so a future change to the seek clamp
 * policy here doesn't accidentally regress the ±10s skip buttons, which use
 * `clampTime`).
 */
export function computeSeekTarget(
    currentTime: number,
    delta: number,
    duration: number
): number {
    const t = (Number.isFinite(currentTime) ? currentTime : 0) + delta;
    if (!Number.isFinite(t)) return 0;
    if (t < 0) return 0;
    if (!Number.isFinite(duration) || duration <= 0) {
        // No metadata yet — only clamp the lower bound.
        return Math.max(0, t);
    }
    if (t > duration) return duration;
    return t;
}

/**
 * Side-effecting application of a `ShortcutAction` onto a `<video>` element.
 *
 * Kept separate from `routeKeyboardEvent` so the pure router can be tested
 * in isolation. The play / fullscreen calls return promises that we
 * intentionally swallow with `void` — the orchestration layer's existing
 * play-error path (the inline error strip) already handles autoplay /
 * codec failures, and fullscreen errors are non-fatal (the user simply
 * stays windowed).
 */
export function applyShortcutAction(
    action: ShortcutAction,
    video: HTMLVideoElement
): void {
    switch (action.kind) {
        case 'play-toggle': {
            if (video.paused || video.ended) {
                void video.play().catch((err) => {
                    console.error('video play failed:', err);
                });
            } else {
                video.pause();
            }
            return;
        }
        case 'seek': {
            video.currentTime = computeSeekTarget(
                video.currentTime,
                action.delta,
                video.duration
            );
            return;
        }
        case 'fullscreen-toggle': {
            const doc = video.ownerDocument || document;
            const fsElement = (doc as Document & {
                fullscreenElement?: Element | null;
            }).fullscreenElement;
            if (fsElement) {
                // Either the video itself or some ancestor is fullscreen;
                // either way, exiting is the user's intent.
                void doc.exitFullscreen?.().catch((err) => {
                    console.error('exitFullscreen failed:', err);
                });
            } else {
                void video.requestFullscreen?.().catch((err) => {
                    console.error('requestFullscreen failed:', err);
                });
            }
            return;
        }
        case 'mute-toggle': {
            video.muted = !video.muted;
            return;
        }
        case 'volume': {
            // Reading `video.volume` returns 0 when muted in some browsers
            // (it doesn't — it preserves the underlying value). We base off
            // the raw volume so consecutive `+` presses while muted still
            // ramp the underlying level; on the next unmute the user hears
            // what they expect.
            const next = clampVolume(video.volume + action.delta);
            video.volume = next;
            // Implicit unmute when the user explicitly raises volume from
            // zero. Matches the volume-slider behaviour in the orchestrator.
            if (video.muted && action.delta > 0 && next > 0) {
                video.muted = false;
            }
            return;
        }
        default: {
            // Exhaustiveness guard.
            const _never: never = action;
            void _never;
        }
    }
}
