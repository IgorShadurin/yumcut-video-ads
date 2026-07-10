import type {
  Project,
  RenderProgress,
  RenderResult,
  SupportReport,
  VideoAds,
} from '../../../src/index';

const DIST_ENTRY = '/dist/index.js';
const runtime = await import(/* @vite-ignore */ DIST_ENTRY) as typeof import('../../../src/index');
const { createVideoAds, secondsToUs } = runtime;

type HarnessStatus =
  | 'idle'
  | 'checking'
  | 'ready'
  | 'rendering'
  | 'complete'
  | 'unsupported'
  | 'error';

type SerializableRenderResult = Omit<RenderResult, 'blob'>;

interface PreviewMetadata {
  duration: number;
  videoWidth: number;
  videoHeight: number;
  readyState: number;
}

interface HarnessState {
  status: HarnessStatus;
  support: SupportReport | null;
  result: SerializableRenderResult | null;
  preview: PreviewMetadata | null;
  progress: RenderProgress[];
  wallClockMs: number | null;
  error: string | null;
}

interface HarnessApi {
  checkSupport(): Promise<SupportReport>;
  render(): Promise<HarnessState>;
  getState(): HarnessState;
  resultDataUrl(): Promise<string>;
  reset(): void;
}

declare global {
  interface Window {
    videoAdsHarness: HarnessApi;
    videoAdsRuntime: typeof import('../../../src/index');
  }
}

window.videoAdsRuntime = runtime;

const DURATION_US = secondsToUs(2.5);
const OUTPUT = { width: 640, height: 360, frameRate: 30 } as const;
const FIXTURES = '/test/fixtures/media';

const videoAds: VideoAds = createVideoAds();
const preview = required<HTMLVideoElement>('preview');
const progressElement = required<HTMLProgressElement>('progress');
const renderButton = required<HTMLButtonElement>('render-button');
const supportButton = required<HTMLButtonElement>('support-button');
const download = required<HTMLAnchorElement>('download');
const errorElement = required<HTMLParagraphElement>('error');

let outputUrl: string | undefined;
let outputBlob: Blob | undefined;
let state: HarnessState = {
  status: 'idle',
  support: null,
  result: null,
  preview: null,
  progress: [],
  wallClockMs: null,
  error: null,
};

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing harness element #${id}.`);
  return element as T;
}

function project(): Project {
  const fade = secondsToUs(0.3);
  return {
    id: 'playwright-mixed-media',
    output: {
      ...OUTPUT,
      durationUs: DURATION_US,
      background: {
        type: 'blur',
        blurRadius: 18,
        dim: 0.24,
        fallbackColor: '#070a12',
      },
    },
    tracks: [
      {
        id: 'template',
        type: 'visual',
        clips: [{
          id: 'template-video',
          type: 'video',
          source: `${FIXTURES}/bunny-template.mp4`,
          startUs: 0,
          durationUs: DURATION_US,
          trimStartUs: secondsToUs(0.25),
          fit: 'cover',
          focalPoint: { x: 0.48, y: 0.5 },
          muted: true,
        }],
      },
      {
        id: 'poster',
        type: 'visual',
        clips: [{
          id: 'poster-image',
          type: 'image',
          source: `${FIXTURES}/bunny-poster.jpg`,
          startUs: secondsToUs(0.2),
          durationUs: secondsToUs(2.05),
          box: { x: 0.055, y: 0.11, width: 0.37, height: 0.42 },
          fit: 'cover',
          focalPoint: { x: 0.5, y: 0.48 },
          transitionIn: { type: 'slide', durationUs: fade, direction: 'right' },
          transitionOut: { type: 'wipe', durationUs: fade, direction: 'left' },
        }],
      },
      {
        id: 'square-overlay',
        type: 'visual',
        clips: [{
          id: 'square-video',
          type: 'video',
          source: `${FIXTURES}/bunny-square.webm`,
          startUs: secondsToUs(0.15),
          durationUs: secondsToUs(2.2),
          loop: true,
          muted: true,
          box: { x: 0.67, y: 0.09, width: 0.27, height: 0.48 },
          fit: 'cover',
          focalPoint: { x: 0.5, y: 0.5 },
          rotationDegrees: 2.5,
          transitionIn: { type: 'fade', durationUs: fade },
          transitionOut: { type: 'fade', durationUs: fade },
        }],
      },
      {
        id: 'title',
        type: 'visual',
        clips: [{
          id: 'title-text',
          type: 'text',
          text: 'FAST BROWSER VIDEO',
          startUs: secondsToUs(0.1),
          durationUs: secondsToUs(2.3),
          box: { x: 0.1, y: 0.71, width: 0.8, height: 0.17 },
          transitionIn: { type: 'fade', durationUs: fade },
          transitionOut: { type: 'fade', durationUs: fade },
          style: {
            fontFamily: 'Inter, system-ui, sans-serif',
            fontWeight: 800,
            fontSize: 34,
            lineHeight: 40,
            color: '#ffffff',
            strokeColor: 'rgba(0, 0, 0, 0.8)',
            strokeWidth: 2,
            backgroundColor: 'rgba(3, 7, 18, 0.66)',
            padding: 12,
            textAlign: 'center',
            verticalAlign: 'middle',
          },
        }],
      },
      {
        id: 'soundtrack',
        type: 'audio',
        volume: 0.65,
        clips: [{
          id: 'standalone-audio',
          type: 'audio',
          source: `${FIXTURES}/yumcut-demo-music.ogg`,
          startUs: 0,
          durationUs: DURATION_US,
          volume: 0.8,
          fadeInUs: secondsToUs(0.15),
          fadeOutUs: secondsToUs(0.25),
        }],
      },
    ],
  };
}

function updateStatus(status: HarnessStatus, label: string): void {
  state.status = status;
  document.body.dataset.state = status;
  required<HTMLOutputElement>('status').value = label;
}

function setBusy(busy: boolean): void {
  renderButton.disabled = busy;
  supportButton.disabled = busy;
}

function setProgress(progress: RenderProgress): void {
  state.progress.push(progress);
  progressElement.value = progress.progress;
  required<HTMLSpanElement>('progress-stage').textContent = progress.stage;
  required<HTMLSpanElement>('progress-percent').textContent = `${Math.round(progress.progress * 100)}%`;
  required<HTMLParagraphElement>('progress-message').textContent = progress.message ?? 'Rendering media locally in the browser…';
}

function showSupport(report: SupportReport): void {
  const compact = {
    status: report.status,
    recommendedOutput: report.recommendedOutput,
    blockers: report.blockers,
    warnings: report.warnings,
    features: Object.fromEntries(
      Object.entries(report.features).map(([name, value]) => [name, value.available]),
    ),
    codecs: report.codecs,
  };
  required<HTMLPreElement>('support-report').textContent = JSON.stringify(compact, null, 2);
}

function showResult(result: SerializableRenderResult, wallClockMs: number): void {
  required<HTMLElement>('metric-format').textContent = result.format.toUpperCase();
  required<HTMLElement>('metric-elapsed').textContent = `${(wallClockMs / 1000).toFixed(2)} s`;
  required<HTMLElement>('metric-frames').textContent = String(result.stats.framesEncoded);
  required<HTMLElement>('metric-size').textContent = `${(result.fileSize / 1024).toFixed(1)} KiB`;
}

async function checkSupport(): Promise<SupportReport> {
  updateStatus('checking', 'Checking support…');
  setBusy(true);
  try {
    const support = await videoAds.detectSupport({
      ...OUTPUT,
      durationUs: DURATION_US,
      format: 'auto',
      runPerformanceProbe: true,
    });
    state.support = support;
    showSupport(support);
    updateStatus(support.supported ? 'ready' : 'unsupported', support.supported ? support.status : 'Unsupported');
    return support;
  } catch (error) {
    fail(error);
    throw error;
  } finally {
    setBusy(false);
  }
}

async function waitForMetadata(video: HTMLVideoElement): Promise<PreviewMetadata> {
  if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
    await new Promise<void>((resolve, reject) => {
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      video.addEventListener('error', () => reject(video.error ?? new Error('Preview failed to load.')), { once: true });
    });
  }
  return {
    duration: video.duration,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    readyState: video.readyState,
  };
}

async function render(): Promise<HarnessState> {
  const support = state.support ?? await checkSupport();
  if (!support.supported) {
    const reason = support.blockers.join(' ') || 'This browser cannot render the requested profile.';
    const error = new Error(reason);
    fail(error, 'unsupported');
    throw error;
  }

  clearOutput();
  state.result = null;
  state.preview = null;
  state.progress = [];
  state.wallClockMs = null;
  state.error = null;
  errorElement.hidden = true;
  updateStatus('rendering', 'Rendering…');
  setBusy(true);
  setProgress({ stage: 'analyzing', progress: 0, message: 'Preparing the mixed-media project…' });
  const startedAt = performance.now();

  try {
    const result = await videoAds.render(project(), {
      format: 'auto',
      output: 'blob',
      quality: 'balanced',
      onProgress: setProgress,
    });
    if (!result.blob) throw new Error('The Blob output target returned no output artifact.');

    const blob = result.blob;
    outputBlob = blob;
    outputUrl = URL.createObjectURL(blob);
    preview.src = outputUrl;
    preview.load();
    download.href = outputUrl;
    download.download = `yumcut-video-ads-playwright.${result.format}`;
    download.hidden = false;

    const previewMetadata = await waitForMetadata(preview);
    const wallClockMs = performance.now() - startedAt;
    const { blob: _blob, ...serializable } = result;
    state.result = serializable;
    state.preview = previewMetadata;
    state.wallClockMs = wallClockMs;
    showResult(serializable, wallClockMs);
    updateStatus('complete', 'Render complete');
    return snapshot();
  } catch (error) {
    fail(error);
    throw error;
  } finally {
    setBusy(false);
  }
}

function fail(error: unknown, status: 'error' | 'unsupported' = 'error'): void {
  const message = error instanceof Error ? error.message : String(error);
  state.error = message;
  errorElement.textContent = message;
  errorElement.hidden = false;
  updateStatus(status, status === 'unsupported' ? 'Unsupported' : 'Render failed');
}

function clearOutput(): void {
  preview.pause();
  preview.removeAttribute('src');
  preview.load();
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = undefined;
  outputBlob = undefined;
  download.removeAttribute('href');
  download.hidden = true;
}

function reset(): void {
  clearOutput();
  state = {
    status: state.support?.supported === true ? 'ready' : 'idle',
    support: state.support,
    result: null,
    preview: null,
    progress: [],
    wallClockMs: null,
    error: null,
  };
  progressElement.value = 0;
  required<HTMLSpanElement>('progress-stage').textContent = 'Idle';
  required<HTMLSpanElement>('progress-percent').textContent = '0%';
  required<HTMLParagraphElement>('progress-message').textContent = 'Waiting to render the fixture composition.';
  errorElement.hidden = true;
  updateStatus(state.status, state.status === 'ready' ? 'Ready' : 'Idle');
}

function snapshot(): HarnessState {
  return {
    ...state,
    progress: [...state.progress],
  };
}

async function resultDataUrl(): Promise<string> {
  if (!outputBlob) throw new Error('Render the project before requesting its bytes.');
  const blob = outputBlob;
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result)), { once: true });
    reader.addEventListener('error', () => reject(reader.error ?? new Error('Unable to read output Blob.')), { once: true });
    reader.readAsDataURL(blob);
  });
}

window.videoAdsHarness = { checkSupport, render, getState: snapshot, resultDataUrl, reset };
supportButton.addEventListener('click', () => { void checkSupport(); });
renderButton.addEventListener('click', () => { void render(); });
window.addEventListener('beforeunload', () => {
  clearOutput();
  videoAds.dispose();
});

updateStatus('idle', 'Ready');
