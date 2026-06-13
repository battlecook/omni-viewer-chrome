import {
    PARQUET_BLOCK_THRESHOLD_BYTES,
    PARQUET_LIMIT_THRESHOLD_BYTES,
    formatBlockedMessage,
    formatLimitMessage,
    parquetSizeBucket,
} from '../templates/parquet/js/parquetSizeGuard';

const MB = 1024 * 1024;

describe('parquetSizeBucket', () => {
    it.each<[number, ReturnType<typeof parquetSizeBucket>]>([
        [0, 'small'],
        [1024, 'small'],
        [49.9 * MB, 'small'],
        [50 * MB - 1, 'small'],
        [50 * MB, 'limited'],
        [50.1 * MB, 'limited'],
        [149.9 * MB, 'limited'],
        [150 * MB - 1, 'limited'],
        [150 * MB, 'blocked'],
        [150.1 * MB, 'blocked'],
        [1024 * MB, 'blocked'],
    ])('size=%i -> %s', (bytes, expected) => {
        expect(parquetSizeBucket(bytes)).toBe(expected);
    });

    it('treats non-finite inputs as small (defensive)', () => {
        expect(parquetSizeBucket(-1)).toBe('small');
        expect(parquetSizeBucket(Number.NaN)).toBe('small');
        // Infinity is not a real file size — return small rather than
        // pretend it's a blocked file.
        expect(parquetSizeBucket(Number.POSITIVE_INFINITY)).toBe('small');
    });

    it('exposes documented thresholds', () => {
        expect(PARQUET_LIMIT_THRESHOLD_BYTES).toBe(50 * MB);
        expect(PARQUET_BLOCK_THRESHOLD_BYTES).toBe(150 * MB);
    });
});

describe('formatLimitMessage', () => {
    it('renders loaded / total when partial', () => {
        const msg = formatLimitMessage(10000, 250000n);
        expect(msg).toContain('10,000');
        expect(msg).toContain('250,000');
        expect(msg).toMatch(/Load more/i);
    });

    it('switches to "all loaded" when loaded ≥ total', () => {
        expect(formatLimitMessage(250000, 250000n)).toMatch(/All 250,000 rows loaded/i);
        expect(formatLimitMessage(300000, 250000n)).toMatch(/All 250,000 rows loaded/i);
    });

    it('accepts plain number for total too', () => {
        const msg = formatLimitMessage(100, 1000);
        expect(msg).toContain('100');
        expect(msg).toContain('1,000');
    });

    it('clamps loaded to non-negative integers', () => {
        const msg = formatLimitMessage(-5, 1000n);
        expect(msg).toContain('0');
    });
});

describe('formatBlockedMessage', () => {
    it('returns headline + detail with size in MB', () => {
        const m = formatBlockedMessage(200 * MB);
        expect(m.headline).toMatch(/too large/i);
        expect(m.detail).toContain('200.0 MB');
        expect(m.detail).toContain('150 MB');
    });

    it('mentions a desktop tool fallback', () => {
        const m = formatBlockedMessage(150 * MB);
        expect(m.detail).toMatch(/desktop tool/i);
    });
});
