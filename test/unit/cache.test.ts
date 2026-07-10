import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAssetCache } from '../../src/cache.js';

describe('persistent cache request isolation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects custom-header sources instead of sharing a URL-only entry', async () => {
    const cache = new BrowserAssetCache();

    await expect(cache.prefetch({
      type: 'url',
      url: 'https://media.example/private.mp4',
      cache: 'persistent',
      headers: { Authorization: 'Bearer private-token' },
    })).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
  });

  it('rejects credentialed persistent sources', async () => {
    const cache = new BrowserAssetCache();

    await expect(cache.fetch({
      type: 'url',
      url: 'https://media.example/account/video.mp4',
      cache: 'persistent',
      credentials: 'include',
    })).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
  });

  it('forces credential omission when prefetching a public same-origin URL', async () => {
    let stored: Response | undefined;
    const cacheStorage = {
      match: vi.fn(async () => stored),
      put: vi.fn(async (_key: Request, response: Response) => {
        stored = response;
      }),
    } as unknown as Cache;
    vi.stubGlobal('caches', {
      open: vi.fn(async () => cacheStorage),
    });
    let request: Request | undefined;
    const assets = new BrowserAssetCache({
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        request = input as Request;
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-length': '3' },
        });
      }) as typeof fetch,
    });

    await assets.prefetch('https://app.example/template.mp4');

    expect(request?.credentials).toBe('omit');
  });
});
