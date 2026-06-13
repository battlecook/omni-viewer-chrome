#!/usr/bin/env node
// Mirror the message key set from `_locales/en/messages.json` into every
// other locale directory. Existing translations are preserved; only
// missing keys are added (with the English value + a `__needsTranslation`
// hint in the description).
//
// Idempotent — safe to re-run after editing `_locales/en/messages.json`.
//
// Usage: `node scripts/sync-locales.mjs`

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const localesRoot = resolve(repoRoot, '_locales');
const enPath = resolve(localesRoot, 'en', 'messages.json');

const enRaw = readFileSync(enPath, 'utf8');
const enJson = JSON.parse(enRaw);

const enKeys = Object.keys(enJson);
let totalAdded = 0;
let touched = 0;
const skipped = [];

for (const dir of readdirSync(localesRoot)) {
    const localePath = resolve(localesRoot, dir);
    if (!statSync(localePath).isDirectory()) continue;
    if (dir === 'en') continue;
    const messagesPath = resolve(localePath, 'messages.json');
    let json;
    try {
        json = JSON.parse(readFileSync(messagesPath, 'utf8'));
    } catch {
        skipped.push(dir);
        continue;
    }
    let added = 0;
    for (const key of enKeys) {
        if (!Object.prototype.hasOwnProperty.call(json, key)) {
            const enEntry = enJson[key];
            json[key] = {
                message: enEntry.message,
                description: enEntry.description
                    ? `[needsTranslation] ${enEntry.description}`
                    : '[needsTranslation]'
            };
            added++;
        }
    }
    if (added > 0) {
        const ordered = {};
        for (const key of enKeys) {
            if (Object.prototype.hasOwnProperty.call(json, key)) {
                ordered[key] = json[key];
            }
        }
        for (const key of Object.keys(json)) {
            if (!Object.prototype.hasOwnProperty.call(ordered, key)) {
                ordered[key] = json[key];
            }
        }
        writeFileSync(messagesPath, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
        touched++;
        totalAdded += added;
        process.stdout.write(`[${dir}] +${added} keys\n`);
    }
}

process.stdout.write(`\nDone. Touched ${touched} locales, added ${totalAdded} keys total. Skipped: ${skipped.join(', ') || 'none'}\n`);
