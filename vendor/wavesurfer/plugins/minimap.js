/**
 * Minimap is a tiny copy of the main waveform serving as a navigation tool.
 */
import BasePlugin from '../base-plugin.js';
import WaveSurfer from '../wavesurfer.js';
import createElement from '../dom.js';
const defaultOptions = {
    height: 50,
    overlayColor: 'rgba(100, 100, 100, 0.1)',
    insertPosition: 'afterend',
};
class MinimapPlugin extends BasePlugin {
    constructor(options) {
        super(options);
        this.miniWavesurfer = null;
        this.miniSubscriptions = [];
        this.container = null;
        this.isInitializing = false;
        this.dragTimeout = null;
        this.options = Object.assign({}, defaultOptions, options);
        this.minimapWrapper = this.initMinimapWrapper();
        this.overlay = this.initOverlay();
    }
    static create(options) {
        return new MinimapPlugin(options);
    }
    /** Called by wavesurfer, don't call manually */
    onInit() {
        var _a, _b;
        if (!this.wavesurfer) {
            throw Error('WaveSurfer is not initialized');
        }
        if (this.options.container) {
            if (typeof this.options.container === 'string') {
                this.container = document.querySelector(this.options.container);
            }
            else if (this.options.container instanceof HTMLElement) {
                this.container = this.options.container;
            }
            (_a = this.container) === null || _a === void 0 ? void 0 : _a.appendChild(this.minimapWrapper);
        }
        else {
            this.container = this.wavesurfer.getWrapper().parentElement;
            (_b = this.container) === null || _b === void 0 ? void 0 : _b.insertAdjacentElement(this.options.insertPosition, this.minimapWrapper);
        }
        this.initWaveSurferEvents();
        Promise.resolve().then(() => {
            this.initMinimap();
        });
    }
    initMinimapWrapper() {
        return createElement('div', {
            part: 'minimap',
            style: {
                position: 'relative',
            },
        });
    }
    initOverlay() {
        return createElement('div', {
            part: 'minimap-overlay',
            style: {
                position: 'absolute',
                zIndex: '2',
                left: '0',
                top: '0',
                bottom: '0',
                transition: 'left 100ms ease-out',
                pointerEvents: 'none',
                backgroundColor: this.options.overlayColor,
            },
        }, this.minimapWrapper);
    }
    initMinimap() {
        // Prevent concurrent initialization
        if (this.isInitializing)
            return;
        this.isInitializing = true;
        this.destroyMinimap();
        if (!this.wavesurfer) {
            this.isInitializing = false;
            return;
        }
        const data = this.wavesurfer.getDecodedData();
        if (!data) {
            this.isInitializing = false;
            return;
        }
        const peaks = [];
        for (let i = 0; i < data.numberOfChannels; i++) {
            peaks.push(data.getChannelData(i));
        }
        this.miniWavesurfer = WaveSurfer.create(Object.assign(Object.assign({}, this.options), { container: this.minimapWrapper, minPxPerSec: 0, fillParent: true, url: undefined, media: undefined, peaks, duration: data.duration }));
        this.syncMinimapPosition(this.wavesurfer.getCurrentTime());
        this.miniSubscriptions.push(this.miniWavesurfer.on('audioprocess', (currentTime) => {
            this.emit('audioprocess', currentTime);
        }), this.miniWavesurfer.on('click', (relativeX, relativeY) => {
            var _a;
            (_a = this.wavesurfer) === null || _a === void 0 ? void 0 : _a.seekTo(relativeX);
            this.emit('click', relativeX, relativeY);
        }), this.miniWavesurfer.on('dblclick', (relativeX, relativeY) => {
            this.emit('dblclick', relativeX, relativeY);
        }), this.miniWavesurfer.on('decode', (duration) => {
            this.emit('decode', duration);
        }), this.miniWavesurfer.on('destroy', () => {
            this.emit('destroy');
        }), this.miniWavesurfer.on('drag', (relativeX) => {
            this.onMinimapDrag(relativeX);
            this.emit('drag', relativeX);
        }), this.miniWavesurfer.on('dragend', (relativeX) => {
            this.emit('dragend', relativeX);
        }), this.miniWavesurfer.on('dragstart', (relativeX) => {
            this.emit('dragstart', relativeX);
        }), this.miniWavesurfer.on('interaction', () => {
            this.emit('interaction');
        }), this.miniWavesurfer.on('init', () => {
            this.emit('init');
        }), this.miniWavesurfer.on('ready', () => {
            var _a;
            this.syncMinimapPosition(((_a = this.wavesurfer) === null || _a === void 0 ? void 0 : _a.getCurrentTime()) || 0);
            this.emit('ready');
        }), this.miniWavesurfer.on('redraw', () => {
            this.emit('redraw');
        }), this.miniWavesurfer.on('redrawcomplete', () => {
            this.emit('redrawcomplete');
        }), this.miniWavesurfer.on('seeking', (currentTime) => {
            this.emit('seeking', currentTime);
        }), this.miniWavesurfer.on('timeupdate', (currentTime) => {
            this.emit('timeupdate', currentTime);
        }));
        // Reset flag after initialization completes
        this.isInitializing = false;
    }
    getOverlayWidth() {
        var _a;
        const waveformWidth = ((_a = this.wavesurfer) === null || _a === void 0 ? void 0 : _a.getWrapper().clientWidth) || 1;
        return Math.round((this.minimapWrapper.clientWidth / waveformWidth) * 100);
    }
    destroyMinimap() {
        const miniWavesurfer = this.miniWavesurfer;
        this.miniWavesurfer = null;
        miniWavesurfer === null || miniWavesurfer === void 0 ? void 0 : miniWavesurfer.destroy();
        this.miniSubscriptions.forEach((unsubscribe) => unsubscribe());
        this.miniSubscriptions = [];
        if (this.dragTimeout) {
            clearTimeout(this.dragTimeout);
            this.dragTimeout = null;
        }
    }
    renderMainProgress(progress) {
        if (!this.wavesurfer)
            return;
        this.wavesurfer.getRenderer().renderProgress(progress, this.wavesurfer.isPlaying());
    }
    renderMinimapProgress(progress) {
        if (!this.wavesurfer || !this.miniWavesurfer)
            return;
        this.miniWavesurfer.getRenderer().renderProgress(progress, this.wavesurfer.isPlaying());
    }
    syncMinimapPosition(currentTime) {
        if (!this.wavesurfer || !this.miniWavesurfer)
            return;
        const duration = this.wavesurfer.getDuration();
        if (!duration)
            return;
        if (this.miniWavesurfer.getDuration()) {
            this.miniWavesurfer.setTime(currentTime);
        }
        else {
            this.renderMinimapProgress(currentTime / duration);
        }
    }
    onMinimapDrag(relativeX) {
        var _a;
        if (!this.wavesurfer)
            return;
        this.renderMainProgress(relativeX);
        if (this.dragTimeout) {
            clearTimeout(this.dragTimeout);
        }
        let debounceTime = 0;
        const dragToSeek = this.options.dragToSeek;
        if (!this.wavesurfer.isPlaying() && dragToSeek === true) {
            debounceTime = 200;
        }
        else if (!this.wavesurfer.isPlaying() && dragToSeek && typeof dragToSeek === 'object') {
            debounceTime = (_a = dragToSeek.debounceTime) !== null && _a !== void 0 ? _a : 200;
        }
        this.dragTimeout = setTimeout(() => {
            var _a;
            (_a = this.wavesurfer) === null || _a === void 0 ? void 0 : _a.seekTo(relativeX);
            this.dragTimeout = null;
        }, debounceTime);
    }
    onRedraw() {
        const overlayWidth = this.getOverlayWidth();
        this.overlay.style.width = `${overlayWidth}%`;
    }
    onScroll(startTime) {
        if (!this.wavesurfer)
            return;
        const duration = this.wavesurfer.getDuration();
        this.overlay.style.left = `${(startTime / duration) * 100}%`;
    }
    initWaveSurferEvents() {
        if (!this.wavesurfer)
            return;
        // Subscribe to decode, scroll and redraw events
        this.subscriptions.push(this.wavesurfer.on('decode', () => {
            this.initMinimap();
        }), this.wavesurfer.on('timeupdate', (currentTime) => {
            this.syncMinimapPosition(currentTime);
        }), this.wavesurfer.on('drag', (relativeX) => {
            this.renderMinimapProgress(relativeX);
        }), this.wavesurfer.on('scroll', (startTime) => {
            this.onScroll(startTime);
        }), this.wavesurfer.on('redraw', () => {
            this.onRedraw();
        }));
    }
    /** Unmount */
    destroy() {
        this.destroyMinimap();
        this.minimapWrapper.remove();
        this.container = null;
        super.destroy();
    }
}
export default MinimapPlugin;
