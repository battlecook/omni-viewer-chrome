/**
 * The Hover plugin follows the mouse and shows a timestamp
 */
import BasePlugin from '../base-plugin.js';
import createElement from '../dom.js';
import { fromEvent } from '../reactive/event-streams.js';
import { effect } from '../reactive/store.js';
const defaultOptions = {
    lineWidth: 1,
    labelSize: 11,
    labelPreferLeft: false,
    formatTimeCallback(seconds) {
        const minutes = Math.floor(seconds / 60);
        const secondsRemainder = Math.floor(seconds) % 60;
        const paddedSeconds = `0${secondsRemainder}`.slice(-2);
        return `${minutes}:${paddedSeconds}`;
    },
};
class HoverPlugin extends BasePlugin {
    constructor(options) {
        super(options || {});
        this.lastPointerPosition = null;
        this.options = Object.assign({}, defaultOptions, options);
        // Create the plugin elements
        this.wrapper = createElement('div', { part: 'hover' });
        this.label = createElement('span', { part: 'hover-label' }, this.wrapper);
    }
    static create(options) {
        return new HoverPlugin(options);
    }
    addUnits(value) {
        const units = typeof value === 'number' ? 'px' : '';
        return `${value}${units}`;
    }
    /** Called by wavesurfer, don't call manually */
    onInit() {
        if (!this.wavesurfer) {
            throw Error('WaveSurfer is not initialized');
        }
        const wsOptions = this.wavesurfer.options;
        const lineColor = this.options.lineColor || wsOptions.cursorColor || wsOptions.progressColor;
        // Vertical line
        Object.assign(this.wrapper.style, {
            position: 'absolute',
            zIndex: 10,
            left: 0,
            top: 0,
            height: '100%',
            pointerEvents: 'none',
            borderLeft: `${this.addUnits(this.options.lineWidth)} solid ${lineColor}`,
            opacity: '0',
            transition: 'opacity .1s ease-in',
        });
        // Timestamp label
        Object.assign(this.label.style, {
            display: 'block',
            backgroundColor: this.options.labelBackground,
            color: this.options.labelColor,
            fontSize: `${this.addUnits(this.options.labelSize)}`,
            transition: 'transform .1s ease-in',
            padding: '2px 3px',
        });
        // Append the wrapper
        const container = this.wavesurfer.getWrapper();
        container.appendChild(this.wrapper);
        // Get reactive state
        const state = this.wavesurfer.getState();
        // Create event streams for pointer events
        const pointerMove = fromEvent(container, 'pointermove');
        const pointerLeave = fromEvent(container, 'pointerleave');
        // React to pointer movement
        this.subscriptions.push(effect(() => {
            const e = pointerMove.value;
            if (!e || !this.wavesurfer)
                return;
            // Store only the position data needed for zoom/scroll updates
            this.lastPointerPosition = { clientX: e.clientX, clientY: e.clientY };
            // Position
            const bbox = this.wavesurfer.getWrapper().getBoundingClientRect();
            const { width } = bbox;
            const offsetX = e.clientX - bbox.left;
            const relX = Math.min(1, Math.max(0, offsetX / width));
            const posX = Math.min(width - this.options.lineWidth - 1, offsetX);
            this.wrapper.style.transform = `translateX(${posX}px)`;
            this.wrapper.style.opacity = '1';
            // Timestamp
            const duration = state.duration.value;
            this.label.textContent = this.options.formatTimeCallback(duration * relX);
            const labelWidth = this.label.offsetWidth;
            const transformCondition = this.options.labelPreferLeft ? posX - labelWidth > 0 : posX + labelWidth > width;
            this.label.style.transform = transformCondition ? `translateX(-${labelWidth + this.options.lineWidth}px)` : '';
            // Emit a hover event with the relative X position
            this.emit('hover', relX);
        }, [pointerMove, state.duration]));
        // React to pointer leave
        this.subscriptions.push(effect(() => {
            const e = pointerLeave.value;
            if (!e)
                return;
            this.wrapper.style.opacity = '0';
            this.lastPointerPosition = null;
        }, [pointerLeave]));
        // When zoom or scroll happens, re-run the pointer move logic with the last known mouse position
        const onUpdate = () => {
            if (this.lastPointerPosition && this.wavesurfer) {
                // Position
                const bbox = this.wavesurfer.getWrapper().getBoundingClientRect();
                const { width } = bbox;
                const offsetX = this.lastPointerPosition.clientX - bbox.left;
                const relX = Math.min(1, Math.max(0, offsetX / width));
                const posX = Math.min(width - this.options.lineWidth - 1, offsetX);
                this.wrapper.style.transform = `translateX(${posX}px)`;
                // Timestamp
                const duration = state.duration.value;
                this.label.textContent = this.options.formatTimeCallback(duration * relX);
                const labelWidth = this.label.offsetWidth;
                const transformCondition = this.options.labelPreferLeft ? posX - labelWidth > 0 : posX + labelWidth > width;
                this.label.style.transform = transformCondition ? `translateX(-${labelWidth + this.options.lineWidth}px)` : '';
            }
        };
        // Subscribe to zoom and scroll events
        this.subscriptions.push(this.wavesurfer.on('zoom', onUpdate));
        this.subscriptions.push(this.wavesurfer.on('scroll', onUpdate));
    }
    /** Unmount */
    destroy() {
        super.destroy();
        this.wrapper.remove();
    }
}
export default HoverPlugin;
