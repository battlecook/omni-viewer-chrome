// Tiny chart-XML → SVG converter for the Chrome Word viewer (issue
// #45). DrawingML chart XML is huge; we only support the subset needed
// to surface a recognisable preview:
//
//   - `<c:lineChart>` series → polyline per series
//   - `<c:barChart>`  series → grouped vertical bars per series
//
// Out of scope (intentionally — see issue #45 pragmatic cuts):
//   - pie / doughnut / scatter / area / bubble / 3D / radar
//   - stacking modes (`<c:grouping val="stacked"/>` etc.)
//   - dual-axis, log scale, secondary axis
//   - rotated category labels, multi-line titles
//   - embedded data references (`<c:f>...</c:f>`) — we read the cached
//     numeric values from `<c:val><c:numRef><c:numCache>` /
//     `<c:val><c:numLit>`, which Office writes alongside the formula.
//
// All XML parsing uses `DOMParser`, which jsdom provides in tests.

export type WordChartType = 'line' | 'bar' | 'unsupported';

export interface WordChartSeries {
    /** Series display name (`<c:tx><c:strRef><c:strCache><c:pt><c:v>`). */
    name: string;
    /** Numeric Y values (in source order, holes stored as 0). */
    values: number[];
}

export interface WordChartData {
    type: WordChartType;
    /** Optional plot title pulled from `<c:title>`. */
    title?: string;
    /** Categories from the first series, if present. */
    categories: string[];
    series: WordChartSeries[];
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_PALETTE = [
    '#4f81bd',
    '#c0504d',
    '#9bbb59',
    '#8064a2',
    '#4bacc6',
    '#f79646',
    '#2c4d75',
    '#772c2a'
];

const CHART_WIDTH = 480;
const CHART_HEIGHT = 280;
const CHART_PADDING_TOP = 32;
const CHART_PADDING_BOTTOM = 36;
const CHART_PADDING_LEFT = 48;
const CHART_PADDING_RIGHT = 16;

function escapeXml(input: string): string {
    return input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * `getElementsByTagName` returns elements regardless of XML namespace,
 * but the names DrawingML uses include the `c:` prefix. jsdom's
 * `getElementsByTagName` matches both with and without the prefix when
 * the document is parsed as `application/xml`. We use it directly for
 * resilience.
 */
function findChildren(parent: Element | Document, localName: string): Element[] {
    // Match both `c:foo` and `foo` so we tolerate stripped namespaces.
    const direct = parent.getElementsByTagName(`c:${localName}`);
    if (direct.length > 0) return Array.from(direct);
    return Array.from(parent.getElementsByTagName(localName));
}

function firstChild(parent: Element | Document, localName: string): Element | null {
    const list = findChildren(parent, localName);
    return list.length > 0 ? list[0] : null;
}

function readTextValues(container: Element): string[] {
    // Cache values can live under `<c:numCache><c:pt><c:v>` for numeric
    // refs or `<c:strCache><c:pt><c:v>` for string refs. Either way we
    // collect every direct `<c:v>` descendant in source order.
    const points = findChildren(container, 'pt');
    const values: { idx: number; raw: string }[] = [];
    for (const pt of points) {
        const idxAttr = pt.getAttribute('idx');
        const idx = idxAttr ? Number.parseInt(idxAttr, 10) : values.length;
        const v = firstChild(pt, 'v');
        const raw = v ? v.textContent || '' : '';
        values.push({ idx: Number.isFinite(idx) ? idx : values.length, raw });
    }
    // Order by `idx` so the chart respects the writer's intent even
    // when entries are out of order in the source XML.
    values.sort((a, b) => a.idx - b.idx);
    return values.map((entry) => entry.raw);
}

function readNumericValues(container: Element): number[] {
    return readTextValues(container).map((raw) => {
        const n = Number.parseFloat(raw);
        return Number.isFinite(n) ? n : 0;
    });
}

function readSeriesName(serElement: Element): string {
    const tx = firstChild(serElement, 'tx');
    if (!tx) return '';
    // Plain literal: <c:tx><c:v>name</c:v></c:tx>
    const directV = firstChild(tx, 'v');
    if (directV && directV.parentElement === tx) {
        return (directV.textContent || '').trim();
    }
    const strRef = firstChild(tx, 'strRef');
    if (strRef) {
        const cache = firstChild(strRef, 'strCache');
        if (cache) {
            const vals = readTextValues(cache);
            if (vals.length > 0) return vals[0];
        }
    }
    return '';
}

function readSeriesValues(serElement: Element): number[] {
    const val = firstChild(serElement, 'val');
    if (val) {
        const numRef = firstChild(val, 'numRef');
        if (numRef) {
            const cache = firstChild(numRef, 'numCache');
            if (cache) return readNumericValues(cache);
        }
        const numLit = firstChild(val, 'numLit');
        if (numLit) return readNumericValues(numLit);
    }
    return [];
}

function readSeriesCategories(serElement: Element): string[] {
    const cat = firstChild(serElement, 'cat');
    if (!cat) return [];
    const strRef = firstChild(cat, 'strRef');
    if (strRef) {
        const cache = firstChild(strRef, 'strCache');
        if (cache) return readTextValues(cache);
    }
    const numRef = firstChild(cat, 'numRef');
    if (numRef) {
        const cache = firstChild(numRef, 'numCache');
        if (cache) return readTextValues(cache);
    }
    const strLit = firstChild(cat, 'strLit');
    if (strLit) return readTextValues(strLit);
    const numLit = firstChild(cat, 'numLit');
    if (numLit) return readTextValues(numLit);
    return [];
}

function readChartTitle(plotArea: Element | null, root: Element | Document): string | undefined {
    // Title lives on the chart, not the plotArea, so search the root.
    const title = firstChild(root, 'title');
    if (!title) return undefined;
    // Walk every <a:t> descendant and concatenate. (DrawingML text =
    // `<a:p><a:r><a:t>chunk</a:t></a:r></a:p>`.)
    const ts = title.getElementsByTagName('a:t');
    if (ts.length > 0) {
        return Array.from(ts)
            .map((t) => t.textContent || '')
            .join('')
            .trim() || undefined;
    }
    const fallback = title.getElementsByTagName('t');
    if (fallback.length > 0) {
        return Array.from(fallback)
            .map((t) => t.textContent || '')
            .join('')
            .trim() || undefined;
    }
    return undefined;
}

/**
 * Parse a DrawingML chart XML payload into a normalized
 * `WordChartData`. Returns `{ type: 'unsupported', ... }` instead of
 * throwing when the chart kind isn't line / bar so the caller can fall
 * back to a placeholder rather than break the whole panel.
 */
export function parseChartXml(xml: string): WordChartData {
    if (!xml || typeof xml !== 'string') {
        return { type: 'unsupported', categories: [], series: [] };
    }
    let doc: Document;
    try {
        const parser = new DOMParser();
        doc = parser.parseFromString(xml, 'application/xml');
    } catch {
        return { type: 'unsupported', categories: [], series: [] };
    }
    if (!doc || !doc.documentElement) {
        return { type: 'unsupported', categories: [], series: [] };
    }
    const root = doc.documentElement;
    if (root.getElementsByTagName('parsererror').length > 0) {
        return { type: 'unsupported', categories: [], series: [] };
    }

    const plotArea = firstChild(doc, 'plotArea');
    let typedRoot: Element | null = null;
    let chartType: WordChartType = 'unsupported';
    if (plotArea) {
        if (firstChild(plotArea, 'lineChart')) {
            chartType = 'line';
            typedRoot = firstChild(plotArea, 'lineChart');
        } else if (firstChild(plotArea, 'barChart')) {
            chartType = 'bar';
            typedRoot = firstChild(plotArea, 'barChart');
        }
    }

    const title = readChartTitle(plotArea, doc);

    if (!typedRoot) {
        return { type: 'unsupported', title, categories: [], series: [] };
    }

    const seriesElements = findChildren(typedRoot, 'ser');
    const series: WordChartSeries[] = [];
    let categories: string[] = [];
    for (let i = 0; i < seriesElements.length; i++) {
        const serEl = seriesElements[i];
        const name = readSeriesName(serEl) || `Series ${i + 1}`;
        const values = readSeriesValues(serEl);
        if (values.length === 0) continue;
        if (categories.length === 0) {
            categories = readSeriesCategories(serEl);
        }
        series.push({ name, values });
    }

    return { type: chartType, title, categories, series };
}

// --- SVG renderer -----------------------------------------------------

interface PlotBox {
    width: number;
    height: number;
    plotLeft: number;
    plotTop: number;
    plotWidth: number;
    plotHeight: number;
}

function plotBox(): PlotBox {
    const plotWidth = CHART_WIDTH - CHART_PADDING_LEFT - CHART_PADDING_RIGHT;
    const plotHeight = CHART_HEIGHT - CHART_PADDING_TOP - CHART_PADDING_BOTTOM;
    return {
        width: CHART_WIDTH,
        height: CHART_HEIGHT,
        plotLeft: CHART_PADDING_LEFT,
        plotTop: CHART_PADDING_TOP,
        plotWidth,
        plotHeight
    };
}

function computeRange(series: WordChartSeries[]): { min: number; max: number } {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const s of series) {
        for (const v of s.values) {
            if (!Number.isFinite(v)) continue;
            if (v < min) min = v;
            if (v > max) max = v;
        }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
        return { min: 0, max: 1 };
    }
    if (min === max) {
        // Spread so the bar / line is visible.
        if (min === 0) return { min: 0, max: 1 };
        return { min: Math.min(0, min), max: Math.max(0, max) || 1 };
    }
    // Always include the 0 baseline so bars have somewhere to grow from.
    if (min > 0) min = 0;
    if (max < 0) max = 0;
    return { min, max };
}

function fmtNumber(n: number): string {
    if (!Number.isFinite(n)) return '';
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(2).replace(/\.?0+$/, '');
}

function renderAxes(box: PlotBox, range: { min: number; max: number }): string {
    const baseY =
        box.plotTop +
        box.plotHeight -
        ((0 - range.min) / (range.max - range.min)) * box.plotHeight;
    const safeBase = Number.isFinite(baseY)
        ? Math.min(box.plotTop + box.plotHeight, Math.max(box.plotTop, baseY))
        : box.plotTop + box.plotHeight;
    const left = box.plotLeft;
    const right = box.plotLeft + box.plotWidth;
    const top = box.plotTop;
    const bottom = box.plotTop + box.plotHeight;
    const yTicks = [range.min, (range.min + range.max) / 2, range.max];
    const tickMarkup = yTicks
        .map((value) => {
            const y =
                bottom -
                ((value - range.min) / (range.max - range.min)) *
                    box.plotHeight;
            return (
                `<line x1="${left - 4}" x2="${left}" y1="${y.toFixed(2)}" y2="${y.toFixed(2)}" stroke="#888" stroke-width="1"/>` +
                `<text x="${left - 6}" y="${(y + 3).toFixed(2)}" text-anchor="end" font-size="10" fill="#555">${escapeXml(fmtNumber(value))}</text>`
            );
        })
        .join('');
    return (
        `<rect x="${left}" y="${top}" width="${box.plotWidth}" height="${box.plotHeight}" fill="#fafafa" stroke="#cccccc" stroke-width="1"/>` +
        `<line x1="${left}" x2="${right}" y1="${safeBase.toFixed(2)}" y2="${safeBase.toFixed(2)}" stroke="#888" stroke-width="1" stroke-dasharray="2 2"/>` +
        tickMarkup
    );
}

function renderLineSeries(
    series: WordChartSeries[],
    box: PlotBox,
    range: { min: number; max: number }
): string {
    const maxLength = series.reduce(
        (m, s) => Math.max(m, s.values.length),
        0
    );
    const denom = Math.max(maxLength - 1, 1);
    const span = range.max - range.min || 1;
    const out: string[] = [];
    series.forEach((s, i) => {
        const color = DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];
        const points: string[] = [];
        s.values.forEach((value, j) => {
            const x =
                box.plotLeft +
                (maxLength <= 1 ? box.plotWidth / 2 : (j / denom) * box.plotWidth);
            const y =
                box.plotTop +
                box.plotHeight -
                ((value - range.min) / span) * box.plotHeight;
            points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
        });
        out.push(
            `<polyline fill="none" stroke="${color}" stroke-width="2" points="${points.join(' ')}"/>`
        );
        s.values.forEach((value, j) => {
            const x =
                box.plotLeft +
                (maxLength <= 1 ? box.plotWidth / 2 : (j / denom) * box.plotWidth);
            const y =
                box.plotTop +
                box.plotHeight -
                ((value - range.min) / span) * box.plotHeight;
            out.push(
                `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="2.5" fill="${color}"/>`
            );
        });
    });
    return out.join('');
}

function renderBarSeries(
    series: WordChartSeries[],
    box: PlotBox,
    range: { min: number; max: number }
): string {
    const groupCount = series.reduce(
        (m, s) => Math.max(m, s.values.length),
        0
    );
    if (groupCount === 0) return '';
    const groupWidth = box.plotWidth / groupCount;
    const innerPadding = Math.min(8, groupWidth * 0.15);
    const barAreaWidth = Math.max(groupWidth - innerPadding, 4);
    const barWidth = barAreaWidth / Math.max(series.length, 1);
    const span = range.max - range.min || 1;
    const baselineY =
        box.plotTop +
        box.plotHeight -
        ((0 - range.min) / span) * box.plotHeight;
    const out: string[] = [];
    series.forEach((s, i) => {
        const color = DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];
        s.values.forEach((value, j) => {
            const groupLeft = box.plotLeft + j * groupWidth + innerPadding / 2;
            const x = groupLeft + i * barWidth;
            const valueY =
                box.plotTop +
                box.plotHeight -
                ((value - range.min) / span) * box.plotHeight;
            const y = Math.min(baselineY, valueY);
            const h = Math.max(Math.abs(valueY - baselineY), 1);
            out.push(
                `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(barWidth - 1).toFixed(2)}" height="${h.toFixed(2)}" fill="${color}"/>`
            );
        });
    });
    return out.join('');
}

function renderLegend(series: WordChartSeries[]): string {
    if (series.length === 0) return '';
    const swatchSize = 10;
    const lineHeight = 14;
    const x = CHART_PADDING_LEFT;
    const y = CHART_HEIGHT - CHART_PADDING_BOTTOM + 14;
    return series
        .map((s, i) => {
            const color = DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];
            // Distribute legend entries on a single row, wrapping after a
            // rough character budget.
            const offsetX = x + i * 110;
            const offsetY = y + Math.floor(i / 4) * lineHeight;
            return (
                `<rect x="${offsetX}" y="${offsetY - swatchSize + 2}" width="${swatchSize}" height="${swatchSize}" fill="${color}"/>` +
                `<text x="${offsetX + swatchSize + 4}" y="${offsetY}" font-size="10" fill="#333">${escapeXml(s.name)}</text>`
            );
        })
        .join('');
}

function renderTitle(title: string | undefined): string {
    if (!title) return '';
    return `<text x="${CHART_WIDTH / 2}" y="18" text-anchor="middle" font-size="13" font-weight="600" fill="#222">${escapeXml(title)}</text>`;
}

/**
 * Render `WordChartData` to a self-contained SVG string suitable for
 * inlining via `innerHTML`. Unsupported chart types render a
 * placeholder so the surrounding layout stays stable.
 */
export function renderChartSvg(data: WordChartData): string {
    const box = plotBox();
    const header = `<svg xmlns="${SVG_NS}" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" width="${CHART_WIDTH}" height="${CHART_HEIGHT}" role="img">`;
    const footer = '</svg>';

    if (data.type === 'unsupported' || data.series.length === 0) {
        const message =
            data.type === 'unsupported'
                ? 'Unsupported chart type'
                : 'Chart has no data';
        const titleMarkup = renderTitle(data.title);
        return (
            header +
            `<rect x="0" y="0" width="${CHART_WIDTH}" height="${CHART_HEIGHT}" fill="#fafafa" stroke="#dddddd"/>` +
            titleMarkup +
            `<text x="${CHART_WIDTH / 2}" y="${CHART_HEIGHT / 2}" text-anchor="middle" font-size="12" fill="#888">${escapeXml(message)}</text>` +
            footer
        );
    }

    const range = computeRange(data.series);
    const axes = renderAxes(box, range);
    const seriesMarkup =
        data.type === 'line'
            ? renderLineSeries(data.series, box, range)
            : renderBarSeries(data.series, box, range);
    const titleMarkup = renderTitle(data.title);
    const legend = renderLegend(data.series);

    return (
        header +
        `<rect x="0" y="0" width="${CHART_WIDTH}" height="${CHART_HEIGHT}" fill="#ffffff"/>` +
        titleMarkup +
        axes +
        seriesMarkup +
        legend +
        footer
    );
}
