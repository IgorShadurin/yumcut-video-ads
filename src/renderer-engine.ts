import {
  AppendOnlyStreamTarget,
  AudioSampleSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
  type Input,
  type InputAudioTrack,
  type InputVideoTrack,
  type OutputFormat as MediabunnyOutputFormat,
  type Target,
} from 'mediabunny';
import {
  AudioClipReader,
  DEFAULT_AUDIO_CHUNK_FRAMES,
  OUTPUT_AUDIO_SAMPLE_RATE,
  mixAudioChunk,
} from './audio-mixer';
import {
  createCompositor,
  type Compositor,
  type CompositorImageSource,
  type CompositorLayer,
} from './compositor';
import { VideoAdsError, throwIfAborted } from './errors';
import {
  estimateVideoBitrate as estimateProfileVideoBitrate,
  outputEncodingProfile,
} from './encoding-profile';
import { createMediaInput, sourceToBlob } from './media';
import {
  clipEndUs,
  containsTimestamp,
  frameCountForDuration,
  frameTimestampUs,
  projectDurationUs,
  sourceTimestampUs,
} from './timeline';
import type {
  AudioClip,
  AudioTrack,
  BaseClip,
  BlurBackground,
  ImageClip,
  OutputFormat,
  Project,
  RenderOptions,
  RenderProgress,
  RenderResult,
  TextClip,
  Transition,
  VideoClip,
  VisualClip,
  VisualTrack,
} from './types';
import { DEFAULT_FRAME_RATE, assertValidProject } from './validation';

interface EngineRenderOptions {
  format?: RenderOptions['format'];
  quality?: RenderOptions['quality'];
  videoBitrate?: number;
  audioBitrate?: number;
  output?: RenderOptions['output'];
  cacheName?: string;
}

export interface RenderEngineCallbacks {
  signal?: AbortSignal;
  onProgress?: (progress: RenderProgress) => void;
}

interface PreparedVisual {
  clip: VisualClip;
  /** True only when every source pixel is known to be opaque. */
  opaque: boolean;
  frameAt(timestampUs: number): Promise<PreparedFrame | null>;
  releaseIfPast?(timestampUs: number): void;
  dispose(): void;
}

interface PreparedFrame {
  source: CompositorImageSource;
  width: number;
  height: number;
}

interface PreparedResources {
  visuals: PreparedVisual[];
  audioReaders: AudioClipReader[];
  inputs: Input[];
  warnings: string[];
  dispose(): void;
}

interface SelectedCodecs {
  format: OutputFormat;
  video: 'avc' | 'vp9';
  videoCodec: string;
  videoBitrate: number;
  audio?: 'aac' | 'opus';
  hardwareAcceleration: 'prefer-hardware' | 'no-preference';
}

interface OutputTargetState {
  target: Target;
  appendOnly: boolean;
  bytesWritten(): number;
  artifact(): Promise<Blob | undefined>;
  cleanup(): Promise<void>;
  finish(): Promise<void>;
  artifactStorage: RenderResult['artifactStorage'];
  temporaryArtifact?: { directoryName: string; fileName: string };
}

const DEFAULT_BACKGROUND_COLOR = '#202124';
// Auto output switches to OPFS before a single encoded Blob can create a large
// transient allocation on memory-constrained/mobile browsers.
const MEMORY_OUTPUT_THRESHOLD = 32 * 1024 * 1024;

class VideoVisual implements PreparedVisual {
  readonly clip: VideoClip;
  readonly opaque: boolean;
  private readonly sink: CanvasSink;
  private readonly sourceDurationUs: number;
  private readonly sourceOriginUs: number;
  private readonly iterator: AsyncGenerator<import('mediabunny').WrappedCanvas | null, void, unknown>;

  constructor(
    clip: VideoClip,
    videoTrack: InputVideoTrack,
    sourceDurationUs: number,
    sourceOriginUs: number,
    frameRate: number,
    opaque: boolean,
  ) {
    this.clip = clip;
    this.opaque = opaque;
    this.sourceDurationUs = sourceDurationUs;
    this.sourceOriginUs = sourceOriginUs;
    this.sink = new CanvasSink(videoTrack, {
      poolSize: 1,
      decoderOptions: { hardwareAcceleration: 'no-preference' },
    });
    this.iterator = this.sink.canvasesAtTimestamps(this.sourceTimestamps(frameRate));
  }

  async frameAt(timestampUs: number): Promise<PreparedFrame | null> {
    if (!containsTimestamp(this.clip, timestampUs)) return null;
    const next = await this.iterator.next();
    if (next.done) return null;
    const wrapped = next.value;
    if (!wrapped) return null;
    return {
      source: wrapped.canvas as CompositorImageSource,
      width: wrapped.canvas.width,
      height: wrapped.canvas.height,
    };
  }

  dispose(): void {
    void this.iterator.return(undefined);
  }

  private *sourceTimestamps(frameRate: number): Generator<number, void, undefined> {
    const firstCandidate = Math.max(
      0,
      Math.floor((this.clip.startUs * frameRate) / 1_000_000) - 1,
    );
    const lastCandidate = Math.ceil((clipEndUs(this.clip) * frameRate) / 1_000_000) + 1;
    for (let frameIndex = firstCandidate; frameIndex < lastCandidate; frameIndex += 1) {
      const outputUs = frameTimestampUs(frameIndex, frameRate);
      const relativeSourceUs = sourceTimestampUs(this.clip, outputUs, this.sourceDurationUs);
      if (relativeSourceUs !== null) {
        yield (relativeSourceUs + this.sourceOriginUs) / 1_000_000;
      }
    }
  }
}

class ImageVisual implements PreparedVisual {
  readonly clip: ImageClip;
  readonly opaque = false;
  private readonly cacheName: string | undefined;
  private readonly signal: AbortSignal | undefined;
  private bitmap: ImageBitmap | undefined;
  private loading: Promise<ImageBitmap> | undefined;
  private disposed = false;

  private constructor(clip: ImageClip, cacheName?: string, signal?: AbortSignal) {
    this.clip = clip;
    this.cacheName = cacheName;
    this.signal = signal;
  }

  static create(clip: ImageClip, cacheName?: string, signal?: AbortSignal): ImageVisual {
    return new ImageVisual(clip, cacheName, signal);
  }

  async frameAt(timestampUs: number): Promise<PreparedFrame | null> {
    if (!containsTimestamp(this.clip, timestampUs)) return null;
    const bitmap = await this.load();
    return { source: bitmap as CompositorImageSource, width: bitmap.width, height: bitmap.height };
  }

  releaseIfPast(timestampUs: number): void {
    if (timestampUs >= clipEndUs(this.clip)) this.releaseBitmap();
  }

  dispose(): void {
    this.disposed = true;
    this.releaseBitmap();
  }

  private async load(): Promise<ImageBitmap> {
    throwIfAborted(this.signal);
    if (this.disposed) throw new VideoAdsError('ABORTED', 'The image decoder was disposed.');
    if (this.bitmap) return this.bitmap;
    this.loading ??= (async () => {
      const blob = await sourceToBlob(this.clip.source, this.cacheName, this.signal);
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(blob, {
          imageOrientation: 'from-image',
          premultiplyAlpha: 'none',
        });
      } catch (error) {
        if (error instanceof VideoAdsError) throw error;
        throw VideoAdsError.from(error, 'CORRUPT_MEDIA', 'Unable to decode an image clip.');
      }
      if (this.disposed || this.signal?.aborted === true) {
        bitmap.close();
        throwIfAborted(this.signal);
        throw new VideoAdsError('ABORTED', 'The image decoder was disposed.');
      }
      this.bitmap = bitmap;
      return bitmap;
    })();
    return this.loading;
  }

  private releaseBitmap(): void {
    this.bitmap?.close();
    this.bitmap = undefined;
  }
}

class TextVisual implements PreparedVisual {
  readonly clip: TextClip;
  readonly opaque = false;
  private readonly width: number;
  private readonly height: number;
  private canvas: OffscreenCanvas | undefined;

  constructor(clip: TextClip, project: Project) {
    this.clip = clip;
    const box = clip.box ?? { x: 0, y: 0, width: 1, height: 1 };
    this.width = Math.max(1, Math.round(project.output.width * box.width));
    this.height = Math.max(1, Math.round(project.output.height * box.height));
  }

  async frameAt(timestampUs: number): Promise<PreparedFrame | null> {
    if (!containsTimestamp(this.clip, timestampUs)) return null;
    this.canvas ??= renderTextCanvas(this.clip, this.width, this.height);
    return { source: this.canvas as CompositorImageSource, width: this.canvas.width, height: this.canvas.height };
  }

  releaseIfPast(timestampUs: number): void {
    if (timestampUs >= clipEndUs(this.clip)) this.releaseCanvas();
  }

  dispose(): void {
    this.releaseCanvas();
  }

  private releaseCanvas(): void {
    if (!this.canvas) return;
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.canvas = undefined;
  }
}

function renderTextCanvas(clip: TextClip, width: number, height: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new VideoAdsError('UNSUPPORTED_ENVIRONMENT', 'Canvas 2D is required for text rendering.');

  const style = clip.style;
  const padding = Math.max(0, style.padding ?? 0);
  const fontWeight = style.fontWeight ?? 400;
  const fontFamily = style.fontFamily ?? 'sans-serif';
  const lineHeight = style.lineHeight ?? style.fontSize * 1.2;
  context.font = `${fontWeight} ${style.fontSize}px ${fontFamily}`;
  context.textAlign = style.textAlign ?? 'center';
  context.textBaseline = 'top';

  if (style.backgroundColor) {
    context.fillStyle = style.backgroundColor;
    context.fillRect(0, 0, width, height);
  }

  const lines = wrapText(context, clip.text, Math.max(1, width - padding * 2));
  const textHeight = lines.length * lineHeight;
  const vertical = style.verticalAlign ?? 'middle';
  const startY = vertical === 'top'
    ? padding
    : vertical === 'bottom'
      ? height - padding - textHeight
      : (height - textHeight) / 2;
  const align = style.textAlign ?? 'center';
  const x = align === 'left' ? padding : align === 'right' ? width - padding : width / 2;

  for (let index = 0; index < lines.length; index += 1) {
    const y = startY + index * lineHeight;
    if ((style.strokeWidth ?? 0) > 0) {
      context.lineWidth = style.strokeWidth ?? 0;
      context.strokeStyle = style.strokeColor ?? '#000000';
      context.lineJoin = 'round';
      context.strokeText(lines[index] ?? '', x, y);
    }
    context.fillStyle = style.color ?? '#ffffff';
    context.fillText(lines[index] ?? '', x, y);
  }
  return canvas;
}

function wrapText(
  context: OffscreenCanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const result: string[] = [];
  for (const paragraph of text.split(/\r?\n/u)) {
    const words = paragraph.split(/\s+/u).filter(Boolean);
    if (words.length === 0) {
      result.push('');
      continue;
    }
    let line = words[0] ?? '';
    for (let index = 1; index < words.length; index += 1) {
      const candidate = `${line} ${words[index] ?? ''}`;
      if (context.measureText(candidate).width <= maxWidth) line = candidate;
      else {
        result.push(line);
        line = words[index] ?? '';
      }
    }
    result.push(line);
  }
  return result;
}

async function prepareProject(
  project: Project,
  signal?: AbortSignal,
  cacheName?: string,
): Promise<PreparedResources> {
  const visuals: PreparedVisual[] = [];
  const audioReaders: AudioClipReader[] = [];
  const inputs: Input[] = [];
  const warnings: string[] = [];
  const abortActiveInputs = () => {
    for (const input of inputs) {
      if (!input.disposed) input.dispose();
    }
  };
  signal?.addEventListener('abort', abortActiveInputs, { once: true });
  if (signal?.aborted === true) abortActiveInputs();

  try {
    for (const track of project.tracks) {
      throwIfAborted(signal);
      if (track.type === 'visual') {
        if (track.visible === false) continue;
        for (const clip of track.clips) {
          throwIfAborted(signal);
          if (clip.type === 'image') {
            visuals.push(ImageVisual.create(clip, cacheName, signal));
          } else if (clip.type === 'text') {
            visuals.push(new TextVisual(clip, project));
          } else {
            await prepareVideoClip(
              clip,
              visuals,
              audioReaders,
              inputs,
              warnings,
              project.output.frameRate ?? DEFAULT_FRAME_RATE,
              cacheName,
              signal,
            );
          }
        }
      } else if (track.muted !== true) {
        for (const clip of track.clips) {
          throwIfAborted(signal);
          await prepareAudioClip(clip, track, audioReaders, inputs, cacheName, signal);
        }
      }
    }
  } catch (error) {
    signal?.removeEventListener('abort', abortActiveInputs);
    for (const visual of visuals) visual.dispose();
    for (const reader of audioReaders) reader.dispose();
    for (const input of inputs) {
      if (!input.disposed) input.dispose();
    }
    throw error;
  }

  return {
    visuals,
    audioReaders,
    inputs,
    warnings,
    dispose() {
      signal?.removeEventListener('abort', abortActiveInputs);
      for (const visual of visuals) visual.dispose();
      for (const reader of audioReaders) reader.dispose();
      for (const input of inputs) {
        if (!input.disposed) input.dispose();
      }
    },
  };
}

async function prepareVideoClip(
  clip: VideoClip,
  visuals: PreparedVisual[],
  audioReaders: AudioClipReader[],
  inputs: Input[],
  warnings: string[],
  frameRate: number,
  cacheName?: string,
  signal?: AbortSignal,
): Promise<void> {
  const input = await createMediaInput(clip.source, cacheName, signal);
  inputs.push(input);
  if (!(await input.canRead())) {
    throw new VideoAdsError('CORRUPT_MEDIA', 'A video clip has an unsupported container format.');
  }
  const [videoTrack, audioTrack] = await Promise.all([
    input.getPrimaryVideoTrack(),
    input.getPrimaryAudioTrack(),
  ]);
  if (!videoTrack) throw new VideoAdsError('CORRUPT_MEDIA', 'A video clip does not contain a video track.');
  if (!(await videoTrack.canDecode())) {
    throw new VideoAdsError('UNSUPPORTED_INPUT_CODEC', 'The browser cannot decode a video clip.', {
      details: { codec: await videoTrack.getCodecParameterString() },
    });
  }

  const pairedTracks = audioTrack ? [videoTrack, audioTrack] : [videoTrack];
  const [originSeconds, endSeconds, hdr, canBeTransparent, sourceCodec] = await Promise.all([
    input.getFirstTimestamp(pairedTracks),
    input.computeDuration(pairedTracks),
    videoTrack.hasHighDynamicRange(),
    videoTrack.canBeTransparent().catch(() => true),
    videoTrack.getCodec(),
  ]);
  const sourceDurationUs = Math.max(0, Math.round((endSeconds - originSeconds) * 1_000_000));
  const sourceOriginUs = Math.round(originSeconds * 1_000_000);
  if (hdr) warnings.push('An HDR input is being converted to the browser canvas SDR output path.');
  visuals.push(new VideoVisual(
    clip,
    videoTrack,
    sourceDurationUs,
    sourceOriginUs,
    frameRate,
    !canBeTransparent || sourceCodec === 'avc' || sourceCodec === 'hevc',
  ));

  if (audioTrack && clip.muted !== true) {
    if (await audioTrack.canDecode()) {
      audioReaders.push(new AudioClipReader({
        clip,
        track: audioTrack,
        sourceDurationUs,
        sourceOriginUs,
      }));
    } else {
      warnings.push('A video clip audio track could not be decoded and was omitted.');
    }
  }
}

async function prepareAudioClip(
  clip: AudioClip,
  track: AudioTrack,
  audioReaders: AudioClipReader[],
  inputs: Input[],
  cacheName?: string,
  signal?: AbortSignal,
): Promise<void> {
  if (clip.muted === true) return;
  const input = await createMediaInput(clip.source, cacheName, signal);
  inputs.push(input);
  if (!(await input.canRead())) throw new VideoAdsError('CORRUPT_MEDIA', 'An audio clip has an unsupported container.');
  const audioTrack = await input.getPrimaryAudioTrack();
  if (!audioTrack) throw new VideoAdsError('CORRUPT_MEDIA', 'An audio clip does not contain an audio track.');
  if (!(await audioTrack.canDecode())) {
    throw new VideoAdsError('UNSUPPORTED_INPUT_CODEC', 'The browser cannot decode an audio clip.', {
      details: { codec: await audioTrack.getCodecParameterString() },
    });
  }
  const [originSeconds, endSeconds] = await Promise.all([
    input.getFirstTimestamp([audioTrack]),
    input.computeDuration([audioTrack]),
  ]);
  const durationUs = Math.max(0, Math.round((endSeconds - originSeconds) * 1_000_000));
  audioReaders.push(new AudioClipReader({
    clip,
    track: audioTrack,
    sourceDurationUs: durationUs,
    sourceOriginUs: Math.round(originSeconds * 1_000_000),
    ...(track.volume === undefined ? {} : { trackVolume: track.volume }),
  }));
}

async function selectCodecs(
  project: Project,
  options: EngineRenderOptions,
  hasAudio: boolean,
): Promise<SelectedCodecs> {
  const requested = options.format ?? 'auto';
  const formats: OutputFormat[] = requested === 'auto' ? ['mp4', 'webm'] : [requested];
  const frameRate = project.output.frameRate ?? DEFAULT_FRAME_RATE;
  const candidates = formats.map((format) => {
    const profile = outputEncodingProfile(
      format,
      project.output.width,
      project.output.height,
      frameRate,
      options.quality ?? 'balanced',
      options.videoBitrate,
    );
    return {
      format: profile.format,
      video: profile.video,
      videoCodec: profile.videoCodec,
      videoBitrate: profile.videoBitrate,
      ...(hasAudio ? { audio: profile.audio } : {}),
    };
  });

  for (const candidate of candidates) {
    const preferHardware = await canEncodeVideo(candidate.video, {
      width: project.output.width,
      height: project.output.height,
      bitrate: candidate.videoBitrate,
      fullCodecString: candidate.videoCodec,
      hardwareAcceleration: 'prefer-hardware',
      latencyMode: 'quality',
    });
    const videoSupported = preferHardware || await canEncodeVideo(candidate.video, {
      width: project.output.width,
      height: project.output.height,
      bitrate: candidate.videoBitrate,
      fullCodecString: candidate.videoCodec,
      hardwareAcceleration: 'no-preference',
      latencyMode: 'quality',
    });
    const audioSupported = !candidate.audio || await canEncodeAudio(candidate.audio, {
      numberOfChannels: 2,
      sampleRate: OUTPUT_AUDIO_SAMPLE_RATE,
      bitrate: options.audioBitrate ?? (options.quality === 'high' ? 256_000 : 192_000),
    });
    if (videoSupported && audioSupported) {
      return {
        ...candidate,
        hardwareAcceleration: preferHardware ? 'prefer-hardware' : 'no-preference',
      };
    }
  }

  throw new VideoAdsError('UNSUPPORTED_OUTPUT_CODEC', 'No requested MP4/WebM encoder combination is available.', {
    details: { requestedFormat: requested, width: project.output.width, height: project.output.height },
  });
}

function estimateVideoBitrate(project: Project, options: EngineRenderOptions, format?: OutputFormat): number {
  return estimateProfileVideoBitrate(
    project.output.width,
    project.output.height,
    project.output.frameRate ?? DEFAULT_FRAME_RATE,
    format ?? 'mp4',
    options.quality ?? 'balanced',
    options.videoBitrate,
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function createOutputTarget(
  project: Project,
  options: EngineRenderOptions,
  format: OutputFormat,
  estimatedBytes: number,
): Promise<OutputTargetState> {
  const request = options.output ?? 'auto';
  let maximumEnd = 0;
  let appendedBytes = 0;
  let target: Target;
  let getArtifact: () => Promise<Blob | undefined>;
  let appendOnly = false;
  let artifactStorage: RenderResult['artifactStorage'] = 'external';
  let temporaryDirectory: FileSystemDirectoryHandle | undefined;
  let temporaryName: string | undefined;
  let finishDestination: () => Promise<void> = async () => {};
  let abortDestination: () => Promise<void> = async () => {};

  if (request === 'blob' || (request === 'auto' && estimatedBytes <= MEMORY_OUTPUT_THRESHOLD)) {
    const bufferTarget = new BufferTarget();
    target = bufferTarget;
    artifactStorage = 'memory';
    getArtifact = async () => {
      if (!bufferTarget.buffer) return undefined;
      return new Blob([bufferTarget.buffer], { type: format === 'mp4' ? 'video/mp4' : 'video/webm' });
    };
  } else if (typeof request === 'object' && request.type === 'writable') {
    const destination = request.writable.getWriter();
    let destinationSettled = false;
    const countingStream = new WritableStream<Uint8Array>({
      async write(chunk) {
        await destination.write(chunk);
        appendedBytes += chunk.byteLength;
      },
      close() {
        // Mediabunny closes targets for both finalize and cancel. Defer the
        // caller's stream close until Output.finalize() has actually succeeded.
      },
      async abort(reason) {
        if (destinationSettled) return;
        destinationSettled = true;
        await destination.abort(reason);
      },
    });
    finishDestination = async () => {
      if (destinationSettled) return;
      destinationSettled = true;
      await destination.close();
    };
    abortDestination = async () => {
      if (destinationSettled) return;
      destinationSettled = true;
      await destination.abort(new DOMException('Video render did not complete.', 'AbortError'));
    };
    target = new AppendOnlyStreamTarget(countingStream);
    appendOnly = true;
    getArtifact = async () => undefined;
  } else {
    let handle: FileSystemFileHandle;
    let exposeArtifact = false;
    if (typeof request === 'object' && request.type === 'file') {
      handle = request.fileHandle;
    } else {
      if (typeof navigator === 'undefined' || navigator.storage?.getDirectory === undefined) {
        throw new VideoAdsError(
          'INSUFFICIENT_STORAGE',
          'This output is too large for the in-memory target and OPFS is unavailable. Supply a writable or file target.',
          { details: { estimatedBytes, memoryThreshold: MEMORY_OUTPUT_THRESHOLD } },
        );
      }
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle('yumcut-video-ads-output', { create: true });
      const extension = format === 'mp4' ? 'mp4' : 'webm';
      const baseName = (project.id ?? Date.now().toString(36))
        .replace(/[^a-z0-9._-]+/giu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 96) || 'render';
      const uniqueId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      temporaryDirectory = directory;
      temporaryName = `yumcut-video-ads-${baseName}-${uniqueId}.${extension}`;
      handle = await directory.getFileHandle(
        temporaryName,
        { create: true },
      );
      exposeArtifact = true;
      artifactStorage = 'opfs';
    }
    const writable = await handle.createWritable();
    const destination = (writable as unknown as WritableStream<unknown>).getWriter();
    let destinationSettled = false;
    const safeWritable = new WritableStream<import('mediabunny').StreamTargetChunk>({
      write(chunk) {
        return destination.write(chunk);
      },
      close() {
        // Commit only after the muxer finalizes successfully.
      },
      async abort(reason) {
        if (destinationSettled) return;
        destinationSettled = true;
        await destination.abort(reason);
      },
    });
    finishDestination = async () => {
      if (destinationSettled) return;
      destinationSettled = true;
      await destination.close();
    };
    abortDestination = async () => {
      if (destinationSettled) return;
      destinationSettled = true;
      await destination.abort(new DOMException('Video render did not complete.', 'AbortError'));
    };
    target = new StreamTarget(safeWritable, {
      chunked: true,
      chunkSize: 16 << 20,
    });
    getArtifact = async () => {
      if (!exposeArtifact) return undefined;
      return handle.getFile();
    };
  }

  target.on('write', ({ end }) => {
    maximumEnd = Math.max(maximumEnd, end);
  });
  return {
    target,
    appendOnly,
    bytesWritten: () => Math.max(maximumEnd, appendedBytes),
    artifact: getArtifact,
    artifactStorage,
    ...(temporaryName === undefined
      ? {}
      : { temporaryArtifact: { directoryName: 'yumcut-video-ads-output', fileName: temporaryName } }),
    finish: finishDestination,
    cleanup: async () => {
      await abortDestination().catch(() => undefined);
      if (temporaryDirectory && temporaryName) {
        await temporaryDirectory.removeEntry(temporaryName).catch(() => undefined);
      }
    },
  };
}

function buildOutputFormat(format: OutputFormat, appendOnly: boolean): MediabunnyOutputFormat {
  return format === 'mp4'
    ? new Mp4OutputFormat(appendOnly
      ? { fastStart: 'fragmented', minimumFragmentDuration: 1 }
      : { fastStart: false })
    : new WebMOutputFormat({ appendOnly, minimumClusterDuration: 1 });
}

function layerForFrame(clip: VisualClip, frame: PreparedFrame, timestampUs: number): CompositorLayer {
  const position = { ...(clip.position ?? { x: 0, y: 0 }) };
  let opacity = clip.opacity ?? 1;
  let wipe: CompositorLayer['wipe'];

  const incoming = transitionProgress(clip, clip.transitionIn, timestampUs, true);
  const outgoing = transitionProgress(clip, clip.transitionOut, timestampUs, false);
  for (const transition of [incoming, outgoing]) {
    if (!transition) continue;
    if (transition.definition.type === 'slide') {
      const amount = transition.entering ? 1 - transition.progress : 1 - transition.progress;
      const sign = transition.entering ? 1 : -1;
      const direction = transition.definition.direction ?? 'left';
      if (direction === 'left') position.x += sign * amount;
      if (direction === 'right') position.x -= sign * amount;
      if (direction === 'up') position.y += sign * amount;
      if (direction === 'down') position.y -= sign * amount;
    } else if (transition.definition.type === 'wipe') {
      wipe = {
        progress: transition.progress,
        direction: transition.definition.direction ?? 'left',
      };
    } else {
      opacity *= transition.progress;
    }
  }

  return {
    source: frame.source,
    sourceWidth: frame.width,
    sourceHeight: frame.height,
    fit: clip.type === 'text' ? 'contain' : clip.fit ?? 'cover',
    box: clip.box ?? { x: 0, y: 0, width: 1, height: 1 },
    focalPoint: clip.focalPoint ?? { x: 0.5, y: 0.5 },
    alignment: clip.alignment ?? { x: 0.5, y: 0.5 },
    position,
    scale: clip.scale ?? 1,
    rotation: clip.rotationDegrees ?? 0,
    opacity: clamp(opacity, 0, 1),
    ...(wipe === undefined ? {} : { wipe }),
  };
}

function isOpaqueFullFrameCover(layer: CompositorLayer): boolean {
  return layer.fit === 'cover' &&
    layer.opacity >= 1 &&
    layer.wipe === undefined &&
    layer.rotation === 0 &&
    layer.scale >= 1 &&
    layer.position.x === 0 &&
    layer.position.y === 0 &&
    layer.box.x <= 0 &&
    layer.box.y <= 0 &&
    layer.box.x + layer.box.width >= 1 &&
    layer.box.y + layer.box.height >= 1;
}

interface ActiveTransition {
  definition: Transition;
  progress: number;
  entering: boolean;
}

function transitionProgress(
  clip: BaseClip,
  transition: Transition | undefined,
  timestampUs: number,
  entering: boolean,
): ActiveTransition | null {
  if (!transition || transition.durationUs <= 0) return null;
  const elapsed = entering ? timestampUs - clip.startUs : clipEndUs(clip) - timestampUs;
  if (elapsed < 0 || elapsed >= transition.durationUs) return null;
  return {
    definition: transition,
    progress: clamp(elapsed / transition.durationUs, 0, 1),
    entering,
  };
}

function backgroundSettings(project: Project): { color: string; blur?: BlurBackground } {
  const background = project.output.background;
  if (typeof background === 'string') return { color: background };
  if (background?.type === 'blur') {
    return { color: background.fallbackColor ?? DEFAULT_BACKGROUND_COLOR, blur: background };
  }
  return { color: DEFAULT_BACKGROUND_COLOR, blur: { type: 'blur', blurRadius: 32, dim: 0.2 } };
}

function emitProgress(
  callback: RenderEngineCallbacks['onProgress'],
  stage: RenderProgress['stage'],
  progress: number,
  processedUs?: number,
  totalUs?: number,
  message?: string,
): void {
  callback?.({
    stage,
    progress: clamp(progress, 0, 1),
    ...(processedUs === undefined ? {} : { processedUs }),
    ...(totalUs === undefined ? {} : { totalUs }),
    ...(message === undefined ? {} : { message }),
  });
}

function projectHasCrossOriginSource(project: Project): boolean {
  if (typeof location === 'undefined') return false;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.type === 'text') continue;
      const source = clip.source;
      const raw = typeof source === 'string'
        ? source
        : source instanceof URL
          ? source.href
          : typeof source === 'object' && source !== null &&
              'type' in source && source.type === 'url' && 'url' in source
            ? source.url instanceof URL ? source.url.href : source.url
            : undefined;
      if (raw === undefined) continue;
      try {
        if (new URL(raw, location.href).origin !== location.origin) return true;
      } catch {
        // Source validation reports malformed URLs before this classifier.
      }
    }
  }
  return false;
}

export async function renderProject(
  project: Project,
  options: EngineRenderOptions = {},
  callbacks: RenderEngineCallbacks = {},
): Promise<RenderResult> {
  assertValidProject(project);
  const { signal, onProgress } = callbacks;
  throwIfAborted(signal);
  const start = performance.now();
  const durationUs = projectDurationUs(project);
  const frameRate = project.output.frameRate ?? DEFAULT_FRAME_RATE;
  const frameCount = frameCountForDuration(durationUs, frameRate);
  let resources: PreparedResources | undefined;
  let compositor: Compositor | undefined;
  let output: Output | undefined;
  let outputState: OutputTargetState | undefined;
  let succeeded = false;

  emitProgress(onProgress, 'fetching', 0, 0, durationUs, 'Opening media sources');
  try {
    resources = await prepareProject(project, signal, options.cacheName);
    throwIfAborted(signal);
    emitProgress(onProgress, 'analyzing', 0.04, 0, durationUs, 'Inspecting tracks and codecs');
    const codecs = await selectCodecs(project, options, resources.audioReaders.length > 0);
    const videoBitrate = codecs.videoBitrate;
    const audioBitrate = options.audioBitrate ?? (options.quality === 'high' ? 256_000 : 192_000);
    const estimatedBytes = Math.ceil(((videoBitrate + (resources.audioReaders.length > 0 ? audioBitrate : 0)) * (durationUs / 1_000_000)) / 8 * 1.05);
    outputState = await createOutputTarget(project, options, codecs.format, estimatedBytes);
    compositor = createCompositor(project.output.width, project.output.height, 'auto');
    const format = buildOutputFormat(codecs.format, outputState.appendOnly);
    output = new Output({ format, target: outputState.target });

    const canvasSource = new CanvasSource(compositor.canvas, {
      codec: codecs.video,
      fullCodecString: codecs.videoCodec,
      bitrate: videoBitrate,
      keyFrameInterval: 2,
      bitrateMode: 'variable',
      latencyMode: 'quality',
      hardwareAcceleration: codecs.hardwareAcceleration,
      sizeChangeBehavior: 'deny',
    });
    output.addVideoTrack(canvasSource, { frameRate, maximumPacketCount: Math.ceil(frameCount * 1.05) + 2 });

    const audioSource = resources.audioReaders.length > 0
      ? new AudioSampleSource({
        codec: codecs.audio ?? (codecs.format === 'mp4' ? 'aac' : 'opus'),
        bitrate: audioBitrate,
      })
      : undefined;
    if (audioSource) {
      const expectedAudioPackets = Math.ceil((durationUs / 1_000_000) * 100 * 1.33);
      output.addAudioTrack(audioSource, { maximumPacketCount: expectedAudioPackets });
    }

    await output.start();
    emitProgress(onProgress, 'analyzing', 0.08, 0, durationUs, `Using ${codecs.format.toUpperCase()} and ${compositor.backend}`);
    const background = backgroundSettings(project);
    let audioFrame = 0;
    const totalAudioFrames = Math.ceil((durationUs * OUTPUT_AUDIO_SAMPLE_RATE) / 1_000_000);
    let decodeMs = 0;
    let composeMs = 0;
    let encodeMs = 0;

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      throwIfAborted(signal);
      const timestampUs = frameTimestampUs(frameIndex, frameRate);
      const nextTimestampUs = frameIndex + 1 < frameCount
        ? frameTimestampUs(frameIndex + 1, frameRate)
        : durationUs;
      const decodedFrames: Array<{ visual: PreparedVisual; frame: PreparedFrame }> = [];
      const emitDetailedStage = frameIndex === 0 || frameIndex % Math.max(1, Math.round(frameRate)) === 0;
      const frameBaseProgress = 0.08 + (frameIndex / frameCount) * 0.88;
      const frameProgressStep = 0.88 / frameCount;
      if (emitDetailedStage) {
        emitProgress(onProgress, 'decoding', frameBaseProgress, timestampUs, durationUs);
      }
      const decodeStart = performance.now();
      for (const visual of resources.visuals) {
        visual.releaseIfPast?.(timestampUs);
        if (!containsTimestamp(visual.clip, timestampUs)) continue;
        const frame = await visual.frameAt(timestampUs);
        if (frame) decodedFrames.push({ visual, frame });
      }
      decodeMs += performance.now() - decodeStart;

      if (emitDetailedStage) {
        emitProgress(onProgress, 'composing', frameBaseProgress + frameProgressStep * 0.25, timestampUs, durationUs);
      }
      const composeStart = performance.now();
      compositor.clear(background.color);
      const layers = decodedFrames.map(({ visual, frame }) => layerForFrame(visual.clip, frame, timestampUs));
      const opaqueCover = decodedFrames.some(({ visual }, index) =>
        visual.opaque && isOpaqueFullFrameCover(layers[index]!));
      if (background.blur && decodedFrames.length > 0 && !opaqueCover) {
        const backgroundFrame = decodedFrames.find(({ visual }) => visual.clip.type !== 'text')?.frame;
        if (backgroundFrame) {
          compositor.draw({
            source: backgroundFrame.source,
            sourceWidth: backgroundFrame.width,
            sourceHeight: backgroundFrame.height,
            fit: 'cover',
            box: { x: 0, y: 0, width: 1, height: 1 },
            focalPoint: { x: 0.5, y: 0.5 },
            alignment: { x: 0.5, y: 0.5 },
            position: { x: 0, y: 0 },
            scale: 1.08,
            rotation: 0,
            opacity: 1 - (background.blur.dim ?? 0.2),
            blur: background.blur.blurRadius ?? 32,
          });
        }
      }
      for (const layer of layers) {
        compositor.draw(layer);
      }
      compositor.finish();
      composeMs += performance.now() - composeStart;

      const encodeStart = performance.now();
      if (emitDetailedStage) {
        emitProgress(onProgress, 'encoding', frameBaseProgress + frameProgressStep * 0.5, timestampUs, durationUs);
      }
      await canvasSource.add(timestampUs / 1_000_000, (nextTimestampUs - timestampUs) / 1_000_000, {
        keyFrame: frameIndex === 0 || frameIndex % Math.max(1, Math.round(frameRate * 2)) === 0,
      });
      const audioUntilFrame = Math.min(
        totalAudioFrames,
        Math.ceil((nextTimestampUs * OUTPUT_AUDIO_SAMPLE_RATE) / 1_000_000),
      );
      while (audioSource && audioFrame < audioUntilFrame) {
        const chunkFrames = Math.min(DEFAULT_AUDIO_CHUNK_FRAMES, audioUntilFrame - audioFrame);
        const sample = await mixAudioChunk(resources.audioReaders, audioFrame, chunkFrames);
        try {
          await audioSource.add(sample);
        } finally {
          sample.close();
        }
        audioFrame += chunkFrames;
      }
      encodeMs += performance.now() - encodeStart;
      emitProgress(onProgress, 'encoding', 0.08 + ((frameIndex + 1) / frameCount) * 0.88, nextTimestampUs, durationUs);
    }

    while (audioSource && audioFrame < totalAudioFrames) {
      throwIfAborted(signal);
      const chunkFrames = Math.min(DEFAULT_AUDIO_CHUNK_FRAMES, totalAudioFrames - audioFrame);
      const sample = await mixAudioChunk(resources.audioReaders, audioFrame, chunkFrames);
      try {
        await audioSource.add(sample);
      } finally {
        sample.close();
      }
      audioFrame += chunkFrames;
    }
    canvasSource.close();
    audioSource?.close();
    emitProgress(onProgress, 'finalizing', 0.98, durationUs, durationUs);
    // Give a main-thread progress handler one task turn to turn a finalizing
    // update into a worker cancellation before the muxer commits its target.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    throwIfAborted(signal);
    await output.finalize();
    throwIfAborted(signal);
    await outputState.finish();
    const artifact = await outputState.artifact();
    const fileSize = artifact?.size ?? outputState.bytesWritten();
    const mimeType = await output.getMimeType();
    const elapsedMs = performance.now() - start;
    emitProgress(onProgress, 'finalizing', 1, durationUs, durationUs);

    const result: RenderResult & {
      __temporaryOutput?: { directoryName: string; fileName: string };
    } = {
      format: codecs.format,
      mimeType,
      width: project.output.width,
      height: project.output.height,
      durationUs,
      fileSize,
      artifactStorage: outputState.artifactStorage,
      ...(artifact === undefined ? {} : { blob: artifact }),
      warnings: [
        ...resources.warnings,
        ...(compositor.backend === 'canvas2d' ? ['WebGL2 was unavailable; Canvas 2D fallback was used.'] : []),
      ],
      stats: {
        elapsedMs,
        framesEncoded: frameCount,
        framesDropped: 0,
        bytesWritten: fileSize,
        decodeMs,
        composeMs,
        encodeMs,
      },
    };
    if (outputState.temporaryArtifact) result.__temporaryOutput = outputState.temporaryArtifact;
    succeeded = true;
    return result;
  } catch (error) {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') {
      await output.cancel().catch(() => undefined);
    }
    if (error instanceof VideoAdsError) throw error;
    if (signal?.aborted === true) {
      throw new VideoAdsError('ABORTED', 'The render was cancelled.', { cause: signal.reason });
    }
    const message = error instanceof Error ? error.message : String(error);
    const suspectedCors = (
      error instanceof TypeError || /failed to fetch|load failed|networkerror/iu.test(message)
    ) && projectHasCrossOriginSource(project) &&
      !(typeof navigator !== 'undefined' && navigator.onLine === false);
    const code = /cors|cross[- ]origin/iu.test(message) || suspectedCors ? 'CORS'
      : /failed to fetch|network|http (?:4|5)\d\d|request failed/iu.test(message) ? 'FETCH_FAILED'
      : /context.*lost|webgl.*lost/iu.test(message) ? 'GPU_CONTEXT_LOST'
      : /encode|encoder|codec/iu.test(message) ? 'ENCODE_FAILED'
      : /decode|decoder/iu.test(message) ? 'DECODE_FAILED'
        : 'INTERNAL_ERROR';
    throw VideoAdsError.from(error, code, `Video render failed: ${message}`);
  } finally {
    compositor?.dispose();
    resources?.dispose();
    if (!succeeded) await outputState?.cleanup();
  }
}

export const __private__ = {
  estimateVideoBitrate,
  layerForFrame,
  renderTextCanvas,
  wrapText,
};
