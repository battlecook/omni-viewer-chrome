import {
    clampMenuPosition,
    copyCellValue,
    copyColumn,
    copyRowAsJson,
    stringifyForCopy,
} from '../templates/parquet/js/parquetContextMenu';

describe('clampMenuPosition', () => {
    it('returns desired position when it fits', () => {
        const pos = clampMenuPosition({
            desiredX: 100,
            desiredY: 200,
            menuWidth: 200,
            menuHeight: 100,
            viewportWidth: 1000,
            viewportHeight: 800,
        });
        expect(pos).toEqual({ left: 100, top: 200 });
    });

    it('shifts left when right-overflow', () => {
        const pos = clampMenuPosition({
            desiredX: 950,
            desiredY: 200,
            menuWidth: 200,
            menuHeight: 100,
            viewportWidth: 1000,
            viewportHeight: 800,
        });
        expect(pos.left).toBe(1000 - 200 - 4);
    });

    it('shifts up when bottom-overflow', () => {
        const pos = clampMenuPosition({
            desiredX: 100,
            desiredY: 750,
            menuWidth: 200,
            menuHeight: 100,
            viewportWidth: 1000,
            viewportHeight: 800,
        });
        expect(pos.top).toBe(800 - 100 - 4);
    });

    it('clamps to top-left margin when negative input', () => {
        const pos = clampMenuPosition({
            desiredX: -50,
            desiredY: -50,
            menuWidth: 200,
            menuHeight: 100,
            viewportWidth: 1000,
            viewportHeight: 800,
            margin: 8,
        });
        expect(pos).toEqual({ left: 8, top: 8 });
    });
});

describe('stringifyForCopy', () => {
    it.each<[unknown, string]>([
        [null, ''],
        [undefined, ''],
        [42, '42'],
        [true, 'true'],
        [false, 'false'],
        ['hello', 'hello'],
        [42n, '42'],
        [{ a: 1 }, '{"a":1}'],
    ])('value=%p → %s', (input, expected) => {
        expect(stringifyForCopy(input)).toBe(expected);
    });
});

describe('copyCellValue / copyColumn / copyRowAsJson', () => {
    const headers = ['id', 'name', 'amount'];
    const rows = [
        [1, 'Alice', 1000],
        [2, 'Bob', 2500n],
        [3, null, 999],
    ];

    it('copyCellValue extracts a single cell', () => {
        expect(copyCellValue(rows[0], 1)).toBe('Alice');
        expect(copyCellValue(rows[1], 2)).toBe('2500');
        expect(copyCellValue(rows[2], 1)).toBe('');
    });

    it('copyCellValue returns empty for invalid index', () => {
        expect(copyCellValue(rows[0], -1)).toBe('');
        expect(copyCellValue(rows[0], 99)).toBe('');
    });

    it('copyColumn joins with newline', () => {
        const out = copyColumn(rows, 0);
        expect(out).toBe('1\n2\n3');
    });

    it('copyColumn handles bigint cells', () => {
        const out = copyColumn(rows, 2);
        expect(out).toBe('1000\n2500\n999');
    });

    it('copyRowAsJson serializes objects with header keys', () => {
        const out = copyRowAsJson(rows[0], headers);
        const parsed = JSON.parse(out);
        expect(parsed).toEqual({ id: 1, name: 'Alice', amount: 1000 });
    });

    it('copyRowAsJson stringifies bigint values', () => {
        const out = copyRowAsJson(rows[1], headers);
        const parsed = JSON.parse(out);
        expect(parsed.amount).toBe('2500');
    });

    it('copyRowAsJson tolerates header / row count mismatch', () => {
        const short = ['id'];
        const out = copyRowAsJson(rows[0], short);
        expect(JSON.parse(out)).toEqual({ id: 1 });
    });
});
