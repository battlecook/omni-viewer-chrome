import { getFirebaseAnonymousIdToken } from '../firebaseAnonymousAuth';

const STORAGE_KEY = 'omni-viewer-firebase-anon-token';

function memoryStorage(initial?: Record<string, string>) {
    const values = new Map(Object.entries(initial ?? {}));
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
        values,
    };
}

function jsonResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

describe('getFirebaseAnonymousIdToken', () => {
    it('creates and caches an anonymous Firebase session', async () => {
        const storage = memoryStorage();
        const fetchImpl = jest.fn(async () => jsonResponse({
            idToken: 'id-1',
            refreshToken: 'refresh-1',
            expiresIn: '3600',
        })) as unknown as typeof fetch;

        const token = await getFirebaseAnonymousIdToken({ fetchImpl, storage, now: () => 1000 });

        expect(token).toBe('id-1');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(String((fetchImpl as jest.Mock).mock.calls[0][0])).toContain('accounts:signUp');
        expect(JSON.parse(storage.values.get(STORAGE_KEY) ?? '{}')).toEqual({
            idToken: 'id-1',
            refreshToken: 'refresh-1',
            expiresAt: 3_601_000,
        });
    });

    it('reuses a cached token that is not near expiry', async () => {
        const storage = memoryStorage({
            [STORAGE_KEY]: JSON.stringify({
                idToken: 'cached-id',
                refreshToken: 'cached-refresh',
                expiresAt: 100_000,
            }),
        });
        const fetchImpl = jest.fn() as unknown as typeof fetch;

        await expect(getFirebaseAnonymousIdToken({ fetchImpl, storage, now: () => 1000 }))
            .resolves.toBe('cached-id');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('refreshes an expired anonymous session', async () => {
        const storage = memoryStorage({
            [STORAGE_KEY]: JSON.stringify({
                idToken: 'old-id',
                refreshToken: 'old-refresh',
                expiresAt: 1000,
            }),
        });
        const fetchImpl = jest.fn(async () => jsonResponse({
            id_token: 'new-id',
            refresh_token: 'new-refresh',
            expires_in: '3600',
        })) as unknown as typeof fetch;

        await expect(getFirebaseAnonymousIdToken({ fetchImpl, storage, now: () => 2000 }))
            .resolves.toBe('new-id');
        expect(String((fetchImpl as jest.Mock).mock.calls[0][0])).toContain('securetoken.googleapis.com');
    });

    it('creates a new anonymous session when refresh fails', async () => {
        const storage = memoryStorage({
            [STORAGE_KEY]: JSON.stringify({
                idToken: 'old-id',
                refreshToken: 'bad-refresh',
                expiresAt: 1000,
            }),
        });
        const fetchImpl = jest.fn()
            .mockResolvedValueOnce(jsonResponse({ error: { message: 'INVALID_REFRESH_TOKEN' } }, 400))
            .mockResolvedValueOnce(jsonResponse({
                idToken: 'replacement-id',
                refreshToken: 'replacement-refresh',
                expiresIn: '3600',
            })) as unknown as typeof fetch;

        await expect(getFirebaseAnonymousIdToken({ fetchImpl, storage, now: () => 2000 }))
            .resolves.toBe('replacement-id');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
});
