'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AnalyzeReport,
  Project,
  RenderProgress,
  RenderResult,
  RequestedOutputFormat,
  SupportReport,
  Track,
  YumCutVideoAds,
} from 'yumcut-video-ads';

type Orientation = 'landscape' | 'portrait' | 'square';
type Resolution = 'quick' | 'hd' | 'full-hd';
type BusyState = 'idle' | 'checking' | 'analyzing' | 'rendering';
type Report = SupportReport | AnalyzeReport;

interface TemplateChoice {
  id: string;
  name: string;
  detail: string;
  src: string;
  poster?: string;
}

interface ResultView {
  url: string;
  width: number;
  height: number;
  downloadName: string;
  format: string;
  size: string;
  duration: string;
  bytes: string;
  elapsed: string;
  frames: string;
  warnings: readonly string[];
}

const TEMPLATES: readonly TemplateChoice[] = [
  {
    id: 'classic',
    name: 'Bunny classic',
    detail: '4 seconds · silent H.264 · 16:9',
    src: '/media/bunny-template.mp4',
    poster: '/media/bunny-poster.jpg',
  },
  {
    id: 'square',
    name: 'Bunny social square',
    detail: '2 seconds · silent VP9 · 1:1',
    src: '/media/bunny-square.webm',
  },
  {
    id: '4k',
    name: 'Bunny 4K surface',
    detail: '1 second · silent H.264 · 3840×2160',
    src: '/media/bunny-4k.mp4',
    poster: '/media/bunny-poster.jpg',
  },
];

const RESOLUTIONS = {
  quick: { long: 640, short: 360, label: 'Quick · 360p' },
  hd: { long: 1280, short: 720, label: 'HD · 720p' },
  'full-hd': { long: 1920, short: 1080, label: 'Full HD · 1080p' },
} as const;

const secondsToUs = (seconds: number) => Math.round(seconds * 1_000_000);

function outputSize(orientation: Orientation, resolution: Resolution) {
  const preset = RESOLUTIONS[resolution];
  if (orientation === 'portrait') return { width: preset.short, height: preset.long };
  if (orientation === 'square') return { width: preset.short, height: preset.short };
  return { width: preset.long, height: preset.short };
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return 'Unknown';
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
  const seconds = Math.max(0, durationUs) / 1_000_000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function messageFor(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'Render cancelled.';
  if (error instanceof Error) return error.message;
  return String(error);
}

function reportDetails(report: Report): string[] {
  const details = [
    ...report.blockers.map((item) => `Blocker: ${item}`),
    ...report.warnings.map((item) => `Warning: ${item}`),
  ];
  if (report.recommendedOutput) {
    const { format, videoCodec, audioCodec } = report.recommendedOutput;
    details.unshift(
      `Recommended: ${format.toUpperCase()} · ${videoCodec}${audioCodec ? ` / ${audioCodec}` : ''}`,
    );
  }
  if ('estimatedOutputBytes' in report) {
    details.unshift(
      `Estimate: ${formatBytes(report.estimatedOutputBytes)} output · ${formatBytes(report.estimatedTemporaryBytes)} temporary`,
    );
  }
  return details;
}

export default function VideoStudio() {
  const [templateId, setTemplateId] = useState(TEMPLATES[0].id);
  const [overlayVideo, setOverlayVideo] = useState<File | null>(null);
  const [music, setMusic] = useState<File | null>(null);
  const [useDemoMusic, setUseDemoMusic] = useState(true);
  const [keepTemplateAudio, setKeepTemplateAudio] = useState(false);
  const [caption, setCaption] = useState('Make the moment yours.');
  const [orientation, setOrientation] = useState<Orientation>('landscape');
  const [resolution, setResolution] = useState<Resolution>('quick');
  const [quality, setQuality] = useState<'balanced' | 'high'>('balanced');
  const [format, setFormat] = useState<RequestedOutputFormat>('auto');
  const [busy, setBusy] = useState<BusyState>('idle');
  const [ready, setReady] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [notice, setNotice] = useState('Loading the browser renderer…');
  const [progress, setProgress] = useState<RenderProgress>({
    stage: 'analyzing',
    progress: 0,
    message: 'Ready when browser support is checked.',
  });
  const [result, setResult] = useState<ResultView | null>(null);

  const clientRef = useRef<YumCutVideoAds | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const releaseRef = useRef<RenderResult['release']>(undefined);

  const selectedTemplate = useMemo(
    () => TEMPLATES.find((template) => template.id === templateId) ?? TEMPLATES[0],
    [templateId],
  );
  const dimensions = useMemo(
    () => outputSize(orientation, resolution),
    [orientation, resolution],
  );
  const isBusy = busy !== 'idle';

  const clearResult = useCallback(async () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
    const release = releaseRef.current;
    releaseRef.current = undefined;
    setResult(null);
    await release?.();
  }, []);

  useEffect(() => {
    let active = true;

    async function initialize() {
      try {
        const { createYumCutVideoAds } = await import('yumcut-video-ads');
        if (!active) return;
        const client = createYumCutVideoAds({ workerUrl: '/vendor/yumcut-render-worker.js' });
        clientRef.current = client;
        setReady(true);
        const initialReport = await client.detectSupport({
          width: 640,
          height: 360,
          frameRate: 30,
          durationUs: secondsToUs(4),
          format: 'auto',
          includeAudio: true,
        });
        if (!active) return;
        setReport(initialReport);
        setNotice(
          initialReport.supported
            ? 'Browser renderer ready. Add your media or render the sample composition.'
            : initialReport.blockers.join(' ') || 'This browser cannot render the selected profile.',
        );
      } catch (error) {
        if (!active) return;
        setNotice(`Could not initialize YumCut: ${messageFor(error)}`);
      }
    }

    void initialize();
    return () => {
      active = false;
      abortRef.current?.abort();
      abortRef.current = null;
      clientRef.current?.dispose();
      clientRef.current = null;
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
      const release = releaseRef.current;
      releaseRef.current = undefined;
      void release?.();
    };
  }, []);

  const buildProject = useCallback(async (): Promise<Project> => {
    const client = clientRef.current;
    if (!client) throw new Error('The browser renderer is still loading.');

    setNotice('Inspecting the selected template…');
    const templateSource = {
      type: 'url' as const,
      url: selectedTemplate.src,
      cache: 'browser' as const,
    };
    const templateInfo = await client.inspect(templateSource);
    if (!templateInfo.hasVideo || templateInfo.durationUs <= 0) {
      throw new Error('The selected template has no usable video track.');
    }
    const durationUs = Math.min(templateInfo.durationUs, secondsToUs(5));
    const hasMusic = music !== null || useDemoMusic;
    const fadeUs = Math.min(secondsToUs(0.28), Math.floor(durationUs / 3));
    const tracks: Track[] = [
      {
        id: 'template-track',
        type: 'visual',
        clips: [
          {
            id: 'template-video',
            type: 'video',
            source: templateSource,
            startUs: 0,
            durationUs,
            fit: 'cover',
            focalPoint: { x: 0.5, y: 0.5 },
            muted: !keepTemplateAudio,
            volume: hasMusic ? 0.28 : 1,
          },
        ],
      },
    ];

    if (overlayVideo) {
      const portrait = orientation === 'portrait';
      tracks.push({
        id: 'uploaded-video-track',
        type: 'visual',
        clips: [
          {
            id: 'uploaded-video',
            type: 'video',
            source: overlayVideo,
            startUs: 0,
            durationUs,
            loop: true,
            muted: true,
            box: portrait
              ? { x: 0.1, y: 0.07, width: 0.8, height: 0.32 }
              : { x: 0.58, y: 0.07, width: 0.36, height: 0.36 },
            fit: 'cover',
            focalPoint: { x: 0.5, y: 0.5 },
            transitionIn: { type: 'slide', direction: 'right', durationUs: fadeUs },
            transitionOut: { type: 'fade', durationUs: fadeUs },
          },
        ],
      });
    }

    const cleanCaption = caption.trim();
    if (cleanCaption) {
      const fontSize = Math.max(22, Math.round(dimensions.width * 0.047));
      tracks.push({
        id: 'caption-track',
        type: 'visual',
        clips: [
          {
            id: 'caption',
            type: 'text',
            text: cleanCaption,
            startUs: 0,
            durationUs,
            box: { x: 0.08, y: 0.72, width: 0.84, height: 0.18 },
            transitionIn: { type: 'fade', durationUs: fadeUs },
            transitionOut: { type: 'fade', durationUs: fadeUs },
            style: {
              fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
              fontWeight: 760,
              fontSize,
              lineHeight: Math.round(fontSize * 1.12),
              color: '#ffffff',
              backgroundColor: 'rgba(10, 11, 17, 0.64)',
              padding: Math.max(10, Math.round(dimensions.width * 0.014)),
              textAlign: 'center',
              verticalAlign: 'middle',
            },
          },
        ],
      });
    }

    const musicSource = music ?? (useDemoMusic ? '/media/yumcut-demo-music.ogg' : null);
    if (musicSource) {
      tracks.push({
        id: 'music-track',
        type: 'audio',
        volume: 0.82,
        clips: [
          {
            id: 'music',
            type: 'audio',
            source: musicSource,
            startUs: 0,
            durationUs,
            loop: true,
            volume: 1,
            fadeInUs: Math.min(secondsToUs(0.2), Math.floor(durationUs / 3)),
            fadeOutUs: Math.min(secondsToUs(0.35), Math.floor(durationUs / 3)),
          },
        ],
      });
    }

    return {
      id: 'yumcut-nextjs-demo',
      output: {
        ...dimensions,
        frameRate: 30,
        durationUs,
        background: {
          type: 'blur',
          blurRadius: Math.max(14, Math.round(dimensions.width * 0.018)),
          dim: 0.18,
          fallbackColor: '#0a0b11',
        },
      },
      tracks,
    };
  }, [caption, dimensions, keepTemplateAudio, music, orientation, overlayVideo, selectedTemplate, useDemoMusic]);

  const checkSupport = async () => {
    const client = clientRef.current;
    if (!client) return;
    setBusy('checking');
    setNotice('Checking browser codecs, canvas, storage, and worker support…');
    try {
      const nextReport = await client.detectSupport({
        ...dimensions,
        frameRate: 30,
        durationUs: secondsToUs(5),
        format,
        quality,
        includeAudio: Boolean(music || useDemoMusic || keepTemplateAudio),
        runPerformanceProbe: true,
      });
      setReport(nextReport);
      setNotice(
        nextReport.supported
          ? `Support check complete: ${nextReport.status}.`
          : nextReport.blockers.join(' ') || 'This output is unsupported.',
      );
    } catch (error) {
      setNotice(messageFor(error));
    } finally {
      setBusy('idle');
    }
  };

  const analyzeProject = async () => {
    const client = clientRef.current;
    if (!client) return;
    setBusy('analyzing');
    setProgress({ stage: 'analyzing', progress: 0.15, message: 'Inspecting source media…' });
    try {
      const project = await buildProject();
      const nextReport = await client.analyze(project, { format, quality, output: 'blob' });
      setReport(nextReport);
      setNotice(
        nextReport.supported
          ? `Project analysis complete: ${nextReport.status}.`
          : nextReport.blockers.join(' ') || 'The project is unsupported.',
      );
      setProgress({ stage: 'analyzing', progress: 1, message: 'Analysis complete.' });
    } catch (error) {
      setNotice(messageFor(error));
      setProgress({ stage: 'analyzing', progress: 0, message: 'Analysis stopped.' });
    } finally {
      setBusy('idle');
    }
  };

  const renderProject = async () => {
    const client = clientRef.current;
    if (!client) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy('rendering');
    setProgress({ stage: 'analyzing', progress: 0, message: 'Preparing composition…' });
    setNotice('Preparing your local render…');
    try {
      await clearResult();
      const project = await buildProject();
      const analysis = await client.analyze(project, { format, quality, output: 'blob' });
      setReport(analysis);
      if (!analysis.supported) {
        throw new Error(analysis.blockers.join(' ') || 'This project is unsupported in this browser.');
      }
      const rendered = await client.render(project, {
        format,
        quality,
        output: 'blob',
        signal: controller.signal,
        onProgress(update) {
          setProgress(update);
          setNotice(update.message ?? `${update.stage}…`);
        },
      });
      if (!rendered.blob) {
        await rendered.release?.();
        throw new Error('The renderer did not return a previewable Blob.');
      }
      const url = URL.createObjectURL(rendered.blob);
      previewUrlRef.current = url;
      releaseRef.current = rendered.release;
      setResult({
        url,
        width: rendered.width,
        height: rendered.height,
        downloadName: `yumcut-ad.${rendered.format}`,
        format: rendered.format.toUpperCase(),
        size: `${rendered.width} × ${rendered.height}`,
        duration: formatDuration(rendered.durationUs),
        bytes: formatBytes(rendered.fileSize),
        elapsed: `${(rendered.stats.elapsedMs / 1000).toFixed(2)}s`,
        frames: `${rendered.stats.framesEncoded} encoded · ${rendered.stats.framesDropped} dropped`,
        warnings: rendered.warnings,
      });
      setProgress({
        stage: 'finalizing',
        progress: 1,
        processedUs: rendered.durationUs,
        totalUs: rendered.durationUs,
        message: 'Video ready to preview and download.',
      });
      setNotice('Render complete. Your source files stayed in this browser.');
    } catch (error) {
      setNotice(messageFor(error));
      setProgress((current) => ({ ...current, message: messageFor(error) }));
    } finally {
      abortRef.current = null;
      setBusy('idle');
    }
  };

  const cancelRender = () => {
    abortRef.current?.abort(new DOMException('Cancelled by the user.', 'AbortError'));
    setNotice('Cancelling after the current browser operation…');
  };

  const detailLines = report ? reportDetails(report) : [];
  const supportTone = report?.status ?? 'neutral';

  return (
    <main className="page-shell">
      <header className="hero">
        <div>
          <div className="brand-mark" aria-hidden="true">Y</div>
          <p className="eyebrow">YumCut Video Ads · Next.js</p>
          <h1>Turn a template into a finished ad, right in your browser.</h1>
          <p className="lede">
            Pick an included clip, add your own video and soundtrack, then analyze, render,
            preview, and download without sending media to a server.
          </p>
        </div>
        <div className={`support-chip ${supportTone}`} data-testid="support-status">
          <span className="pulse" aria-hidden="true" />
          {ready ? report?.status ?? 'ready' : 'loading'}
        </div>
      </header>

      <section className="privacy-note" aria-label="Privacy note">
        <span aria-hidden="true">◎</span>
        <p><strong>Local-first render.</strong> Uploaded files remain in this tab unless your app sends them elsewhere.</p>
      </section>

      <div className="studio-grid">
        <section className="panel setup-panel" aria-labelledby="setup-title">
          <div className="panel-heading">
            <div>
              <p className="step">01 · Compose</p>
              <h2 id="setup-title">Build your video</h2>
            </div>
            <span className="quiet">All fields stay local</span>
          </div>

          <div className="template-preview">
            <video
              key={selectedTemplate.src}
              src={selectedTemplate.src}
              poster={selectedTemplate.poster}
              muted
              loop
              autoPlay
              playsInline
              controls
              aria-label={`Preview ${selectedTemplate.name}`}
            />
            <div className="preview-caption">
              <span>Selected template</span>
              <strong>{selectedTemplate.name}</strong>
              <small>{selectedTemplate.detail}</small>
            </div>
          </div>

          <div className="field-grid">
            <label className="field span-2">
              <span>Template video</span>
              <select
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
                disabled={isBusy}
                data-testid="template-select"
              >
                {TEMPLATES.map((template) => (
                  <option key={template.id} value={template.id}>{template.name} — {template.detail}</option>
                ))}
              </select>
            </label>

            <label className="upload-card">
              <span className="upload-icon" aria-hidden="true">↗</span>
              <span><strong>Add your video</strong><small>Optional picture-in-picture overlay</small></span>
              <input
                type="file"
                accept="video/*,.mp4,.webm,.mov"
                onChange={(event) => setOverlayVideo(event.currentTarget.files?.[0] ?? null)}
                disabled={isBusy}
                data-testid="overlay-input"
              />
              <em>{overlayVideo?.name ?? 'Choose a video'}</em>
            </label>

            <label className="upload-card">
              <span className="upload-icon" aria-hidden="true">♫</span>
              <span><strong>Add your music</strong><small>Optional audio track; loops to fit</small></span>
              <input
                type="file"
                accept="audio/*,.mp3,.m4a,.wav,.ogg,.aac"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0] ?? null;
                  setMusic(file);
                  if (file) setUseDemoMusic(false);
                }}
                disabled={isBusy}
                data-testid="music-input"
              />
              <em>{music?.name ?? 'Choose audio'}</em>
            </label>

            <label className="field span-2">
              <span>On-screen message <small>optional</small></span>
              <input
                value={caption}
                onChange={(event) => setCaption(event.target.value)}
                maxLength={100}
                placeholder="A concise call to action"
                disabled={isBusy}
              />
            </label>

            <label className="switch-row">
              <input
                type="checkbox"
                checked={useDemoMusic}
                onChange={(event) => setUseDemoMusic(event.target.checked)}
                disabled={isBusy || music !== null}
              />
              <span><strong>Use bundled demo music</strong><small>CC BY sample, ready for the first render</small></span>
            </label>
            <label className="switch-row">
              <input
                type="checkbox"
                checked={keepTemplateAudio}
                onChange={(event) => setKeepTemplateAudio(event.target.checked)}
                disabled={isBusy}
              />
              <span><strong>Keep template audio if present</strong><small>Bundled demo templates are silent</small></span>
            </label>
          </div>
        </section>

        <aside className="panel output-panel" aria-labelledby="output-title">
          <div className="panel-heading">
            <div>
              <p className="step">02 · Output</p>
              <h2 id="output-title">Choose the delivery</h2>
            </div>
          </div>

          <fieldset className="segmented-field">
            <legend>Orientation</legend>
            <div className="segmented">
              {(['landscape', 'portrait', 'square'] as const).map((value) => (
                <label key={value} className={orientation === value ? 'selected' : ''}>
                  <input
                    type="radio"
                    name="orientation"
                    value={value}
                    checked={orientation === value}
                    onChange={() => setOrientation(value)}
                    disabled={isBusy}
                  />
                  <span className={`frame-icon ${value}`} aria-hidden="true" />
                  {value}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="field-grid compact">
            <label className="field span-2">
              <span>Resolution</span>
              <select value={resolution} onChange={(event) => setResolution(event.target.value as Resolution)} disabled={isBusy}>
                {Object.entries(RESOLUTIONS).map(([value, preset]) => (
                  <option key={value} value={value}>{preset.label}</option>
                ))}
              </select>
              <small>{dimensions.width} × {dimensions.height} · 30 fps</small>
            </label>
            <label className="field">
              <span>Quality</span>
              <select value={quality} onChange={(event) => setQuality(event.target.value as 'balanced' | 'high')} disabled={isBusy}>
                <option value="balanced">Balanced</option>
                <option value="high">High</option>
              </select>
            </label>
            <label className="field">
              <span>Format</span>
              <select value={format} onChange={(event) => setFormat(event.target.value as RequestedOutputFormat)} disabled={isBusy}>
                <option value="auto">Best available</option>
                <option value="mp4">MP4</option>
                <option value="webm">WebM</option>
              </select>
            </label>
          </div>

          <div className="action-stack">
            <button className="button secondary" type="button" onClick={() => void checkSupport()} disabled={!ready || isBusy}>
              Check this browser
            </button>
            <button className="button secondary" type="button" onClick={() => void analyzeProject()} disabled={!ready || isBusy} data-testid="analyze-button">
              Analyze composition
            </button>
            <button className="button primary" type="button" onClick={() => void renderProject()} disabled={!ready || isBusy} data-testid="render-button">
              <span aria-hidden="true">▶</span> Render video locally
            </button>
            {busy === 'rendering' && (
              <button className="button danger" type="button" onClick={cancelRender}>Cancel render</button>
            )}
          </div>
        </aside>

        <section className="panel status-panel" aria-labelledby="status-title">
          <div className="panel-heading status-heading">
            <div>
              <p className="step">03 · Verify</p>
              <h2 id="status-title">Browser readiness</h2>
            </div>
            <span className={`report-badge ${supportTone}`}>{report?.status ?? 'pending'}</span>
          </div>
          <p className="notice" aria-live="polite" data-testid="notice">{notice}</p>
          <div className="progress-row">
            <progress value={progress.progress} max={1} data-testid="progress" />
            <strong>{Math.round(progress.progress * 100)}%</strong>
          </div>
          <p className="progress-detail">{progress.stage} · {progress.message}</p>
          {detailLines.length > 0 && (
            <ul className="report-list">
              {detailLines.map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}
            </ul>
          )}
        </section>

        <section className="panel result-panel" aria-labelledby="result-title">
          <div className="panel-heading">
            <div>
              <p className="step">04 · Preview</p>
              <h2 id="result-title">Your finished cut</h2>
            </div>
            {result && <span className="ready-label">Ready</span>}
          </div>
          {result ? (
            <>
              <video
                className={`result-video ${result.width === result.height ? 'square-result' : result.width < result.height ? 'portrait-result' : 'landscape-result'}`}
                src={result.url}
                width={result.width}
                height={result.height}
                controls
                playsInline
                data-testid="result-preview"
              />
              <dl className="metrics">
                <div><dt>Output</dt><dd>{result.format} · {result.size}</dd></div>
                <div><dt>Duration</dt><dd>{result.duration}</dd></div>
                <div><dt>File size</dt><dd>{result.bytes}</dd></div>
                <div><dt>Render time</dt><dd>{result.elapsed}</dd></div>
                <div className="wide"><dt>Frames</dt><dd>{result.frames}</dd></div>
              </dl>
              {result.warnings.map((warning) => <p className="result-warning" key={warning}>{warning}</p>)}
              <div className="result-actions">
                <a className="button primary" href={result.url} download={result.downloadName} data-testid="download-link">Download video</a>
                <button className="button ghost" type="button" onClick={() => void clearResult()}>Clear result</button>
              </div>
            </>
          ) : (
            <div className="empty-result">
              <div className="empty-icon" aria-hidden="true">▶</div>
              <strong>Your preview will appear here</strong>
              <p>Start with the quick 360p preset to validate the complete browser workflow.</p>
            </div>
          )}
        </section>
      </div>

      <footer>
        <p>YumCut Video Ads · App Router consumer demo · Included media is CC BY 3.0.</p>
      </footer>
    </main>
  );
}
