import type {
  CacheEstimate,
  CodecSupport,
  CompositionLimits,
  EncoderProbeReport,
  FeatureSupport,
  OutputFormat,
  StorageSupport,
  SupportFeatures,
  SupportProfile,
  SupportReport,
} from './types';
import { outputEncodingProfile } from './encoding-profile';

export type { EncoderProbeReport } from './types';

const SUPPORT_CACHE_NAME = '__yumcut_video_ads_capability_probe__';
const DEFAULT_FRAME_RATE = 30;
const DEFAULT_AUDIO_BITRATE = 192_000;

export interface SupportDetectionOptions {
  /**
   * Configure an encoder and encode a single small frame. This catches broken
   * WebCodecs implementations but is intentionally opt-in because it can wake
   * up the device's hardware encoder.
   */
  runEncoderProbe?: boolean;
}

export type CapabilityReport = SupportReport;

interface CodecCandidate {
  format: OutputFormat;
  video: 'avc' | 'vp9';
  videoCodec: string;
  videoBitrate: number;
  audio: 'aac' | 'opus';
  audioCodec: string;
}

interface CodecSelection {
  candidates: CodecCandidate[];
  eligibleFormats: OutputFormat[];
}

function makeFeature(
  available: boolean,
  required: boolean,
  reason?: string,
): FeatureSupport {
  return reason === undefined
    ? { available, required }
    : { available, required, reason };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function even(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

function selectCodecs(
  profile: SupportProfile,
  width: number,
  height: number,
  frameRate: number,
): CodecSelection {
  const quality = profile.quality ?? 'balanced';
  const candidates: CodecCandidate[] = (['mp4', 'webm'] as const).map((format) =>
    outputEncodingProfile(
      format,
      width,
      height,
      frameRate,
      quality,
      profile.videoBitrate,
    ));

  const eligibleFormats: OutputFormat[] =
    profile.format === undefined || profile.format === 'auto'
      ? ['mp4', 'webm']
      : [profile.format];
  return { candidates, eligibleFormats };
}

function videoConfig(
  codec: string,
  width: number,
  height: number,
  frameRate: number,
  bitrate: number,
  hardwareAcceleration: 'prefer-hardware' | 'no-preference',
): VideoEncoderConfig {
  return {
    codec,
    width,
    height,
    framerate: frameRate,
    bitrate,
    hardwareAcceleration,
    latencyMode: 'quality',
  };
}

function audioConfig(codec: string, bitrate: number): AudioEncoderConfig {
  return {
    codec,
    sampleRate: 48_000,
    numberOfChannels: 2,
    bitrate,
  };
}

async function probeVideoCodec(
  codec: string,
  width: number,
  height: number,
  frameRate: number,
  bitrate: number,
): Promise<CodecSupport> {
  if (typeof VideoEncoder === 'undefined') {
    return { codec, supported: false, reason: 'VideoEncoder is unavailable.' };
  }

  const errors: string[] = [];
  for (const hardwareAcceleration of ['prefer-hardware', 'no-preference'] as const) {
    try {
      const result = await VideoEncoder.isConfigSupported(
        videoConfig(codec, width, height, frameRate, bitrate, hardwareAcceleration),
      );
      if (result.supported) {
        return {
          codec,
          supported: true,
          hardwareAcceleration: hardwareAcceleration === 'prefer-hardware',
        };
      }
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }
  return {
    codec,
    supported: false,
    reason: errors.length > 0
      ? `The encoder rejected this configuration: ${errors.join('; ')}`
      : 'The encoder rejected this configuration.',
  };
}

async function probeAudioCodec(codec: string, bitrate: number): Promise<CodecSupport> {
  if (typeof AudioEncoder === 'undefined') {
    return { codec, supported: false, reason: 'AudioEncoder is unavailable.' };
  }

  try {
    const result = await AudioEncoder.isConfigSupported(audioConfig(codec, bitrate));
    return result.supported
      ? { codec, supported: true }
      : { codec, supported: false, reason: 'The encoder rejected this configuration.' };
  } catch (error) {
    return { codec, supported: false, reason: errorMessage(error) };
  }
}

interface CanvasProbe {
  offscreenAvailable: boolean;
  offscreenReason?: string;
  webgl2Available: boolean;
  webgl2Reason?: string;
  limits?: CompositionLimits;
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function probeCanvases(width: number, height: number): CanvasProbe {
  if (typeof OffscreenCanvas === 'undefined') {
    return {
      offscreenAvailable: false,
      offscreenReason: 'OffscreenCanvas is unavailable in a worker; this renderer cannot run on the device.',
      webgl2Available: false,
      webgl2Reason: 'WebGL2 cannot be created without OffscreenCanvas in the render worker.',
    };
  }

  const probeWidth = positiveInteger(width) ? width : 1;
  const probeHeight = positiveInteger(height) ? height : 1;
  let offscreenAvailable = false;
  let offscreenReason: string | undefined;
  try {
    const outputCanvas = new OffscreenCanvas(probeWidth, probeHeight);
    const context = outputCanvas.getContext('2d');
    offscreenAvailable = context !== null;
    if (context === null) {
      offscreenReason = `A ${probeWidth}x${probeHeight} worker canvas could not be created.`;
    }
  } catch (error) {
    offscreenReason = `A ${probeWidth}x${probeHeight} worker canvas could not be created: ${errorMessage(error)}`;
  }

  let webgl2Available = false;
  let webgl2Reason: string | undefined;
  let limits: CompositionLimits | undefined;
  try {
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
    if (context === null) {
      webgl2Reason = 'WebGL2 is unavailable; GPU composition cannot be used.';
    } else {
      const maxTextureSize = Number(context.getParameter(context.MAX_TEXTURE_SIZE));
      const maxRenderbufferSize = Number(context.getParameter(context.MAX_RENDERBUFFER_SIZE));
      const viewport = context.getParameter(context.MAX_VIEWPORT_DIMS) as Int32Array | number[];
      const maxViewportWidth = Number(viewport?.[0]);
      const maxViewportHeight = Number(viewport?.[1]);
      limits = {
        ...(Number.isFinite(maxTextureSize) ? { maxTextureSize } : {}),
        ...(Number.isFinite(maxRenderbufferSize) ? { maxRenderbufferSize } : {}),
        ...(Number.isFinite(maxViewportWidth) ? { maxViewportWidth } : {}),
        ...(Number.isFinite(maxViewportHeight) ? { maxViewportHeight } : {}),
      };
      const effectiveWidthLimit = Math.min(
        maxTextureSize || Infinity,
        maxRenderbufferSize || Infinity,
        maxViewportWidth || Infinity,
      );
      const effectiveHeightLimit = Math.min(
        maxTextureSize || Infinity,
        maxRenderbufferSize || Infinity,
        maxViewportHeight || Infinity,
      );
      webgl2Available = probeWidth <= effectiveWidthLimit && probeHeight <= effectiveHeightLimit;
      if (!webgl2Available) {
        webgl2Reason = `${probeWidth}x${probeHeight} exceeds this device's WebGL2 composition limit; Canvas2D fallback will be used.`;
      }
      context.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch (error) {
    webgl2Reason = `WebGL2 is unavailable: ${errorMessage(error)}`;
  }

  return {
    offscreenAvailable,
    ...(offscreenReason === undefined ? {} : { offscreenReason }),
    webgl2Available,
    ...(webgl2Reason === undefined ? {} : { webgl2Reason }),
    ...(limits === undefined ? {} : { limits }),
  };
}

function canTransferVideoFrame(): boolean {
  if (
    typeof VideoFrame === 'undefined' ||
    typeof OffscreenCanvas === 'undefined' ||
    typeof structuredClone === 'undefined'
  ) {
    return false;
  }

  let source: VideoFrame | undefined;
  let clone: VideoFrame | undefined;
  try {
    source = new VideoFrame(new OffscreenCanvas(2, 2), { timestamp: 0 });
    clone = structuredClone(source, {
      transfer: [source as unknown as Transferable],
    }) as VideoFrame;
    return clone.codedWidth === 2;
  } catch {
    return false;
  } finally {
    try {
      source?.close();
    } catch {
      // Transferred frames are already detached.
    }
    clone?.close();
  }
}

async function probeCacheStorage(): Promise<{ available: boolean; reason?: string }> {
  if (typeof caches === 'undefined') {
    return { available: false, reason: 'Cache Storage is unavailable.' };
  }

  try {
    await caches.has(SUPPORT_CACHE_NAME);
    return { available: true };
  } catch (error) {
    return { available: false, reason: errorMessage(error) };
  }
}

async function probeStorage(): Promise<{
  estimate: CacheEstimate;
  estimateAvailable: boolean;
  estimateReason?: string;
  opfsAvailable: boolean;
  opfsReason?: string;
  persisted?: boolean;
}> {
  if (typeof navigator === 'undefined' || navigator.storage === undefined) {
    return {
      estimate: {},
      estimateAvailable: false,
      estimateReason: 'The Storage Manager API is unavailable.',
      opfsAvailable: false,
      opfsReason: 'OPFS is unavailable.',
    };
  }

  const estimate: CacheEstimate = {};
  let estimateAvailable = false;
  let estimateReason: string | undefined;
  let opfsAvailable = false;
  let opfsReason: string | undefined;
  let persisted: boolean | undefined;

  if (typeof navigator.storage.estimate === 'function') {
    try {
      const result = await navigator.storage.estimate();
      if (typeof result.usage === 'number') estimate.usageBytes = result.usage;
      if (typeof result.quota === 'number') estimate.quotaBytes = result.quota;
      if (typeof result.usage === 'number' && typeof result.quota === 'number') {
        estimate.availableBytes = Math.max(0, result.quota - result.usage);
      }
      estimateAvailable = true;
    } catch (error) {
      estimateReason = errorMessage(error);
    }
  } else {
    estimateReason = 'Storage estimates are unavailable.';
  }

  if (typeof navigator.storage.persisted === 'function') {
    try {
      persisted = await navigator.storage.persisted();
    } catch {
      // Persistence is useful metadata, not a capability requirement.
    }
  }

  if (typeof navigator.storage.getDirectory === 'function') {
    try {
      await navigator.storage.getDirectory();
      opfsAvailable = true;
    } catch (error) {
      opfsReason = errorMessage(error);
    }
  } else {
    opfsReason = 'OPFS is unavailable.';
  }

  const result: {
    estimate: CacheEstimate;
    estimateAvailable: boolean;
    estimateReason?: string;
    opfsAvailable: boolean;
    opfsReason?: string;
    persisted?: boolean;
  } = { estimate, estimateAvailable, opfsAvailable };
  if (estimateReason !== undefined) result.estimateReason = estimateReason;
  if (opfsReason !== undefined) result.opfsReason = opfsReason;
  if (persisted !== undefined) result.persisted = persisted;
  return result;
}

function estimateOutputBytes(
  profile: SupportProfile,
  width: number,
  height: number,
  format: OutputFormat,
): number | undefined {
  if (profile.durationUs === undefined || profile.durationUs <= 0) return undefined;
  const frameRate = profile.frameRate ?? DEFAULT_FRAME_RATE;
  const durationSeconds = profile.durationUs / 1_000_000;
  const videoBitrate = outputEncodingProfile(
    format,
    width,
    height,
    frameRate,
    profile.quality ?? 'balanced',
    profile.videoBitrate,
  ).videoBitrate;
  const bitsPerSecond = videoBitrate +
    (profile.includeAudio === false
      ? 0
      : profile.audioBitrate ?? (profile.quality === 'high' ? 256_000 : DEFAULT_AUDIO_BITRATE));
  return Math.ceil((bitsPerSecond * durationSeconds * 1.08) / 8);
}

async function runEncoderProbe(
  codec: string,
  targetWidth: number,
  targetHeight: number,
  frameRate: number,
  bitrate: number,
): Promise<EncoderProbeReport> {
  const aspect = targetWidth / targetHeight;
  const width = even(Math.min(640, targetWidth));
  const height = even(Math.min(640, Math.max(2, Math.round(width / aspect))));

  if (
    typeof VideoEncoder === 'undefined' ||
    typeof VideoFrame === 'undefined' ||
    typeof OffscreenCanvas === 'undefined'
  ) {
    return {
      status: 'skipped',
      codec,
      width,
      height,
      reason: 'A frame cannot be created for an encoder probe in this environment.',
    };
  }

  const startedAt = typeof performance === 'undefined' ? Date.now() : performance.now();
  let encoder: VideoEncoder | undefined;
  let frame: VideoFrame | undefined;
  let encoderError: DOMException | undefined;
  let outputCount = 0;

  try {
    const probeBitrate = Math.max(
      250_000,
      Math.round(bitrate * (width * height) / (targetWidth * targetHeight)),
    );
    let probeConfig: VideoEncoderConfig | undefined;
    const configurationErrors: string[] = [];
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference'] as const) {
      const candidate = videoConfig(
        codec,
        width,
        height,
        frameRate,
        probeBitrate,
        hardwareAcceleration,
      );
      try {
        const support = await VideoEncoder.isConfigSupported(candidate);
        if (support.supported) {
          probeConfig = candidate;
          break;
        }
      } catch (error) {
        configurationErrors.push(errorMessage(error));
      }
    }
    if (probeConfig === undefined) {
      return {
        status: 'failed',
        codec,
        width,
        height,
        reason: configurationErrors.length > 0
          ? `The encoder rejected the probe configuration: ${configurationErrors.join('; ')}`
          : 'The encoder rejected the probe configuration.',
      };
    }

    encoder = new VideoEncoder({
      output: () => {
        outputCount += 1;
      },
      error: (error) => {
        encoderError = error;
      },
    });
    encoder.configure(probeConfig);

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Could not create a 2D probe canvas.');
    context.fillStyle = '#000';
    context.fillRect(0, 0, width, height);
    frame = new VideoFrame(canvas, { timestamp: 0, duration: Math.round(1_000_000 / frameRate) });
    encoder.encode(frame, { keyFrame: true });
    await encoder.flush();

    if (encoderError !== undefined) throw encoderError;
    if (outputCount === 0) throw new Error('The encoder produced no output.');

    const finishedAt = typeof performance === 'undefined' ? Date.now() : performance.now();
    return {
      status: 'passed',
      codec,
      width,
      height,
      elapsedMs: Math.max(0, finishedAt - startedAt),
    };
  } catch (error) {
    return {
      status: 'failed',
      codec,
      width,
      height,
      reason: errorMessage(error),
    };
  } finally {
    try {
      frame?.close();
    } catch {
      // A failed encoder can already have detached its input frame.
    }
    try {
      encoder?.close();
    } catch {
      // The error callback can close the encoder before this cleanup runs.
    }
  }
}

/**
 * Detects whether the current browser can render the requested output profile.
 * No user-agent allow-list is used: mobile browsers receive the same concrete
 * API, codec, resolution, and storage checks as desktop browsers.
 */
export async function detectSupport(
  profile: SupportProfile = {},
  options: SupportDetectionOptions = {},
): Promise<CapabilityReport> {
  const warnings: string[] = [];
  const blockers: string[] = [];
  const width = profile.width ?? 1920;
  const height = profile.height ?? 1080;
  const frameRate = profile.frameRate ?? DEFAULT_FRAME_RATE;
  const includeAudio = profile.includeAudio !== false;

  const browserAvailable =
    typeof navigator !== 'undefined' &&
    typeof fetch !== 'undefined' &&
    typeof Request !== 'undefined' &&
    typeof Response !== 'undefined';
  const secureContextAvailable =
    browserAvailable && globalThis.isSecureContext === true;
  const workerAvailable = typeof Worker !== 'undefined';
  const canvasProbe = probeCanvases(width, height);
  const offscreenCanvasAvailable = canvasProbe.offscreenAvailable;
  const webGl2Available = canvasProbe.webgl2Available;
  const webCodecsAvailable =
    typeof VideoEncoder !== 'undefined' &&
    typeof VideoDecoder !== 'undefined' &&
    (!includeAudio || (typeof AudioEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined')) &&
    typeof VideoFrame !== 'undefined';
  const transferableVideoFrameAvailable = canTransferVideoFrame();

  const [cacheStorage, storage] = await Promise.all([
    probeCacheStorage(),
    probeStorage(),
  ]);

  const features: SupportFeatures = {
    browser: makeFeature(
      browserAvailable,
      true,
      browserAvailable ? undefined : 'A browser environment is required.',
    ),
    secureContext: makeFeature(
      secureContextAvailable,
      true,
      secureContextAvailable ? undefined : 'HTTPS or localhost is required.',
    ),
    worker: makeFeature(
      workerAvailable,
      true,
      workerAvailable ? undefined : 'Web Workers are unavailable.',
    ),
    offscreenCanvas: makeFeature(
      offscreenCanvasAvailable,
      true,
      offscreenCanvasAvailable ? undefined : canvasProbe.offscreenReason,
    ),
    webgl2: makeFeature(
      webGl2Available,
      false,
      webGl2Available ? undefined : canvasProbe.webgl2Reason,
    ),
    webCodecs: makeFeature(
      webCodecsAvailable,
      true,
      webCodecsAvailable ? undefined : 'The required WebCodecs APIs are unavailable.',
    ),
    cacheStorage: makeFeature(
      cacheStorage.available,
      false,
      cacheStorage.reason,
    ),
    opfs: makeFeature(storage.opfsAvailable, false, storage.opfsReason),
    storageEstimate: makeFeature(
      storage.estimateAvailable,
      false,
      storage.estimateReason,
    ),
    transferableVideoFrame: makeFeature(
      transferableVideoFrameAvailable,
      false,
      transferableVideoFrameAvailable
        ? undefined
        : 'Transferable VideoFrame is unavailable, but this renderer decodes frames inside its worker.',
    ),
  };

  for (const [name, capability] of Object.entries(features) as Array<[
    keyof SupportFeatures,
    FeatureSupport,
  ]>) {
    if (capability.available) continue;
    if (name === 'transferableVideoFrame') continue;
    const message = capability.reason ?? `${name} is unavailable.`;
    if (capability.required) blockers.push(message);
    else warnings.push(message);
  }

  if (!Number.isInteger(width) || width <= 0 || width % 2 !== 0) {
    blockers.push('Output width must be a positive even integer.');
  }
  if (!Number.isInteger(height) || height <= 0 || height % 2 !== 0) {
    blockers.push('Output height must be a positive even integer.');
  }
  if (!Number.isFinite(frameRate) || frameRate <= 0 || frameRate > 60) {
    blockers.push('Frame rate must be greater than 0 and no more than 60 fps.');
  }
  if (profile.durationUs !== undefined && (!Number.isFinite(profile.durationUs) || profile.durationUs <= 0)) {
    blockers.push('Duration must be a positive number of microseconds.');
  }
  if (profile.quality !== undefined && profile.quality !== 'balanced' && profile.quality !== 'high') {
    blockers.push('Quality must be "balanced" or "high".');
  }
  if (profile.videoBitrate !== undefined && (!Number.isFinite(profile.videoBitrate) || profile.videoBitrate <= 0)) {
    blockers.push('Video bitrate must be a positive number.');
  }
  if (profile.audioBitrate !== undefined && (!Number.isFinite(profile.audioBitrate) || profile.audioBitrate <= 0)) {
    blockers.push('Audio bitrate must be a positive number.');
  }

  const selection = selectCodecs(profile, width, height, frameRate);

  const dimensionsValid =
    Number.isInteger(width) &&
    width > 0 &&
    width % 2 === 0 &&
    Number.isInteger(height) &&
    height > 0 &&
    height % 2 === 0 &&
    Number.isFinite(frameRate) &&
    frameRate > 0 &&
    frameRate <= 60;

  const [videoResults, audioResults] = await Promise.all([
    Promise.all(selection.candidates.map((candidate) =>
      dimensionsValid
        ? probeVideoCodec(
          candidate.videoCodec,
          width,
          height,
          frameRate,
          candidate.videoBitrate,
        )
        : Promise.resolve<CodecSupport>({
          codec: candidate.videoCodec,
          supported: false,
          reason: 'The output dimensions or frame rate are invalid.',
        }),
    )),
    Promise.all(selection.candidates.map((candidate) => probeAudioCodec(
      candidate.audioCodec,
      profile.audioBitrate ?? (profile.quality === 'high' ? 256_000 : DEFAULT_AUDIO_BITRATE),
    ))),
  ]);

  const isCandidateSupported = (candidate: CodecCandidate): boolean => {
    const video = videoResults.find((result) => result.codec === candidate.videoCodec);
    const audio = audioResults.find((result) => result.codec === candidate.audioCodec);
    return video?.supported === true && (!includeAudio || audio?.supported === true);
  };

  const recommendedCandidate = selection.candidates.find(
    (candidate) =>
      selection.eligibleFormats.includes(candidate.format) && isCandidateSupported(candidate),
  );

  if (recommendedCandidate === undefined) {
    const requested =
      profile.format === undefined || profile.format === 'auto'
        ? includeAudio
          ? 'MP4 (AVC/AAC) or WebM (VP9/Opus)'
          : 'MP4 (AVC) or WebM (VP9)'
        : profile.format.toUpperCase();
    blockers.push(`No supported WebCodecs encoder configuration was found for ${requested}.`);
  }

  const storageResult: StorageSupport = { ...storage.estimate };
  if (storage.persisted !== undefined) storageResult.persisted = storage.persisted;

  const estimatedBytes = estimateOutputBytes(
    profile,
    width,
    height,
    recommendedCandidate?.format ?? selection.eligibleFormats[0] ?? 'mp4',
  );
  if (
    estimatedBytes !== undefined &&
    storageResult.availableBytes !== undefined &&
    storageResult.availableBytes < estimatedBytes * 1.25
  ) {
    warnings.push(
      `Available origin storage may be too small for the estimated ${Math.ceil(estimatedBytes / 1_048_576)} MiB output.`,
    );
  }

  let encoderProbe: EncoderProbeReport | undefined;
  if (
    (options.runEncoderProbe === true || profile.runPerformanceProbe === true) &&
    recommendedCandidate !== undefined &&
    blockers.length === 0
  ) {
    encoderProbe = await runEncoderProbe(
      recommendedCandidate.videoCodec,
      width,
      height,
      frameRate,
      recommendedCandidate.videoBitrate,
    );
    if (encoderProbe.status === 'failed') {
      blockers.push(`The live encoder probe failed: ${encoderProbe.reason ?? 'unknown error'}`);
    } else if (encoderProbe.status === 'skipped') {
      warnings.push(encoderProbe.reason ?? 'The live encoder probe was skipped.');
    }
  }

  const status = blockers.length > 0
    ? 'unsupported'
    : warnings.length > 0
      ? 'degraded'
      : 'supported';

  const report: CapabilityReport = {
    status,
    supported: status !== 'unsupported',
    features,
    codecs: { video: videoResults, audio: audioResults },
    warnings,
    blockers,
    storage: storageResult,
    ...(canvasProbe.limits === undefined ? {} : { compositionLimits: canvasProbe.limits }),
  };

  if (recommendedCandidate !== undefined) {
    report.recommendedOutput = {
      format: recommendedCandidate.format,
      videoCodec: recommendedCandidate.videoCodec,
      ...(includeAudio ? { audioCodec: recommendedCandidate.audioCodec } : {}),
    };
  }
  if (encoderProbe !== undefined) report.encoderProbe = encoderProbe;
  return report;
}

export const __private__ = { probeCanvases, probeVideoCodec, selectCodecs };
