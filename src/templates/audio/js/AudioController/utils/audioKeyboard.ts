// Keyboard-shortcut routing for the audio viewer (issue #27).
//
// Mirrors the videoKeyboard.ts pattern (issue #31): a pure router maps a
// `KeyboardEvent` to a logical `AudioShortcutAction`, and a side-effect
// dispatcher applies the action against a small handle of audio "things"
// (waveform, regions, zoom, loop checkbox).
//
// Why a separate module:
//   - The EventManager owns the document-level listener, but the bulk of
//     the logic is pure key->action mapping that we want to unit test
//     without booting WaveSurfer / jsdom audio surfaces.
//   - Keeps the shortcut policy centralized so #25 (playback speed) and
//     #27 (this issue) don't accidentally fight over the same bindings.
//
// Modifier policy: only bare keys are handled. Holding Ctrl / Alt / Meta
// means the user is invoking a browser/OS shortcut. Shift IS a meaningful
// modifier here — `Shift+ArrowLeft` is the fine-grained ±0.5s seek.

/**
 * Logical actions emitted by the audio keyboard router.
 *
 * - `play-toggle`        : Space — clicks the play/pause button.
 * - `seek` (±5s, ±0.5s)  : Arrow / Shift+Arrow — relative seek in seconds.
 * - `zoom` (+1 / -1)     : `+` / `-` — clicks the zoom-in / zoom-out button
 *                          (the discrete factor matches what those buttons do).
 * - `loop-toggle`        : `L` — toggle the loop checkbox + state flag.
 */
export type AudioShortcutAction =
    | { kind: 'play-toggle' }
    | { kind: 'seek'; delta: number }
    | { kind: 'zoom'; direction: 1 | -1 }
    | { kind: 'loop-toggle' };

/** Coarse seek size for `ArrowLeft` / `ArrowRight`, in seconds. */
export const ARROW_SEEK_SECONDS = 5;
/** Fine seek size for `Shift+ArrowLeft` / `Shift+ArrowRight`, in seconds. */
export const SHIFT_ARROW_SEEK_SECONDS = 0.5;

/**
 * Returns true when the keyboard event originated from a form control or
 * contenteditable element. Such targets must completely bypass the audio
 * shortcut router (issue #27 DoD step 5).
 *
 * Mirrors `videoKeyboard.isInputLikeTarget` so the two viewers stay
 * consistent without sharing an import (the audio + video bundles are
 * separate webpack chunks and we don't want one to drag in the other).
 */
export function isInputLikeTarget(target: EventTarget | null): boolean {
    if (!target) return false;
    const el = target as Partial<HTMLElement> & {
        tagName?: string;
        isContentEditable?: boolean;
        getAttribute?: (name: string) => string | null;
    };
    const tag = (el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        return true;
    }
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
 * Pure routing: classify a `KeyboardEvent` into an `AudioShortcutAction` or
 * return `null` when the event should be ignored.
 *
 * Returning `null` covers four cases:
 *   1. The target is an input / textarea / select / contenteditable — the
 *      user is typing.
 *   2. The event carries Ctrl / Alt / Meta — that's a browser/OS shortcut,
 *      not ours.
 *   3. The key is unmapped.
 *   4. A `+` / `-` arrived as `Shift+=` etc. that we don't support.
 */
export function routeKeyboardEvent(e: KeyboardEvent): AudioShortcutAction | null {
    if (isInputLikeTarget(e.target)) return null;
    if (e.ctrlKey || e.altKey || e.metaKey) return null;

    switch (e.key) {
        case ' ':
        case 'Spacebar':
            return { kind: 'play-toggle' };
        case 'ArrowLeft': {
            const delta = e.shiftKey
                ? -SHIFT_ARROW_SEEK_SECONDS
                : -ARROW_SEEK_SECONDS;
            return { kind: 'seek', delta };
        }
        case 'ArrowRight': {
            const delta = e.shiftKey
                ? +SHIFT_ARROW_SEEK_SECONDS
                : +ARROW_SEEK_SECONDS;
            return { kind: 'seek', delta };
        }
        case '+':
        case '=':
            return { kind: 'zoom', direction: +1 };
        case '-':
        case '_':
            return { kind: 'zoom', direction: -1 };
        case 'l':
        case 'L':
            return { kind: 'loop-toggle' };
        default:
            return null;
    }
}

/**
 * Compute the new time after a seek, clamped into `[0, duration]`. Exported
 * so unit tests can pin down the boundary behaviour without driving a real
 * WaveSurfer instance.
 *
 * Mirrors `videoKeyboard.computeSeekTarget`.
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
        return Math.max(0, t);
    }
    if (t > duration) return duration;
    return t;
}

/**
 * Side-effect handle the audio dispatcher operates on. Kept structural so
 * tests can pass a hand-rolled object without instantiating the real
 * managers / WaveSurfer.
 *
 * Each method is optional — the dispatcher no-ops cleanly if a hook is
 * missing, which keeps the router resilient to phases where (e.g.) the
 * waveform isn't decoded yet.
 */
export interface AudioShortcutHandle {
    /** Returns the current playback time in seconds (0 if unknown). */
    getCurrentTime?: () => number;
    /** Returns the total duration in seconds (NaN/0 if unknown). */
    getDuration?: () => number;
    /** Seek to an absolute time, in seconds. */
    seekTo?: (time: number) => void;
    /** Trigger play/pause via the play button click path. */
    togglePlay?: () => void;
    /** Click the zoom-in button. */
    zoomIn?: () => void;
    /** Click the zoom-out button. */
    zoomOut?: () => void;
    /** Toggle the loop checkbox + propagate to state. */
    toggleLoop?: () => void;
}

/**
 * Apply a routed `AudioShortcutAction` against the supplied handle. Pure
 * dispatcher: no DOM lookups happen here so the test surface is just the
 * handle's recorded calls.
 */
export function applyShortcutAction(
    action: AudioShortcutAction,
    handle: AudioShortcutHandle
): void {
    switch (action.kind) {
        case 'play-toggle': {
            handle.togglePlay?.();
            return;
        }
        case 'seek': {
            const cur = handle.getCurrentTime ? handle.getCurrentTime() : 0;
            const dur = handle.getDuration ? handle.getDuration() : NaN;
            const next = computeSeekTarget(cur, action.delta, dur);
            handle.seekTo?.(next);
            return;
        }
        case 'zoom': {
            if (action.direction > 0) {
                handle.zoomIn?.();
            } else {
                handle.zoomOut?.();
            }
            return;
        }
        case 'loop-toggle': {
            handle.toggleLoop?.();
            return;
        }
        default: {
            const _never: never = action;
            void _never;
        }
    }
}
