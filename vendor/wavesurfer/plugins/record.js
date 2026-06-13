/**
 * Record audio from the microphone with a real-time waveform preview
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import BasePlugin from '../base-plugin.js';
import Timer from '../timer.js';
const DEFAULT_BITS_PER_SECOND = 128000;
const DEFAULT_SCROLLING_WAVEFORM_WINDOW = 5;
const FPS = 100;
const MIME_TYPES = ['audio/webm', 'audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/mp3'];
const findSupportedMimeType = () => MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
class RecordPlugin extends BasePlugin {
    /** Create an instance of the Record plugin */
    constructor(options) {
        var _a, _b, _c, _d, _e, _f;
        super(Object.assign(Object.assign({}, options), { audioBitsPerSecond: (_a = options.audioBitsPerSecond) !== null && _a !== void 0 ? _a : DEFAULT_BITS_PER_SECOND, scrollingWaveform: (_b = options.scrollingWaveform) !== null && _b !== void 0 ? _b : false, scrollingWaveformWindow: (_c = options.scrollingWaveformWindow) !== null && _c !== void 0 ? _c : DEFAULT_SCROLLING_WAVEFORM_WINDOW, continuousWaveform: (_d = options.continuousWaveform) !== null && _d !== void 0 ? _d : false, renderRecordedAudio: (_e = options.renderRecordedAudio) !== null && _e !== void 0 ? _e : true, mediaRecorderTimeslice: (_f = options.mediaRecorderTimeslice) !== null && _f !== void 0 ? _f : undefined }));
        this.stream = null;
        this.mediaRecorder = null;
        this.dataWindow = null;
        this.isWaveformPaused = false;
        this.lastStartTime = 0;
        this.lastDuration = 0;
        this.duration = 0;
        this.micStream = null;
        this.recordedBlobUrl = null;
        this.timer = new Timer();
        this.subscriptions.push(this.timer.on('tick', () => {
            const currentTime = performance.now() - this.lastStartTime;
            this.duration = this.isPaused() ? this.duration : this.lastDuration + currentTime;
            this.emit('record-progress', this.duration);
        }));
    }
    /** Create an instance of the Record plugin */
    static create(options) {
        return new RecordPlugin(options || {});
    }
    renderMicStream(stream) {
        var _a;
        const audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        source.connect(analyser);
        // Use smaller FFT size for more responsive peak detection
        if (this.options.continuousWaveform || this.options.scrollingWaveform) {
            analyser.fftSize = 32;
        }
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Float32Array(bufferLength);
        let sampleIdx = 0;
        if (this.wavesurfer) {
            (_a = this.originalOptions) !== null && _a !== void 0 ? _a : (this.originalOptions = Object.assign({}, this.wavesurfer.options));
            this.wavesurfer.options.interact = false;
            if (this.options.scrollingWaveform) {
                this.wavesurfer.options.cursorWidth = 0;
                // Use fixed max peak in scrolling mode to prevent "dancing" waveform
                this.wavesurfer.options.normalize = true;
                this.wavesurfer.options.maxPeak = 1;
            }
        }
        const drawWaveform = () => {
            var _a, _b, _c, _d;
            if (this.isWaveformPaused)
                return;
            analyser.getFloatTimeDomainData(dataArray);
            if (this.options.scrollingWaveform) {
                // Scrolling waveform - use peak values for smooth rendering
                const windowSize = Math.floor((this.options.scrollingWaveformWindow || 0) * FPS);
                // Calculate peak value from the current buffer
                let maxValue = 0;
                for (let i = 0; i < bufferLength; i++) {
                    const value = Math.abs(dataArray[i]);
                    if (value > maxValue) {
                        maxValue = value;
                    }
                }
                if (!this.dataWindow) {
                    this.dataWindow = new Float32Array(windowSize);
                }
                const tempArray = new Float32Array(windowSize);
                if (this.dataWindow && this.dataWindow.length > 0) {
                    // Shift old data to the left, dropping the oldest sample
                    const keepLength = windowSize - 1;
                    const oldData = this.dataWindow.slice(-keepLength);
                    tempArray.set(oldData, 0);
                }
                // Add new peak value at the end
                tempArray[windowSize - 1] = maxValue;
                this.dataWindow = tempArray;
            }
            else if (this.options.continuousWaveform) {
                // Continuous waveform
                if (!this.dataWindow) {
                    const size = this.options.continuousWaveformDuration
                        ? Math.round(this.options.continuousWaveformDuration * FPS)
                        : ((_b = (_a = this.wavesurfer) === null || _a === void 0 ? void 0 : _a.getWidth()) !== null && _b !== void 0 ? _b : 0) * window.devicePixelRatio;
                    this.dataWindow = new Float32Array(size);
                }
                let maxValue = 0;
                for (let i = 0; i < bufferLength; i++) {
                    const value = Math.abs(dataArray[i]);
                    if (value > maxValue) {
                        maxValue = value;
                    }
                }
                if (sampleIdx + 1 > this.dataWindow.length) {
                    const tempArray = new Float32Array(this.dataWindow.length * 2);
                    tempArray.set(this.dataWindow, 0);
                    this.dataWindow = tempArray;
                }
                this.dataWindow[sampleIdx] = maxValue;
                sampleIdx++;
            }
            else {
                this.dataWindow = dataArray;
            }
            // Render the waveform
            if (this.wavesurfer) {
                const totalDuration = ((_d = (_c = this.dataWindow) === null || _c === void 0 ? void 0 : _c.length) !== null && _d !== void 0 ? _d : 0) / FPS;
                this.wavesurfer
                    .load('', [this.dataWindow], this.options.scrollingWaveform ? this.options.scrollingWaveformWindow : totalDuration)
                    .then(() => {
                    if (this.wavesurfer && this.options.continuousWaveform) {
                        this.wavesurfer.setTime(this.getDuration() / 1000);
                        if (!this.wavesurfer.options.minPxPerSec) {
                            this.wavesurfer.setOptions({
                                minPxPerSec: this.wavesurfer.getWidth() / this.wavesurfer.getDuration(),
                            });
                        }
                    }
                })
                    .catch((err) => {
                    console.error('Error rendering real-time recording data:', err);
                });
            }
        };
        const intervalId = setInterval(drawWaveform, 1000 / FPS);
        const cleanup = () => {
            clearInterval(intervalId);
            source === null || source === void 0 ? void 0 : source.disconnect();
            audioContext === null || audioContext === void 0 ? void 0 : audioContext.close();
        };
        return {
            onDestroy: cleanup,
            onEnd: () => {
                this.isWaveformPaused = true;
                this.stopMic();
            },
        };
    }
    /** Request access to the microphone and start monitoring incoming audio */
    startMic(options) {
        return __awaiter(this, void 0, void 0, function* () {
            // Stop previous mic stream if exists to clean up AudioContext
            if (this.micStream) {
                this.stopMic();
            }
            let stream;
            try {
                stream = yield navigator.mediaDevices.getUserMedia({
                    audio: options !== null && options !== void 0 ? options : true,
                });
            }
            catch (err) {
                throw new Error('Error accessing the microphone: ' + err.message);
            }
            const micStream = this.renderMicStream(stream);
            this.micStream = micStream;
            this.unsubscribeDestroy = this.once('destroy', micStream.onDestroy);
            this.unsubscribeRecordEnd = this.once('record-end', micStream.onEnd);
            this.stream = stream;
            return stream;
        });
    }
    /** Stop monitoring incoming audio */
    stopMic() {
        var _a, _b, _c;
        (_a = this.micStream) === null || _a === void 0 ? void 0 : _a.onDestroy();
        (_b = this.unsubscribeDestroy) === null || _b === void 0 ? void 0 : _b.call(this);
        (_c = this.unsubscribeRecordEnd) === null || _c === void 0 ? void 0 : _c.call(this);
        this.micStream = null;
        this.unsubscribeDestroy = undefined;
        this.unsubscribeRecordEnd = undefined;
        if (!this.stream)
            return;
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
        this.mediaRecorder = null;
    }
    /** Start recording audio from the microphone */
    startRecording(options) {
        return __awaiter(this, void 0, void 0, function* () {
            const stream = this.stream || (yield this.startMic(options));
            this.dataWindow = null;
            const mediaRecorder = this.mediaRecorder ||
                new MediaRecorder(stream, {
                    mimeType: this.options.mimeType || findSupportedMimeType(),
                    audioBitsPerSecond: this.options.audioBitsPerSecond,
                });
            this.mediaRecorder = mediaRecorder;
            this.stopRecording();
            const recordedChunks = [];
            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    recordedChunks.push(event.data);
                }
                this.emit('record-data-available', event.data);
            };
            const emitWithBlob = (ev) => {
                var _a;
                const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
                this.emit(ev, blob);
                if (this.options.renderRecordedAudio) {
                    this.applyOriginalOptionsIfNeeded();
                    // Revoke previous blob URL before creating a new one
                    if (this.recordedBlobUrl) {
                        URL.revokeObjectURL(this.recordedBlobUrl);
                    }
                    this.recordedBlobUrl = URL.createObjectURL(blob);
                    (_a = this.wavesurfer) === null || _a === void 0 ? void 0 : _a.load(this.recordedBlobUrl);
                }
            };
            mediaRecorder.onpause = () => emitWithBlob('record-pause');
            mediaRecorder.onstop = () => emitWithBlob('record-end');
            mediaRecorder.start(this.options.mediaRecorderTimeslice);
            this.lastStartTime = performance.now();
            this.lastDuration = 0;
            this.duration = 0;
            this.isWaveformPaused = false;
            this.timer.start();
            this.emit('record-start');
        });
    }
    /** Get the duration of the recording */
    getDuration() {
        return this.duration;
    }
    /** Check if the audio is being recorded */
    isRecording() {
        var _a;
        return ((_a = this.mediaRecorder) === null || _a === void 0 ? void 0 : _a.state) === 'recording';
    }
    isPaused() {
        var _a;
        return ((_a = this.mediaRecorder) === null || _a === void 0 ? void 0 : _a.state) === 'paused';
    }
    isActive() {
        var _a;
        return ((_a = this.mediaRecorder) === null || _a === void 0 ? void 0 : _a.state) !== 'inactive';
    }
    /** Stop the recording */
    stopRecording() {
        var _a;
        if (this.isActive()) {
            (_a = this.mediaRecorder) === null || _a === void 0 ? void 0 : _a.stop();
            this.timer.stop();
        }
    }
    /** Pause the recording */
    pauseRecording() {
        var _a, _b;
        if (this.isRecording()) {
            this.isWaveformPaused = true;
            (_a = this.mediaRecorder) === null || _a === void 0 ? void 0 : _a.requestData();
            (_b = this.mediaRecorder) === null || _b === void 0 ? void 0 : _b.pause();
            this.timer.stop();
            this.lastDuration = this.duration;
        }
    }
    /** Resume the recording */
    resumeRecording() {
        var _a;
        if (this.isPaused()) {
            this.isWaveformPaused = false;
            (_a = this.mediaRecorder) === null || _a === void 0 ? void 0 : _a.resume();
            this.timer.start();
            this.lastStartTime = performance.now();
            this.emit('record-resume');
        }
    }
    /** Get a list of available audio devices
     * You can use this to get the device ID of the microphone to use with the startMic and startRecording methods
     * Will return an empty array if the browser doesn't support the MediaDevices API or if the user has not granted access to the microphone
     * You can ask for permission to the microphone by calling startMic
     */
    static getAvailableAudioDevices() {
        return __awaiter(this, void 0, void 0, function* () {
            return navigator.mediaDevices
                .enumerateDevices()
                .then((devices) => devices.filter((device) => device.kind === 'audioinput'));
        });
    }
    /** Destroy the plugin */
    destroy() {
        this.applyOriginalOptionsIfNeeded();
        super.destroy();
        this.stopRecording();
        this.stopMic();
        // Revoke blob URL to free memory
        if (this.recordedBlobUrl) {
            URL.revokeObjectURL(this.recordedBlobUrl);
            this.recordedBlobUrl = null;
        }
    }
    applyOriginalOptionsIfNeeded() {
        if (this.wavesurfer && this.originalOptions) {
            this.wavesurfer.setOptions(this.originalOptions);
            delete this.originalOptions;
        }
    }
}
export default RecordPlugin;
