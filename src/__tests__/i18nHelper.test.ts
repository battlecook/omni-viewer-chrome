import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    SUPPORTED_LOCALES,
    applyDocumentLocale,
    isRtlLocale,
    localizeRoot,
    normalizeLocaleTag,
    resolveLocale,
    t,
} from '../utils/i18n';

describe('t', () => {
    afterEach(() => {
        delete (globalThis as any).chrome?.i18n?.getMessage;
    });

    it('returns chrome.i18n.getMessage when present', () => {
        (globalThis as any).chrome = (globalThis as any).chrome ?? {};
        (globalThis as any).chrome.i18n = {
            getMessage: jest.fn().mockReturnValue('Hello'),
        };
        expect(t('greet', 'fallback')).toBe('Hello');
    });

    it('falls back to the developer-supplied string when chrome returns empty', () => {
        (globalThis as any).chrome = (globalThis as any).chrome ?? {};
        (globalThis as any).chrome.i18n = {
            getMessage: jest.fn().mockReturnValue(''),
        };
        expect(t('greet', 'fallback')).toBe('fallback');
    });

    it('falls back to the key when neither chrome nor a fallback is provided', () => {
        (globalThis as any).chrome = (globalThis as any).chrome ?? {};
        (globalThis as any).chrome.i18n = {
            getMessage: jest.fn().mockReturnValue(''),
        };
        expect(t('greet')).toBe('greet');
    });

    it('passes substitutions to chrome.i18n.getMessage', () => {
        const spy = jest.fn().mockReturnValue('Hi $1');
        (globalThis as any).chrome = (globalThis as any).chrome ?? {};
        (globalThis as any).chrome.i18n = { getMessage: spy };
        t('greet', 'fallback', 'Alice');
        expect(spy).toHaveBeenCalledWith('greet', 'Alice');
    });
});

describe('normalizeLocaleTag', () => {
    it.each<[string, string]>([
        ['ko', 'ko'],
        ['ko-KR', 'ko_KR'],
        ['ko_kr', 'ko_KR'],
        ['en', 'en'],
        ['en-US', 'en_US'],
        ['en-gb', 'en_GB'],
        ['pt-BR', 'pt_BR'],
        ['pt_pt', 'pt_PT'],
        ['es-419', 'es_419'],
        ['zh-Hans-CN', 'zh_CN'],
        ['zh-Hant-TW', 'zh_TW'],
        ['fr-CA', 'fr_CA'],
    ])('normalizes %s -> %s', (input, expected) => {
        expect(normalizeLocaleTag(input)).toBe(expected);
    });

    it('returns empty string for empty / null / undefined input', () => {
        expect(normalizeLocaleTag('')).toBe('');
        expect(normalizeLocaleTag(null)).toBe('');
        expect(normalizeLocaleTag(undefined)).toBe('');
    });
});

describe('resolveLocale', () => {
    it('matches a fully-normalized region variant', () => {
        expect(resolveLocale(['pt-BR'])).toBe('pt_BR');
        expect(resolveLocale(['zh-CN'])).toBe('zh_CN');
        expect(resolveLocale(['zh-TW'])).toBe('zh_TW');
        expect(resolveLocale(['es-419'])).toBe('es_419');
    });

    it('falls back to the base language when the variant is not supported', () => {
        // fr_CA is not in the directory; fr is.
        expect(resolveLocale(['fr-CA'])).toBe('fr');
    });

    it('walks the preference list', () => {
        expect(resolveLocale(['xx-YY', 'ko-KR'])).toBe('ko');
    });

    it('falls back to en when no preference matches', () => {
        expect(resolveLocale(['xx-YY', 'zz-ZZ'])).toBe('en');
    });

    it('reads navigator.languages when no argument is passed', () => {
        const original = (navigator as any).languages;
        Object.defineProperty(navigator, 'languages', {
            configurable: true,
            value: ['ko-KR', 'en-US'],
        });
        try {
            expect(resolveLocale()).toBe('ko');
        } finally {
            Object.defineProperty(navigator, 'languages', {
                configurable: true,
                value: original,
            });
        }
    });
});

describe('isRtlLocale', () => {
    it.each(['ar', 'fa', 'he', 'ur'])('detects %s as RTL', (locale) => {
        expect(isRtlLocale(locale)).toBe(true);
    });
    it.each(['ko', 'ja', 'en', 'fr', 'zh_CN', ''])('detects %s as not RTL', (locale) => {
        expect(isRtlLocale(locale)).toBe(false);
    });
    it('handles region variants', () => {
        expect(isRtlLocale('ar-EG')).toBe(true);
        expect(isRtlLocale('he_IL')).toBe(true);
    });
});

describe('applyDocumentLocale', () => {
    it('sets lang and dir on the document root', () => {
        const original = (navigator as any).languages;
        Object.defineProperty(navigator, 'languages', {
            configurable: true,
            value: ['ar-EG'],
        });
        try {
            applyDocumentLocale(document);
            expect(document.documentElement.lang).toBe('ar');
            expect(document.documentElement.dir).toBe('rtl');
        } finally {
            Object.defineProperty(navigator, 'languages', {
                configurable: true,
                value: original,
            });
        }
    });

    it('sets ltr for non-RTL locales', () => {
        const original = (navigator as any).languages;
        Object.defineProperty(navigator, 'languages', {
            configurable: true,
            value: ['ko-KR'],
        });
        try {
            applyDocumentLocale(document);
            expect(document.documentElement.lang).toBe('ko');
            expect(document.documentElement.dir).toBe('ltr');
        } finally {
            Object.defineProperty(navigator, 'languages', {
                configurable: true,
                value: original,
            });
        }
    });
});

describe('localizeRoot', () => {
    beforeEach(() => {
        (globalThis as any).chrome = (globalThis as any).chrome ?? {};
        (globalThis as any).chrome.i18n = {
            getMessage: (key: string) => {
                if (key === 'greet') return 'Hello';
                if (key === 'tip') return 'Tooltip';
                return '';
            },
        };
    });

    it('translates [data-i18n], [data-i18n-title], [data-i18n-placeholder]', () => {
        const root = document.createElement('div');
        root.innerHTML = `
            <span data-i18n="greet">Original</span>
            <button data-i18n-title="tip" title="Old">x</button>
            <input data-i18n-placeholder="greet" placeholder="Old" />
        `;
        localizeRoot(root);
        expect(root.querySelector('span')?.textContent).toBe('Hello');
        expect(root.querySelector('button')?.title).toBe('Tooltip');
        expect((root.querySelector('input') as HTMLInputElement).placeholder).toBe('Hello');
    });
});

describe('SUPPORTED_LOCALES', () => {
    it('includes en', () => {
        expect(SUPPORTED_LOCALES).toContain('en');
    });
    it('includes major region variants', () => {
        for (const v of ['pt_BR', 'pt_PT', 'es_419', 'zh_CN', 'zh_TW', 'en_GB', 'en_US']) {
            expect(SUPPORTED_LOCALES).toContain(v);
        }
    });
});

describe('_locales key parity', () => {
    const localesRoot = resolve(__dirname, '../../_locales');
    const enKeys = Object.keys(
        JSON.parse(readFileSync(resolve(localesRoot, 'en/messages.json'), 'utf8'))
    );

    it('en has the documented core keys', () => {
        expect(enKeys).toContain('appName');
        expect(enKeys).toContain('commonLoading');
        expect(enKeys).toContain('pdfPasswordPromptInitial');
    });

    it('every locale directory has the en key set', () => {
        const localeDirs = readdirSync(localesRoot).filter((dir) =>
            statSync(resolve(localesRoot, dir)).isDirectory()
        );
        const missing: Record<string, string[]> = {};
        for (const dir of localeDirs) {
            if (dir === 'en') continue;
            const path = resolve(localesRoot, dir, 'messages.json');
            const json = JSON.parse(readFileSync(path, 'utf8'));
            const keys = new Set(Object.keys(json));
            const gaps = enKeys.filter((k) => !keys.has(k));
            if (gaps.length > 0) missing[dir] = gaps;
        }
        expect(missing).toEqual({});
    });
});
