// Browser-side tabular helpers for omni-viewer-chrome.
//
// Issue #3 only needs the delimiter detection helper used by the text-based
// viewer-type sniffer. Full CSV / JSON / Parquet parsing is owned by the
// per-viewer issues.
//
// Issue #34 ships a richer detector (mean / variance / priority tie-break +
// quote-aware) in `src/templates/csv/js/csvDelimiter.ts`. We re-export it
// here so any future global sniffer can opt into the richer signal, while
// the existing array-based `detectDelimiter(string[])` API below stays
// untouched for #3 callers.

import { extOf } from './media';

export {
    detectDelimiter as detectCsvDelimiter,
    detectDelimiterForFile as detectCsvDelimiterForFile,
    countOutsideQuotes as countDelimiterOutsideQuotes
} from '../../templates/csv/js/csvDelimiter';
export type {
    CsvDelimiter,
    DelimiterDetectionResult,
    DetectOptions as CsvDelimiterDetectOptions
} from '../../templates/csv/js/csvDelimiter';

const DEFAULT_DELIMITER = ',';

export function getDelimitedFileDelimiter(fileName: string, lines: string[] = []): string {
    const ext = extOf(fileName);
    if (ext === '.tsv') {
        return '\t';
    }
    if (ext === '.csv') {
        const detected = detectDelimiter(lines);
        return detected ?? DEFAULT_DELIMITER;
    }
    return detectDelimiter(lines) ?? DEFAULT_DELIMITER;
}

export function detectDelimiter(lines: string[]): string | null {
    const sampleLines = lines
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, 10);

    if (sampleLines.length === 0) {
        return null;
    }

    const candidates = [',', ';', '\t', '|'];
    let bestDelimiter: string | null = null;
    let bestScore = 0;

    for (const candidate of candidates) {
        const counts = sampleLines.map((line) => countDelimiterOccurrences(line, candidate));
        const positiveCounts = counts.filter((count) => count > 0);

        if (positiveCounts.length === 0) {
            continue;
        }

        const consistencyScore = positiveCounts.length;
        const densityScore = positiveCounts.reduce((sum, count) => sum + count, 0);
        const score = consistencyScore * 100 + densityScore;

        if (score > bestScore) {
            bestScore = score;
            bestDelimiter = candidate;
        }
    }

    return bestDelimiter;
}

function countDelimiterOccurrences(line: string, delimiter: string): number {
    let count = 0;
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (char === '"') {
            if (inQuotes && line[i + 1] === '"') {
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === delimiter && !inQuotes) {
            count++;
        }
    }

    return count;
}
