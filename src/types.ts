/** Integer timestamps used by the public API. One second is 1,000,000 microseconds. */
export type TimeUs = number;

export type OutputFormat = 'mp4' | 'webm';
export type RequestedOutputFormat = OutputFormat | 'auto';
export type FitMode = 'cover' | 'contain';
export type CacheMode = 'browser' | 'persistent' | 'none';
export type SupportStatus = 'supported' | 'degraded' | 'unsupported';

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point, Size {}

/** A rectangle expressed as fractions of the output width and height. */
export type NormalizedRect = Rect;

export interface UrlMediaSource {
  type: 'url';
  url: string | URL;
  headers?: Readonly<Record<string, string>>;
  credentials?: RequestCredentials;
  cache?: CacheMode;
}

export interface BufferMediaSource {
  type: 'buffer';
  data: ArrayBuffer | ArrayBufferView;
  mimeType?: string;
  name?: string;
}

/**
 * Browser-native media inputs. Strings and URL objects are treated as remote URLs.
 * A descriptor is only needed when request or persistent-cache options are required.
 */
export type MediaSource =
  | string
  | URL
  | Blob
  | File
  | ArrayBuffer
  | ArrayBufferView
  | UrlMediaSource
  | BufferMediaSource;

/** Alias retained for APIs where "input" reads more naturally than "source". */
export type MediaInput = MediaSource;

export interface Transition {
  type: 'fade' | 'slide' | 'wipe';
  durationUs: TimeUs;
  direction?: 'left' | 'right' | 'up' | 'down';
}

export interface ClipLayout {
  /** Destination rectangle in normalized output coordinates. Defaults to the full frame. */
  box?: NormalizedRect;
  /** Aspect-safe placement inside `box`. Defaults to `cover`. */
  fit?: FitMode;
  /** Normalized point in the source that should remain visible when `cover` crops it. */
  focalPoint?: Point;
  /** Alignment within unused space for `contain`. Defaults to the center. */
  alignment?: Point;
  /** Additional clockwise visual rotation around the destination center. */
  rotationDegrees?: number;
  /** Additional uniform scale around the destination center. Defaults to 1. */
  scale?: number;
  /** Normalized translation relative to the output frame. */
  position?: Point;
}

export interface BaseClip {
  id?: string;
  startUs: TimeUs;
  durationUs: TimeUs;
  opacity?: number;
  transitionIn?: Transition;
  transitionOut?: Transition;
}

export interface BaseMediaClip extends BaseClip {
  source: MediaSource;
  trimStartUs?: TimeUs;
  loop?: boolean;
}

export interface ClipAudioOptions {
  muted?: boolean;
  volume?: number;
  fadeInUs?: TimeUs;
  fadeOutUs?: TimeUs;
}

export interface VideoClip extends BaseMediaClip, ClipLayout, ClipAudioOptions {
  type: 'video';
}

export interface ImageClip extends BaseMediaClip, ClipLayout {
  type: 'image';
}

export interface TextStyle {
  fontFamily?: string;
  fontWeight?: string | number;
  fontSize: number;
  lineHeight?: number;
  color?: string;
  strokeColor?: string;
  strokeWidth?: number;
  backgroundColor?: string;
  padding?: number;
  textAlign?: 'left' | 'center' | 'right';
  verticalAlign?: 'top' | 'middle' | 'bottom';
}

export interface TextClip extends BaseClip, ClipLayout {
  type: 'text';
  text: string;
  style: TextStyle;
}

export interface AudioClip extends BaseMediaClip, ClipAudioOptions {
  type: 'audio';
}

export type VisualClip = VideoClip | ImageClip | TextClip;
export type Clip = VisualClip | AudioClip;

export interface VisualTrack {
  id?: string;
  type: 'visual';
  clips: readonly VisualClip[];
  visible?: boolean;
}

export interface AudioTrack {
  id?: string;
  type: 'audio';
  clips: readonly AudioClip[];
  muted?: boolean;
  volume?: number;
}

export type Track = VisualTrack | AudioTrack;

export interface BlurBackground {
  type: 'blur';
  blurRadius?: number;
  dim?: number;
  fallbackColor?: string;
}

export type ProjectBackground = string | BlurBackground;

export interface ProjectOutput {
  width: number;
  height: number;
  frameRate?: number;
  durationUs?: TimeUs;
  background?: ProjectBackground;
}

export interface Project {
  id?: string;
  output: ProjectOutput;
  /** Tracks are composited in array order; later visual tracks appear on top. */
  tracks: readonly Track[];
}

export interface WritableOutputTarget {
  type: 'writable';
  writable: WritableStream<Uint8Array>;
}

export interface FileOutputTarget {
  type: 'file';
  fileHandle: FileSystemFileHandle;
}

export type RenderOutputTarget = 'auto' | 'blob' | WritableOutputTarget | FileOutputTarget;

export type RenderStage =
  | 'fetching'
  | 'analyzing'
  | 'decoding'
  | 'composing'
  | 'encoding'
  | 'finalizing';

export interface RenderProgress {
  stage: RenderStage;
  /** Overall progress in the inclusive range 0..1. */
  progress: number;
  processedUs?: TimeUs;
  totalUs?: TimeUs;
  message?: string;
}

export interface RenderOptions {
  format?: RequestedOutputFormat;
  quality?: 'balanced' | 'high';
  videoBitrate?: number;
  audioBitrate?: number;
  output?: RenderOutputTarget;
  signal?: AbortSignal;
  onProgress?: (progress: RenderProgress) => void;
}

/** Render-relevant choices used by {@link VideoAds.analyze} without starting a render. */
export interface AnalyzeOptions {
  format?: RequestedOutputFormat;
  quality?: 'balanced' | 'high';
  videoBitrate?: number;
  audioBitrate?: number;
  output?: RenderOutputTarget;
}

export interface RenderStats {
  elapsedMs: number;
  framesEncoded: number;
  framesDropped: number;
  bytesWritten: number;
  decodeMs?: number;
  composeMs?: number;
  encodeMs?: number;
}

export interface RenderResult {
  format: OutputFormat;
  mimeType: string;
  width: number;
  height: number;
  durationUs: TimeUs;
  fileSize: number;
  /** Present for in-memory output and auto-created OPFS output. */
  blob?: Blob;
  /** Where the completed artifact is owned after `render()` resolves. */
  artifactStorage: 'memory' | 'opfs' | 'external';
  /**
   * Removes this result's auto-created OPFS artifact. Revoke object URLs and
   * finish reading `blob` first. Safe to call repeatedly and after
   * `cleanupTemporaryOutputs()`; non-enumerable and present only for OPFS.
   */
  release?: () => Promise<void>;
  warnings: readonly string[];
  stats: RenderStats;
}

export interface MediaTrackInfo {
  type: 'video' | 'audio';
  codec: string;
  /** Whether the current browser's WebCodecs implementation can decode this track. */
  decodable: boolean;
  durationUs?: TimeUs;
  width?: number;
  height?: number;
  frameRate?: number;
  sampleRate?: number;
  channels?: number;
  bitrate?: number;
}

export interface MediaInfo {
  durationUs: TimeUs;
  width?: number;
  height?: number;
  displayWidth?: number;
  displayHeight?: number;
  pixelAspectRatio?: number;
  rotationDegrees?: number;
  frameRate?: number;
  videoCodec?: string;
  audioCodec?: string;
  videoDecodable?: boolean;
  audioDecodable?: boolean;
  hasAudio: boolean;
  hasVideo: boolean;
  hdr?: boolean;
  tracks: readonly MediaTrackInfo[];
}

export interface SupportProfile {
  width?: number;
  height?: number;
  frameRate?: number;
  durationUs?: TimeUs;
  format?: RequestedOutputFormat;
  quality?: 'balanced' | 'high';
  videoBitrate?: number;
  audioBitrate?: number;
  /** Set to false for video-only output so missing audio encoders do not block support. */
  includeAudio?: boolean;
  runPerformanceProbe?: boolean;
}

export interface FeatureSupport {
  available: boolean;
  required: boolean;
  reason?: string;
}

export interface SupportFeatures {
  browser: FeatureSupport;
  secureContext: FeatureSupport;
  worker: FeatureSupport;
  offscreenCanvas: FeatureSupport;
  webgl2: FeatureSupport;
  webCodecs: FeatureSupport;
  cacheStorage: FeatureSupport;
  opfs: FeatureSupport;
  storageEstimate: FeatureSupport;
  transferableVideoFrame: FeatureSupport;
}

export interface CodecSupport {
  codec: string;
  supported: boolean;
  hardwareAcceleration?: boolean;
  reason?: string;
}

export interface RecommendedOutput {
  format: OutputFormat;
  videoCodec: string;
  audioCodec?: string;
}

export interface CacheEstimate {
  usageBytes?: number;
  quotaBytes?: number;
  availableBytes?: number;
  entries?: number;
  storedBytes?: number;
}

export interface StorageSupport extends CacheEstimate {
  persisted?: boolean;
}

export interface CompositionLimits {
  maxTextureSize?: number;
  maxRenderbufferSize?: number;
  maxViewportWidth?: number;
  maxViewportHeight?: number;
}

export interface EncoderProbeReport {
  status: 'passed' | 'failed' | 'skipped';
  codec: string;
  width: number;
  height: number;
  elapsedMs?: number;
  reason?: string;
}

export interface CacheEntryInfo {
  key: string;
  url: string;
  sizeBytes?: number;
  createdAt: number;
  lastAccessedAt: number;
  etag?: string;
  lastModified?: string;
}

export interface SupportReport {
  status: SupportStatus;
  supported: boolean;
  features: SupportFeatures;
  codecs: {
    video: readonly CodecSupport[];
    audio: readonly CodecSupport[];
  };
  warnings: readonly string[];
  blockers: readonly string[];
  recommendedOutput?: RecommendedOutput;
  storage?: StorageSupport;
  /** WebGL2 limits observed while checking the requested composition size. */
  compositionLimits?: CompositionLimits;
  /** Present when `runPerformanceProbe` was requested. */
  encoderProbe?: EncoderProbeReport;
}

export interface AnalyzeReport extends SupportReport {
  media: readonly MediaInfo[];
  estimatedOutputBytes: number;
  estimatedTemporaryBytes: number;
  availableStorageBytes?: number;
}

export type AnalysisReport = AnalyzeReport;

export interface CachePrefetchOptions {
  signal?: AbortSignal;
  headers?: Readonly<Record<string, string>>;
  credentials?: RequestCredentials;
}

export interface CacheController {
  prefetch(source: string | URL | UrlMediaSource, options?: CachePrefetchOptions): Promise<CacheEntryInfo>;
  remove(source: string | URL | UrlMediaSource): Promise<boolean>;
  clear(): Promise<void>;
  estimate(): Promise<CacheEstimate>;
}

export interface YumCutVideoAds {
  detectSupport(profile?: SupportProfile): Promise<SupportReport>;
  analyze(project: Project, options?: AnalyzeOptions): Promise<AnalyzeReport>;
  render(project: Project, options?: RenderOptions): Promise<RenderResult>;
  inspect(source: MediaSource): Promise<MediaInfo>;
  readonly cache: CacheController;
  /**
   * Remove every auto-created OPFS output owned by this library on the origin.
   * Use for orphan recovery only when no render or returned OPFS result is active.
   */
  cleanupTemporaryOutputs(): Promise<void>;
  /**
   * Cancel active work and release worker resources. Completed OPFS results
   * remain caller-owned and require `result.release()` or orphan cleanup.
   */
  dispose(): void;
}

/** Descriptive compatibility name retained for pre-brand integrations. */
export type VideoAds = YumCutVideoAds;
