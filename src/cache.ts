import { VideoAdsError, throwIfAborted } from './errors';
import type {
  CacheController,
  CacheEntryInfo,
  CacheEstimate,
  CacheMode,
  CachePrefetchOptions,
  UrlMediaSource,
} from './types';

/** Shared with the render worker so a URL can be looked up without an adapter. */
export const YUMCUT_VIDEO_ADS_CACHE_NAME = 'yumcut-video-ads-assets-v1';
/** @deprecated Use `YUMCUT_VIDEO_ADS_CACHE_NAME`. */
export const VIDEO_ADS_CACHE_NAME = YUMCUT_VIDEO_ADS_CACHE_NAME;

const CACHED_AT_HEADER = 'x-yumcut-video-ads-cached-at';

export interface AssetCacheOptions {
  cacheName?: string;
  /** Primarily useful for tests or applications with an instrumented fetch wrapper. */
  fetch?: typeof fetch;
}

export interface AssetRequestOptions extends CachePrefetchOptions {
  /** Additional native Request options. GET is always enforced for media assets. */
  requestInit?: Omit<RequestInit, 'body' | 'method' | 'signal' | 'headers' | 'credentials'>;
  /** Use ETag or Last-Modified validators when a persistent entry already exists. */
  revalidate?: boolean;
}

export interface AssetFetchOptions extends AssetRequestOptions {
  /** Overrides a descriptor's cache mode. Defaults to `browser`. */
  cache?: CacheMode;
}

interface NormalizedSource {
  url: string;
  headers: Headers;
  credentials?: RequestCredentials;
  cache: CacheMode;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveUrl(source: string | URL): string {
  try {
    if (source instanceof URL) return source.href;
    if (typeof location !== 'undefined') return new URL(source, location.href).href;
    return new URL(source).href;
  } catch (error) {
    throw new VideoAdsError('INVALID_SOURCE', `Invalid media URL: ${String(source)}`, {
      cause: error,
    });
  }
}

function normalizeSource(
  source: string | URL | UrlMediaSource,
  options: AssetFetchOptions = {},
): NormalizedSource {
  const descriptor =
    typeof source === 'object' && !(source instanceof URL) && source.type === 'url'
      ? source
      : undefined;
  const url = resolveUrl(descriptor?.url ?? source as string | URL);
  const headers = new Headers(descriptor?.headers);
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers.set(name, value);
  }

  const normalized: NormalizedSource = {
    url,
    headers,
    cache: options.cache ?? descriptor?.cache ?? 'browser',
  };
  const credentials = options.credentials ?? descriptor?.credentials;
  if (credentials !== undefined) normalized.credentials = credentials;
  return normalized;
}

function canonicalRequest(url: string): Request {
  const protocol = new URL(url).protocol;
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new VideoAdsError(
      'INVALID_SOURCE',
      `Persistent caching only supports HTTP(S) URLs, not ${protocol}`,
      { details: { url } },
    );
  }
  // Deliberately omit source headers: the worker uses cache.match(url), and a
  // single canonical request also avoids persisting secrets in the cache key.
  return new Request(url, { method: 'GET', credentials: 'omit' });
}

/**
 * Persistent entries are intentionally keyed by URL so the render worker can
 * consume them without receiving secrets. That is only safe for public,
 * invariant responses. A personalized request must stay in the browser HTTP
 * cache (or use a distinct signed/versioned URL) rather than sharing this
 * origin-wide Cache Storage entry.
 */
function assertPublicPersistentSource(source: NormalizedSource): void {
  if (source.headers.keys().next().done !== true || (
    source.credentials !== undefined && source.credentials !== 'omit'
  )) {
    throw new VideoAdsError(
      'INVALID_SOURCE',
      'Persistent caching is only available for public media without custom headers or credentials. Use cache: "browser", or a distinct signed/versioned URL.',
      { details: { url: source.url } },
    );
  }
}

function networkRequest(
  source: NormalizedSource,
  options: AssetRequestOptions,
  requestCache: RequestCache,
  conditionalHeaders?: Headers,
): Request {
  const headers = new Headers(source.headers);
  conditionalHeaders?.forEach((value, name) => {
    if (!headers.has(name)) headers.set(name, value);
  });

  const init: RequestInit = {
    ...options.requestInit,
    method: 'GET',
    headers,
    cache: requestCache,
    // Explicit CORS mode prevents an opaque response from being mistaken for
    // usable media. Same-origin requests also work in CORS mode.
    mode: options.requestInit?.mode ?? 'cors',
  };
  if (source.credentials !== undefined) init.credentials = source.credentials;
  else if (source.cache === 'persistent') init.credentials = 'omit';
  if (options.signal !== undefined) init.signal = options.signal;
  return new Request(source.url, init);
}

function responseSize(response: Response): number | undefined {
  const raw = response.headers.get('content-length');
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function headerTimestamp(response: Response, name: string, fallback: number): number {
  const parsed = Number(response.headers.get(name));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function entryInfo(url: string, response: Response, now = Date.now()): CacheEntryInfo {
  const entry: CacheEntryInfo = {
    key: url,
    url,
    createdAt: headerTimestamp(response, CACHED_AT_HEADER, now),
    lastAccessedAt: now,
  };
  const sizeBytes = responseSize(response);
  const etag = response.headers.get('etag');
  const lastModified = response.headers.get('last-modified');
  if (sizeBytes !== undefined) entry.sizeBytes = sizeBytes;
  if (etag !== null) entry.etag = etag;
  if (lastModified !== null) entry.lastModified = lastModified;
  return entry;
}

function responseForCache(response: Response, cachedAt: number): Response {
  const headers = new Headers(response.headers);
  headers.set(CACHED_AT_HEADER, String(cachedAt));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function conditionalHeaders(response: Response): Headers {
  const headers = new Headers();
  const etag = response.headers.get('etag');
  const lastModified = response.headers.get('last-modified');
  if (etag !== null) headers.set('if-none-match', etag);
  if (lastModified !== null) headers.set('if-modified-since', lastModified);
  return headers;
}

function assertUsableResponse(
  response: Response,
  url: string,
  requireComplete = false,
): void {
  if (response.type === 'opaque' || response.type === 'opaqueredirect') {
    throw new VideoAdsError(
      'CORS',
      'The server returned an opaque response. It must allow cross-origin media requests.',
      { details: { url, responseType: response.type } },
    );
  }
  if (!response.ok) {
    throw new VideoAdsError(
      'FETCH_FAILED',
      `Media request failed with HTTP ${response.status} ${response.statusText}.`,
      { details: { url, status: response.status } },
    );
  }
  if (requireComplete && response.status === 206) {
    throw new VideoAdsError(
      'FETCH_FAILED',
      'Persistent caching requires a complete response; the server returned partial content.',
      { details: { url, status: response.status } },
    );
  }
}

function isProbablyCrossOrigin(url: string): boolean {
  if (typeof location === 'undefined') return false;
  try {
    return new URL(url).origin !== location.origin;
  } catch {
    return false;
  }
}

function fetchFailure(error: unknown, url: string, signal?: AbortSignal): VideoAdsError {
  if (
    signal?.aborted === true ||
    (error instanceof Error && error.name === 'AbortError')
  ) {
    return new VideoAdsError('ABORTED', 'The asset request was cancelled.', {
      cause: error,
      details: { url },
    });
  }
  if (error instanceof VideoAdsError) return error;

  if (error instanceof TypeError && isProbablyCrossOrigin(url)) {
    return new VideoAdsError(
      'CORS',
      'The cross-origin media request failed. Check the server CORS policy and URL.',
      { cause: error, details: { url } },
    );
  }
  return new VideoAdsError('FETCH_FAILED', `Failed to fetch media: ${messageOf(error)}`, {
    cause: error,
    details: { url },
  });
}

/**
 * Cache manager for remote templates and media.
 *
 * `fetch()` with the default `browser` mode delegates to the normal HTTP cache.
 * `prefetch()` always stores a complete response in Cache Storage under its URL.
 */
export class BrowserAssetCache implements CacheController {
  readonly cacheName: string;
  private readonly fetchImplementation: typeof fetch | undefined;

  constructor(options: AssetCacheOptions = {}) {
    this.cacheName = options.cacheName ?? VIDEO_ADS_CACHE_NAME;
    this.fetchImplementation = options.fetch;
  }

  private getFetch(): typeof fetch {
    if (this.fetchImplementation !== undefined) return this.fetchImplementation;
    if (typeof fetch !== 'undefined') return globalThis.fetch.bind(globalThis);
    throw new VideoAdsError(
      'UNSUPPORTED_ENVIRONMENT',
      'The Fetch API is unavailable in this environment.',
    );
  }

  private async openCache(): Promise<Cache> {
    if (typeof caches === 'undefined') {
      throw new VideoAdsError(
        'UNSUPPORTED_ENVIRONMENT',
        'Cache Storage is unavailable in this environment.',
      );
    }
    try {
      return await caches.open(this.cacheName);
    } catch (error) {
      throw new VideoAdsError('CACHE_FAILED', 'Could not open the persistent asset cache.', {
        cause: error,
        details: { cacheName: this.cacheName },
      });
    }
  }

  private async downloadToCache(
    source: NormalizedSource,
    options: AssetRequestOptions,
    cache: Cache,
    key: Request,
    existing?: Response,
  ): Promise<Response> {
    throwIfAborted(options.signal);
    const validators = options.revalidate === true && existing !== undefined
      ? conditionalHeaders(existing)
      : undefined;
    const request = networkRequest(
      source,
      options,
      options.revalidate === true ? 'no-cache' : 'default',
      validators,
    );

    let response: Response;
    try {
      response = await this.getFetch()(request);
    } catch (error) {
      throw fetchFailure(error, source.url, options.signal);
    }

    if (response.status === 304 && existing !== undefined) return existing;
    assertUsableResponse(response, source.url, true);

    try {
      // Pass the original body to Cache Storage instead of cloning it. Cloning
      // a large streaming response can make the unused tee buffer the full file
      // in memory. Read the stored response back after the write completes.
      await cache.put(key, responseForCache(response, Date.now()));
      const stored = await cache.match(key, { ignoreVary: true });
      if (stored === undefined) {
        throw new Error('The response was not present after Cache.put().');
      }
      return stored;
    } catch (error) {
      if (error instanceof VideoAdsError) throw error;
      throw new VideoAdsError('CACHE_FAILED', 'Could not persist the downloaded media.', {
        cause: error,
        details: { cacheName: this.cacheName, url: source.url },
      });
    }
  }

  async prefetch(
    source: string | URL | UrlMediaSource,
    options: AssetRequestOptions = {},
  ): Promise<CacheEntryInfo> {
    const normalized = normalizeSource(source, options);
    normalized.cache = 'persistent';
    throwIfAborted(options.signal);
    assertPublicPersistentSource(normalized);
    if (normalized.headers.has('range')) {
      throw new VideoAdsError(
        'INVALID_SOURCE',
        'Persistent prefetch cannot use a Range request because it stores the complete asset.',
        { details: { url: normalized.url } },
      );
    }
    const key = canonicalRequest(normalized.url);
    const cache = await this.openCache();

    let existing: Response | undefined;
    try {
      existing = await cache.match(key, { ignoreVary: true });
    } catch (error) {
      throw new VideoAdsError('CACHE_FAILED', 'Could not read the persistent asset cache.', {
        cause: error,
        details: { cacheName: this.cacheName, url: normalized.url },
      });
    }

    const response =
      existing !== undefined && options.revalidate !== true
        ? existing
        : await this.downloadToCache(normalized, options, cache, key, existing);
    return entryInfo(normalized.url, response);
  }

  /** Fetch a source using browser HTTP caching, persistent caching, or no cache. */
  async fetch(
    source: string | URL | UrlMediaSource,
    options: AssetFetchOptions = {},
  ): Promise<Response> {
    const normalized = normalizeSource(source, options);
    throwIfAborted(options.signal);

    if (normalized.cache !== 'persistent') {
      const requestCache: RequestCache = normalized.cache === 'none' ? 'no-store' : 'default';
      const request = networkRequest(normalized, options, requestCache);
      try {
        const response = await this.getFetch()(request);
        assertUsableResponse(response, normalized.url);
        return response;
      } catch (error) {
        throw fetchFailure(error, normalized.url, options.signal);
      }
    }

    assertPublicPersistentSource(normalized);
    const key = canonicalRequest(normalized.url);
    if (normalized.headers.has('range')) {
      throw new VideoAdsError(
        'INVALID_SOURCE',
        'Persistent caching cannot use a Range request because it stores the complete asset.',
        { details: { url: normalized.url } },
      );
    }
    const cache = await this.openCache();
    let existing: Response | undefined;
    try {
      existing = await cache.match(key, { ignoreVary: true });
    } catch (error) {
      throw new VideoAdsError('CACHE_FAILED', 'Could not read the persistent asset cache.', {
        cause: error,
        details: { cacheName: this.cacheName, url: normalized.url },
      });
    }
    if (existing !== undefined && options.revalidate !== true) return existing;
    return this.downloadToCache(normalized, options, cache, key, existing);
  }

  async remove(source: string | URL | UrlMediaSource): Promise<boolean> {
    const normalized = normalizeSource(source);
    assertPublicPersistentSource(normalized);
    const key = canonicalRequest(normalized.url);
    const cache = await this.openCache();
    try {
      return await cache.delete(key, { ignoreVary: true });
    } catch (error) {
      throw new VideoAdsError('CACHE_FAILED', 'Could not remove the cached media.', {
        cause: error,
        details: { cacheName: this.cacheName, url: normalized.url },
      });
    }
  }

  async clear(): Promise<void> {
    if (typeof caches === 'undefined') return;
    try {
      await caches.delete(this.cacheName);
    } catch (error) {
      throw new VideoAdsError('CACHE_FAILED', 'Could not clear the persistent asset cache.', {
        cause: error,
        details: { cacheName: this.cacheName },
      });
    }
  }

  async estimate(): Promise<CacheEstimate> {
    const estimate: CacheEstimate = {};

    if (
      typeof navigator !== 'undefined' &&
      navigator.storage !== undefined &&
      typeof navigator.storage.estimate === 'function'
    ) {
      try {
        const storage = await navigator.storage.estimate();
        if (typeof storage.usage === 'number') estimate.usageBytes = storage.usage;
        if (typeof storage.quota === 'number') estimate.quotaBytes = storage.quota;
        if (typeof storage.usage === 'number' && typeof storage.quota === 'number') {
          estimate.availableBytes = Math.max(0, storage.quota - storage.usage);
        }
      } catch {
        // Cache-specific information below remains useful when quota estimates
        // are restricted by privacy settings.
      }
    }

    if (typeof caches === 'undefined') return estimate;
    try {
      if (!(await caches.has(this.cacheName))) {
        estimate.entries = 0;
        estimate.storedBytes = 0;
        return estimate;
      }
      const cache = await caches.open(this.cacheName);
      const keys = await cache.keys();
      const responses = await Promise.all(
        keys.map((key) => cache.match(key, { ignoreVary: true })),
      );
      let storedBytes = 0;
      for (const response of responses) {
        if (response === undefined) continue;
        storedBytes += responseSize(response) ?? 0;
      }
      estimate.entries = keys.length;
      estimate.storedBytes = storedBytes;
      return estimate;
    } catch (error) {
      throw new VideoAdsError('CACHE_FAILED', 'Could not estimate the persistent asset cache.', {
        cause: error,
        details: { cacheName: this.cacheName },
      });
    }
  }

  /** Return metadata for persistent entries without reading their bodies. */
  async entries(): Promise<readonly CacheEntryInfo[]> {
    const cache = await this.openCache();
    try {
      const keys = await cache.keys();
      const now = Date.now();
      const entries = await Promise.all(
        keys.map(async (key): Promise<CacheEntryInfo | undefined> => {
          const response = await cache.match(key, { ignoreVary: true });
          return response === undefined ? undefined : entryInfo(key.url, response, now);
        }),
      );
      return entries.filter((entry): entry is CacheEntryInfo => entry !== undefined);
    } catch (error) {
      throw new VideoAdsError('CACHE_FAILED', 'Could not list the persistent asset cache.', {
        cause: error,
        details: { cacheName: this.cacheName },
      });
    }
  }
}

export { BrowserAssetCache as AssetCache };

export function createAssetCache(options: AssetCacheOptions = {}): BrowserAssetCache {
  return new BrowserAssetCache(options);
}
