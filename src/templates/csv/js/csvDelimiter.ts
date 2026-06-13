// CSV delimiter auto-detection helpers (issue #34).
//
// Pure / DOM-less so the helper can be unit-tested under jsdom and reused by
// the global file-type sniffer (`src/utils/fileUtils/tabular.ts`).
//
// Algorithm summary
// -----------------
// 1. Take a small sample of leading lines (default N = 10) so detection is
//    O(sample). We split on LF after normalising CRLF/CR, but a quoted region
//    is allowed to span lines — when we reach the sample cap we cut at line
//    boundaries that fall *outside* of an open quote so the per-line counts
//    don't get poisoned by half a quoted record.
// 2. For each candidate (`,`, `;`, `\t`, `|`) count occurrences per sample
//    line, *only outside double-quoted regions*. `""` inside a quoted span is
//    the RFC-4180 escaped quote and stays inside the quote (i.e. doesn't
//    flip back to "outside").
// 3. Pick the candidate with the highest score:
//      - higher mean count per line wins,
//      - ties broken by lower variance (more consistent line-by-line),
//      - ties still tied broken by the priority order  `, > \t > ; > |`.
// 4. Confidence is a 0..1 number derived from how dominant the winner is
//    compared to the runner-up (callers can use it to decide whether to
//    surface a "delimiter looks ambiguous" hint, but the viewer just shows
//    the manual <select> regardless).

export type CsvDelimiter = ',' | ';' | '\t' | '|';

export interface DelimiterDetectionResult {
    delimiter: CsvDelimiter;
    confidence: number;
}

/** Order matters — earlier candidates win priority ties. */
export const DELIMITER_PRIORITY: readonly CsvDelimiter[] = [',', '\t', ';', '|'];

const DEFAULT_SAMPLE_LINES = 10;
const DEFAULT_DELIMITER: CsvDelimiter = ',';

export interface DetectOptions {
    /** Maximum number of leading lines to inspect (default 10). */
    sampleLines?: number;
}

/**
 * Detect the most likely delimiter in `text`.
 *
 * Always returns a result. When `text` has no candidates at all (e.g. a
 * single-column CSV with no delimiters) we fall back to `,` with
 * confidence 0 so callers can still parse deterministically.
 */
export function detectDelimiter(
    text: string,
    options: DetectOptions = {}
): DelimiterDetectionResult {
    const sampleLines = options.sampleLines ?? DEFAULT_SAMPLE_LINES;
    const lines = takeSampleLines(text, sampleLines);

    if (lines.length === 0) {
        return { delimiter: DEFAULT_DELIMITER, confidence: 0 };
    }

    interface Score {
        delimiter: CsvDelimiter;
        /** Count averaged over lines that actually contain the delimiter. */
        mean: number;
        variance: number;
        /** mean × (positive lines / total lines) — the value used for ranking. */
        score: number;
        priorityIndex: number;
    }

    const scores: Score[] = DELIMITER_PRIORITY.map((delimiter, priorityIndex) => {
        const counts = lines.map((line) => countOutsideQuotes(line, delimiter));
        const positive = counts.filter((c) => c > 0);
        const mean = positive.length === 0 ? 0 : sum(positive) / positive.length;
        const variance =
            positive.length === 0
                ? Number.POSITIVE_INFINITY
                : varianceOf(positive, mean);
        // Consistency factor: how many of the sample lines actually contain
        // this delimiter. We square it so a delimiter that fires on every
        // line is strongly preferred over one that fires on a single
        // high-count outlier (e.g. 4 lines of "a,b" vs one line with nine
        // pipes — the consistent comma should win).
        const consistency = positive.length / lines.length;
        const score = mean * consistency * consistency;
        return { delimiter, mean, variance, score, priorityIndex };
    });

    // Sort: highest score first, then lowest variance, then priority order.
    scores.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.variance !== b.variance) return a.variance - b.variance;
        return a.priorityIndex - b.priorityIndex;
    });

    const winner = scores[0];
    if (winner.score === 0) {
        return { delimiter: DEFAULT_DELIMITER, confidence: 0 };
    }

    const runnerUp = scores[1];
    const runnerScore = runnerUp ? runnerUp.score : 0;
    const total = winner.score + runnerScore;
    const confidence = total === 0 ? 0 : (winner.score - runnerScore) / total;

    return {
        delimiter: winner.delimiter,
        confidence: Math.max(0, Math.min(1, confidence))
    };
}

/**
 * Slice `text` into up to `max` "logical" lines for sampling.
 *
 * "Logical" means we only treat a `\n` as a line break when it falls outside
 * of an open double-quoted span, so a single CSV record that wraps lines
 * (e.g. `"a\nb",c`) is kept intact and not double-counted.
 */
function takeSampleLines(text: string, max: number): string[] {
    if (!text || max <= 0) return [];

    // Strip BOM and normalise line endings the same way csvParser does.
    const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const normalized = stripped.replace(/\r\n?/g, '\n');

    const out: string[] = [];
    let buf = '';
    let inQuotes = false;

    for (let i = 0; i < normalized.length; i++) {
        const ch = normalized[i];
        if (ch === '"') {
            // RFC-4180 `""` escape: stay inside the quoted region.
            if (inQuotes && normalized[i + 1] === '"') {
                buf += '""';
                i++;
                continue;
            }
            inQuotes = !inQuotes;
            buf += ch;
            continue;
        }
        if (ch === '\n' && !inQuotes) {
            if (buf.length > 0) out.push(buf);
            buf = '';
            if (out.length >= max) return out;
            continue;
        }
        buf += ch;
    }

    if (out.length < max && buf.length > 0) out.push(buf);
    return out;
}

/**
 * Count occurrences of `delimiter` in `line`, ignoring any inside a
 * double-quoted span. `""` is treated as an escaped quote (stays inside).
 */
export function countOutsideQuotes(line: string, delimiter: string): number {
    if (!delimiter) return 0;
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                i++;
                continue;
            }
            inQuotes = !inQuotes;
            continue;
        }
        if (!inQuotes && ch === delimiter) {
            count++;
        }
    }
    return count;
}

function sum(values: readonly number[]): number {
    let s = 0;
    for (const v of values) s += v;
    return s;
}

function varianceOf(values: readonly number[], mean: number): number {
    if (values.length <= 1) return 0;
    let acc = 0;
    for (const v of values) {
        const d = v - mean;
        acc += d * d;
    }
    return acc / values.length;
}

/**
 * Convenience wrapper: callers that already know the file extension can use
 * this to short-circuit detection for `.tsv` (which is unambiguously
 * tab-delimited) before falling through to content-based detection.
 */
export function detectDelimiterForFile(
    fileName: string,
    text: string,
    options: DetectOptions = {}
): DelimiterDetectionResult {
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.tsv')) {
        return { delimiter: '\t', confidence: 1 };
    }
    return detectDelimiter(text, options);
}
