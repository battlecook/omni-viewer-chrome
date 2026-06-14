#!/usr/bin/env node

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const localesRoot = resolve(repoRoot, '_locales');
const english = JSON.parse(readFileSync(resolve(localesRoot, 'en/messages.json'), 'utf8'));
const onlyLocale = process.argv.find((arg) => arg.startsWith('--locale='))?.split('=')[1];
const dryRun = process.argv.includes('--dry-run');

const targetLanguage = {
    en_AU: 'en',
    en_GB: 'en',
    en_US: 'en',
    es_419: 'es',
    fil: 'tl',
    pt_BR: 'pt',
    pt_PT: 'pt',
    zh_CN: 'zh-CN',
    zh_TW: 'zh-TW',
};

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

function protectPlaceholders(message) {
    return message.replace(/\$(\d+)/g, (_, number) => `ZXQPH${number}QXZ`);
}

function restorePlaceholders(message) {
    return message
        .replace(/ZXQPH\s*(\d+)\s*QXZ/gi, (_, number) => `$${number}`)
        .replace(/ЗКСКПХ\s*(\d+)\s*ККСЗ/giu, (_, number) => `$${number}`);
}

async function requestTranslation(messages, language) {
    const body = new URLSearchParams({
        client: 'gtx',
        sl: 'en',
        tl: language,
        dt: 't',
        q: messages.map(protectPlaceholders).join(' || '),
    });

    let lastError;
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            const response = await fetch('https://translate.googleapis.com/translate_a/single', {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                body,
            });
            if (!response.ok) {
                const error = new Error(`HTTP ${response.status}`);
                error.status = response.status;
                throw error;
            }
            const payload = await response.json();
            const translated = payload?.[0]?.map((part) => part?.[0] ?? '').join('');
            if (!translated) throw new Error('empty translation');
            return translated.split(/\s*\|\|\s*/).map(restorePlaceholders);
        } catch (error) {
            lastError = error;
            await delay(lastError?.status === 429 ? attempt * 5000 : attempt * 750);
        }
    }
    throw lastError;
}

async function translateBatch(messages, language) {
    if (messages.length === 0) return [];
    const translated = await requestTranslation(messages, language);
    if (translated.length === messages.length) return translated;
    if (messages.length === 1) {
        throw new Error(`translation delimiter mismatch for: ${messages[0]}`);
    }

    const midpoint = Math.ceil(messages.length / 2);
    const left = await translateBatch(messages.slice(0, midpoint), language);
    const right = await translateBatch(messages.slice(midpoint), language);
    return [...left, ...right];
}

const localeDirectories = readdirSync(localesRoot)
    .filter((locale) => statSync(resolve(localesRoot, locale)).isDirectory())
    .filter((locale) => locale !== 'en')
    .filter((locale) => !onlyLocale || locale === onlyLocale)
    .sort();

async function translateLocale(locale) {
    const path = resolve(localesRoot, locale, 'messages.json');
    const messages = JSON.parse(readFileSync(path, 'utf8'));
    const language = targetLanguage[locale] ?? locale;
    const pending = [];

    for (const [key, englishEntry] of Object.entries(english)) {
        const entry = messages[key];
        if (!entry) throw new Error(`${locale}: missing key ${key}`);

        const needsTranslation = String(entry.description ?? '').includes('[needsTranslation]');
        if (needsTranslation) {
            pending.push({ entry, englishEntry });
        }
        entry.description = englishEntry.description;
    }

    const translated = language === 'en'
        ? pending.map(({ englishEntry }) => englishEntry.message)
        : await translateBatch(pending.map(({ englishEntry }) => englishEntry.message), language);
    pending.forEach(({ entry }, index) => {
        entry.message = translated[index];
    });

    if (!dryRun) {
        writeFileSync(path, `${JSON.stringify(messages, null, 2)}\n`, 'utf8');
    }
    process.stdout.write(`[${locale}] ${pending.length} messages translated\n`);
}

async function runLocales(concurrency) {
    let nextIndex = 0;

    async function run() {
        while (nextIndex < localeDirectories.length) {
            const index = nextIndex++;
            await translateLocale(localeDirectories[index]);
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, localeDirectories.length) }, run));
}

await runLocales(1);
