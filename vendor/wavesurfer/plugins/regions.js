/**
 * Regions are visual overlays on the waveform that can be used to mark segments of audio.
 * Regions can be clicked on, dragged and resized.
 * You can set the color and content of each region, as well as their HTML content.
 */
import BasePlugin from '../base-plugin.js';
import EventEmitter from '../event-emitter.js';
import createElement from '../dom.js';
import { createDragStream } from '../reactive/drag-stream.js';
import { effect } from '../reactive/store.js';
import { fromEvent, cleanup as cleanupStream } from '../reactive/event-streams.js';
class SingleRegion extends EventEmitter {
    constructor(params, totalDuration, numberOfChannels = 0) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
        super();
        this.totalDuration = totalDuration;
        this.numberOfChannels = numberOfChannels;
        this.element = null; // Element is created on init
        this.minLength = 0;
        this.maxLength = Infinity;
        this.contentEditable = false;
        this.subscriptions = [];
        this.updatingSide = undefined;
        this.isRemoved = false;
        this.subscriptions = [];
        this.id = params.id || `region-${Math.random().toString(32).slice(2)}`;
        this.start = this.clampPosition(params.start);
        this.end = this.clampPosition((_a = params.end) !== null && _a !== void 0 ? _a : params.start);
        this.drag = (_b = params.drag) !== null && _b !== void 0 ? _b : true;
        this.resize = (_c = params.resize) !== null && _c !== void 0 ? _c : true;
        this.resizeStart = (_d = params.resizeStart) !== null && _d !== void 0 ? _d : true;
        this.resizeEnd = (_e = params.resizeEnd) !== null && _e !== void 0 ? _e : true;
        this.color = (_f = params.color) !== null && _f !== void 0 ? _f : 'rgba(0, 0, 0, 0.1)';
        this.minLength = (_g = params.minLength) !== null && _g !== void 0 ? _g : this.minLength;
        this.maxLength = (_h = params.maxLength) !== null && _h !== void 0 ? _h : this.maxLength;
        this.channelIdx = (_j = params.channelIdx) !== null && _j !== void 0 ? _j : -1;
        this.contentEditable = (_k = params.contentEditable) !== null && _k !== void 0 ? _k : this.contentEditable;
        this.element = this.initElement();
        this.setContent(params.content);
        this.setPart();
        this.renderPosition();
        this.initMouseEvents();
    }
    clampPosition(time) {
        return Math.max(0, Math.min(this.totalDuration, time));
    }
    setPart() {
        var _a;
        const isMarker = this.start === this.end;
        (_a = this.element) === null || _a === void 0 ? void 0 : _a.setAttribute('part', `${isMarker ? 'marker' : 'region'} ${this.id}`);
    }
    addResizeHandles(element) {
        const handleStyle = {
            position: 'absolute',
            zIndex: '2',
            width: '6px',
            height: '100%',
            top: '0',
            cursor: 'ew-resize',
            wordBreak: 'keep-all',
        };
        const leftHandle = createElement('div', {
            part: 'region-handle region-handle-left',
            style: Object.assign(Object.assign({}, handleStyle), { left: '0', borderLeft: '2px solid rgba(0, 0, 0, 0.5)', borderRadius: '2px 0 0 2px' }),
        }, element);
        const rightHandle = createElement('div', {
            part: 'region-handle region-handle-right',
            style: Object.assign(Object.assign({}, handleStyle), { right: '0', borderRight: '2px solid rgba(0, 0, 0, 0.5)', borderRadius: '0 2px 2px 0' }),
        }, element);
        // Resize
        const resizeThreshold = 1;
        const leftDragStream = createDragStream(leftHandle, { threshold: resizeThreshold });
        const rightDragStream = createDragStream(rightHandle, { threshold: resizeThreshold });
        const unsubscribeLeft = effect(() => {
            const drag = leftDragStream.signal.value;
            if (!drag)
                return;
            if (drag.type === 'move' && drag.deltaX !== undefined) {
                this.onResize(drag.deltaX, 'start');
            }
            else if (drag.type === 'end') {
                this.onEndResizing('start');
            }
        }, [leftDragStream.signal]);
        const unsubscribeRight = effect(() => {
            const drag = rightDragStream.signal.value;
            if (!drag)
                return;
            if (drag.type === 'move' && drag.deltaX !== undefined) {
                this.onResize(drag.deltaX, 'end');
            }
            else if (drag.type === 'end') {
                this.onEndResizing('end');
            }
        }, [rightDragStream.signal]);
        this.subscriptions.push(() => {
            unsubscribeLeft();
            unsubscribeRight();
            leftDragStream.cleanup();
            rightDragStream.cleanup();
        });
    }
    removeResizeHandles(element) {
        const leftHandle = element.querySelector('[part*="region-handle-left"]');
        const rightHandle = element.querySelector('[part*="region-handle-right"]');
        if (leftHandle) {
            element.removeChild(leftHandle);
        }
        if (rightHandle) {
            element.removeChild(rightHandle);
        }
    }
    initElement() {
        if (this.isRemoved)
            return null;
        const isMarker = this.start === this.end;
        let elementTop = 0;
        let elementHeight = 100;
        if (this.channelIdx >= 0 && this.numberOfChannels > 0 && this.channelIdx < this.numberOfChannels) {
            elementHeight = 100 / this.numberOfChannels;
            elementTop = elementHeight * this.channelIdx;
        }
        const element = createElement('div', {
            style: {
                position: 'absolute',
                top: `${elementTop}%`,
                height: `${elementHeight}%`,
                backgroundColor: isMarker ? 'none' : this.color,
                borderLeft: isMarker ? '2px solid ' + this.color : 'none',
                borderRadius: '2px',
                boxSizing: 'border-box',
                transition: 'background-color 0.2s ease',
                cursor: this.drag ? 'grab' : 'default',
                pointerEvents: 'all',
            },
        });
        // Add resize handles
        if (!isMarker && this.resize) {
            this.addResizeHandles(element);
        }
        return element;
    }
    renderPosition() {
        if (!this.element)
            return;
        const start = this.start / this.totalDuration;
        const end = (this.totalDuration - this.end) / this.totalDuration;
        this.element.style.left = `${start * 100}%`;
        this.element.style.right = `${end * 100}%`;
    }
    toggleCursor(toggle) {
        var _a;
        if (!this.drag || !((_a = this.element) === null || _a === void 0 ? void 0 : _a.style))
            return;
        this.element.style.cursor = toggle ? 'grabbing' : 'grab';
    }
    initMouseEvents() {
        const { element } = this;
        if (!element)
            return;
        // Create event streams
        const clicks = fromEvent(element, 'click');
        const mouseenters = fromEvent(element, 'mouseenter');
        const mouseleaves = fromEvent(element, 'mouseleave');
        const dblclicks = fromEvent(element, 'dblclick');
        const pointerdowns = fromEvent(element, 'pointerdown');
        const pointerups = fromEvent(element, 'pointerup');
        // Subscribe to streams
        const unsubscribeClick = clicks.subscribe((e) => e && this.emit('click', e));
        const unsubscribeMouseenter = mouseenters.subscribe((e) => e && this.emit('over', e));
        const unsubscribeMouseleave = mouseleaves.subscribe((e) => e && this.emit('leave', e));
        const unsubscribeDblclick = dblclicks.subscribe((e) => e && this.emit('dblclick', e));
        const unsubscribePointerdown = pointerdowns.subscribe((e) => e && this.toggleCursor(true));
        const unsubscribePointerup = pointerups.subscribe((e) => e && this.toggleCursor(false));
        // Store cleanup
        this.subscriptions.push(() => {
            unsubscribeClick();
            unsubscribeMouseenter();
            unsubscribeMouseleave();
            unsubscribeDblclick();
            unsubscribePointerdown();
            unsubscribePointerup();
            cleanupStream(clicks);
            cleanupStream(mouseenters);
            cleanupStream(mouseleaves);
            cleanupStream(dblclicks);
            cleanupStream(pointerdowns);
            cleanupStream(pointerups);
        });
        // Drag
        const dragStream = createDragStream(element);
        const unsubscribeDrag = effect(() => {
            const drag = dragStream.signal.value;
            if (!drag)
                return;
            if (drag.type === 'start') {
                this.toggleCursor(true);
            }
            else if (drag.type === 'move' && drag.deltaX !== undefined) {
                this.onMove(drag.deltaX);
            }
            else if (drag.type === 'end') {
                this.toggleCursor(false);
                if (this.drag)
                    this.emit('update-end');
            }
        }, [dragStream.signal]);
        this.subscriptions.push(() => {
            unsubscribeDrag();
            dragStream.cleanup();
        });
        if (this.contentEditable && this.content) {
            this.contentClickListener = (e) => this.onContentClick(e);
            this.contentBlurListener = () => this.onContentBlur();
            this.content.addEventListener('click', this.contentClickListener);
            this.content.addEventListener('blur', this.contentBlurListener);
        }
    }
    _onUpdate(dx, side, startTime) {
        var _a;
        if (!((_a = this.element) === null || _a === void 0 ? void 0 : _a.parentElement))
            return;
        const { width } = this.element.parentElement.getBoundingClientRect();
        const deltaSeconds = (dx / width) * this.totalDuration;
        let newStart = !side || side === 'start' ? this.start + deltaSeconds : this.start;
        let newEnd = !side || side === 'end' ? this.end + deltaSeconds : this.end;
        const isRegionCreating = startTime !== undefined; // startTime is passed when the region is being created.
        if (isRegionCreating) {
            if (this.updatingSide && this.updatingSide !== side) {
                if (this.updatingSide === 'start') {
                    newStart = startTime;
                }
                else {
                    newEnd = startTime;
                }
            }
        }
        newStart = Math.max(0, newStart);
        newEnd = Math.min(this.totalDuration, newEnd);
        const length = newEnd - newStart;
        this.updatingSide = side;
        const resizeValid = length >= this.minLength && length <= this.maxLength;
        if (newStart <= newEnd && (resizeValid || isRegionCreating)) {
            this.start = newStart;
            this.end = newEnd;
            this.renderPosition();
            this.emit('update', side);
        }
    }
    onMove(dx) {
        if (!this.drag)
            return;
        this._onUpdate(dx);
    }
    onResize(dx, side) {
        if (!this.resize)
            return;
        if (!this.resizeStart && side === 'start')
            return;
        if (!this.resizeEnd && side === 'end')
            return;
        this._onUpdate(dx, side);
    }
    onEndResizing(side) {
        if (!this.resize)
            return;
        this.emit('update-end', side);
        this.updatingSide = undefined;
    }
    onContentClick(event) {
        event.stopPropagation();
        const contentContainer = event.target;
        contentContainer.focus();
        this.emit('click', event);
    }
    onContentBlur() {
        this.emit('update-end');
    }
    _setTotalDuration(totalDuration) {
        this.totalDuration = totalDuration;
        this.renderPosition();
    }
    /** Play the region from the start, pass `true` to stop at region end */
    play(stopAtEnd) {
        this.emit('play', stopAtEnd && this.end !== this.start ? this.end : undefined);
    }
    /** Get Content as html or string */
    getContent(asHTML = false) {
        var _a;
        if (asHTML) {
            return this.content || undefined;
        }
        if (this.element instanceof HTMLElement) {
            return ((_a = this.content) === null || _a === void 0 ? void 0 : _a.innerHTML) || undefined;
        }
        return '';
    }
    /** Set the HTML content of the region */
    setContent(content) {
        var _a;
        if (!this.element)
            return;
        // Remove event listeners from old content before removing it
        if (this.content && this.contentEditable) {
            if (this.contentClickListener) {
                this.content.removeEventListener('click', this.contentClickListener);
            }
            if (this.contentBlurListener) {
                this.content.removeEventListener('blur', this.contentBlurListener);
            }
        }
        (_a = this.content) === null || _a === void 0 ? void 0 : _a.remove();
        if (!content) {
            this.content = undefined;
            return;
        }
        if (typeof content === 'string') {
            const isMarker = this.start === this.end;
            this.content = createElement('div', {
                style: {
                    padding: `0.2em ${isMarker ? 0.2 : 0.4}em`,
                    display: 'inline-block',
                },
                textContent: content,
            });
        }
        else {
            this.content = content;
        }
        if (this.contentEditable) {
            this.content.contentEditable = 'true';
            // Re-add event listeners to new content
            this.contentClickListener = (e) => this.onContentClick(e);
            this.contentBlurListener = () => this.onContentBlur();
            this.content.addEventListener('click', this.contentClickListener);
            this.content.addEventListener('blur', this.contentBlurListener);
        }
        this.content.setAttribute('part', 'region-content');
        this.element.appendChild(this.content);
        this.emit('content-changed');
    }
    /** Update the region's options */
    setOptions(options) {
        var _a, _b;
        if (!this.element)
            return;
        if (options.color) {
            this.color = options.color;
            this.element.style.backgroundColor = this.color;
        }
        if (options.drag !== undefined) {
            this.drag = options.drag;
            this.element.style.cursor = this.drag ? 'grab' : 'default';
        }
        if (options.start !== undefined || options.end !== undefined) {
            const isMarker = this.start === this.end;
            this.start = this.clampPosition((_a = options.start) !== null && _a !== void 0 ? _a : this.start);
            this.end = this.clampPosition((_b = options.end) !== null && _b !== void 0 ? _b : (isMarker ? this.start : this.end));
            this.renderPosition();
            this.setPart();
            this.emit('render');
        }
        if (options.content) {
            this.setContent(options.content);
        }
        if (options.id) {
            this.id = options.id;
            this.setPart();
        }
        if (options.resize !== undefined && options.resize !== this.resize) {
            const isMarker = this.start === this.end;
            this.resize = options.resize;
            if (this.resize && !isMarker) {
                this.addResizeHandles(this.element);
            }
            else {
                this.removeResizeHandles(this.element);
            }
        }
        if (options.resizeStart !== undefined) {
            this.resizeStart = options.resizeStart;
        }
        if (options.resizeEnd !== undefined) {
            this.resizeEnd = options.resizeEnd;
        }
    }
    /** Remove the region */
    remove() {
        this.isRemoved = true;
        this.emit('remove');
        // Clean up all subscriptions (drag streams, event listeners, etc.)
        this.subscriptions.forEach((unsubscribe) => unsubscribe());
        this.subscriptions = [];
        // Clean up content event listeners
        if (this.content && this.contentEditable) {
            if (this.contentClickListener) {
                this.content.removeEventListener('click', this.contentClickListener);
                this.contentClickListener = undefined;
            }
            if (this.contentBlurListener) {
                this.content.removeEventListener('blur', this.contentBlurListener);
                this.contentBlurListener = undefined;
            }
        }
        // Remove DOM element
        if (this.element) {
            this.element.remove();
            this.element = null;
        }
        // Clear all event listeners from the EventEmitter
        this.unAll();
    }
}
class RegionsPlugin extends BasePlugin {
    /** Create an instance of RegionsPlugin */
    constructor(options) {
        super(options);
        this.regions = [];
        this.regionsContainer = this.initRegionsContainer();
    }
    /** Create an instance of RegionsPlugin */
    static create(options) {
        return new RegionsPlugin(options);
    }
    /** Called by wavesurfer, don't call manually */
    onInit() {
        if (!this.wavesurfer) {
            throw Error('WaveSurfer is not initialized');
        }
        this.wavesurfer.getWrapper().appendChild(this.regionsContainer);
        // Update region durations when a new audio file is loaded
        this.subscriptions.push(this.wavesurfer.on('ready', (duration) => {
            this.regions.forEach((region) => region._setTotalDuration(duration));
        }));
        let activeRegions = [];
        this.subscriptions.push(this.wavesurfer.on('timeupdate', (currentTime) => {
            // Detect when regions are being played
            const playedRegions = this.regions.filter((region) => region.start <= currentTime &&
                (region.end === region.start ? region.start + 0.05 : region.end) >= currentTime);
            // Trigger region-in when activeRegions doesn't include a played regions
            playedRegions.forEach((region) => {
                if (!activeRegions.includes(region)) {
                    this.emit('region-in', region);
                }
            });
            // Trigger region-out when activeRegions include a un-played regions
            activeRegions.forEach((region) => {
                if (!playedRegions.includes(region)) {
                    this.emit('region-out', region);
                }
            });
            // Update activeRegions only played regions
            activeRegions = playedRegions;
        }));
    }
    initRegionsContainer() {
        return createElement('div', {
            part: 'regions-container',
            style: {
                position: 'absolute',
                top: '0',
                left: '0',
                width: '100%',
                height: '100%',
                zIndex: '5',
                pointerEvents: 'none',
            },
        });
    }
    /** Get all created regions */
    getRegions() {
        return this.regions;
    }
    avoidOverlapping(region) {
        if (!region.content || region.isRemoved)
            return;
        setTimeout(() => {
            // Check that the label doesn't overlap with other labels
            // If it does, push it down until it doesn't
            // only check regions that are before us in the list -- otherwise
            // both overlapping regions will try to move down away from each other.
            const div = region.content;
            const box = div.getBoundingClientRect();
            const regionIndex = this.regions.indexOf(region);
            const overlap = this.regions
                .slice(0, regionIndex)
                .filter((reg) => !reg.isRemoved)
                .map((reg) => {
                if (reg === region || !reg.content)
                    return 0;
                const otherBox = reg.content.getBoundingClientRect();
                if (box.left < otherBox.left + otherBox.width && otherBox.left < box.left + box.width) {
                    return otherBox.height + 2;
                }
                return 0;
            })
                .reduce((sum, val) => sum + val, 0);
            div.style.marginTop = `${overlap}px`;
        }, 10);
    }
    adjustScroll(region) {
        var _a, _b;
        if (!region.element)
            return;
        const scrollContainer = (_b = (_a = this.wavesurfer) === null || _a === void 0 ? void 0 : _a.getWrapper()) === null || _b === void 0 ? void 0 : _b.parentElement;
        if (!scrollContainer)
            return;
        const { clientWidth, scrollWidth } = scrollContainer;
        if (scrollWidth <= clientWidth)
            return;
        const scrollBbox = scrollContainer.getBoundingClientRect();
        const bbox = region.element.getBoundingClientRect();
        const left = bbox.left - scrollBbox.left;
        const right = bbox.right - scrollBbox.left;
        if (left < 0) {
            scrollContainer.scrollLeft += left;
        }
        else if (right > clientWidth) {
            scrollContainer.scrollLeft += right - clientWidth;
        }
    }
    virtualAppend(region, container, element) {
        const renderIfVisible = () => {
            if (!this.wavesurfer)
                return;
            const clientWidth = this.wavesurfer.getWidth();
            const scrollLeft = this.wavesurfer.getScroll();
            const scrollWidth = container.clientWidth;
            const duration = this.wavesurfer.getDuration();
            const start = Math.round((region.start / duration) * scrollWidth);
            const width = Math.round(((region.end - region.start) / duration) * scrollWidth) || 1;
            // Check if the region is between the scrollLeft and scrollLeft + clientWidth
            const isVisible = start + width > scrollLeft && start < scrollLeft + clientWidth;
            if (isVisible && !element.parentElement) {
                container.appendChild(element);
            }
            else if (!isVisible && element.parentElement) {
                element.remove();
            }
        };
        setTimeout(() => {
            // Check if region was removed before setTimeout executed
            if (!this.wavesurfer || !region.element)
                return;
            renderIfVisible();
            const unsubscribeScroll = this.wavesurfer.on('scroll', renderIfVisible);
            const unsubscribeZoom = this.wavesurfer.on('zoom', renderIfVisible);
            const unsubscribeResize = this.wavesurfer.on('resize', renderIfVisible);
            const unsubscribeRender = region.on('render', renderIfVisible);
            // Only push the unsubscribe functions, not the once() return values
            this.subscriptions.push(unsubscribeScroll, unsubscribeZoom, unsubscribeResize, unsubscribeRender);
            // Clean up subscriptions when region is removed
            region.once('remove', () => {
                unsubscribeScroll();
                unsubscribeZoom();
                unsubscribeResize();
                unsubscribeRender();
            });
        }, 0);
    }
    saveRegion(region) {
        if (!region.element)
            return;
        this.virtualAppend(region, this.regionsContainer, region.element);
        this.avoidOverlapping(region);
        this.regions.push(region);
        const regionSubscriptions = [
            region.on('update', (side) => {
                // Undefined side indicates that we are dragging not resizing
                if (!side) {
                    this.adjustScroll(region);
                }
                this.emit('region-update', region, side);
            }),
            region.on('update-end', (side) => {
                this.avoidOverlapping(region);
                this.emit('region-updated', region, side);
            }),
            region.on('play', (end) => {
                var _a;
                (_a = this.wavesurfer) === null || _a === void 0 ? void 0 : _a.play(region.start, end);
            }),
            region.on('click', (e) => {
                this.emit('region-clicked', region, e);
            }),
            region.on('dblclick', (e) => {
                this.emit('region-double-clicked', region, e);
            }),
            region.on('content-changed', () => {
                this.emit('region-content-changed', region);
            }),
            // Remove the region from the list when it's removed
            region.once('remove', () => {
                regionSubscriptions.forEach((unsubscribe) => unsubscribe());
                this.regions = this.regions.filter((reg) => reg !== region);
                this.emit('region-removed', region);
            }),
        ];
        this.subscriptions.push(...regionSubscriptions);
        this.emit('region-created', region);
    }
    /** Create a region with given parameters */
    addRegion(options) {
        var _a, _b;
        if (!this.wavesurfer) {
            throw Error('WaveSurfer is not initialized');
        }
        const duration = this.wavesurfer.getDuration();
        const numberOfChannels = (_b = (_a = this.wavesurfer) === null || _a === void 0 ? void 0 : _a.getDecodedData()) === null || _b === void 0 ? void 0 : _b.numberOfChannels;
        const region = new SingleRegion(options, duration, numberOfChannels);
        this.emit('region-initialized', region);
        if (!duration) {
            this.subscriptions.push(this.wavesurfer.once('ready', (duration) => {
                region._setTotalDuration(duration);
                this.saveRegion(region);
            }));
        }
        else {
            this.saveRegion(region);
        }
        return region;
    }
    /**
     * Enable creation of regions by dragging on an empty space on the waveform.
     * Returns a function to disable the drag selection.
     */
    enableDragSelection(options, threshold = 3) {
        var _a;
        const wrapper = (_a = this.wavesurfer) === null || _a === void 0 ? void 0 : _a.getWrapper();
        if (!wrapper || !(wrapper instanceof HTMLElement))
            return () => undefined;
        const initialSize = 5;
        let region = null;
        let startX = 0;
        let startTime = 0;
        const dragStream = createDragStream(wrapper, { threshold });
        const unsubscribe = effect(() => {
            var _a, _b;
            const drag = dragStream.signal.value;
            if (!drag)
                return;
            if (drag.type === 'start') {
                // On drag start
                startX = drag.x;
                if (!this.wavesurfer)
                    return;
                const duration = this.wavesurfer.getDuration();
                const numberOfChannels = (_b = (_a = this.wavesurfer) === null || _a === void 0 ? void 0 : _a.getDecodedData()) === null || _b === void 0 ? void 0 : _b.numberOfChannels;
                const { width } = this.wavesurfer.getWrapper().getBoundingClientRect();
                startTime = (startX / width) * duration;
                // Calculate the start time of the region
                const start = (drag.x / width) * duration;
                // Give the region a small initial size
                const end = ((drag.x + initialSize) / width) * duration;
                // Create a region but don't save it until the drag ends
                region = new SingleRegion(Object.assign(Object.assign({}, options), { start,
                    end }), duration, numberOfChannels);
                this.emit('region-initialized', region);
                // Just add it to the DOM for now
                if (region.element) {
                    this.regionsContainer.appendChild(region.element);
                }
            }
            else if (drag.type === 'move' && drag.deltaX !== undefined) {
                // On drag move
                if (region) {
                    // Update the end position of the region
                    // If we're dragging to the left, we need to update the start instead
                    region._onUpdate(drag.deltaX, drag.x > startX ? 'end' : 'start', startTime);
                }
            }
            else if (drag.type === 'end') {
                // On drag end
                if (region) {
                    this.saveRegion(region);
                    region.updatingSide = undefined;
                    region = null;
                }
            }
        }, [dragStream.signal]);
        return () => {
            unsubscribe();
            dragStream.cleanup();
        };
    }
    /** Remove all regions */
    clearRegions() {
        const regions = this.regions.slice();
        regions.forEach((region) => region.remove());
        this.regions = [];
    }
    /** Destroy the plugin and clean up */
    destroy() {
        this.clearRegions();
        super.destroy();
        this.regionsContainer.remove();
    }
}
export default RegionsPlugin;
