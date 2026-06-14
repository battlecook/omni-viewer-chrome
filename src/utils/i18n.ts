// Shared i18n helpers for the Chrome extension viewers (issue #71).
//
// Reads message strings via `chrome.i18n.getMessage(...)`, falling back to a
// developer-supplied English string when the key is missing or the runtime
// is non-extension (jest jsdom). Provides locale normalization that maps
// `navigator.language(s)` to a Chrome `_locales/<dir>` directory, including
// the region-variant forms Chrome uses (`pt_BR`, `pt_PT`, `es_419`,
// `zh_CN`, `zh_TW`, `en_GB`, `en_US`).

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Locales we ship under `_locales/`. Region-variant directories live next
 * to the base-language ones so a Chrome i18n lookup picks the most
 * specific match first. The list mirrors the directory inventory at
 * commit time; `scripts/sync-locales.mjs` keeps the message-key set in
 * sync across all of them.
 */
export const SUPPORTED_LOCALES: readonly string[] = Object.freeze([
    'am', 'ar', 'as', 'az', 'bg', 'bn', 'ca', 'cs', 'da', 'de',
    'el', 'en', 'en_AU', 'en_GB', 'en_US', 'es', 'es_419', 'et', 'eu', 'fa',
    'fi', 'fil', 'fr', 'gu', 'he', 'hi', 'hr', 'hu', 'hy', 'id',
    'it', 'ja', 'ka', 'kn', 'ko', 'lt', 'lv', 'mk', 'ml', 'mr',
    'ms', 'my', 'ne', 'nl', 'no', 'or', 'pa', 'pl', 'pt_BR', 'pt_PT',
    'ro', 'ru', 'si', 'sk', 'sl', 'sq', 'sr', 'sv', 'sw', 'ta',
    'te', 'th', 'tr', 'uk', 'ur', 'uz', 'vi', 'zh_CN', 'zh_TW',
]) as readonly string[];

const SUPPORTED_LOCALE_SET = new Set(SUPPORTED_LOCALES);

/**
 * Locales whose script flows right-to-left. Used by `applyDocumentLocale`
 * to set `dir="rtl"` on the document root.
 */
export const RTL_LOCALES: readonly string[] = Object.freeze(['ar', 'fa', 'he', 'ur']);
const RTL_LOCALE_SET = new Set(RTL_LOCALES);

/**
 * Read a message via `chrome.i18n.getMessage`. Returns `fallback` (or the
 * key itself) when the lookup is missing / empty / outside an extension
 * runtime. Substitutions follow Chrome's contract — either a single
 * string or a string array, mapped to `$1`/`$2`/etc placeholders.
 */
export function t(
    key: string,
    fallback?: string,
    substitutions?: string | string[]
): string {
    if (typeof key !== 'string' || !key) {
        return fallback ?? '';
    }
    const fromChrome = readChromeMessage(key, substitutions);
    if (fromChrome) return fromChrome;
    if (typeof fallback === 'string') return fallback;
    return key;
}

function readChromeMessage(key: string, substitutions?: string | string[]): string {
    try {
        const override = (globalThis as any).__omniLocaleMessages?.[key]?.message;
        if (typeof override === 'string' && override.length > 0) {
            const values = Array.isArray(substitutions)
                ? substitutions
                : substitutions == null ? [] : [substitutions];
            return override.replace(/\$(\d+)/g, (match: string, index: string) =>
                values[Number(index) - 1] ?? match
            );
        }
        const c: any = (typeof chrome !== 'undefined' ? chrome : undefined);
        if (c && c.i18n && typeof c.i18n.getMessage === 'function') {
            const msg = c.i18n.getMessage(key, substitutions as any);
            if (typeof msg === 'string' && msg.length > 0) return msg;
        }
    } catch {
        // best-effort
    }
    return '';
}

/**
 * Normalize a single browser-supplied tag to the Chrome `_locales`
 * directory form: `pt-BR` → `pt_BR`, `zh-Hant-TW` → `zh_TW`, `en` → `en`.
 * Returns `''` for empty input.
 */
export function normalizeLocaleTag(tag: string | null | undefined): string {
    if (!tag) return '';
    const cleaned = tag.trim().replace(/-/g, '_');
    if (!cleaned) return '';
    const parts = cleaned.split('_').filter(Boolean);
    if (parts.length === 0) return '';
    const lang = parts[0].toLowerCase();
    if (parts.length === 1) return lang;
    // Drop a script subtag if present — Chrome locales encode scripts via
    // the region (`zh_CN` for Simplified, `zh_TW` for Traditional).
    let region: string | undefined;
    for (let i = 1; i < parts.length; i++) {
        const p = parts[i];
        if (p.length === 2 || /^\d{3}$/.test(p)) {
            region = p.toUpperCase();
            break;
        }
        // 4-letter script (`Hant`, `Hans`) — skip and keep walking.
    }
    if (!region) return lang;
    return `${lang}_${region}`;
}

/**
 * Pick the best matching `_locales/<dir>` for a list of browser language
 * preferences. Walks each preference top-to-bottom, trying first the
 * fully-normalized form (`pt_BR`), then the base language (`pt`), then
 * the next preference. Falls back to `en` when no preference matches.
 */
export function resolveLocale(preferences?: ReadonlyArray<string | null | undefined>): string {
    const prefs = preferences && preferences.length
        ? preferences
        : readNavigatorPreferences();
    for (const raw of prefs) {
        const normalized = normalizeLocaleTag(raw);
        if (!normalized) continue;
        if (SUPPORTED_LOCALE_SET.has(normalized)) return normalized;
        const base = normalized.split('_')[0];
        if (SUPPORTED_LOCALE_SET.has(base)) return base;
    }
    return 'en';
}

function readNavigatorPreferences(): string[] {
    try {
        if (typeof navigator !== 'undefined') {
            const langs = (navigator as any).languages;
            if (Array.isArray(langs) && langs.length) return langs.slice();
            if (typeof navigator.language === 'string') return [navigator.language];
        }
    } catch {
        // best-effort
    }
    return [];
}

/** True when `locale`'s script flows right-to-left. */
export function isRtlLocale(locale: string | null | undefined): boolean {
    if (!locale) return false;
    const base = String(locale).toLowerCase().split(/[_-]/)[0];
    return RTL_LOCALE_SET.has(base);
}

/**
 * Set `<html lang>` and `<html dir>` on a document based on the resolved
 * locale. Idempotent — safe to call from multiple viewers.
 */
export function applyDocumentLocale(doc: Document = document): string {
    const locale = resolveLocale();
    try {
        doc.documentElement.lang = locale.replace('_', '-');
        doc.documentElement.dir = isRtlLocale(locale) ? 'rtl' : 'ltr';
    } catch {
        // best-effort
    }
    return locale;
}

/**
 * Localize a DOM subtree by walking `[data-i18n]`, `[data-i18n-title]`,
 * `[data-i18n-placeholder]`, and `[data-i18n-aria-label]`. The default
 * fallback is the existing text/attribute value, so callers don't have
 * to write fallbacks in two places.
 */
export function localizeRoot(root: ParentNode = document): void {
    if (!root || typeof (root as any).querySelectorAll !== 'function') return;
    root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
        const key = el.dataset.i18n;
        if (!key) return;
        el.textContent = t(key, el.textContent ?? '');
    });
    root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
        const key = el.dataset.i18nTitle;
        if (!key) return;
        el.title = t(key, el.title);
    });
    root.querySelectorAll<HTMLElement>('[data-i18n-placeholder]').forEach((el) => {
        const key = el.dataset.i18nPlaceholder;
        if (!key) return;
        const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
        inputEl.placeholder = t(key, inputEl.placeholder);
    });
    root.querySelectorAll<HTMLElement>('[data-i18n-aria-label]').forEach((el) => {
        const key = el.dataset.i18nAriaLabel;
        if (!key) return;
        el.setAttribute('aria-label', t(key, el.getAttribute('aria-label') ?? ''));
    });
}
