/// <reference types="vite/client" />

import {
  createYumCutVideoAds,
  isYumCutVideoAdsError,
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
} from 'yumcut-video-ads';
import './style.css';

const publicAsset = (path: string): string =>
  `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`;

const TEMPLATES: Readonly<Record<string, { label: string; format: string }>> = {
  [publicAsset('media/bunny-template.mp4')]: { label: 'Classic landscape', format: 'MP4' },
  [publicAsset('media/bunny-square.webm')]: { label: 'Social square', format: 'WebM' },
  [publicAsset('media/bunny-4k.mp4')]: { label: 'Detail showcase', format: '4K MP4' },
};

type Orientation = 'landscape' | 'portrait' | 'square';
type Resolution = '720' | '1080' | '2160';
type Layout = 'pip' | 'hero' | 'full';
type Tone = 'neutral' | 'supported' | 'degraded' | 'unsupported';
type Report = SupportReport | AnalyzeReport;

const videoAds = createYumCutVideoAds();
let activeController: AbortController | undefined;
let resultUrl: string | undefined;
let resultRelease: (() => Promise<void>) | undefined;

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing demo element #${id}.`);
  return value as T;
}

const templateSelect = element<HTMLSelectElement>('template-select');
const templatePreview = element<HTMLVideoElement>('template-preview');
const templateMeta = element<HTMLParagraphElement>('template-meta');
const templateFormat = element<HTMLSpanElement>('template-format');
const keepTemplateAudio = element<HTMLInputElement>('keep-template-audio');
const overlayVideo = element<HTMLInputElement>('overlay-video');
const overlayVideoName = element<HTMLSpanElement>('overlay-video-name');
const musicFile = element<HTMLInputElement>('music-file');
const musicFileName = element<HTMLSpanElement>('music-file-name');
const sampleMusic = element<HTMLInputElement>('sample-music');
const overlayLayout = element<HTMLSelectElement>('overlay-layout');
const caption = element<HTMLInputElement>('caption');
const orientation = element<HTMLSelectElement>('orientation');
const resolution = element<HTMLSelectElement>('resolution');
const quality = element<HTMLSelectElement>('quality');
const format = element<HTMLSelectElement>('format');
const outputSummary = element<HTMLParagraphElement>('output-summary');
const supportButton = element<HTMLButtonElement>('support-button');
const analyzeButton = element<HTMLButtonElement>('analyze-button');
const renderButton = element<HTMLButtonElement>('render-button');
const cancelButton = element<HTMLButtonElement>('cancel-button');
const progress = element<HTMLProgressElement>('progress');
const progressStage = element<HTMLElement>('progress-stage');
const progressPercent = element<HTMLSpanElement>('progress-percent');
const progressMessage = element<HTMLParagraphElement>('progress-message');
const statusPill = element<HTMLSpanElement>('status-pill');
const reportElement = element<HTMLDivElement>('report');
const technicalReport = element<HTMLPreElement>('technical-report');
const resultFrame = element<HTMLDivElement>('result-frame');
const resultVideo = element<HTMLVideoElement>('result-video');
const emptyResult = element<HTMLDivElement>('empty-result');
const downloadLink = element<HTMLAnchorElement>('download-link');
const clearResultButton = element<HTMLButtonElement>('clear-result');
const metricDuration = element<HTMLElement>('metric-duration');
const metricSize = element<HTMLElement>('metric-size');
const metricTime = element<HTMLElement>('metric-time');
const metricFrames = element<HTMLElement>('metric-frames');

function selectedFile(input: HTMLInputElement): File | undefined {
  return input.files?.[0];
}

function selectedOutput(): {
  width: number;
  height: number;
  frameRate: number;
  format: RequestedOutputFormat;
  quality: 'balanced' | 'high';
  orientation: Orientation;
} {
  const selectedOrientation = orientation.value as Orientation;
  const selectedResolution = resolution.value as Resolution;
  const shortEdge = Number(selectedResolution);
  if (!['landscape', 'portrait', 'square'].includes(selectedOrientation)) {
    throw new Error('Choose a valid orientation.');
  }
  if (!Number.isFinite(shortEdge)) throw new Error('Choose a valid resolution.');

  const dimensions = selectedOrientation === 'square'
    ? { width: shortEdge, height: shortEdge }
    : selectedOrientation === 'portrait'
      ? { width: shortEdge, height: Math.round(shortEdge * 16 / 9) }
      : { width: Math.round(shortEdge * 16 / 9), height: shortEdge };
  const selectedFormat = format.value;
  if (!['auto', 'mp4', 'webm'].includes(selectedFormat)) throw new Error('Choose a valid format.');

  return {
    ...dimensions,
    frameRate: 30,
    format: selectedFormat as RequestedOutputFormat,
    quality: quality.value === 'high' ? 'high' : 'balanced',
    orientation: selectedOrientation,
  };
}

function templateSource(): MediaSource {
  return {
    type: 'url',
    url: new URL(templateSelect.value, window.location.href).href,
    cache: 'browser',
  };
}

function overlayBox(layout: Layout): { x: number; y: number; width: number; height: number } {
  if (layout === 'full') return { x: 0, y: 0, width: 1, height: 1 };
  if (layout === 'hero') return { x: 0.14, y: 0.12, width: 0.72, height: 0.7 };
  return { x: 0.61, y: 0.065, width: 0.33, height: 0.38 };
}

async function buildProject(): Promise<Project> {
  setProgress('Inspecting media', 0.04, 'Reading the selected template metadata…');
  const source = templateSource();
  const templateInfo = await videoAds.inspect(source);
  if (!templateInfo.hasVideo || templateInfo.durationUs <= 0) {
    throw new Error('The selected template does not contain a usable video track.');
  }

  const selected = selectedOutput();
  const durationUs = templateInfo.durationUs;
  const fadeUs = Math.min(secondsToUs(0.3), Math.floor(durationUs / 3));
  const tracks: Track[] = [
    {
      id: 'template-track',
      type: 'visual',
      clips: [
        {
          id: 'template',
          type: 'video',
          source,
          startUs: 0,
          durationUs,
          fit: 'cover',
          focalPoint: { x: 0.5, y: 0.5 },
          muted: !keepTemplateAudio.checked,
          volume: selectedFile(musicFile) || sampleMusic.checked ? 0.42 : 1,
        },
      ],
    },
  ];

  const uploadedVideo = selectedFile(overlayVideo);
  if (uploadedVideo) {
    const layout = overlayLayout.value as Layout;
    tracks.push({
      id: 'uploaded-video-track',
      type: 'visual',
      clips: [
        {
          id: 'uploaded-video',
          type: 'video',
          source: uploadedVideo,
          startUs: 0,
          durationUs,
          loop: true,
          muted: true,
          box: overlayBox(layout),
          fit: 'cover',
          focalPoint: { x: 0.5, y: 0.5 },
          transitionIn: { type: layout === 'full' ? 'fade' : 'slide', durationUs: fadeUs, direction: 'right' },
          transitionOut: { type: 'fade', durationUs: fadeUs },
        },
      ],
    });
  }

  const captionText = caption.value.trim();
  if (captionText) {
    const fontSize = Math.max(30, Math.round(selected.width * 0.047));
    tracks.push({
      id: 'caption-track',
      type: 'visual',
      clips: [
        {
          id: 'caption',
          type: 'text',
          text: captionText,
          startUs: 0,
          durationUs,
          box: { x: 0.08, y: 0.76, width: 0.84, height: 0.15 },
          transitionIn: { type: 'fade', durationUs: fadeUs },
          transitionOut: { type: 'fade', durationUs: fadeUs },
          style: {
            fontFamily: 'Arial, Helvetica, sans-serif',
            fontWeight: 800,
            fontSize,
            lineHeight: Math.round(fontSize * 1.08),
            color: '#fffaf2',
            strokeColor: 'rgba(15, 10, 18, 0.5)',
            strokeWidth: Math.max(2, Math.round(fontSize * 0.035)),
            backgroundColor: 'rgba(12, 8, 16, 0.68)',
            padding: Math.max(14, Math.round(selected.width * 0.015)),
            textAlign: 'center',
            verticalAlign: 'middle',
          },
        },
      ],
    });
  }

  const uploadedMusic = selectedFile(musicFile);
  const musicSource: MediaSource | undefined = uploadedMusic
    ?? (sampleMusic.checked
      ? { type: 'url', url: new URL(publicAsset('media/yumcut-demo-music.ogg'), window.location.origin).href, cache: 'browser' }
      : undefined);
  if (musicSource) {
    const audioClip: AudioClip = {
      id: 'music',
      type: 'audio',
      source: musicSource,
      startUs: 0,
      durationUs,
      loop: true,
      volume: 0.82,
      fadeInUs: Math.min(secondsToUs(0.2), Math.floor(durationUs / 3)),
      fadeOutUs: Math.min(secondsToUs(0.4), Math.floor(durationUs / 3)),
    };
    tracks.push({ id: 'music-track', type: 'audio', clips: [audioClip] });
  }

  return {
    id: 'yumcut-vanilla-demo',
    output: {
      width: selected.width,
      height: selected.height,
      frameRate: selected.frameRate,
      durationUs,
      background: {
        type: 'blur',
        blurRadius: Math.max(18, Math.round(selected.width * 0.018)),
        dim: 0.2,
        fallbackColor: '#130d18',
      },
    },
    tracks,
  };
}

function setProgress(stage: string, value: number, message: string): void {
  const normalized = Math.max(0, Math.min(1, value));
  progress.value = normalized;
  progressStage.textContent = stage;
  progressPercent.textContent = `${Math.round(normalized * 100)}%`;
  progressMessage.textContent = message;
}

function handleProgress(update: RenderProgress): void {
  const stage = update.stage.charAt(0).toUpperCase() + update.stage.slice(1);
  const timeline = update.processedUs !== undefined && update.totalUs !== undefined
    ? ` · ${formatDuration(update.processedUs)} / ${formatDuration(update.totalUs)}`
    : '';
  setProgress(stage, update.progress, `${update.message ?? `${stage}…`}${timeline}`);
}

function setStatus(tone: Tone, label: string): void {
  statusPill.className = `status-pill ${tone}`;
  statusPill.textContent = label;
}

function showReport(report: Report, title: string): void {
  setStatus(report.status, report.status);
  const messages = [
    report.recommendedOutput
      ? `Recommended output: ${report.recommendedOutput.format.toUpperCase()} using ${report.recommendedOutput.videoCodec}.`
      : undefined,
    ...report.blockers.map((item) => `Blocker: ${item}`),
    ...report.warnings.map((item) => `Note: ${item}`),
  ].filter((item): item is string => Boolean(item));
  reportElement.replaceChildren();
  const heading = document.createElement('strong');
  heading.textContent = `${title}: ${report.status}.`;
  reportElement.append(heading);
  if (messages.length > 0) {
    const list = document.createElement('ul');
    for (const message of messages) {
      const item = document.createElement('li');
      item.textContent = message;
      list.append(item);
    }
    reportElement.append(list);
  }
  technicalReport.textContent = JSON.stringify({
    status: report.status,
    supported: report.supported,
    recommendedOutput: report.recommendedOutput,
    blockers: report.blockers,
    warnings: report.warnings,
    codecs: report.codecs,
    features: report.features,
    ...('media' in report ? {
      estimatedOutputBytes: report.estimatedOutputBytes,
      estimatedTemporaryBytes: report.estimatedTemporaryBytes,
      media: report.media,
    } : {}),
  }, null, 2);
}

function showError(error: unknown): void {
  const code = isYumCutVideoAdsError(error) ? error.code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  setStatus('unsupported', code ?? 'Error');
  reportElement.replaceChildren();
  const strong = document.createElement('strong');
  strong.textContent = code ? `${code}: ${message}` : message;
  reportElement.append(strong);
  technicalReport.textContent = JSON.stringify({ code, message }, null, 2);
  setProgress('Stopped', progress.value, message);
}

function setBusy(busy: boolean): void {
  supportButton.disabled = busy;
  analyzeButton.disabled = busy;
  renderButton.disabled = busy;
  cancelButton.disabled = !busy;
  cancelButton.classList.toggle('hidden', !busy);
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatDuration(durationUs: number): string {
  const seconds = usToSeconds(Math.max(0, durationUs));
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
}

async function clearResult(): Promise<void> {
  resultVideo.pause();
  resultVideo.removeAttribute('src');
  resultVideo.load();
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = undefined;
  const release = resultRelease;
  resultRelease = undefined;
  await release?.();
  resultVideo.classList.remove('ready');
  emptyResult.classList.remove('hidden');
  downloadLink.removeAttribute('href');
  downloadLink.removeAttribute('download');
  downloadLink.classList.add('disabled');
  downloadLink.setAttribute('aria-disabled', 'true');
  clearResultButton.disabled = true;
  metricDuration.textContent = '—';
  metricSize.textContent = '—';
  metricTime.textContent = '—';
  metricFrames.textContent = '—';
}

async function showResult(result: RenderResult): Promise<void> {
  if (!result.blob) {
    await result.release?.();
    throw new Error('The renderer completed without a previewable Blob.');
  }
  try {
    await clearResult();
  } catch (error) {
    await result.release?.().catch(() => undefined);
    throw error;
  }
  resultRelease = result.release;
  resultUrl = URL.createObjectURL(result.blob);
  resultVideo.src = resultUrl;
  resultVideo.classList.add('ready');
  emptyResult.classList.add('hidden');
  downloadLink.href = resultUrl;
  downloadLink.download = `yumcut-video-ad.${result.format}`;
  downloadLink.classList.remove('disabled');
  downloadLink.removeAttribute('aria-disabled');
  clearResultButton.disabled = false;
  metricDuration.textContent = formatDuration(result.durationUs);
  metricSize.textContent = formatBytes(result.fileSize);
  metricTime.textContent = `${(result.stats.elapsedMs / 1000).toFixed(2)}s`;
  metricFrames.textContent = result.stats.framesEncoded.toLocaleString();
  technicalReport.textContent = JSON.stringify({
    format: result.format,
    mimeType: result.mimeType,
    dimensions: `${result.width} × ${result.height}`,
    durationSeconds: usToSeconds(result.durationUs),
    artifactStorage: result.artifactStorage,
    fileSize: result.fileSize,
    warnings: result.warnings,
    stats: result.stats,
  }, null, 2);
}

function updateOutputPresentation(): void {
  const selected = selectedOutput();
  outputSummary.textContent = `${selected.width} × ${selected.height} · ${selected.frameRate} fps · aspect-safe cover`;
  resultFrame.className = `result-frame ${selected.orientation}`;
}

async function refreshTemplatePreview(): Promise<void> {
  const selected = TEMPLATES[templateSelect.value];
  templatePreview.src = templateSelect.value;
  templateFormat.textContent = selected?.format ?? 'Video';
  templateMeta.textContent = selected ? `${selected.label} · reading metadata…` : 'Reading metadata…';
  try {
    const info = await videoAds.inspect(templateSource());
    const size = info.displayWidth && info.displayHeight ? `${info.displayWidth} × ${info.displayHeight}` : 'video';
    templateMeta.textContent = `${size} · ${formatDuration(info.durationUs)} · ${info.videoCodec ?? 'browser codec'}`;
  } catch (error) {
    templateMeta.textContent = error instanceof Error ? error.message : 'Unable to inspect this template.';
  }
  void templatePreview.play().catch(() => undefined);
}

function updateFileLabel(input: HTMLInputElement, label: HTMLElement, fallback: string): void {
  const file = selectedFile(input);
  label.textContent = file ? `${file.name} · ${formatBytes(file.size)}` : fallback;
}

supportButton.addEventListener('click', async () => {
  try {
    setBusy(true);
    const selected = selectedOutput();
    setProgress('Checking support', 0.12, 'Probing browser APIs, encoders, and storage…');
    const report = await videoAds.detectSupport({
      width: selected.width,
      height: selected.height,
      frameRate: selected.frameRate,
      format: selected.format,
      quality: selected.quality,
      includeAudio: true,
      runPerformanceProbe: true,
    });
    showReport(report, 'Browser support');
    setProgress('Check complete', 1, 'Review the device-specific result before rendering.');
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
    const selected = selectedOutput();
    setProgress('Analyzing project', 0.25, 'Checking source codecs and estimating storage…');
    const report = await videoAds.analyze(project, {
      format: selected.format,
      quality: selected.quality,
      output: 'auto',
    });
    showReport(report, 'Project analysis');
    setProgress('Analysis complete', 1, 'The composition is ready when no blockers are shown.');
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
    await clearResult();
    setProgress('Preparing project', 0, 'Building the composition…');
    const project = await buildProject();
    const selected = selectedOutput();
    const analysis = await videoAds.analyze(project, {
      format: selected.format,
      quality: selected.quality,
      output: 'auto',
    });
    showReport(analysis, 'Pre-render analysis');
    if (!analysis.supported) {
      throw new Error(analysis.blockers.join(' ') || 'This composition is not supported in the current browser.');
    }
    const result = await videoAds.render(project, {
      format: selected.format,
      quality: selected.quality,
      output: 'auto',
      signal: activeController.signal,
      onProgress: handleProgress,
    });
    await showResult(result);
    const tone: Tone = result.warnings.length > 0 ? 'degraded' : 'supported';
    setStatus(tone, result.warnings.length > 0 ? 'Complete + notes' : 'Complete');
    reportElement.replaceChildren();
    const message = document.createElement('strong');
    message.textContent = 'Your video is ready to preview and download.';
    reportElement.append(message);
    if (result.warnings.length > 0) {
      const list = document.createElement('ul');
      for (const warning of result.warnings) {
        const item = document.createElement('li');
        item.textContent = warning;
        list.append(item);
      }
      reportElement.append(list);
    }
    setProgress('Render complete', 1, `Created ${formatDuration(result.durationUs)} in ${(result.stats.elapsedMs / 1000).toFixed(2)}s.`);
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
  setProgress('Cancelling', progress.value, 'Finishing the current browser operation, then stopping…');
});

templateSelect.addEventListener('change', () => void refreshTemplatePreview());
overlayVideo.addEventListener('change', () => updateFileLabel(overlayVideo, overlayVideoName, 'MP4, WebM or MOV'));
musicFile.addEventListener('change', () => {
  updateFileLabel(musicFile, musicFileName, 'MP3, AAC, WAV or OGG');
  if (selectedFile(musicFile)) sampleMusic.checked = false;
});
sampleMusic.addEventListener('change', () => {
  if (sampleMusic.checked && selectedFile(musicFile)) {
    musicFile.value = '';
    updateFileLabel(musicFile, musicFileName, 'MP3, AAC, WAV or OGG');
  }
});
orientation.addEventListener('change', updateOutputPresentation);
resolution.addEventListener('change', updateOutputPresentation);
clearResultButton.addEventListener('click', () => void clearResult());
downloadLink.addEventListener('click', (event) => {
  if (!downloadLink.href || downloadLink.classList.contains('disabled')) event.preventDefault();
});

function initialize(): void {
  const badge = element<HTMLDivElement>('environment-badge');
  const coarsePointer = matchMedia('(pointer: coarse)').matches;
  badge.textContent = `${window.isSecureContext ? 'Secure context' : 'HTTPS required'} · ${coarsePointer ? 'mobile profile' : 'desktop profile'}`;
  badge.classList.toggle('warning', !window.isSecureContext);
  if (!window.isSecureContext) {
    setStatus('unsupported', 'HTTPS required');
    reportElement.textContent = 'Open this demo on HTTPS or localhost to use secure browser media APIs.';
  }
  updateOutputPresentation();
  void refreshTemplatePreview();
}

window.addEventListener('beforeunload', () => {
  activeController?.abort();
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  const release = resultRelease;
  resultRelease = undefined;
  void release?.();
  videoAds.dispose();
});

initialize();
