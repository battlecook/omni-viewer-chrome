// AudioContextManager — owns the WebAudio context lifecycle.
//
// Port of vscode-omni-viewer's AudioController/managers/AudioContextManager.js.
// Behavior is unchanged; the only port-level differences are TypeScript types
// and the use of the cross-browser context constructor without referencing
// `(window as any).webkitAudioContext`.

import type { AudioControllerState } from './types';
import { AudioUtils } from '../utils/AudioUtils';

interface WebkitAudioContextWindow extends Window {
    webkitAudioContext?: typeof AudioContext;
}

function getAudioContextCtor(): typeof AudioContext | undefined {
    if (typeof window === 'undefined') return undefined;
    return (
        window.AudioContext ||
        (window as WebkitAudioContextWindow).webkitAudioContext
    );
}

export class AudioContextManager {
    private readonly state: AudioControllerState;

    constructor(state: AudioControllerState) {
        this.state = state;
    }

    /**
     * Create or resume the page's WebAudio context. Idempotent — safe to
     * call multiple times.
     */
    async initialize(): Promise<void> {
        if (this.state.audioContextInitialized) return;

        try {
            const Ctor = getAudioContextCtor();
            if (!Ctor) {
                throw new Error('AudioContext is not available in this browser');
            }
            const ctx = new Ctor();
            if (ctx.state === 'suspended') {
                await ctx.resume();
            }
            this.state.audioContextInitialized = true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('Failed to initialize AudioContext:', error);
            AudioUtils.showStatus(
                'AudioContext initialization failed: ' + message,
                this.state.elements.status
            );
        }
    }

    /**
     * Best-effort access to the AudioContext WaveSurfer is using. Returns
     * `null` when the wavesurfer instance hasn't created one yet (which is
     * the case for the MediaElement backend used in precomputed/streaming
     * mode).
     */
    getWaveSurferAudioContext(): AudioContext | null {
        try {
            const ctx = this.state.wavesurfer?.backend?.audioContext;
            return ctx ?? null;
        } catch (error) {
            console.error('Error getting WaveSurfer AudioContext:', error);
            return null;
        }
    }

    checkState(): AudioContextState | null {
        const ctx = this.getWaveSurferAudioContext();
        return ctx ? ctx.state : null;
    }
}
