import {
    isAbortedPdfLoad,
    reasonFromPdfJsResponse
} from '../templates/pdf/js/pdfPassword';

describe('reasonFromPdfJsResponse', () => {
    it('treats code 1 as initial', () => {
        expect(reasonFromPdfJsResponse(1)).toBe('initial');
    });
    it('treats code 2 as incorrect', () => {
        expect(reasonFromPdfJsResponse(2)).toBe('incorrect');
    });
    it('falls back to initial for unknown / undefined codes', () => {
        expect(reasonFromPdfJsResponse(undefined)).toBe('initial');
        expect(reasonFromPdfJsResponse(99)).toBe('initial');
    });
});

describe('isAbortedPdfLoad', () => {
    it('matches "Loading aborted"', () => {
        expect(isAbortedPdfLoad(new Error('Loading aborted'))).toBe(true);
    });
    it('matches "Worker was destroyed"', () => {
        expect(isAbortedPdfLoad(new Error('Worker was destroyed'))).toBe(true);
    });
    it('rejects other errors', () => {
        expect(isAbortedPdfLoad(new Error('Network failure'))).toBe(false);
        expect(isAbortedPdfLoad(undefined)).toBe(false);
        expect(isAbortedPdfLoad(null)).toBe(false);
    });
});
