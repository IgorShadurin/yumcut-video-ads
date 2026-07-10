/// <reference types="vite/client" />

import renderWorkerUrl from '../../src/render-worker.ts?worker&url';
import {
  createYumCutVideoAds,
  secondsToUs,
  usToSeconds,
  type AnalyzeReport,
  type AudioClip,
  type MediaSource,
  type Project,
  type RenderProgress,
  type RenderResult,
  type RequestedOutputFormat,
  type SupportReport,
  type Track,
  type VisualClip,
} from '../../src/index';

const RESOLUTIONS = {
  'landscape-720': { width: 1280, height: 720 },
  'landscape-1080': { width: 1920, height: 1080 },
  'landscape-4k': { width: 3840, height: 2160 },
  'portrait-720': { width: 720, height: 1280 },
  'portrait-1080': { width: 1080, height: 1920 },
  'portrait-4k': { width: 2160, height: 3840 },
} as const;

type Report = SupportReport | AnalyzeReport;
type StatusTone = 'supported' | 'degraded' | 'unsupported' | 'neutral';

const videoAds = createYumCutVideoAds({ workerUrl: renderWorkerUrl });
let activeController: AbortController | undefined;
let previewUrl: string | undefined;
let previewRelease: (() => Promise<void>) | undefined;

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing playground element #${id}.`);
  return found as T;
};

const templateMode = element<HTMLSelectElement>('template-mode');
const templateUrl = element<HTMLInputElement>('template-url');
const templateFile = element<HTMLInputElement>('template-file');
const persistentCache = element<HTMLInputElement>('persistent-cache');
const overlayImages = element<HTMLInputElement>('overlay-images');
const overlayVideos = element<HTMLInputElement>('overlay-videos');
const overlayAudio = element<HTMLInputElement>('overlay-audio');
const overlayVideoAudio = element<HTMLInputElement>('overlay-video-audio');
const caption = element<HTMLInputElement>('caption');
const resolution = element<HTMLSelectElement>('resolution');
const frameRate = element<HTMLSelectElement>('frame-rate');
const format = element<HTMLSelectElement>('format');
const quality = element<HTMLSelectElement>('quality');
const supportButton = element<HTMLButtonElement>('support-button');
const analyzeButton = element<HTMLButtonElement>('analyze-button');
const renderButton = element<HTMLButtonElement>('render-button');
const cancelButton = element<HTMLButtonElement>('cancel-button');
const prefetchButton = element<HTMLButtonElement>('prefetch-button');
const clearCacheButton = element<HTMLButtonElement>('clear-cache-button');
const progress = element<HTMLProgressElement>('progress');
const progressStage = element<HTMLSpanElement>('progress-stage');
const progressPercent = element<HTMLSpanElement>('progress-percent');
const progressMessage = element<HTMLParagraphElement>('progress-message');
const statusPill = element<HTMLSpanElement>('status-pill');
const messages = element<HTMLDivElement>('messages');
const technicalReport = element<HTMLPreElement>('technical-report');
const renderReport = element<HTMLPreElement>('render-report');
const cacheSummary = element<HTMLOutputElement>('cache-summary');
const preview = element<HTMLVideoElement>('preview');
const emptyPreview = element<HTMLDivElement>('empty-preview');
const saveLink = element<HTMLAnchorElement>('save-link');
const metrics = element<HTMLDListElement>('metrics');

const files = (input: HTMLInputElement): File[] => Array.from(input.files ?? []);

function selectedOutput(): {
  width: number;
  height: number;
  frameRate: number;
  format: RequestedOutputFormat;
} {
  const size = RESOLUTIONS[resolution.value as keyof typeof RESOLUTIONS];
  if (!size) throw new Error('Choose a valid output resolution.');
  const fps = Number(frameRate.value);
  if (!Number.isFinite(fps)) throw new Error('Choose a valid frame rate.');
  const requestedFormat = format.value;
  if (requestedFormat !== 'auto' && requestedFormat !== 'mp4' && requestedFormat !== 'webm') {
    throw new Error('Choose a valid output format.');
  }
  return { ...size, frameRate: fps, format: requestedFormat };
}

function remoteTemplateUrl(): string {
  const url = templateUrl.value.trim();
  if (!url) throw new Error('Enter a template video URL.');
  try {
    return new URL(url, window.location.href).href;
  } catch {
    throw new Error('Enter a valid template video URL.');
  }
}

function templateSource(): MediaSource {
  if (templateMode.value === 'file') {
    const file = templateFile.files?.[0];
    if (!file) throw new Error('Choose a local template video.');
    return file;
  }

  return {
    type: 'url',
    url: remoteTemplateUrl(),
    cache: persistentCache.checked ? 'persistent' : 'browser',
  };
}

function overlayBox(index: number, count: number): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (count === 1) return { x: 0.62, y: 0.07, width: 0.32, height: 0.34 };
  const columns = Math.min(3, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / columns);
  const gap = 0.018;
  const region = { x: 0.06, y: 0.53, width: 0.88, height: 0.38 };
  const width = (region.width - gap * (columns - 1)) / columns;
  const height = (region.height - gap * (rows - 1)) / rows;
  return {
    x: region.x + (index % columns) * (width + gap),
    y: region.y + Math.floor(index / columns) * (height + gap),
    width,
    height,
  };
}

async function buildProject(): Promise<Project> {
  const source = templateSource();
  setProgress('Inspecting', 0, 'Reading template metadata…');
  const templateInfo = await videoAds.inspect(source);
  if (!templateInfo.hasVideo) throw new Error('The template source does not contain a video track.');
  if (templateInfo.durationUs <= 0) throw new Error('The template video has no usable duration.');

  const selected = selectedOutput();
  const durationUs = templateInfo.durationUs;
  const localVisuals = [...files(overlayImages), ...files(overlayVideos)];
  const fadeUs = Math.min(secondsToUs(0.35), Math.floor(durationUs / 3));

  const tracks: Track[] = [
    {
      id: 'template',
      type: 'visual',
      clips: [
        {
          id: 'template-video',
          type: 'video',
          source,
          startUs: 0,
          durationUs,
          fit: 'cover',
          focalPoint: { x: 0.5, y: 0.5 },
          volume: 1,
        },
      ],
    },
  ];

  localVisuals.forEach((file, index) => {
    const isVideo = file.type.startsWith('video/');
    const common = {
      id: `overlay-${index + 1}`,
      source: file,
      startUs: 0,
      durationUs,
      box: overlayBox(index, localVisuals.length),
      fit: 'cover' as const,
      focalPoint: { x: 0.5, y: 0.5 },
      transitionIn: { type: 'fade' as const, durationUs: fadeUs },
      transitionOut: { type: 'fade' as const, durationUs: fadeUs },
    };
    const clip: VisualClip = isVideo
      ? {
          ...common,
          type: 'video',
          loop: true,
          muted: !overlayVideoAudio.checked,
          volume: 0.7,
        }
      : { ...common, type: 'image' };
    tracks.push({ id: `overlay-track-${index + 1}`, type: 'visual', clips: [clip] });
  });

  const captionText = caption.value.trim();
  if (captionText) {
    const captionFontSize = Math.max(28, Math.round(selected.width * 0.045));
    tracks.push({
      id: 'caption',
      type: 'visual',
      clips: [
        {
          id: 'caption-text',
          type: 'text',
          text: captionText,
          startUs: 0,
          durationUs,
          box: { x: 0.08, y: 0.74, width: 0.84, height: 0.16 },
          transitionIn: { type: 'fade', durationUs: fadeUs },
          transitionOut: { type: 'fade', durationUs: fadeUs },
          style: {
            fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
            fontWeight: 750,
            fontSize: captionFontSize,
            lineHeight: Math.round(captionFontSize * 1.08),
            color: '#ffffff',
            backgroundColor: 'rgba(7, 10, 18, 0.64)',
            padding: Math.max(12, Math.round(selected.width * 0.014)),
            textAlign: 'center',
            verticalAlign: 'middle',
          },
        },
      ],
    });
  }

  const audioFiles = files(overlayAudio);
  if (audioFiles.length > 0) {
    const audioClips: AudioClip[] = audioFiles.map((file, index) => ({
      id: `audio-${index + 1}`,
      type: 'audio',
      source: file,
      startUs: 0,
      durationUs,
      loop: true,
      volume: 0.72 / Math.sqrt(audioFiles.length),
      fadeInUs: Math.min(secondsToUs(0.25), Math.floor(durationUs / 3)),
      fadeOutUs: Math.min(secondsToUs(0.5), Math.floor(durationUs / 3)),
    }));
    tracks.push({ id: 'additional-audio', type: 'audio', volume: 1, clips: audioClips });
  }

  return {
    id: 'playground-project',
    output: {
      width: selected.width,
      height: selected.height,
      frameRate: selected.frameRate,
      durationUs,
      background: {
        type: 'blur',
        blurRadius: Math.max(16, Math.round(selected.width * 0.018)),
        dim: 0.22,
        fallbackColor: '#0a0d14',
      },
    },
    tracks,
  };
}

function setProgress(stage: string, value: number, message: string): void {
  const normalized = Math.min(1, Math.max(0, value));
  progress.value = normalized;
  progressStage.textContent = stage;
  progressPercent.textContent = `${Math.round(normalized * 100)}%`;
  progressMessage.textContent = message;
}

function onRenderProgress(update: RenderProgress): void {
  const stage = update.stage.charAt(0).toUpperCase() + update.stage.slice(1);
  let detail = update.message ?? `${stage} media…`;
  if (update.processedUs !== undefined && update.totalUs !== undefined) {
    detail += ` ${formatDuration(update.processedUs)} / ${formatDuration(update.totalUs)}`;
  }
  setProgress(stage, update.progress, detail);
}

function setStatus(tone: StatusTone, label: string): void {
  statusPill.className = `status-pill ${tone}`;
  statusPill.textContent = label;
}

function renderMessages(title: string, details: readonly string[], tone: StatusTone): void {
  messages.replaceChildren();
  const heading = document.createElement('p');
  heading.className = `message-title ${tone}`;
  heading.textContent = title;
  messages.append(heading);
  if (details.length === 0) return;
  const list = document.createElement('ul');
  for (const detail of details) {
    const item = document.createElement('li');
    item.textContent = detail;
    list.append(item);
  }
  messages.append(list);
}

function compactReport(report: Report): unknown {
  const base = {
    status: report.status,
    supported: report.supported,
    recommendedOutput: report.recommendedOutput,
    blockers: report.blockers,
    warnings: report.warnings,
    features: report.features,
    codecs: report.codecs,
    storage: report.storage,
  };
  if (!('media' in report)) return base;
  return {
    ...base,
    estimatedOutputBytes: report.estimatedOutputBytes,
    estimatedTemporaryBytes: report.estimatedTemporaryBytes,
    availableStorageBytes: report.availableStorageBytes,
    media: report.media,
  };
}

function showReport(report: Report, label: string): void {
  setStatus(report.status, report.status);
  const recommendation = report.recommendedOutput
    ? `Recommended: ${report.recommendedOutput.format.toUpperCase()} · ${report.recommendedOutput.videoCodec}${
        report.recommendedOutput.audioCodec ? ` / ${report.recommendedOutput.audioCodec}` : ''
      }.`
    : undefined;
  const details = [
    ...(recommendation ? [recommendation] : []),
    ...report.blockers.map((message) => `Blocker: ${message}`),
    ...report.warnings.map((message) => `Warning: ${message}`),
  ];
  if ('estimatedOutputBytes' in report) {
    details.unshift(
      `Estimated output: ${formatBytes(report.estimatedOutputBytes)}; temporary storage: ${formatBytes(
        report.estimatedTemporaryBytes,
      )}.`,
    );
  }
  renderMessages(`${label}: ${report.status}.`, details, report.status);
  technicalReport.textContent = JSON.stringify(compactReport(report), null, 2);
}

function showError(error: unknown): void {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  setStatus('unsupported', code ?? 'Error');
  renderMessages(code ? `${code}: ${message}` : message, [], 'unsupported');
  technicalReport.textContent = JSON.stringify(
    {
      name: error instanceof Error ? error.name : typeof error,
      code,
      message,
      details:
        typeof error === 'object' && error !== null && 'details' in error ? error.details : undefined,
    },
    null,
    2,
  );
  setProgress('Stopped', progress.value, message);
}

function setBusy(busy: boolean): void {
  supportButton.disabled = busy;
  analyzeButton.disabled = busy;
  renderButton.disabled = busy;
  prefetchButton.disabled = busy;
  clearCacheButton.disabled = busy;
  cancelButton.disabled = !busy;
  cancelButton.classList.toggle('hidden', !busy);
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatDuration(durationUs: number): string {
  const seconds = usToSeconds(Math.max(0, Math.round(durationUs)));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return minutes > 0 ? `${minutes}:${remainder.toFixed(1).padStart(4, '0')}` : `${remainder.toFixed(1)}s`;
}

async function clearPreview(): Promise<void> {
  preview.pause();
  preview.removeAttribute('src');
  preview.load();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = undefined;
  preview.classList.remove('ready');
  emptyPreview.classList.remove('hidden');
  saveLink.classList.add('hidden');
  saveLink.removeAttribute('download');
  saveLink.href = '#';

  const release = previewRelease;
  previewRelease = undefined;
  await release?.();
}

async function showResult(result: RenderResult): Promise<void> {
  if (!result.blob) {
    await result.release?.();
    throw new Error('The playground requested Blob output, but no Blob was returned.');
  }
  try {
    await clearPreview();
  } catch (error) {
    await result.release?.().catch(() => undefined);
    throw error;
  }
  previewRelease = result.release;
  previewUrl = URL.createObjectURL(result.blob);
  preview.src = previewUrl;
  preview.classList.add('ready');
  emptyPreview.classList.add('hidden');
  saveLink.href = previewUrl;
  saveLink.download = `yumcut-video-ads-result.${result.format}`;
  saveLink.classList.remove('hidden');

  const metricValues = [
    `${(result.stats.elapsedMs / 1000).toFixed(2)} s`,
    `${result.width} × ${result.height} · ${result.format.toUpperCase()}`,
    `${result.stats.framesEncoded.toLocaleString()} encoded · ${result.stats.framesDropped.toLocaleString()} dropped`,
    formatBytes(result.fileSize),
  ];
  Array.from(metrics.querySelectorAll('dd')).forEach((node, index) => {
    node.textContent = metricValues[index] ?? '—';
  });

  renderReport.textContent = JSON.stringify(
    {
      format: result.format,
      mimeType: result.mimeType,
      dimensions: `${result.width}x${result.height}`,
      durationSeconds: usToSeconds(result.durationUs),
      fileSize: result.fileSize,
      artifactStorage: result.artifactStorage,
      warnings: result.warnings,
      stats: result.stats,
    },
    null,
    2,
  );
}

async function refreshCacheSummary(prefix = ''): Promise<void> {
  const estimate = await videoAds.cache.estimate();
  const entryText = estimate.entries === undefined ? '' : ` · ${estimate.entries} cached item(s)`;
  const storageText = estimate.storedBytes === undefined ? '' : ` · ${formatBytes(estimate.storedBytes)} stored`;
  const quotaText = estimate.availableBytes === undefined ? '' : ` · ${formatBytes(estimate.availableBytes)} available`;
  cacheSummary.textContent = `${prefix}${entryText}${storageText}${quotaText}`.replace(/^ · /, '') || 'Cache is available.';
}

templateMode.addEventListener('change', () => {
  const remote = templateMode.value === 'url';
  element('template-url-field').classList.toggle('hidden', !remote);
  element('template-file-field').classList.toggle('hidden', remote);
  element('persistent-cache-field').classList.toggle('hidden', !remote);
  element('cache-actions').classList.toggle('hidden', !remote);
});

supportButton.addEventListener('click', async () => {
  try {
    setBusy(true);
    const selected = selectedOutput();
    setProgress('Checking', 0.1, 'Checking browser primitives, codecs, and storage…');
    const report = await videoAds.detectSupport({
      width: selected.width,
      height: selected.height,
      frameRate: selected.frameRate,
      format: selected.format,
      runPerformanceProbe: true,
    });
    showReport(report, 'Browser support');
    setProgress('Checked', 1, 'Capability check complete. This is not a render-speed guarantee.');
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
});

analyzeButton.addEventListener('click', async () => {
  try {
    setBusy(true);
    const project = await buildProject();
    setProgress('Analyzing', 0.25, 'Inspecting sources, codecs, and estimated storage…');
    const selected = selectedOutput();
    const report = await videoAds.analyze(project, {
      format: selected.format,
      quality: quality.value === 'high' ? 'high' : 'balanced',
      output: 'auto',
    });
    showReport(report, 'Project analysis');
    setProgress('Analyzed', 1, 'Project analysis complete. Review blockers and warnings before rendering.');
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
});

renderButton.addEventListener('click', async () => {
  activeController = new AbortController();
  try {
    setBusy(true);
    await clearPreview();
    setProgress('Preparing', 0, 'Building and analyzing the composition…');
    const project = await buildProject();
    const selected = selectedOutput();
    const selectedQuality = quality.value === 'high' ? 'high' : 'balanced';
    const analysis = await videoAds.analyze(project, {
      format: selected.format,
      quality: selectedQuality,
      output: 'auto',
    });
    showReport(analysis, 'Pre-render analysis');
    if (!analysis.supported) {
      throw new Error(analysis.blockers.join(' ') || 'This project is not supported in the current browser.');
    }

    const result = await videoAds.render(project, {
      format: selected.format,
      quality: selectedQuality,
      output: 'auto',
      signal: activeController.signal,
      onProgress: onRenderProgress,
    });
    await showResult(result);
    const warnings = result.warnings.map((warning) => `Warning: ${warning}`);
    renderMessages('Render complete.', warnings, warnings.length > 0 ? 'degraded' : 'supported');
    setStatus(warnings.length > 0 ? 'degraded' : 'supported', warnings.length > 0 ? 'Complete with warnings' : 'Complete');
    setProgress('Complete', 1, `Rendered ${formatDuration(result.durationUs)} to ${formatBytes(result.fileSize)}.`);
  } catch (error) {
    showError(error);
  } finally {
    activeController = undefined;
    setBusy(false);
  }
});

cancelButton.addEventListener('click', () => {
  activeController?.abort(new DOMException('Cancelled by the user.', 'AbortError'));
  cancelButton.disabled = true;
  setProgress('Cancelling', progress.value, 'Stopping after the current browser operation…');
});

prefetchButton.addEventListener('click', async () => {
  const controller = new AbortController();
  activeController = controller;
  try {
    setBusy(true);
    const url = remoteTemplateUrl();
    setProgress('Fetching', 0, 'Downloading the complete template into Cache Storage…');
    const entry = await videoAds.cache.prefetch(url, { signal: controller.signal });
    persistentCache.checked = true;
    await refreshCacheSummary(`Cached ${formatBytes(entry.sizeBytes)}`);
    setProgress('Cached', 1, 'Template is available in the persistent browser cache.');
  } catch (error) {
    showError(error);
  } finally {
    activeController = undefined;
    setBusy(false);
  }
});

clearCacheButton.addEventListener('click', async () => {
  try {
    setBusy(true);
    await videoAds.cache.clear();
    await refreshCacheSummary('Cleared');
    setProgress('Cache cleared', 1, 'Persistent YumCut Video Ads template entries were removed.');
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
});

function initializeEnvironment(): void {
  const badge = element<HTMLDivElement>('environment-badge');
  const secure = window.isSecureContext;
  const mobile = matchMedia('(pointer: coarse)').matches;
  badge.textContent = `${secure ? 'Secure context' : 'Insecure context'} · ${mobile ? 'mobile/coarse pointer' : 'desktop/fine pointer'}`;
  badge.classList.toggle('warning', !secure);
  if (!secure) {
    setStatus('unsupported', 'HTTPS required');
    renderMessages(
      'This page is not a secure context.',
      ['Open it through HTTPS or localhost before running capability checks.'],
      'unsupported',
    );
  }
  void refreshCacheSummary().catch(() => {
    cacheSummary.textContent = 'Persistent cache is unavailable in this context.';
  });
}

window.addEventListener('beforeunload', () => {
  activeController?.abort();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  const release = previewRelease;
  previewRelease = undefined;
  void release?.();
  videoAds.dispose();
});

initializeEnvironment();
