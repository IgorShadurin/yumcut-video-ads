import { afterEach, describe, expect, it, vi } from 'vitest';
import { __private__, sourceToBlob, sourceUrl } from '../../src/media.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('media source helpers', () => {
  it('normalizes string, URL, and descriptor URLs', () => {
    const url = new URL('https://media.example/video.mp4?quality=high');

    expect(sourceUrl('https://media.example/template.mp4')).toBe(
      'https://media.example/template.mp4',
    );
    expect(sourceUrl(url)).toBe(url.href);
    expect(sourceUrl({ type: 'url', url })).toBe(url.href);
  });

  it('copies only the addressed bytes from an ArrayBuffer view', () => {
    const backing = Uint8Array.from([10, 20, 30, 40]);
    const view = new Uint8Array(backing.buffer, 1, 2);
    const exact = __private__.exactArrayBuffer(view);

    expect(exact.byteLength).toBe(2);
    expect([...new Uint8Array(exact)]).toEqual([20, 30]);
    backing[1] = 99;
    expect([...new Uint8Array(exact)]).toEqual([20, 30]);
  });

  it('reuses the backing ArrayBuffer when a view addresses all of it', () => {
    const view = Uint8Array.from([10, 20, 30, 40]);
    const exact = __private__.exactArrayBuffer(view);

    expect(exact).toBe(view.buffer);
    view[1] = 99;
    expect([...new Uint8Array(exact)]).toEqual([10, 99, 30, 40]);
  });

  it('recognizes URL and buffer descriptors without confusing native inputs', () => {
    expect(__private__.isUrlDescriptor({ type: 'url', url: 'https://media.example/a.mp4' })).toBe(true);
    expect(__private__.isUrlDescriptor(new URL('https://media.example/a.mp4'))).toBe(false);
    expect(__private__.isBufferDescriptor({ type: 'buffer', data: new ArrayBuffer(1) })).toBe(true);
    expect(__private__.isBufferDescriptor(new ArrayBuffer(1))).toBe(false);
  });

  it('derives request options without adding undefined fields', () => {
    expect(
      __private__.requestInitFor({
        type: 'url',
        url: 'https://media.example/a.mp4',
        headers: { Authorization: 'Bearer test' },
        credentials: 'include',
        cache: 'none',
      }),
    ).toEqual({
      headers: { Authorization: 'Bearer test' },
      credentials: 'include',
      cache: 'no-store',
    });
    expect(
      __private__.requestInitFor({
        type: 'url',
        url: 'https://media.example/a.mp4',
        cache: 'browser',
      }),
    ).toEqual({});
    expect(
      __private__.requestInitFor({
        type: 'url',
        url: 'https://media.example/public.mp4',
        cache: 'persistent',
      }),
    ).toEqual({ credentials: 'omit' });
  });

  it('rejects personalized descriptors from the URL-keyed persistent cache', () => {
    expect(() => __private__.assertPublicPersistentSource({
      type: 'url',
      url: 'https://media.example/private.mp4',
      cache: 'persistent',
      headers: { Authorization: 'Bearer secret' },
    })).toThrowError(/public media without custom headers or credentials/iu);
    expect(() => __private__.assertPublicPersistentSource({
      type: 'url',
      url: 'https://media.example/private.mp4',
      cache: 'persistent',
      credentials: 'include',
    })).toThrowError(/public media without custom headers or credentials/iu);
    expect(() => __private__.assertPublicPersistentSource({
      type: 'url',
      url: 'https://media.example/public.mp4',
      cache: 'persistent',
      credentials: 'omit',
    })).not.toThrow();
  });

  it('stops worker-style CORS retries and bounds other network retries', () => {
    vi.stubGlobal('location', {
      href: 'https://app.example/editor',
      origin: 'https://app.example',
    });
    vi.stubGlobal('navigator', { onLine: true });

    expect(__private__.urlRetryDelay(
      1,
      new TypeError('Failed to fetch'),
      'https://cdn.example/template.mp4',
    )).toBeNull();
    expect(__private__.urlRetryDelay(
      1,
      new TypeError('Temporary connection reset'),
      'https://app.example/template.mp4',
    )).toBe(0.5);
    expect(__private__.urlRetryDelay(
      2,
      new TypeError('Temporary connection reset'),
      'https://app.example/template.mp4',
    )).toBe(1);
    expect(__private__.urlRetryDelay(
      3,
      new TypeError('Temporary connection reset'),
      'https://app.example/template.mp4',
    )).toBeNull();

    const streamRetry = __private__.createBoundedRetryPolicy();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect(streamRetry(
        1,
        new TypeError('Response body terminated'),
        'https://app.example/template.mp4',
      )).toBe(0.5);
    }
    expect(streamRetry(
      1,
      new TypeError('Response body terminated'),
      'https://app.example/template.mp4',
    )).toBeNull();
  });

  it('passes cancellation into direct media downloads', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (init?.signal?.aborted === true) abort();
        else init?.signal?.addEventListener('abort', abort, { once: true });
      }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const pending = sourceToBlob(
      { type: 'url', url: 'https://media.example/poster.png', cache: 'none' },
      undefined,
      controller.signal,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort('test cancellation');

    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('accepts a small complete response when a server ignores Range', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(128), {
      status: 200,
      headers: { 'content-length': '128' },
    })));

    const response = await __private__.boundedMediaFetch('https://media.example/small.mp4', {
      headers: { Range: 'bytes=0-31' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('128');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(128));
  });

  it('accepts a bounded complete response without Content-Length when a CDN ignores Range', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
    })));

    const response = await __private__.boundedMediaFetch('https://media.example/cdn.mp4', {
      headers: { Range: 'bytes=0-31' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('4');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3, 4]);
  });

  it('rejects an oversized complete response when a server ignores Range', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(8), {
      status: 200,
      headers: { 'content-length': String(80 * 1024 * 1024) },
    })));

    await expect(__private__.boundedMediaFetch('https://media.example/large.mp4', {
      headers: { Range: 'bytes=0-31' },
    })).rejects.toMatchObject({ code: 'FETCH_FAILED' });
  });
});
