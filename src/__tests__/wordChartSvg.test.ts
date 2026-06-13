// Unit tests for the chart-XML → SVG converter (issue #45).
//
// Coverage:
//   - `parseChartXml` recognises `<c:lineChart>` and `<c:barChart>`,
//     pulls series names from `<c:tx><c:strRef><c:strCache>` (or the
//     literal `<c:tx><c:v>`), and reads numeric values from
//     `<c:val><c:numRef><c:numCache>`.
//   - Categories are pulled from the first series.
//   - Other chart kinds (pie, scatter, area) report `unsupported`.
//   - Malformed / empty input falls back to `unsupported` rather than
//     throwing.
//   - `renderChartSvg` returns a self-contained SVG document with a
//     `<svg>` root, includes a `<polyline>` for line charts and one
//     `<rect>` per data point for bar charts, and prints the title +
//     legend when provided.
//
// All XML parsing uses jsdom's built-in DOMParser, so no extra setup
// is required.

import {
    parseChartXml,
    renderChartSvg,
    WordChartData
} from '../templates/word/js/wordChartSvg';

const NS_HEAD =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"` +
    ` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"` +
    ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`;
const NS_TAIL = `</c:chartSpace>`;

function lineChart(): string {
    return (
        NS_HEAD +
        `<c:chart>` +
        `<c:title>` +
        `<c:tx><c:rich>` +
        `<a:p><a:r><a:t>Sales by Quarter</a:t></a:r></a:p>` +
        `</c:rich></c:tx>` +
        `</c:title>` +
        `<c:plotArea>` +
        `<c:lineChart>` +
        `<c:ser>` +
        `<c:idx val="0"/>` +
        `<c:tx><c:strRef><c:f>Sheet1!$B$1</c:f>` +
        `<c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Revenue</c:v></c:pt></c:strCache>` +
        `</c:strRef></c:tx>` +
        `<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$5</c:f>` +
        `<c:strCache>` +
        `<c:ptCount val="4"/>` +
        `<c:pt idx="0"><c:v>Q1</c:v></c:pt>` +
        `<c:pt idx="1"><c:v>Q2</c:v></c:pt>` +
        `<c:pt idx="2"><c:v>Q3</c:v></c:pt>` +
        `<c:pt idx="3"><c:v>Q4</c:v></c:pt>` +
        `</c:strCache></c:strRef></c:cat>` +
        `<c:val><c:numRef><c:f>Sheet1!$B$2:$B$5</c:f>` +
        `<c:numCache>` +
        `<c:formatCode>General</c:formatCode>` +
        `<c:ptCount val="4"/>` +
        `<c:pt idx="0"><c:v>10</c:v></c:pt>` +
        `<c:pt idx="1"><c:v>20</c:v></c:pt>` +
        `<c:pt idx="2"><c:v>15</c:v></c:pt>` +
        `<c:pt idx="3"><c:v>30</c:v></c:pt>` +
        `</c:numCache></c:numRef></c:val>` +
        `</c:ser>` +
        `</c:lineChart>` +
        `</c:plotArea>` +
        `</c:chart>` +
        NS_TAIL
    );
}

function barChartTwoSeries(): string {
    return (
        NS_HEAD +
        `<c:chart><c:plotArea>` +
        `<c:barChart>` +
        `<c:barDir val="col"/>` +
        `<c:ser>` +
        `<c:idx val="0"/>` +
        `<c:tx><c:v>Plan</c:v></c:tx>` +
        `<c:cat><c:strLit>` +
        `<c:ptCount val="3"/>` +
        `<c:pt idx="0"><c:v>A</c:v></c:pt>` +
        `<c:pt idx="1"><c:v>B</c:v></c:pt>` +
        `<c:pt idx="2"><c:v>C</c:v></c:pt>` +
        `</c:strLit></c:cat>` +
        `<c:val><c:numLit>` +
        `<c:ptCount val="3"/>` +
        `<c:pt idx="0"><c:v>5</c:v></c:pt>` +
        `<c:pt idx="1"><c:v>9</c:v></c:pt>` +
        `<c:pt idx="2"><c:v>3</c:v></c:pt>` +
        `</c:numLit></c:val>` +
        `</c:ser>` +
        `<c:ser>` +
        `<c:idx val="1"/>` +
        `<c:tx><c:v>Actual</c:v></c:tx>` +
        `<c:val><c:numLit>` +
        `<c:ptCount val="3"/>` +
        `<c:pt idx="0"><c:v>4</c:v></c:pt>` +
        `<c:pt idx="1"><c:v>11</c:v></c:pt>` +
        `<c:pt idx="2"><c:v>2</c:v></c:pt>` +
        `</c:numLit></c:val>` +
        `</c:ser>` +
        `</c:barChart>` +
        `</c:plotArea></c:chart>` +
        NS_TAIL
    );
}

function pieChart(): string {
    return (
        NS_HEAD +
        `<c:chart><c:plotArea>` +
        `<c:pieChart>` +
        `<c:ser>` +
        `<c:idx val="0"/>` +
        `<c:val><c:numLit>` +
        `<c:ptCount val="2"/>` +
        `<c:pt idx="0"><c:v>1</c:v></c:pt>` +
        `<c:pt idx="1"><c:v>2</c:v></c:pt>` +
        `</c:numLit></c:val>` +
        `</c:ser>` +
        `</c:pieChart>` +
        `</c:plotArea></c:chart>` +
        NS_TAIL
    );
}

describe('parseChartXml', () => {
    it('parses a line chart with one series and category labels', () => {
        const data = parseChartXml(lineChart());
        expect(data.type).toBe('line');
        expect(data.title).toBe('Sales by Quarter');
        expect(data.categories).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
        expect(data.series).toHaveLength(1);
        expect(data.series[0].name).toBe('Revenue');
        expect(data.series[0].values).toEqual([10, 20, 15, 30]);
    });

    it('parses a bar chart with two literal-value series', () => {
        const data = parseChartXml(barChartTwoSeries());
        expect(data.type).toBe('bar');
        expect(data.series.map((s) => s.name)).toEqual(['Plan', 'Actual']);
        expect(data.series[0].values).toEqual([5, 9, 3]);
        expect(data.series[1].values).toEqual([4, 11, 2]);
        expect(data.categories).toEqual(['A', 'B', 'C']);
    });

    it('reports unsupported for chart kinds we do not handle', () => {
        const data = parseChartXml(pieChart());
        expect(data.type).toBe('unsupported');
        expect(data.series).toEqual([]);
    });

    it('falls back to unsupported on malformed XML', () => {
        const data = parseChartXml('<not-a-chart');
        expect(data.type).toBe('unsupported');
    });

    it('falls back to unsupported on empty input', () => {
        expect(parseChartXml('').type).toBe('unsupported');
        expect(parseChartXml(undefined as unknown as string).type).toBe(
            'unsupported'
        );
    });

    it('respects pt @idx ordering when entries are out of order', () => {
        const xml =
            NS_HEAD +
            `<c:chart><c:plotArea><c:lineChart>` +
            `<c:ser>` +
            `<c:tx><c:v>S</c:v></c:tx>` +
            `<c:val><c:numLit>` +
            `<c:ptCount val="3"/>` +
            `<c:pt idx="2"><c:v>30</c:v></c:pt>` +
            `<c:pt idx="0"><c:v>10</c:v></c:pt>` +
            `<c:pt idx="1"><c:v>20</c:v></c:pt>` +
            `</c:numLit></c:val>` +
            `</c:ser>` +
            `</c:lineChart></c:plotArea></c:chart>` +
            NS_TAIL;
        const data = parseChartXml(xml);
        expect(data.series[0].values).toEqual([10, 20, 30]);
    });

    it('supplies a default series name when one is missing', () => {
        const xml =
            NS_HEAD +
            `<c:chart><c:plotArea><c:lineChart>` +
            `<c:ser>` +
            `<c:val><c:numLit>` +
            `<c:ptCount val="2"/>` +
            `<c:pt idx="0"><c:v>1</c:v></c:pt>` +
            `<c:pt idx="1"><c:v>2</c:v></c:pt>` +
            `</c:numLit></c:val>` +
            `</c:ser>` +
            `</c:lineChart></c:plotArea></c:chart>` +
            NS_TAIL;
        const data = parseChartXml(xml);
        expect(data.series[0].name).toBe('Series 1');
    });
});

describe('renderChartSvg', () => {
    it('emits an SVG root with width / height attributes', () => {
        const data = parseChartXml(lineChart());
        const svg = renderChartSvg(data);
        expect(svg.startsWith('<svg')).toBe(true);
        expect(svg.endsWith('</svg>')).toBe(true);
        expect(svg).toMatch(/width="\d+"/);
        expect(svg).toMatch(/height="\d+"/);
        expect(svg).toMatch(/xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    });

    it('renders a polyline for line charts', () => {
        const data = parseChartXml(lineChart());
        const svg = renderChartSvg(data);
        expect(svg).toMatch(/<polyline /);
        expect(svg).toContain('Sales by Quarter');
        expect(svg).toContain('Revenue');
    });

    it('renders one rect per data point for bar charts', () => {
        const data = parseChartXml(barChartTwoSeries());
        const svg = renderChartSvg(data);
        // 2 series × 3 categories = 6 data rects, plus the plot-area
        // background rect and the chart background. Look for at least 6
        // non-background rects.
        const rectMatches = svg.match(/<rect /g) || [];
        expect(rectMatches.length).toBeGreaterThanOrEqual(6 + 2);
        // Each series name should appear in the legend.
        expect(svg).toContain('Plan');
        expect(svg).toContain('Actual');
    });

    it('returns a placeholder for unsupported chart types', () => {
        const data: WordChartData = {
            type: 'unsupported',
            categories: [],
            series: []
        };
        const svg = renderChartSvg(data);
        expect(svg).toContain('Unsupported chart type');
        // No data series → no polyline / data rect markup.
        expect(svg).not.toMatch(/<polyline /);
    });

    it('escapes XML special characters in titles + series names', () => {
        const data: WordChartData = {
            type: 'line',
            title: 'Q1 < Q2 & Q3',
            categories: [],
            series: [
                {
                    name: 'a&b',
                    values: [1, 2, 3]
                }
            ]
        };
        const svg = renderChartSvg(data);
        expect(svg).toContain('Q1 &lt; Q2 &amp; Q3');
        expect(svg).toContain('a&amp;b');
        expect(svg).not.toContain('Q1 < Q2 & Q3');
    });

    it('parses + renders the line-chart fixture round-trip without crashing', () => {
        // Mirrors the DoD: 1 chart correctly displayed.
        const data = parseChartXml(lineChart());
        const svg = renderChartSvg(data);
        expect(svg.length).toBeGreaterThan(200);
        // Title + series legend make it into the rendered SVG. (Category
        // tick labels are intentionally out of scope per issue #45 — the
        // category strings live on the parsed data only.)
        expect(svg).toContain('Sales by Quarter');
        expect(svg).toContain('Revenue');
        expect(data.categories).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
        // jsdom can parse the produced SVG end-to-end.
        const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
        expect(doc.documentElement.nodeName).toBe('svg');
        expect(
            doc.documentElement.getElementsByTagName('polyline').length
        ).toBeGreaterThan(0);
    });
});
