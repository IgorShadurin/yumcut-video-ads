import {
  ALL_FORMATS,
  BlobSource,
  BufferSource,
  Input,
  UnsupportedInputFormatError,
  UrlSource,
  type InputAudioTrack,
  type InputVideoTrack,
} from 'mediabunny';
import { VideoAdsError, throwIfAborted } from './errors';
import type {
  BufferMediaSource,
  MediaInfo,
  MediaSource,
  MediaTrackInfo,
  UrlMediaSource,
} from './types';

export const ASSET_CACHE_NAME = 'yumcut-video-ads-assets-v1';
const MAX_IGNORED_RANGE_RESPONSE_BYTES = 64 * 1024 * 1024;

const isUrlDescriptor = (source: MediaSource): source is UrlMediaSource =>
  typeof source === 'object' && source !== null && 'type' in source && source.type === 'url';

const isBufferDescriptor = (source: MediaSource): source is BufferMediaSource =>
  typeof source === 'object' && source !== null && 'type' in source && source.type === 'buffer';

export const sourceUrl = (source: string | URL | UrlMediaSource): string => {
  if (typeof source === 'string') return source;
  if (source instanceof URL) return source.href;
  return source.url instanceof URL ? source.url.href : source.url;
};

const exactArrayBuffer = (data: ArrayBuffer | ArrayBufferView): ArrayBuffer => {
  if (data instanceof ArrayBuffer) return data;
  if (data.buffer instanceof ArrayBuffer) {
    if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) return data.buffer;
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }

  // Blob does not accept SharedArrayBuffer-backed views, and partial views must
  // expose only their addressed bytes. Copy those uncommon cases into a normal,
  // exact-sized ArrayBuffer.
  const copy = new Uint8Array(data.byteLength);
  copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return copy.buffer;
};

const requestInitFor = (source: UrlMediaSource): Omit<RequestInit, 'signal'> => ({
  ...(source.headers === undefined ? {} : { headers: { ...source.headers } }),
  ...(source.credentials === undefined
    ? source.cache === 'persistent' ? { credentials: 'omit' as const } : {}
    : { credentials: source.credentials }),
  ...(source.cache === 'none' ? { cache: 'no-store' as RequestCache } : {}),
});

const assertPublicPersistentSource = (source: UrlMediaSource): void => {
  if (source.cache !== 'persistent') return;
  const hasHeaders = source.headers !== undefined && Object.keys(source.headers).length > 0;
  const hasCredentials = source.credentials !== undefined && source.credentials !== 'omit';
  if (hasHeaders || hasCredentials) {
    throw new VideoAdsError(
      'INVALID_SOURCE',
      'Persistent caching is only available for public media without custom headers or credentials. Use cache: "browser", or a distinct signed/versioned URL.',
      { details: { url: sourceUrl(source) } },
    );
  }
};

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

const isLikelyCrossOriginFetchFailure = (
  error: unknown,
  source: string | URL | Request,
): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  if (
    !(error instanceof TypeError) &&
    !/failed to fetch|load failed|networkerror when attempting to fetch resource/iu.test(message)
  ) {
    return false;
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  if (typeof location === 'undefined') return false;

  try {
    const raw = typeof source === 'string'
      ? source
      : source instanceof URL
        ? source.href
        : source.url;
    return new URL(raw, location.href).origin !== location.origin;
  } catch {
    return false;
  }
};

/** A finite UrlSource retry policy that also works in DedicatedWorkerGlobalScope. */
const urlRetryDelay = (
  previousAttempts: number,
  error: unknown,
  source: string | URL | Request,
): number | null => {
  if (
    error instanceof VideoAdsError ||
    isAbortError(error) ||
    isLikelyCrossOriginFetchFailure(error, source)
  ) return null;
  // The initial request plus two retries absorbs a transient failure without
  // allowing an invalid/offline URL to hang a render forever.
  if (previousAttempts >= 3) return null;
  return Math.min(2 ** (previousAttempts - 2), 2);
};

const createBoundedRetryPolicy = (): typeof urlRetryDelay => {
  let totalFailures = 0;
  return (previousAttempts, error, source) => {
    totalFailures += 1;
    // Mediabunny currently reports every response-body resume failure as
    // attempt 1. A per-source ceiling keeps that path finite as well as the
    // ordinary fetch retry loop.
    if (totalFailures > 6) return null;
    return urlRetryDelay(previousAttempts, error, source);
  };
};

/**
 * UrlSource may otherwise buffer an entire large asset when a host ignores a
 * byte-range request. Small complete responses remain useful, but an unknown
 * or large one must be prefetched to persistent storage (or supplied as Blob)
 * so memory use stays bounded.
 */
const boundedMediaFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const response = await fetch(input, init);
  if (request.headers.has('range') && response.status === 200) {
    const rawLength = response.headers.get('content-length');
    const length = rawLength === null ? undefined : Number(rawLength);
    const safeSmallResponse = length !== undefined &&
      Number.isFinite(length) &&
      length >= 0 &&
      length <= MAX_IGNORED_RANGE_RESPONSE_BYTES;
    if (!safeSmallResponse) {
      await response.body?.cancel().catch(() => undefined);
      throw new VideoAdsError(
        'FETCH_FAILED',
        'The media server ignored byte-range requests for a large or unknown-size asset. Prefetch it with cache: "persistent", or provide a Blob/File.',
        {
          details: {
            url: request.url,
            contentLength: Number.isFinite(length) ? length : undefined,
            maximumBufferedBytes: MAX_IGNORED_RANGE_RESPONSE_BYTES,
          },
        },
      );
    }
  }
  return response;
};

async function cachedBlob(
  source: UrlMediaSource,
  cacheName = ASSET_CACHE_NAME,
  signal?: AbortSignal,
): Promise<Blob | null> {
  assertPublicPersistentSource(source);
  throwIfAborted(signal);
  if (source.cache !== 'persistent' || typeof caches === 'undefined') return null;
  const cache = await caches.open(cacheName);
  throwIfAborted(signal);
  const response = await cache.match(sourceUrl(source), { ignoreVary: true });
  throwIfAborted(signal);
  if (!response) return null;
  const blob = await response.blob();
  throwIfAborted(signal);
  return blob;
}

export async function createMediaInput(
  source: MediaSource,
  cacheName = ASSET_CACHE_NAME,
  signal?: AbortSignal,
): Promise<Input> {
  let input: Input | undefined;
  try {
    throwIfAborted(signal);
    if (isUrlDescriptor(source)) {
      const blob = await cachedBlob(source, cacheName, signal);
      if (blob) {
        input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob, { maxCacheSize: 16 << 20 }) });
      } else {
        input = new Input({
          formats: ALL_FORMATS,
          source: new UrlSource(sourceUrl(source), {
            requestInit: requestInitFor(source),
            maxCacheSize: 32 << 20,
            parallelism: 2,
            getRetryDelay: createBoundedRetryPolicy(),
            fetchFn: boundedMediaFetch,
          }),
        });
      }
    } else if (typeof source === 'string' || source instanceof URL) {
      input = new Input({
        formats: ALL_FORMATS,
        source: new UrlSource(sourceUrl(source), {
          maxCacheSize: 32 << 20,
          parallelism: 2,
          getRetryDelay: createBoundedRetryPolicy(),
          fetchFn: boundedMediaFetch,
        }),
      });
    } else if (isBufferDescriptor(source)) {
      input = new Input({ formats: ALL_FORMATS, source: new BufferSource(exactArrayBuffer(source.data)) });
    } else if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
      input = new Input({ formats: ALL_FORMATS, source: new BufferSource(exactArrayBuffer(source)) });
    } else if (typeof Blob !== 'undefined' && source instanceof Blob) {
      input = new Input({ formats: ALL_FORMATS, source: new BlobSource(source, { maxCacheSize: 16 << 20 }) });
    } else {
      throw new VideoAdsError('INVALID_SOURCE', 'The media source type is not supported.');
    }

    throwIfAborted(signal);
    return input;
  } catch (error) {
    if (input && !input.disposed) input.dispose();
    if (error instanceof VideoAdsError) throw error;
    throw VideoAdsError.from(error, 'INVALID_SOURCE', 'Unable to open the media source.');
  }
}

const toUs = (seconds: number): number => Math.max(0, Math.round(seconds * 1_000_000));

async function videoTrackInfo(track: InputVideoTrack): Promise<MediaTrackInfo> {
  const [codec, end, start, width, height, bitrate, stats, decodable] = await Promise.all([
    track.getCodecParameterString().then((value) => value ?? track.getCodec()).then((value) => value ?? 'unknown'),
    track.getDurationFromMetadata().then((value) => value ?? track.computeDuration()),
    track.getFirstTimestamp(),
    track.getDisplayWidth(),
    track.getDisplayHeight(),
    track.getAverageBitrate(),
    track.computePacketStats(120).catch(() => null),
    track.canDecode().catch(() => false),
  ]);
  return {
    type: 'video',
    codec: String(codec),
    decodable,
    durationUs: toUs(Math.max(0, end - start)),
    width,
    height,
    ...(stats === null ? {} : { frameRate: stats.averagePacketRate }),
    ...(bitrate === null ? {} : { bitrate }),
  };
}

async function audioTrackInfo(track: InputAudioTrack): Promise<MediaTrackInfo> {
  const [codec, end, start, sampleRate, channels, bitrate, decodable] = await Promise.all([
    track.getCodecParameterString().then((value) => value ?? track.getCodec()).then((value) => value ?? 'unknown'),
    track.getDurationFromMetadata().then((value) => value ?? track.computeDuration()),
    track.getFirstTimestamp(),
    track.getSampleRate(),
    track.getNumberOfChannels(),
    track.getAverageBitrate(),
    track.canDecode().catch(() => false),
  ]);
  return {
    type: 'audio',
    codec: String(codec),
    decodable,
    durationUs: toUs(Math.max(0, end - start)),
    sampleRate,
    channels,
    ...(bitrate === null ? {} : { bitrate }),
  };
}

async function inspectImage(source: MediaSource, cacheName: string): Promise<MediaInfo> {
  const blob = await sourceToBlob(source, cacheName);
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    return {
      durationUs: 0,
      width: bitmap.width,
      height: bitmap.height,
      displayWidth: bitmap.width,
      displayHeight: bitmap.height,
      pixelAspectRatio: 1,
      rotationDegrees: 0,
      hasAudio: false,
      hasVideo: false,
      tracks: [],
    };
  } catch (error) {
    throw VideoAdsError.from(error, 'CORRUPT_MEDIA', 'The source is neither readable media nor a supported image.');
  } finally {
    bitmap?.close();
  }
}

export async function sourceToBlob(
  source: MediaSource,
  cacheName = ASSET_CACHE_NAME,
  signal?: AbortSignal,
): Promise<Blob> {
  throwIfAborted(signal);
  if (typeof Blob !== 'undefined' && source instanceof Blob) return source;
  if (isBufferDescriptor(source)) return new Blob([exactArrayBuffer(source.data)], {
    ...(source.mimeType === undefined ? {} : { type: source.mimeType }),
  });
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    return new Blob([exactArrayBuffer(source)]);
  }

  const descriptor: UrlMediaSource = isUrlDescriptor(source)
    ? source
    : { type: 'url', url: source as string | URL };
  const cached = await cachedBlob(descriptor, cacheName, signal);
  if (cached) return cached;

  try {
    const response = await fetch(sourceUrl(descriptor), {
      ...requestInitFor(descriptor),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      throw new VideoAdsError('FETCH_FAILED', `Media request failed with HTTP ${response.status}.`, {
        details: { url: sourceUrl(descriptor), status: response.status },
      });
    }
    const blob = await response.blob();
    throwIfAborted(signal);
    return blob;
  } catch (error) {
    if (error instanceof VideoAdsError) throw error;
    if (signal?.aborted === true || isAbortError(error)) {
      throw new VideoAdsError('ABORTED', 'The media request was cancelled.', {
        cause: error,
        details: { url: sourceUrl(descriptor) },
      });
    }
    const url = sourceUrl(descriptor);
    const crossOrigin = typeof location !== 'undefined' && new URL(url, location.href).origin !== location.origin;
    const code = error instanceof TypeError && crossOrigin ? 'CORS' : 'FETCH_FAILED';
    const message = code === 'CORS'
      ? 'The cross-origin source could not be fetched. Check its Access-Control-Allow-Origin policy.'
      : 'Unable to fetch the source. Check the URL and network connection.';
    throw VideoAdsError.from(error, code, message, { url });
  }
}

export async function inspectMedia(source: MediaSource, cacheName = ASSET_CACHE_NAME): Promise<MediaInfo> {
  const input = await createMediaInput(source, cacheName);
  try {
    if (!(await input.canRead())) {
      input.dispose();
      return inspectImage(source, cacheName);
    }

    const [videoTracks, audioTracks] = await Promise.all([
      input.getVideoTracks(),
      input.getAudioTracks(),
    ]);
    const allTracks = [...videoTracks, ...audioTracks];
    const [endTimestamp, firstTimestamp] = await Promise.all([
      input.getDurationFromMetadata(allTracks).then((value) => value ?? input.computeDuration(allTracks)),
      input.getFirstTimestamp(allTracks),
    ]);
    const duration = Math.max(0, endTimestamp - firstTimestamp);
    const [videoInfos, audioInfos, primaryVideo, primaryAudio] = await Promise.all([
      Promise.all(videoTracks.map(videoTrackInfo)),
      Promise.all(audioTracks.map(audioTrackInfo)),
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
    ]);

    const tracks: MediaTrackInfo[] = [...videoInfos, ...audioInfos];
    const video = primaryVideo === null
      ? undefined
      : videoInfos[videoTracks.indexOf(primaryVideo)] ?? await videoTrackInfo(primaryVideo);
    const audio = primaryAudio === null
      ? undefined
      : audioInfos[audioTracks.indexOf(primaryAudio)] ?? await audioTrackInfo(primaryAudio);
    const [videoDecodable, audioDecodable] = await Promise.all([
      primaryVideo?.canDecode().catch(() => false),
      primaryAudio?.canDecode().catch(() => false),
    ]);
    const [displayWidth, displayHeight, codedWidth, codedHeight, pixelRatio, rotation, hdr] = primaryVideo
      ? await Promise.all([
        primaryVideo.getDisplayWidth(),
        primaryVideo.getDisplayHeight(),
        primaryVideo.getCodedWidth(),
        primaryVideo.getCodedHeight(),
        primaryVideo.getPixelAspectRatio(),
        primaryVideo.getRotation(),
        primaryVideo.hasHighDynamicRange(),
      ])
      : [undefined, undefined, undefined, undefined, undefined, undefined, undefined];

    return {
      durationUs: toUs(duration),
      ...(codedWidth === undefined ? {} : { width: codedWidth }),
      ...(codedHeight === undefined ? {} : { height: codedHeight }),
      ...(displayWidth === undefined ? {} : { displayWidth }),
      ...(displayHeight === undefined ? {} : { displayHeight }),
      ...(pixelRatio === undefined ? {} : { pixelAspectRatio: pixelRatio.num / pixelRatio.den }),
      ...(rotation === undefined ? {} : { rotationDegrees: rotation }),
      ...(video?.frameRate === undefined ? {} : { frameRate: video.frameRate }),
      ...(video === undefined ? {} : { videoCodec: video.codec }),
      ...(audio === undefined ? {} : { audioCodec: audio.codec }),
      ...(videoDecodable === undefined ? {} : { videoDecodable }),
      ...(audioDecodable === undefined ? {} : { audioDecodable }),
      hasAudio: primaryAudio !== null,
      hasVideo: primaryVideo !== null,
      ...(hdr === undefined ? {} : { hdr }),
      tracks,
    };
  } catch (error) {
    if (error instanceof UnsupportedInputFormatError) {
      input.dispose();
      return inspectImage(source, cacheName);
    }
    if (error instanceof VideoAdsError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (isRemoteMediaSource(source) && (/cors|cross[- ]origin/iu.test(message) || error instanceof TypeError)) {
      throw VideoAdsError.from(
        error,
        'CORS',
        'The remote media could not be read. Confirm that its server allows CORS and byte-range requests.',
      );
    }
    if (isRemoteMediaSource(source) && /fetch|network|http|response|request/iu.test(message)) {
      throw VideoAdsError.from(error, 'FETCH_FAILED', 'Unable to read the remote media response.');
    }
    throw VideoAdsError.from(error, 'CORRUPT_MEDIA', 'Unable to inspect the media source.');
  } finally {
    if (!input.disposed) input.dispose();
  }
}

export const isRemoteMediaSource = (source: MediaSource): boolean =>
  typeof source === 'string' || source instanceof URL || isUrlDescriptor(source);

export const __private__ = {
  assertPublicPersistentSource,
  boundedMediaFetch,
  createBoundedRetryPolicy,
  exactArrayBuffer,
  isBufferDescriptor,
  isUrlDescriptor,
  requestInitFor,
  urlRetryDelay,
};
