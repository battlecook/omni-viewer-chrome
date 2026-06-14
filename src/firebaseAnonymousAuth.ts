const FIREBASE_WEB_API_KEY = 'AIzaSyDEm6Pcue_Icmu4SnvoX8LkzOq8EpbkzlM';
const STORAGE_KEY = 'omni-viewer-firebase-anon-token';
const EXPIRY_SKEW_MS = 30_000;

interface FirebaseTokenState {
    idToken: string;
    refreshToken: string;
    expiresAt: number;
}

interface FirebaseSignUpResponse {
    idToken: string;
    refreshToken: string;
    expiresIn: string;
}

interface FirebaseRefreshResponse {
    id_token: string;
    refresh_token: string;
    expires_in: string;
}

export interface FirebaseAnonymousAuthOptions {
    fetchImpl?: typeof fetch;
    storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
    now?: () => number;
}

let inflightTokenPromise: Promise<string> | null = null;

export async function getFirebaseAnonymousIdToken(
    options: FirebaseAnonymousAuthOptions = {},
): Promise<string> {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const storage = options.storage ?? globalThis.localStorage;
    const now = options.now ?? Date.now;

    if (inflightTokenPromise) return inflightTokenPromise;

    inflightTokenPromise = (async () => {
        const cached = readTokenState(storage);
        if (cached && cached.expiresAt - EXPIRY_SKEW_MS > now()) {
            return cached.idToken;
        }

        let next: FirebaseTokenState;
        if (cached?.refreshToken) {
            try {
                next = await refreshAnonymousToken(fetchImpl, cached.refreshToken, now());
            } catch {
                storage.removeItem(STORAGE_KEY);
                next = await signUpAnonymous(fetchImpl, now());
            }
        } else {
            next = await signUpAnonymous(fetchImpl, now());
        }

        storage.setItem(STORAGE_KEY, JSON.stringify(next));
        return next.idToken;
    })();

    try {
        return await inflightTokenPromise;
    } finally {
        inflightTokenPromise = null;
    }
}

function readTokenState(storage: Pick<Storage, 'getItem'>): FirebaseTokenState | null {
    try {
        const raw = storage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as FirebaseTokenState;
        if (!parsed?.idToken || !parsed?.refreshToken || !parsed?.expiresAt) return null;
        return parsed;
    } catch {
        return null;
    }
}

async function signUpAnonymous(fetchImpl: typeof fetch, now: number): Promise<FirebaseTokenState> {
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(FIREBASE_WEB_API_KEY)}`;
    const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnSecureToken: true }),
    });
    if (!res.ok) {
        throw new Error(`Firebase anonymous sign-in failed (HTTP ${res.status}). ${await readError(res)}`.trim());
    }
    const data = await readJson<FirebaseSignUpResponse>(res, 'Firebase anonymous sign-in');
    return toState(data.idToken, data.refreshToken, data.expiresIn, now);
}

async function refreshAnonymousToken(
    fetchImpl: typeof fetch,
    refreshToken: string,
    now: number,
): Promise<FirebaseTokenState> {
    const url = `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(FIREBASE_WEB_API_KEY)}`;
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
    });
    const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    if (!res.ok) {
        throw new Error(`Firebase token refresh failed (HTTP ${res.status}). ${await readError(res)}`.trim());
    }
    const data = await readJson<FirebaseRefreshResponse>(res, 'Firebase token refresh');
    return toState(data.id_token, data.refresh_token, data.expires_in, now);
}

function toState(
    idToken: string,
    refreshToken: string,
    expiresIn: string,
    now: number,
): FirebaseTokenState {
    if (!idToken || !refreshToken) {
        throw new Error('Firebase authentication response is missing token fields.');
    }
    const seconds = Number.parseInt(expiresIn, 10);
    const lifetimeMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 50 * 60 * 1000;
    return { idToken, refreshToken, expiresAt: now + lifetimeMs };
}

async function readJson<T>(res: Response, label: string): Promise<T> {
    try {
        return await res.json() as T;
    } catch {
        throw new Error(`${label} returned invalid JSON.`);
    }
}

async function readError(res: Response): Promise<string> {
    try {
        const text = (await res.text()).trim();
        if (!text) return '';
        const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
        return parsed.error?.message?.trim() || parsed.message?.trim() || text;
    } catch {
        return '';
    }
}
