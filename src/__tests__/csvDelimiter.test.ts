// Unit tests for the CSV delimiter auto-detector (issue #34).
//
// Coverage:
//   - 4 candidates (`,` / `;` / `\t` / `|`) auto-detected from realistic
//     fixtures (CSV, TSV, European semicolon-CSV, pipe-delimited log).
//   - Quote escaping: delimiters inside `"..."` regions are NOT counted, and
//     the RFC-4180 `""` escape stays inside the quoted span.
//   - Quoted newlines: a record that wraps across a `\n` inside quotes is
//     treated as one logical line (no double-counting).
//   - Tie-break priority order: `, > \t > ; > |`.
//   - `.tsv` filename short-circuit picks tab regardless of content.
//   - countOutsideQuotes helper edge-cases.

import {
    countOutsideQuotes,
    detectDelimiter,
    detectDelimiterForFile
} from '../templates/csv/js/csvDelimiter';

describe('detectDelimiter', () => {
    it('picks "," for a comma-dominant CSV', () => {
        const text = [
            'name,age,city',
            'Alice,30,Seoul',
            'Bob,25,Busan',
            'Carol,40,Incheon'
        ].join('\n');
        const result = detectDelimiter(text);
        expect(result.delimiter).toBe(',');
        expect(result.confidence).toBeGreaterThan(0);
    });

    it('picks "\\t" for a TSV body', () => {
        const text = [
            'name\tage\tcity',
            'Alice\t30\tSeoul',
            'Bob\t25\tBusan'
        ].join('\n');
        const result = detectDelimiter(text);
        expect(result.delimiter).toBe('\t');
    });

    it('picks ";" for European-style decimal CSV', () => {
        // Commas appear inside quoted decimal numbers — they must not win.
        const text = [
            'product;price;notes',
            'Widget;"1,50";"good, cheap"',
            'Gadget;"2,75";"medium"',
            'Doohickey;"3,99";"premium"'
        ].join('\n');
        const result = detectDelimiter(text);
        expect(result.delimiter).toBe(';');
    });

    it('picks "|" for pipe-delimited logs', () => {
        const text = [
            'ts|level|message',
            '2026-05-08T10:00:00Z|INFO|server started',
            '2026-05-08T10:00:01Z|WARN|slow query',
            '2026-05-08T10:00:02Z|ERROR|connection refused'
        ].join('\n');
        const result = detectDelimiter(text);
        expect(result.delimiter).toBe('|');
    });

    it('does not count delimiters inside quoted fields', () => {
        // A pure single-row case: 2 commas total, both inside quotes.
        // Without quote handling the detector would prefer ",". With proper
        // handling no candidate has any *outside-quotes* count, so we fall
        // back to the default "," with confidence 0.
        const line = '"a,b","c,d"';
        expect(countOutsideQuotes(line, ',')).toBe(1);
        // A strictly single-pair line: `"a,b"` has zero commas outside quotes.
        expect(countOutsideQuotes('"a,b"', ',')).toBe(0);
        expect(countOutsideQuotes('"a,b","c,d"', ';')).toBe(0);
    });

    it('handles RFC-4180 escaped quotes inside quoted fields', () => {
        // Unterminated quoted span: the `""` is an escaped quote and stays
        // inside, so the comma in `hi,there` is also inside (not counted).
        const unterminated = '"he said ""hi,there""';
        expect(countOutsideQuotes(unterminated, ',')).toBe(0);
        // Properly terminated quoted span followed by `,"ok"`: one outside.
        const terminated = '"he said ""hi,there""","ok"';
        expect(countOutsideQuotes(terminated, ',')).toBe(1);
    });

    it('treats quoted newlines as part of the same record', () => {
        // The 2nd record spans a newline inside its first field. The
        // detector must not split it into two sample lines and must not
        // count the `,` inside the quoted span.
        const text = [
            'a,b',
            '"line1',
            'line2",x',
            'p,q'
        ].join('\n');
        const result = detectDelimiter(text);
        expect(result.delimiter).toBe(',');
    });

    it('breaks ties using priority order , > \\t > ; > |', () => {
        // Each line has exactly one of every candidate so all have equal
        // mean (1) and equal variance (0). Priority must pick `,`.
        const text = [
            'a,b\tc;d|e',
            'f,g\th;i|j',
            'k,l\tm;n|o'
        ].join('\n');
        const result = detectDelimiter(text);
        expect(result.delimiter).toBe(',');
    });

    it('prefers \\t over ; when both have equal counts (priority)', () => {
        const text = ['a\tb;c', 'd\te;f', 'g\th;i'].join('\n');
        const result = detectDelimiter(text);
        expect(result.delimiter).toBe('\t');
    });

    it('falls back to "," with confidence 0 for delimiter-less input', () => {
        const result = detectDelimiter('just-one-column\nanother\nmore');
        expect(result.delimiter).toBe(',');
        expect(result.confidence).toBe(0);
    });

    it('handles empty input gracefully', () => {
        expect(detectDelimiter('').delimiter).toBe(',');
        expect(detectDelimiter('').confidence).toBe(0);
    });

    it('strips a leading BOM before sampling', () => {
        const text = '﻿a,b,c\nd,e,f\n';
        const result = detectDelimiter(text);
        expect(result.delimiter).toBe(',');
    });

    it('normalises CRLF and CR line endings', () => {
        const crlf = 'a;b;c\r\nd;e;f\r\ng;h;i';
        const cr = 'a|b|c\rd|e|f\rg|h|i';
        expect(detectDelimiter(crlf).delimiter).toBe(';');
        expect(detectDelimiter(cr).delimiter).toBe('|');
    });

    it('respects the sampleLines option', () => {
        // First two lines are pipe-only, the rest is comma. With sample = 2
        // the detector should see only the pipe header and pick "|".
        const text = [
            'a|b|c',
            'd|e|f',
            'g,h,i,j,k',
            'l,m,n,o,p',
            'q,r,s,t,u'
        ].join('\n');
        expect(detectDelimiter(text, { sampleLines: 2 }).delimiter).toBe('|');
        expect(detectDelimiter(text, { sampleLines: 5 }).delimiter).toBe(',');
    });

    it('penalises delimiters that appear on only one of many lines', () => {
        // Pipe shows up many times but on a single line; comma appears once
        // per line every line. The consistent comma should win.
        const text = [
            'a,b',
            'a,b',
            'a,b',
            'a|b|c|d|e|f|g|h|i|j',
            'a,b'
        ].join('\n');
        const result = detectDelimiter(text);
        expect(result.delimiter).toBe(',');
    });
});

describe('detectDelimiterForFile', () => {
    it('forces "\\t" for .tsv files regardless of content', () => {
        const csvLikeBody = 'a,b,c\nd,e,f\n';
        const result = detectDelimiterForFile('data.tsv', csvLikeBody);
        expect(result.delimiter).toBe('\t');
        expect(result.confidence).toBe(1);
    });

    it('is case-insensitive for the .tsv suffix', () => {
        expect(detectDelimiterForFile('DATA.TSV', '').delimiter).toBe('\t');
    });

    it('falls through to content-based detection for .csv', () => {
        const text = 'a;b;c\nd;e;f\ng;h;i';
        const result = detectDelimiterForFile('data.csv', text);
        expect(result.delimiter).toBe(';');
    });
});

describe('countOutsideQuotes', () => {
    it('returns 0 for an empty delimiter', () => {
        expect(countOutsideQuotes('a,b,c', '')).toBe(0);
    });

    it('counts every occurrence when there are no quotes', () => {
        expect(countOutsideQuotes('a,b,c,d', ',')).toBe(3);
        expect(countOutsideQuotes('a||b||c', '|')).toBe(4);
    });

    it('ignores delimiters fully enclosed in a quoted span', () => {
        expect(countOutsideQuotes('"a,b,c"', ',')).toBe(0);
        expect(countOutsideQuotes('x,"a,b",y', ',')).toBe(2);
    });

    it('treats `""` inside quotes as an escaped quote', () => {
        // The quoted span is "he said ""hi"" then" — the comma after is
        // outside, so we count exactly one.
        expect(
            countOutsideQuotes('"he said ""hi"" then",end', ',')
        ).toBe(1);
    });
});
