import { createAssetCache, type AssetCacheOptions, type BrowserAssetCache } from './cache';
import {
  VIDEO_ADS_ERROR_CODES,
  VideoAdsError,
  type VideoAdsErrorCode,
} from './errors';
import { inspectMedia, isRemoteMediaSource, sourceUrl } from './media';
import { detectSupport } from './support';
import { projectDurationUs } from './timeline';
import type {
  AnalyzeOptions,
  AnalyzeReport,
  MediaInfo,
  MediaSource,
  Project,
  RenderOptions,
  RenderResult,
  SupportProfile,
  SupportReport,
  UrlMediaSource,
  YumCutVideoAds,
} from './types';
import { assertValidProject } from './validation';
import type {
  WorkerRequest,
  WorkerResponse,
  WorkerResultResponse,
} from './worker-protocol';

export interface YumCutVideoAdsOptions {
  /** Override the emitted worker URL, primarily for custom CDN/CSP deployments. */
  workerUrl?: string | URL;
  /** Supply a custom worker for tests or applications with their own worker loader. */
  workerFactory?: () => Worker;
  cache?: AssetCacheOptions;
}

/** Descriptive compatibility name retained for pre-brand integrations. */
export type VideoAdsOptions = YumCutVideoAdsOptions;

interface PendingRender {
  resolve: (result: RenderResult) => void;
  reject: (error: unknown) => void;
  onProgress?: RenderOptions['onProgress'];
  cleanupAbort?: () => void;
}

const errorCode = (value: string): VideoAdsErrorCode =>
  (VIDEO_ADS_ERROR_CODES as readonly string[]).includes(value)
    ? value as VideoAdsErrorCode
    : 'INTERNAL_ERROR';

const resolveAgainstPage = (value: string | URL): string => {
  const raw = value instanceof URL ? value.href : value;
  if (typeof document !== 'undefined') return new URL(raw, document.baseURI).href;
  if (typeof location !== 'undefined') return new URL(raw, location.href).href;
  return new URL(raw).href;
};

function absoluteSource(source: MediaSource): MediaSource {
  if (typeof source === 'string' || source instanceof URL) return resolveAgainstPage(source);
  if (
    typeof source === 'object' &&
    source !== null &&
    'type' in source &&
    source.type === 'url' &&
    'url' in source
  ) {
    const descriptor = source as UrlMediaSource;
    return { ...descriptor, url: resolveAgainstPage(descriptor.url) };
  }
  return source;
}

function absoluteProject(project: Project): Project {
  return {
    ...project,
    tracks: project.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => clip.type === 'text'
        ? clip
        : { ...clip, source: absoluteSource(clip.source) }),
    })) as Project['tracks'],
  };
}

function sourceIdentity(source: MediaSource): string | MediaSource {
  if (isRemoteMediaSource(source)) {
    if (typeof source === 'string' || source instanceof URL) return resolveAgainstPage(source);
    const descriptor = source as UrlMediaSource;
    const headers = descriptor.headers === undefined
      ? []
      : Object.entries(descriptor.headers).sort(([left], [right]) => left.localeCompare(right));
    if (headers.length === 0 && descriptor.credentials === undefined) return sourceUrl(descriptor);
    return JSON.stringify([sourceUrl(descriptor), descriptor.credentials ?? null, headers]);
  }
  return source;
}

function collectSources(project: Project): MediaSource[] {
  const identities = new Set<string | MediaSource>();
  const sources: MediaSource[] = [];
  const durationUs = projectDurationUs(project);
  for (const track of project.tracks) {
    if (track.type === 'visual' && track.visible === false) continue;
    if (track.type === 'audio' && (track.muted === true || (track.volume ?? 1) <= 0)) continue;
    for (const clip of track.clips) {
      if (clip.type === 'text') continue;
      if (!clipIsActive(clip.startUs, clip.durationUs, durationUs)) continue;
      if (clip.type === 'audio' && (clip.muted === true || (clip.volume ?? 1) <= 0)) continue;
      const identity = sourceIdentity(clip.source);
      if (identities.has(identity)) continue;
      identities.add(identity);
      sources.push(clip.source);
    }
  }
  return sources;
}

const AUTO_BLOB_OUTPUT_MAX_BYTES = 32 * 1024 * 1024;

interface ActiveMediaAssessment {
  includeAudio: boolean;
  blockers: string[];
  warnings: string[];
}

function clipIsActive(startUs: number, durationUs: number, projectDurationUs: number): boolean {
  return startUs < projectDurationUs && startUs + durationUs > 0;
}

function autoOutputNeedsOriginStorage(
  output: AnalyzeOptions['output'],
  estimatedOutputBytes: number,
): boolean {
  return (output ?? 'auto') === 'auto' && estimatedOutputBytes > AUTO_BLOB_OUTPUT_MAX_BYTES;
}

function assessActiveMedia(
  project: Project,
  sources: readonly MediaSource[],
  media: readonly MediaInfo[],
): ActiveMediaAssessment {
  const bySource = new Map<string | MediaSource, MediaInfo>();
  sources.forEach((source, index) => {
    const info = media[index];
    if (info !== undefined) bySource.set(sourceIdentity(source), info);
  });

  const durationUs = projectDurationUs(project);
  const blockers = new Set<string>();
  const warnings = new Set<string>();
  let includeAudio = false;
  for (const track of project.tracks) {
    if (track.type === 'visual') {
      if (track.visible === false) continue;
      for (const clip of track.clips) {
        if (!clipIsActive(clip.startUs, clip.durationUs, durationUs) || clip.type === 'text') continue;
        const info = bySource.get(sourceIdentity(clip.source));
        if (info === undefined) continue;
        if (clip.type === 'image') {
          if (info.hasVideo || info.hasAudio) {
            blockers.add('An active image clip source is media rather than a decodable still image.');
          }
          continue;
        }
        if (!info.hasVideo) {
          blockers.add('An active video clip does not contain a video track.');
        } else if (info.videoDecodable === false) {
          blockers.add(`The browser cannot decode an active ${info.videoCodec ?? 'unknown'} video track.`);
        }
        if (info.hasVideo) assessTrimmedDuration(clip, info, blockers, warnings, 'video');
        if (clip.muted !== true && (clip.volume ?? 1) > 0 && info.hasAudio) {
          includeAudio = true;
          if (info.audioDecodable === false) {
            blockers.add(`The browser cannot decode an active ${info.audioCodec ?? 'unknown'} audio track.`);
          }
        }
      }
      continue;
    }

    if (track.muted === true || (track.volume ?? 1) <= 0) continue;
    for (const clip of track.clips) {
      if (
        !clipIsActive(clip.startUs, clip.durationUs, durationUs) ||
        clip.muted === true ||
        (clip.volume ?? 1) <= 0
      ) {
        continue;
      }
      const info = bySource.get(sourceIdentity(clip.source));
      if (info === undefined) continue;
      if (!info.hasAudio) {
        blockers.add('An active audio clip does not contain an audio track.');
        continue;
      }
      assessTrimmedDuration(clip, info, blockers, warnings, 'audio');
      includeAudio = true;
      if (info.audioDecodable === false) {
        blockers.add(`The browser cannot decode an active ${info.audioCodec ?? 'unknown'} audio track.`);
      }
    }
  }
  return { includeAudio, blockers: [...blockers], warnings: [...warnings] };
}

function assessTrimmedDuration(
  clip: { trimStartUs?: number; durationUs: number; loop?: boolean },
  info: MediaInfo,
  blockers: Set<string>,
  warnings: Set<string>,
  kind: 'video' | 'audio',
): void {
  const trimStartUs = clip.trimStartUs ?? 0;
  if (trimStartUs >= info.durationUs) {
    blockers.add(`An active ${kind} clip starts at or beyond its source duration.`);
    return;
  }
  if (clip.loop !== true && trimStartUs + clip.durationUs > info.durationUs) {
    warnings.add(`A non-looping ${kind} clip extends beyond its source and will end early.`);
  }
}

function estimatedBytes(
  project: Project,
  format: 'mp4' | 'webm' = 'mp4',
  includeAudio = true,
  options: AnalyzeOptions = {},
): number {
  const frameRate = project.output.frameRate ?? 30;
  const duration = projectDurationUs(project) / 1_000_000;
  const high = options.quality === 'high';
  const bpp = format === 'webm' ? (high ? 0.1 : 0.07) : (high ? 0.15 : 0.1);
  const video = options.videoBitrate ?? Math.max(500_000, Math.min(80_000_000,
    project.output.width * project.output.height * frameRate * bpp));
  const audio = includeAudio
    ? (options.audioBitrate ?? (options.quality === 'high' ? 256_000 : 192_000))
    : 0;
  return Math.ceil(((video + audio) * duration) / 8 * 1.05);
}

class YumCutVideoAdsClient implements YumCutVideoAds {
  readonly cache: BrowserAssetCache;
  private readonly options: VideoAdsOptions;
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRender>();
  private disposed = false;

  constructor(options: VideoAdsOptions = {}) {
    this.options = options;
    this.cache = createAssetCache(options.cache);
  }

  detectSupport(profile?: SupportProfile): Promise<SupportReport> {
    this.assertActive();
    return detectSupport(profile);
  }

  inspect(source: MediaSource): Promise<MediaInfo> {
    this.assertActive();
    return inspectMedia(absoluteSource(source), this.cache.cacheName);
  }

  async analyze(project: Project, options: AnalyzeOptions = {}): Promise<AnalyzeReport> {
    this.assertActive();
    assertValidProject(project);
    const normalized = absoluteProject(project);
    const durationUs = projectDurationUs(normalized);
    const sources = collectSources(normalized);
    const media = await Promise.all(
      sources.map((source) => inspectMedia(source, this.cache.cacheName)),
    );
    const activeMedia = assessActiveMedia(normalized, sources, media);
    const support = await detectSupport({
      width: normalized.output.width,
      height: normalized.output.height,
      frameRate: normalized.output.frameRate ?? 30,
      durationUs,
      format: options.format ?? 'auto',
      ...(options.quality === undefined ? {} : { quality: options.quality }),
      ...(options.videoBitrate === undefined ? {} : { videoBitrate: options.videoBitrate }),
      ...(options.audioBitrate === undefined ? {} : { audioBitrate: options.audioBitrate }),
      includeAudio: activeMedia.includeAudio,
    });

    const estimate = estimatedBytes(
      normalized,
      support.recommendedOutput?.format ?? 'mp4',
      activeMedia.includeAudio,
      options,
    );
    const autoNeedsOriginStorage = autoOutputNeedsOriginStorage(options.output, estimate);
    const warnings = [
      ...support.warnings.filter((warning) =>
        autoNeedsOriginStorage || !warning.startsWith('Available origin storage may be too small')),
      ...activeMedia.warnings,
    ];
    const blockers = [...support.blockers, ...activeMedia.blockers];
    if (media.some((info) => info.hdr === true)) {
      warnings.push('One or more HDR sources will use the SDR canvas conversion path.');
    }
    const maxTextureSize = support.compositionLimits?.maxTextureSize;
    if (
      maxTextureSize !== undefined &&
      media.some((info) =>
        (info.displayWidth ?? info.width ?? 0) > maxTextureSize ||
        (info.displayHeight ?? info.height ?? 0) > maxTextureSize)
    ) {
      warnings.push(
        `One or more sources exceed the ${maxTextureSize}px WebGL texture limit and will be pre-scaled before GPU composition.`,
      );
    }
    if (durationUs > 300_000_000) {
      warnings.push('This project is longer than the five-minute performance qualification envelope.');
    }
    if (normalized.output.width * normalized.output.height > 4096 * 2160) {
      warnings.push('This project is larger than the qualified 4K performance envelope.');
    }
    const available = support.storage?.availableBytes;
    if (autoNeedsOriginStorage && support.features.opfs.available === false) {
      blockers.push(
        'This auto output exceeds the in-memory threshold and OPFS is unavailable; use a writable or file output target.',
      );
    }
    if (autoNeedsOriginStorage && available !== undefined && estimate * 1.25 > available) {
      blockers.push('Available origin storage is below the estimated render requirement.');
    }
    const status = blockers.length > 0 ? 'unsupported' : warnings.length > 0 ? 'degraded' : 'supported';
    return {
      ...support,
      status,
      supported: status !== 'unsupported',
      warnings,
      blockers,
      media,
      estimatedOutputBytes: estimate,
      estimatedTemporaryBytes: Math.ceil(estimate * 1.25),
      ...(available === undefined ? {} : { availableStorageBytes: available }),
    };
  }

  async render(project: Project, options: RenderOptions = {}): Promise<RenderResult> {
    this.assertActive();
    assertValidProject(project);
    if (options.signal?.aborted === true) {
      throw new VideoAdsError('ABORTED', 'The render was cancelled.', { cause: options.signal.reason });
    }

    const worker = this.getWorker();
    const id = this.nextId++;
    const normalizedProject = absoluteProject(project);
    const workerOptions = {
      ...(options.format === undefined ? {} : { format: options.format }),
      ...(options.quality === undefined ? {} : { quality: options.quality }),
      ...(options.videoBitrate === undefined ? {} : { videoBitrate: options.videoBitrate }),
      ...(options.audioBitrate === undefined ? {} : { audioBitrate: options.audioBitrate }),
      ...(options.output === undefined ? {} : { output: options.output }),
      cacheName: this.cache.cacheName,
    };

    return new Promise<RenderResult>((resolve, reject) => {
      const pending: PendingRender = {
        resolve,
        reject,
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      };
      if (options.signal) {
        const abort = () => {
          const reason = typeof options.signal?.reason === 'string' ? options.signal.reason : undefined;
          const request: WorkerRequest = {
            type: 'cancel',
            id,
            ...(reason === undefined ? {} : { reason }),
          };
          worker.postMessage(request);
        };
        options.signal.addEventListener('abort', abort, { once: true });
        pending.cleanupAbort = () => options.signal?.removeEventListener('abort', abort);
      }
      this.pending.set(id, pending);

      const request: WorkerRequest = { type: 'render', id, project: normalizedProject, options: workerOptions };
      const transfers: Transferable[] = [];
      if (typeof options.output === 'object' && options.output.type === 'writable') {
        transfers.push(options.output.writable as unknown as Transferable);
      }
      try {
        worker.postMessage(request, transfers);
      } catch (error) {
        this.pending.delete(id);
        pending.cleanupAbort?.();
        reject(VideoAdsError.from(error, 'UNSUPPORTED_ENVIRONMENT', 'Unable to send the render to the worker.'));
      }
    });
  }

  async cleanupTemporaryOutputs(): Promise<void> {
    this.assertActive();
    if (typeof navigator === 'undefined' || navigator.storage?.getDirectory === undefined) return;
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('yumcut-video-ads-output', { recursive: true });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return;
      throw VideoAdsError.from(error, 'CACHE_FAILED', 'Unable to remove temporary video outputs.');
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.worker) {
      const worker = this.worker;
      for (const id of this.pending.keys()) {
        const cancel: WorkerRequest = { type: 'cancel', id, reason: 'Renderer disposed' };
        worker.postMessage(cancel);
      }
      const request: WorkerRequest = { type: 'dispose' };
      worker.postMessage(request);
      setTimeout(() => worker.terminate(), 1_000);
      this.worker = undefined;
    }
    const error = new VideoAdsError('ABORTED', 'The renderer was disposed.');
    for (const pending of this.pending.values()) {
      pending.cleanupAbort?.();
      pending.reject(error);
    }
    this.pending.clear();
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    const suppliedWorker = this.options.workerFactory?.();
    if (suppliedWorker === undefined && typeof Worker === 'undefined') {
      throw new VideoAdsError('UNSUPPORTED_ENVIRONMENT', 'Dedicated workers are unavailable.');
    }
    const worker = suppliedWorker ?? new Worker(
      this.options.workerUrl ?? new URL('./render-worker.js', import.meta.url),
      { type: 'module', name: 'yumcut-video-ads-renderer' },
    );
    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => this.onMessage(event.data));
    worker.addEventListener('error', (event) => {
      const error = new VideoAdsError('INTERNAL_ERROR', event.message || 'The render worker failed.', {
        details: { filename: event.filename, line: event.lineno, column: event.colno },
      });
      for (const pending of this.pending.values()) {
        pending.cleanupAbort?.();
        pending.reject(error);
      }
      this.pending.clear();
      worker.terminate();
      if (this.worker === worker) this.worker = undefined;
    });
    this.worker = worker;
    return worker;
  }

  private onMessage(response: WorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    if (response.type === 'progress') {
      pending.onProgress?.(response.progress);
      return;
    }
    this.pending.delete(response.id);
    pending.cleanupAbort?.();
    if (response.type === 'result') {
      const result = (response as WorkerResultResponse).result;
      const temporary = result.__temporaryOutput;
      delete result.__temporaryOutput;
      if (temporary) {
        let released = false;
        Object.defineProperty(result, 'release', {
          enumerable: false,
          configurable: false,
          value: async () => {
            if (released) return;
            try {
              const root = await navigator.storage.getDirectory();
              const directory = await root.getDirectoryHandle(temporary.directoryName);
              await directory.removeEntry(temporary.fileName);
              released = true;
            } catch (error) {
              if (error instanceof DOMException && error.name === 'NotFoundError') {
                // Bulk cleanup, another tab, or an earlier release may already
                // have removed either the directory or this particular file.
                released = true;
                return;
              }
              throw VideoAdsError.from(
                error,
                'CACHE_FAILED',
                'Unable to remove the temporary video output.',
              );
            }
          },
        });
      }
      pending.resolve(result);
      return;
    }
    pending.reject(new VideoAdsError(
      errorCode(response.error.code),
      response.error.message,
      response.error.details === undefined ? {} : { details: response.error.details },
    ));
  }

  private assertActive(): void {
    if (this.disposed) throw new VideoAdsError('ABORTED', 'The renderer has been disposed.');
  }
}

export function createYumCutVideoAds(options: YumCutVideoAdsOptions = {}): YumCutVideoAds {
  return new YumCutVideoAdsClient(options);
}

/** Descriptive compatibility alias retained for pre-brand integrations. */
export const createVideoAds = createYumCutVideoAds;

export const __private__ = {
  absoluteProject,
  absoluteSource,
  assessActiveMedia,
  autoOutputNeedsOriginStorage,
  clipIsActive,
  collectSources,
  estimatedBytes,
};
