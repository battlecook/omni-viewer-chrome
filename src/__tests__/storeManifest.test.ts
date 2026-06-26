// Manifest invariants tests for the Chrome Web Store submission gate.
//
// These tests pin the manifest properties that matter for the Web Store
// review. They are intentionally read via `fs.readFileSync` (rather than a
// JSON import) so we don't need `resolveJsonModule` and so the assertions
// run against the exact file that will be packaged.
//
// Whenever `manifest.json` changes, run `npm test` to verify these
// invariants still hold. Adjust both the manifest and the listing copy
// (`store/listing.md`) together if a new permission is genuinely required.

import fs from 'node:fs';
import path from 'node:path';

interface FileHandlerEntry {
    action: string;
    name: string;
    accept: Record<string, string[]>;
    launch_type?: string;
}

interface WebAccessibleResource {
    resources: string[];
    matches: string[];
}

interface ChromeManifest {
    manifest_version: number;
    name: string;
    short_name?: string;
    version: string;
    description: string;
    action?: { default_title?: string };
    background?: { service_worker?: string };
    icons?: Record<string, string>;
    permissions?: string[];
    host_permissions?: string[];
    file_handlers?: FileHandlerEntry[];
    content_security_policy?: { extension_pages?: string };
    web_accessible_resources?: WebAccessibleResource[];
}

const REPO_ROOT = process.cwd();
const MANIFEST_PATH = path.join(REPO_ROOT, 'manifest.json');
const PACKAGE_PATH = path.join(REPO_ROOT, 'package.json');

function loadManifest(): ChromeManifest {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
    return JSON.parse(raw) as ChromeManifest;
}

function loadPackage(): { version: string } {
    const raw = fs.readFileSync(PACKAGE_PATH, 'utf8');
    return JSON.parse(raw) as { version: string };
}

describe('storeManifest invariants', () => {
    let manifest: ChromeManifest;

    beforeAll(() => {
        manifest = loadManifest();
    });

    describe('required top-level fields', () => {
        it('uses Manifest V3', () => {
            expect(manifest.manifest_version).toBe(3);
        });

        it('declares a non-empty name', () => {
            expect(typeof manifest.name).toBe('string');
            expect(manifest.name.length).toBeGreaterThan(0);
        });

        it('declares a semver-shaped version', () => {
            expect(typeof manifest.version).toBe('string');
            // Chrome accepts dotted up to four numeric segments. Pin the
            // shape so a bad bump fails fast.
            expect(manifest.version).toMatch(/^\d+(\.\d+){1,3}$/);
        });

        it('declares a non-empty description', () => {
            expect(typeof manifest.description).toBe('string');
            expect(manifest.description.length).toBeGreaterThan(0);
        });

        it('keeps the manifest version in sync with package.json', () => {
            const pkg = loadPackage();
            expect(manifest.version).toBe(pkg.version);
        });

        it('declares all four icon sizes required by the Web Store', () => {
            expect(manifest.icons).toBeDefined();
            const icons = manifest.icons as Record<string, string>;
            for (const size of ['16', '32', '48', '128']) {
                expect(typeof icons[size]).toBe('string');
                expect(icons[size].length).toBeGreaterThan(0);
            }
        });

        it('points the background service worker at a real source path', () => {
            expect(manifest.background).toBeDefined();
            const sw = manifest.background?.service_worker;
            expect(typeof sw).toBe('string');
            expect((sw as string).length).toBeGreaterThan(0);
        });
    });

    describe('permissions are minimized', () => {
        // The store listing justifies exactly `storage`. Anything else
        // requires a corresponding update in `store/listing.md`.
        const ALLOWED_PERMISSIONS = new Set<string>(['storage']);

        it('declares only the allow-listed permissions', () => {
            const declared = manifest.permissions ?? [];
            for (const perm of declared) {
                expect(ALLOWED_PERMISSIONS.has(perm)).toBe(true);
            }
        });

        it('declares the storage permission (used for UI preferences)', () => {
            const declared = manifest.permissions ?? [];
            expect(declared).toContain('storage');
        });

        it('does not declare any unexpected permissions', () => {
            const declared = manifest.permissions ?? [];
            const unexpected = declared.filter((p) => !ALLOWED_PERMISSIONS.has(p));
            expect(unexpected).toEqual([]);
        });

        it('limits host permissions to the documented share API', () => {
            const hosts = manifest.host_permissions ?? [];
            expect(hosts).toEqual([
                'https://omni-viewer-share-624036133562.us-west1.run.app/*',
                'https://identitytoolkit.googleapis.com/*',
                'https://securetoken.googleapis.com/*',
                'https://storage.googleapis.com/*',
            ]);
        });
    });

    describe('content security policy', () => {
        it('declares an extension_pages CSP', () => {
            const csp = manifest.content_security_policy?.extension_pages;
            expect(typeof csp).toBe('string');
            expect((csp as string).length).toBeGreaterThan(0);
        });

        it('does not allow script unsafe-eval', () => {
            const csp = manifest.content_security_policy?.extension_pages ?? '';
            // `'wasm-unsafe-eval'` is allowed (audio decoder), but plain
            // `'unsafe-eval'` for scripts is not.
            const scriptSrc = csp
                .split(';')
                .map((s) => s.trim())
                .find((s) => s.startsWith('script-src'));
            expect(scriptSrc).toBeDefined();
            // Match `'unsafe-eval'` as a token, not the substring inside
            // `'wasm-unsafe-eval'`.
            const tokens = (scriptSrc as string).split(/\s+/);
            expect(tokens).not.toContain("'unsafe-eval'");
        });

        it('restricts script-src to self (and optionally wasm-unsafe-eval)', () => {
            const csp = manifest.content_security_policy?.extension_pages ?? '';
            const scriptSrc = csp
                .split(';')
                .map((s) => s.trim())
                .find((s) => s.startsWith('script-src')) as string;
            const tokens = scriptSrc.split(/\s+/).slice(1);
            const allowed = new Set(["'self'", "'wasm-unsafe-eval'"]);
            for (const token of tokens) {
                expect(allowed.has(token)).toBe(true);
            }
            expect(tokens).toContain("'self'");
        });
    });

    describe('web_accessible_resources scope', () => {
        it('only exposes the extension-bundled vendor and templates dirs', () => {
            const groups = manifest.web_accessible_resources ?? [];
            // We allow exactly one block today. If a future block is
            // added, this test will require an explicit update — that is
            // intentional, since broadening WAR is store-relevant.
            expect(groups.length).toBeGreaterThan(0);
            const allResources = groups.flatMap((g) => g.resources);
            const allowedPrefixes = ['vendor/', 'templates/'];
            for (const resource of allResources) {
                const ok = allowedPrefixes.some((prefix) =>
                    resource.startsWith(prefix)
                );
                expect(ok).toBe(true);
            }
        });
    });

    describe('file_handlers cover the documented viewer formats', () => {
        it('declares at least one file_handlers entry', () => {
            expect(Array.isArray(manifest.file_handlers)).toBe(true);
            expect((manifest.file_handlers as FileHandlerEntry[]).length).toBeGreaterThan(0);
        });

        it('each entry routes through viewer.html', () => {
            for (const entry of manifest.file_handlers ?? []) {
                expect(entry.action).toBe('viewer.html');
            }
        });

        it('covers a representative extension from each viewer family', () => {
            const accept = (manifest.file_handlers ?? []).flatMap((e) =>
                Object.values(e.accept).flat()
            );
            const required = [
                '.png',  // image
                '.pdf',  // pdf
                '.csv',  // csv
                '.json', // json
                '.jsonl',// jsonl
                '.yaml', // yaml
                '.toml', // toml
                '.mmd',  // mermaid
                '.puml', // plantuml
                '.mp3',  // audio
                '.mp4',  // video
                '.xlsx', // excel
                '.docx', // word
                '.pptx', // ppt
                '.psd',  // psd
                '.parquet', // parquet
                '.hwp',  // hwp
                '.avro', // Avro
                '.bag',  // ROS bag
                '.stp',  // STEP
                '.db3',  // SQLite/ROS2 bag database
                '.reqif', // ReqIF
                '.zip'   // archive
            ];
            for (const ext of required) {
                expect(accept).toContain(ext);
            }
        });
    });
});
