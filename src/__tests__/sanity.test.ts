import { escapeJsonForHtmlScriptTag } from '../utils/htmlEscaping';

describe('jest harness sanity', () => {
    it('runs basic assertions in jsdom', () => {
        expect(1 + 1).toBe(2);
    });

    it('compiles and executes project TypeScript via ts-jest', () => {
        const escaped = escapeJsonForHtmlScriptTag('<script>alert(1)</script>');
        expect(escaped).not.toContain('<script>');
        expect(escaped).toContain('\\u003Cscript\\u003E');
    });

    it('exposes a stubbed chrome global with jest spies', () => {
        expect(typeof chrome).toBe('object');
        expect(chrome.runtime.getURL('viewer.html')).toBe(
            'chrome-extension://omni-viewer-test/viewer.html'
        );
        expect(jest.isMockFunction(chrome.runtime.sendMessage)).toBe(true);
    });

    it('exposes a stubbed fetch returning an empty Response', async () => {
        expect(jest.isMockFunction(fetch)).toBe(true);
        const res = await fetch('chrome-extension://omni-viewer-test/anything');
        expect(res.ok).toBe(true);
        expect(await res.text()).toBe('');
    });
});
