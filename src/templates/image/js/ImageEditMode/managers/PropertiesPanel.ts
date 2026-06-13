// PropertiesPanel — sidebar/inline panel that two-way binds the selected
// element's style + text to a small set of HTML inputs.
//
// Chrome-side port of `vscode-omni-viewer/.../PropertiesPanel.js`, scoped
// to issue #14. Visible only when SelectionManager has exactly one entry.
//
// Inputs (DOM ids retained from the VSCode original — same keys are used by
// the test suite + future #15 save flow):
//   - shapeColor      (input[type=color])  — fill color (text -> font color)
//   - borderColor     (input[type=color])  — stroke color (shapes only)
//   - fillOpacity     (input[type=range])  — 0..100 % => style.opacity 0..1
//   - borderOpacity   (input[type=range])  — currently mirrors fillOpacity
//                                            since ElementStyle has a single
//                                            opacity key (kept for parity
//                                            with the VSCode shape).
//   - textInput       (input[type=text])   — text content (text only)
//   - fontSize        (input[type=range])  — font size in px (text only)
//   - fontSizeInput   (input[type=number]) — same value, numeric mirror
//
// The two-way binding is split into a pure reducer (`computeBoundProperties`
// + `inputValueFromElement`) so the test suite can drive selection -> input
// values without DOM, then the panel composes that with input event hooks
// to push changes back into ElementManager.

import type { ElementManager, ElementData, ElementStyle } from './ElementManager';
import type { SelectionManager } from './SelectionManager';
import { setVisible } from '../utils/DOMUtils';

/** DOM ids the panel registers, mirroring the VSCode original. */
export const PROPERTIES_PANEL_ID = 'editProperties';
export const SHAPE_COLOR_ID = 'shapeColor';
export const BORDER_COLOR_ID = 'borderColor';
export const FILL_OPACITY_ID = 'fillOpacity';
export const FILL_OPACITY_VALUE_ID = 'fillOpacityValue';
export const BORDER_OPACITY_ID = 'borderOpacity';
export const BORDER_OPACITY_VALUE_ID = 'borderOpacityValue';
export const TEXT_INPUT_ID = 'textInput';
export const FONT_SIZE_ID = 'fontSize';
export const FONT_SIZE_INPUT_ID = 'fontSizeInput';

/** Defaults applied when an element is missing a key (matches ElementManager). */
export const DEFAULT_FILL = '#ff3030';
export const DEFAULT_STROKE = '#000000';
export const DEFAULT_OPACITY_PCT = 100;
export const DEFAULT_FONT_SIZE = 24;

/**
 * Plain values shown in the panel inputs. Opacity is stored as 0..100
 * percent (the slider's units); fontSize as px. These live in their own
 * type so the reducer is trivially testable.
 */
export interface BoundProperties {
    shapeColor: string;
    borderColor: string;
    fillOpacity: number; // 0..100
    borderOpacity: number; // 0..100
    text: string;
    fontSize: number; // px
}

/** Per-row visibility — driven by element type. */
export interface PropertyRowVisibility {
    shapeColor: boolean;
    borderColor: boolean;
    fillOpacity: boolean;
    borderOpacity: boolean;
    text: boolean;
    fontSize: boolean;
}

/** Element-type-driven property row visibility. */
export function computeRowVisibility(element: ElementData): PropertyRowVisibility {
    const isText = element.type === 'text';
    const isShape = !isText;
    return {
        shapeColor: true,
        borderColor: isShape,
        fillOpacity: true,
        borderOpacity: isShape,
        text: isText,
        fontSize: isText
    };
}

/**
 * Pure reducer: read the element + its style and produce the values the
 * panel inputs should display. Used for selection -> panel binding.
 *
 * Inverse of {@link applyPropertyChange} — together they form the
 * round-trip the panel runs on every mutation.
 */
export function computeBoundProperties(element: ElementData): BoundProperties {
    const style = element.style;
    const opacityPct = clampPct(Math.round((style.opacity ?? 1) * 100));
    return {
        shapeColor: style.fill ?? DEFAULT_FILL,
        borderColor: style.stroke ?? DEFAULT_STROKE,
        fillOpacity: opacityPct,
        borderOpacity: opacityPct,
        text: element.text ?? '',
        fontSize: style.fontSize ?? DEFAULT_FONT_SIZE
    };
}

/** Which input the user just edited. */
export type PropertyKey =
    | 'shapeColor'
    | 'borderColor'
    | 'fillOpacity'
    | 'borderOpacity'
    | 'text'
    | 'fontSize';

/**
 * Pure reducer: given the current element + the key the user edited and the
 * new raw input value, produce the partial update to feed
 * `ElementManager.update`. Returns `null` when the value is invalid (so the
 * caller can ignore the event without throwing).
 */
export function applyPropertyChange(
    element: ElementData,
    key: PropertyKey,
    rawValue: string
): { style?: Partial<ElementStyle>; text?: string } | null {
    switch (key) {
        case 'shapeColor': {
            if (!isHexColor(rawValue)) return null;
            return { style: { fill: rawValue } };
        }
        case 'borderColor': {
            if (!isHexColor(rawValue)) return null;
            if (element.type === 'text') return null;
            return { style: { stroke: rawValue } };
        }
        case 'fillOpacity':
        case 'borderOpacity': {
            const pct = parseInt(rawValue, 10);
            if (Number.isNaN(pct)) return null;
            return { style: { opacity: clampPct(pct) / 100 } };
        }
        case 'text': {
            if (element.type !== 'text') return null;
            return { text: rawValue };
        }
        case 'fontSize': {
            if (element.type !== 'text') return null;
            const px = parseInt(rawValue, 10);
            if (Number.isNaN(px) || px <= 0) return null;
            return { style: { fontSize: px } };
        }
        default:
            return null;
    }
}

function clampPct(value: number): number {
    if (Number.isNaN(value)) return 0;
    if (value < 0) return 0;
    if (value > 100) return 100;
    return value;
}

function isHexColor(value: string): boolean {
    return /^#[0-9a-fA-F]{6}$/.test(value);
}

/** Construction options for PropertiesPanel. */
export interface PropertiesPanelOptions {
    elementManager: ElementManager;
    selectionManager: SelectionManager;
    /** Host the `.iv-properties-panel` is appended to. */
    host: HTMLElement;
}

/** Returned handle for tests + the orchestrator. */
export interface PropertiesPanelHandle {
    readonly panel: HTMLElement;
    readonly inputs: {
        readonly shapeColor: HTMLInputElement;
        readonly borderColor: HTMLInputElement;
        readonly fillOpacity: HTMLInputElement;
        readonly borderOpacity: HTMLInputElement;
        readonly text: HTMLInputElement;
        readonly fontSize: HTMLInputElement;
        readonly fontSizeInput: HTMLInputElement;
    };
    /** Manually re-pull the current selection's values into the inputs. */
    refresh(): void;
    /** Detach listeners + remove DOM. */
    dispose(): void;
}

/**
 * Build the DOM-backed two-way-binding panel. Hidden whenever the selection
 * isn't exactly one element.
 */
export function mountPropertiesPanel(options: PropertiesPanelOptions): PropertiesPanelHandle {
    const { elementManager, selectionManager, host } = options;

    const panel = document.createElement('div');
    panel.id = PROPERTIES_PANEL_ID;
    panel.className = 'iv-properties-panel';
    setVisible(panel, false);

    const shapeColor = makeRow(panel, 'Color', SHAPE_COLOR_ID, 'color');
    const borderColor = makeRow(panel, 'Border', BORDER_COLOR_ID, 'color');
    const fillOpacity = makeRow(panel, 'Opacity', FILL_OPACITY_ID, 'range', {
        min: '0',
        max: '100',
        step: '1',
        valueId: FILL_OPACITY_VALUE_ID
    });
    const borderOpacity = makeRow(panel, 'Border opacity', BORDER_OPACITY_ID, 'range', {
        min: '0',
        max: '100',
        step: '1',
        valueId: BORDER_OPACITY_VALUE_ID
    });
    const text = makeRow(panel, 'Text', TEXT_INPUT_ID, 'text');
    const fontSize = makeRow(panel, 'Font size', FONT_SIZE_ID, 'range', {
        min: '6',
        max: '128',
        step: '1'
    });
    const fontSizeInput = makeRow(panel, 'Font size (px)', FONT_SIZE_INPUT_ID, 'number', {
        min: '6',
        max: '256',
        step: '1'
    });

    host.appendChild(panel);

    const inputs = {
        shapeColor: shapeColor.input,
        borderColor: borderColor.input,
        fillOpacity: fillOpacity.input,
        borderOpacity: borderOpacity.input,
        text: text.input,
        fontSize: fontSize.input,
        fontSizeInput: fontSizeInput.input
    } as const;

    /**
     * Pull selection state into the inputs. Hides the panel when the
     * selection isn't exactly one element (handles + panel must be in
     * sync per the issue's DoD).
     */
    const refresh = (): void => {
        const ids = selectionManager.list();
        if (ids.length !== 1) {
            setVisible(panel, false);
            return;
        }
        const data = elementManager.getById(ids[0]);
        if (!data) {
            setVisible(panel, false);
            return;
        }

        const props = computeBoundProperties(data);
        const visibility = computeRowVisibility(data);

        setVisible(panel, true);
        setVisible(shapeColor.row, visibility.shapeColor);
        setVisible(borderColor.row, visibility.borderColor);
        setVisible(fillOpacity.row, visibility.fillOpacity);
        setVisible(borderOpacity.row, visibility.borderOpacity);
        setVisible(text.row, visibility.text);
        setVisible(fontSize.row, visibility.fontSize);
        setVisible(fontSizeInput.row, visibility.fontSize);

        inputs.shapeColor.value = props.shapeColor;
        inputs.borderColor.value = props.borderColor;
        inputs.fillOpacity.value = String(props.fillOpacity);
        inputs.borderOpacity.value = String(props.borderOpacity);
        inputs.text.value = props.text;
        inputs.fontSize.value = String(props.fontSize);
        inputs.fontSizeInput.value = String(props.fontSize);

        if (fillOpacity.valueLabel) fillOpacity.valueLabel.textContent = `${props.fillOpacity}%`;
        if (borderOpacity.valueLabel) borderOpacity.valueLabel.textContent = `${props.borderOpacity}%`;
    };

    /**
     * Bind one input -> ElementManager.update path. The reducer
     * (`applyPropertyChange`) handles all the sanitisation; this just
     * resolves the current selection + dispatches the update.
     */
    const onPropertyEdit = (key: PropertyKey, rawValue: string): void => {
        const ids = selectionManager.list();
        if (ids.length !== 1) return;
        const data = elementManager.getById(ids[0]);
        if (!data) return;
        const partial = applyPropertyChange(data, key, rawValue);
        if (!partial) return;
        elementManager.update(ids[0], partial);
    };

    const handlers: Array<[HTMLInputElement, string, EventListener]> = [];
    const bind = (input: HTMLInputElement, key: PropertyKey, eventName: string, after?: () => void): void => {
        const handler: EventListener = () => {
            onPropertyEdit(key, input.value);
            after?.();
        };
        input.addEventListener(eventName, handler);
        handlers.push([input, eventName, handler]);
    };

    bind(inputs.shapeColor, 'shapeColor', 'input');
    bind(inputs.borderColor, 'borderColor', 'input');
    bind(inputs.fillOpacity, 'fillOpacity', 'input', () => {
        if (fillOpacity.valueLabel) fillOpacity.valueLabel.textContent = `${inputs.fillOpacity.value}%`;
    });
    bind(inputs.borderOpacity, 'borderOpacity', 'input', () => {
        if (borderOpacity.valueLabel) borderOpacity.valueLabel.textContent = `${inputs.borderOpacity.value}%`;
    });
    bind(inputs.text, 'text', 'input');
    bind(inputs.fontSize, 'fontSize', 'input', () => {
        inputs.fontSizeInput.value = inputs.fontSize.value;
    });
    bind(inputs.fontSizeInput, 'fontSize', 'input', () => {
        inputs.fontSize.value = inputs.fontSizeInput.value;
    });

    const selectionUnsub = selectionManager.subscribe(() => refresh());
    // Re-pull when the element list mutates so a delete that drops the
    // single selection hides the panel.
    const elementUnsub = elementManager.subscribe(() => refresh());

    refresh();

    const dispose = (): void => {
        for (const [input, eventName, handler] of handlers) {
            input.removeEventListener(eventName, handler);
        }
        selectionUnsub();
        elementUnsub();
        if (panel.parentElement) {
            panel.parentElement.removeChild(panel);
        }
    };

    return { panel, inputs, refresh, dispose };
}

interface MakeRowOptions {
    min?: string;
    max?: string;
    step?: string;
    valueId?: string;
}

interface RowHandle {
    row: HTMLElement;
    input: HTMLInputElement;
    valueLabel: HTMLElement | null;
}

/** Build one `.iv-prop-row` (label + input). Optionally renders a value label. */
function makeRow(
    panel: HTMLElement,
    labelText: string,
    inputId: string,
    inputType: string,
    extra: MakeRowOptions = {}
): RowHandle {
    const row = document.createElement('div');
    row.className = 'iv-prop-row';

    const label = document.createElement('label');
    label.className = 'iv-prop-label';
    label.htmlFor = inputId;
    label.textContent = labelText;
    row.appendChild(label);

    const input = document.createElement('input');
    input.className = 'iv-prop-input';
    input.id = inputId;
    input.type = inputType;
    if (extra.min !== undefined) input.min = extra.min;
    if (extra.max !== undefined) input.max = extra.max;
    if (extra.step !== undefined) input.step = extra.step;
    row.appendChild(input);

    let valueLabel: HTMLElement | null = null;
    if (extra.valueId) {
        valueLabel = document.createElement('span');
        valueLabel.id = extra.valueId;
        valueLabel.className = 'iv-prop-value';
        row.appendChild(valueLabel);
    }

    panel.appendChild(row);
    return { row, input, valueLabel };
}
