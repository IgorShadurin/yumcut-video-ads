import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import {
  createYumCutVideoAds,
  isYumCutVideoAdsError,
  secondsToUs,
  usToSeconds,
  type AudioClip,
  type Project,
  type RenderProgress,
  type RenderResult,
  type SupportReport,
  type Track,
} from 'yumcut-video-ads';

type Orientation = 'landscape' | 'portrait';
type Quality = 'balanced' | 'high';
type MusicMode = 'sample' | 'upload' | 'none';
type StatusTone = 'idle' | 'working' | 'success' | 'warning' | 'error';

interface TemplateOption {
  id: string;
  title: string;
  description: string;
  source: string;
  detail: string;
}

interface ResultSummary {
  filename: string;
  format: string;
  dimensions: string;
  duration: string;
  size: string;
  elapsed: string;
}

const publicAsset = (path: string): string =>
  `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`;

const TEMPLATES: readonly TemplateOption[] = [
  {
    id: 'classic',
    title: 'Classic motion',
    description: 'A compact MP4 starter with motion and natural texture.',
    source: publicAsset('media/bunny-template.mp4'),
    detail: 'MP4 · landscape',
  },
  {
    id: 'social',
    title: 'Social square',
    description: 'A square WebM source that demonstrates aspect-safe cropping.',
    source: publicAsset('media/bunny-square.webm'),
    detail: 'WebM · square',
  },
  {
    id: 'detail',
    title: 'High-detail source',
    description: 'A 4K source for checking browser decode and downscale performance.',
    source: publicAsset('media/bunny-4k.mp4'),
    detail: 'MP4 · 4K source',
  },
] as const;

const OUTPUTS: Record<Orientation, { width: number; height: number }> = {
  landscape: { width: 1280, height: 720 },
  portrait: { width: 720, height: 1280 },
};

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes)) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
};

const formatDuration = (durationUs: number): string => {
  const totalSeconds = usToSeconds(durationUs);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return minutes > 0 ? `${minutes}:${seconds.toFixed(1).padStart(4, '0')}` : `${seconds.toFixed(1)} sec`;
};

const stageLabel = (progress: RenderProgress): string =>
  progress.stage.charAt(0).toUpperCase() + progress.stage.slice(1);

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg aria-hidden="true" className="icon" viewBox="0 0 24 24" fill="none">
      {children}
    </svg>
  );
}

function UploadIcon() {
  return (
    <Icon>
      <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" />
      <path d="M5 14.5v3A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5v-3" />
    </Icon>
  );
}

function SparkIcon() {
  return (
    <Icon>
      <path d="m12 2 1.35 4.15A4 4 0 0 0 15.85 8.7L20 10l-4.15 1.35a4 4 0 0 0-2.5 2.5L12 18l-1.35-4.15a4 4 0 0 0-2.5-2.5L4 10l4.15-1.3a4 4 0 0 0 2.5-2.55L12 2Z" />
      <path d="m19 17 .55 1.45L21 19l-1.45.55L19 21l-.55-1.45L17 19l1.45-.55L19 17Z" />
    </Icon>
  );
}

function CheckIcon() {
  return (
    <Icon>
      <path d="m5 12.5 4.2 4.2L19 7" />
    </Icon>
  );
}

function DownloadIcon() {
  return (
    <Icon>
      <path d="M12 4v11m0 0 4-4m-4 4-4-4" />
      <path d="M5 19h14" />
    </Icon>
  );
}

function TrashIcon() {
  return (
    <Icon>
      <path d="M5 7h14M9 7V4h6v3m2 0-.7 13H7.7L7 7m3 4v5m4-5v5" />
    </Icon>
  );
}

function FilePicker({
  id,
  accept,
  title,
  hint,
  file,
  onChange,
  onClear,
  disabled,
}: {
  id: string;
  accept: string;
  title: string;
  hint: string;
  file: File | null;
  onChange: (file: File | null) => void;
  onClear: () => void;
  disabled: boolean;
}) {
  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    onChange(event.target.files?.[0] ?? null);
    event.target.value = '';
  };

  return (
    <div className={`file-picker ${file ? 'has-file' : ''}`}>
      <label htmlFor={id} className="file-picker-main">
        <span className="upload-icon"><UploadIcon /></span>
        <span className="file-copy">
          <strong>{file?.name ?? title}</strong>
          <small>{file ? `${formatBytes(file.size)} · click to replace` : hint}</small>
        </span>
      </label>
      <input id={id} type="file" accept={accept} onChange={chooseFile} disabled={disabled} />
      {file && (
        <button className="icon-button" type="button" onClick={onClear} aria-label={`Remove ${file.name}`} disabled={disabled}>
          <TrashIcon />
        </button>
      )}
    </div>
  );
}

function App() {
  const editor = useMemo(() => createYumCutVideoAds(), []);
  const [templateId, setTemplateId] = useState(TEMPLATES[0].id);
  const [orientation, setOrientation] = useState<Orientation>('landscape');
  const [quality, setQuality] = useState<Quality>('balanced');
  const [userVideo, setUserVideo] = useState<File | null>(null);
  const [musicMode, setMusicMode] = useState<MusicMode>('sample');
  const [musicFile, setMusicFile] = useState<File | null>(null);
  const [keepVideoAudio, setKeepVideoAudio] = useState(false);
  const [musicVolume, setMusicVolume] = useState(72);
  const [caption, setCaption] = useState('Make your story move');
  const [busy, setBusy] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [phase, setPhase] = useState('Ready to compose');
  const [progress, setProgress] = useState(0);
  const [statusTone, setStatusTone] = useState<StatusTone>('idle');
  const [statusMessage, setStatusMessage] = useState('Choose a template, add your media, then check this browser.');
  const [support, setSupport] = useState<SupportReport | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [resultSummary, setResultSummary] = useState<ResultSummary | null>(null);

  const controllerRef = useRef<AbortController | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const releaseRef = useRef<RenderResult['release']>(undefined);
  const mountedRef = useRef(true);

  const selectedTemplate = TEMPLATES.find((template) => template.id === templateId) ?? TEMPLATES[0];
  const selectedOutput = OUTPUTS[orientation];

  const clearResult = useCallback(async () => {
    const url = previewUrlRef.current;
    previewUrlRef.current = null;
    if (url) URL.revokeObjectURL(url);

    const release = releaseRef.current;
    releaseRef.current = undefined;
    await release?.();

    if (mountedRef.current) {
      setPreviewUrl(null);
      setResultSummary(null);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort('The React demo was closed.');
      const url = previewUrlRef.current;
      previewUrlRef.current = null;
      if (url) URL.revokeObjectURL(url);
      const release = releaseRef.current;
      releaseRef.current = undefined;
      void release?.();
      editor.dispose();
    };
  }, [editor]);

  const buildProject = useCallback(async (): Promise<Project> => {
    const templateSource = {
      type: 'url' as const,
      url: new URL(selectedTemplate.source, window.location.href),
      cache: 'browser' as const,
    };
    setPhase('Inspecting template');
    setProgress(0.04);
    const templateInfo = await editor.inspect(templateSource);
    if (!templateInfo.hasVideo || templateInfo.durationUs <= 0) {
      throw new Error('The selected template does not contain a usable video track.');
    }

    const durationUs = templateInfo.durationUs;
    const transitionUs = Math.min(secondsToUs(0.35), Math.floor(durationUs / 4));
    const inset = orientation === 'portrait'
      ? { x: 0.07, y: 0.12, width: 0.86, height: 0.67 }
      : { x: 0.08, y: 0.11, width: 0.84, height: 0.69 };
    const tracks: Track[] = [
      {
        id: 'template-background',
        type: 'visual',
        clips: [
          {
            id: 'template',
            type: 'video',
            source: templateSource,
            startUs: 0,
            durationUs,
            fit: 'cover',
            focalPoint: { x: 0.5, y: 0.5 },
            muted: true,
          },
        ],
      },
    ];

    if (userVideo) {
      tracks.push({
        id: 'uploaded-video',
        type: 'visual',
        clips: [
          {
            id: 'uploaded-video-clip',
            type: 'video',
            source: userVideo,
            startUs: 0,
            durationUs,
            loop: true,
            box: inset,
            fit: 'cover',
            focalPoint: { x: 0.5, y: 0.5 },
            muted: !keepVideoAudio,
            volume: 0.55,
            transitionIn: { type: 'fade', durationUs: transitionUs },
            transitionOut: { type: 'fade', durationUs: transitionUs },
          },
        ],
      });
    }

    const captionText = caption.trim();
    if (captionText) {
      const fontSize = Math.round(selectedOutput.width * (orientation === 'portrait' ? 0.066 : 0.041));
      tracks.push({
        id: 'headline',
        type: 'visual',
        clips: [
          {
            id: 'headline-text',
            type: 'text',
            text: captionText,
            startUs: 0,
            durationUs,
            box: orientation === 'portrait'
              ? { x: 0.08, y: 0.8, width: 0.84, height: 0.13 }
              : { x: 0.1, y: 0.82, width: 0.8, height: 0.11 },
            transitionIn: { type: 'fade', durationUs: transitionUs },
            transitionOut: { type: 'fade', durationUs: transitionUs },
            style: {
              fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
              fontWeight: 760,
              fontSize,
              lineHeight: Math.round(fontSize * 1.06),
              color: '#ffffff',
              backgroundColor: 'rgba(8, 10, 16, 0.68)',
              padding: Math.max(14, Math.round(selectedOutput.width * 0.012)),
              textAlign: 'center',
              verticalAlign: 'middle',
            },
          },
        ],
      });
    }

    const soundtrack = musicMode === 'upload'
      ? musicFile
      : musicMode === 'sample'
        ? {
            type: 'url' as const,
            url: new URL(publicAsset('media/yumcut-demo-music.ogg'), window.location.origin),
            cache: 'browser' as const,
          }
        : null;

    if (soundtrack) {
      const audioClip: AudioClip = {
        id: 'soundtrack-clip',
        type: 'audio',
        source: soundtrack,
        startUs: 0,
        durationUs,
        loop: true,
        volume: musicVolume / 100,
        fadeInUs: Math.min(secondsToUs(0.25), Math.floor(durationUs / 4)),
        fadeOutUs: Math.min(secondsToUs(0.5), Math.floor(durationUs / 4)),
      };
      tracks.push({ id: 'soundtrack', type: 'audio', clips: [audioClip] });
    }

    return {
      id: 'yumcut-react-demo',
      output: {
        width: selectedOutput.width,
        height: selectedOutput.height,
        frameRate: 30,
        durationUs,
        background: {
          type: 'blur',
          blurRadius: Math.max(18, Math.round(selectedOutput.width * 0.018)),
          dim: 0.26,
          fallbackColor: '#090b12',
        },
      },
      tracks,
    };
  }, [
    caption,
    editor,
    keepVideoAudio,
    musicFile,
    musicMode,
    musicVolume,
    orientation,
    selectedOutput.height,
    selectedOutput.width,
    selectedTemplate.source,
    userVideo,
  ]);

  const checkSupport = async () => {
    try {
      setBusy(true);
      setStatusTone('working');
      setPhase('Checking browser');
      setProgress(0.15);
      setStatusMessage('Testing WebCodecs, workers, canvas, codecs, and storage…');
      const report = await editor.detectSupport({
        width: selectedOutput.width,
        height: selectedOutput.height,
        frameRate: 30,
        format: 'auto',
        includeAudio: musicMode !== 'none' || (Boolean(userVideo) && keepVideoAudio),
        runPerformanceProbe: true,
      });
      setSupport(report);
      setProgress(1);
      setPhase(report.supported ? 'Browser ready' : 'Needs attention');
      setStatusTone(report.status === 'supported' ? 'success' : report.status === 'degraded' ? 'warning' : 'error');
      const recommendation = report.recommendedOutput
        ? ` Recommended output: ${report.recommendedOutput.format.toUpperCase()}.`
        : '';
      const firstIssue = report.blockers[0] ?? report.warnings[0] ?? '';
      setStatusMessage(`${report.supported ? 'This browser can render the selected HD layout.' : 'This browser cannot render this layout.'}${recommendation}${firstIssue ? ` ${firstIssue}` : ''}`);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const showError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = isYumCutVideoAdsError(error) ? `${error.code}: ` : '';
    setStatusTone('error');
    setStatusMessage(`${code}${message}`);
    setPhase('Stopped');
  };

  const acceptResult = async (result: RenderResult) => {
    if (!result.blob) {
      await result.release?.();
      throw new Error('The renderer completed without a previewable Blob.');
    }
    const url = URL.createObjectURL(result.blob);
    previewUrlRef.current = url;
    releaseRef.current = result.release;
    const filename = `yumcut-${orientation}-${Date.now()}.${result.format}`;
    setPreviewUrl(url);
    setResultSummary({
      filename,
      format: result.format.toUpperCase(),
      dimensions: `${result.width} × ${result.height}`,
      duration: formatDuration(result.durationUs),
      size: formatBytes(result.fileSize),
      elapsed: `${(result.stats.elapsedMs / 1000).toFixed(2)} sec`,
    });
  };

  const renderVideo = async () => {
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      setBusy(true);
      setRendering(true);
      setSupport(null);
      setStatusTone('working');
      setStatusMessage('Preparing your composition locally. Your files never leave this browser.');
      setPhase('Preparing');
      setProgress(0);
      await clearResult();

      const project = await buildProject();
      setPhase('Analyzing project');
      setProgress(0.08);
      const analysis = await editor.analyze(project, {
        format: 'auto',
        quality,
        output: 'auto',
      });
      setSupport(analysis);
      if (!analysis.supported) {
        throw new Error(analysis.blockers.join(' ') || 'The current browser cannot render this project.');
      }

      const result = await editor.render(project, {
        format: 'auto',
        quality,
        output: 'auto',
        signal: controller.signal,
        onProgress: (update) => {
          if (!mountedRef.current) return;
          setPhase(stageLabel(update));
          setProgress(update.progress);
          if (update.message) setStatusMessage(update.message);
        },
      });
      await acceptResult(result);
      setProgress(1);
      setPhase('Render complete');
      setStatusTone(result.warnings.length > 0 ? 'warning' : 'success');
      setStatusMessage(result.warnings[0] ?? 'Your video is ready to preview and download.');
    } catch (error) {
      showError(error);
    } finally {
      controllerRef.current = null;
      setRendering(false);
      setBusy(false);
    }
  };

  const cancelRender = () => {
    controllerRef.current?.abort('Cancelled from the React demo.');
    setPhase('Cancelling');
    setStatusMessage('Stopping safely after the current browser operation…');
  };

  const changeTemplate = (id: string) => {
    setTemplateId(id);
    setSupport(null);
  };

  return (
    <div className="app-shell" data-testid="react-vite-demo">
      <header className="topbar">
        <a className="brand" href="#studio" aria-label="YumCut Video Ads home">
          <span className="brand-mark"><SparkIcon /></span>
          <span><strong>YumCut</strong><small>Video Ads</small></span>
        </a>
        <div className="privacy-note">
          <span className="privacy-dot" />
          Local browser rendering
        </div>
      </header>

      <main id="studio" className="studio">
        <section className="hero" aria-labelledby="page-title">
          <div>
            <p className="eyebrow">React + Vite integration</p>
            <h1 id="page-title">Turn your clips into a <span>finished ad.</span></h1>
          </div>
          <p className="hero-copy">Choose a bundled template, layer in your own video and soundtrack, and render a polished HD video without uploading media to a server.</p>
        </section>

        <div className="workspace">
          <section className="editor-card" aria-label="Video composition controls">
            <div className="section-heading">
              <span className="step-number">01</span>
              <div><h2>Choose a template</h2><p>Bundled with this demo and served from the same origin.</p></div>
            </div>

            <div className="template-grid" role="radiogroup" aria-label="Video template">
              {TEMPLATES.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  role="radio"
                  aria-checked={template.id === templateId}
                  className={`template-card ${template.id === templateId ? 'selected' : ''}`}
                  onClick={() => changeTemplate(template.id)}
                  disabled={busy}
                >
                  <span className="template-thumb">
                    <img src={publicAsset('media/bunny-poster.jpg')} alt="" />
                    <span className="template-chip">{template.detail}</span>
                    <span className="selection-check"><CheckIcon /></span>
                  </span>
                  <span className="template-copy"><strong>{template.title}</strong><small>{template.description}</small></span>
                </button>
              ))}
            </div>

            <div className="section-divider" />
            <div className="section-heading">
              <span className="step-number">02</span>
              <div><h2>Add your media</h2><p>Files remain on this device and are passed directly to the renderer.</p></div>
            </div>

            <div className="file-grid">
              <FilePicker
                id="video-upload"
                accept="video/*"
                title="Upload your video"
                hint="MP4, WebM, MOV, or another browser-decodable video"
                file={userVideo}
                onChange={setUserVideo}
                onClear={() => setUserVideo(null)}
                disabled={busy}
              />
              <FilePicker
                id="music-upload"
                accept="audio/*"
                title="Upload your music"
                hint="MP3, AAC, OGG, WAV, or another browser-decodable audio file"
                file={musicFile}
                onChange={(file) => {
                  setMusicFile(file);
                  if (file) setMusicMode('upload');
                }}
                onClear={() => {
                  setMusicFile(null);
                  setMusicMode('sample');
                }}
                disabled={busy}
              />
            </div>

            <div className="field-grid media-options">
              <label className="field span-two">
                <span>Headline</span>
                <input value={caption} onChange={(event) => setCaption(event.target.value)} maxLength={72} disabled={busy} placeholder="Add a short message" />
                <small>{caption.length}/72 characters</small>
              </label>
              <fieldset className="field span-two segmented-field">
                <legend>Soundtrack</legend>
                <div className="segmented three">
                  {([
                    ['sample', 'Bundled sample'],
                    ['upload', 'My upload'],
                    ['none', 'No music'],
                  ] as const).map(([value, label]) => (
                    <label key={value} className={musicMode === value ? 'active' : ''}>
                      <input
                        type="radio"
                        name="music-mode"
                        value={value}
                        checked={musicMode === value}
                        onChange={() => setMusicMode(value)}
                        disabled={busy || (value === 'upload' && !musicFile)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="field range-field span-two">
                <span>Music volume <output>{musicVolume}%</output></span>
                <input type="range" min="0" max="100" value={musicVolume} onChange={(event) => setMusicVolume(Number(event.target.value))} disabled={busy || musicMode === 'none'} />
              </label>
              <label className="checkbox-field span-two">
                <input type="checkbox" checked={keepVideoAudio} onChange={(event) => setKeepVideoAudio(event.target.checked)} disabled={busy || !userVideo} />
                <span><strong>Keep uploaded video audio</strong><small>Mix it at a lower volume beneath the soundtrack.</small></span>
              </label>
            </div>

            <div className="section-divider" />
            <div className="section-heading">
              <span className="step-number">03</span>
              <div><h2>Set the output</h2><p>Cover-fit composition preserves aspect ratio without black bars or stretching.</p></div>
            </div>

            <div className="field-grid">
              <fieldset className="field segmented-field">
                <legend>Orientation</legend>
                <div className="segmented">
                  {([
                    ['landscape', '16:9 Landscape'],
                    ['portrait', '9:16 Portrait'],
                  ] as const).map(([value, label]) => (
                    <label key={value} className={orientation === value ? 'active' : ''}>
                      <input type="radio" name="orientation" checked={orientation === value} onChange={() => setOrientation(value)} disabled={busy} />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset className="field segmented-field">
                <legend>Quality</legend>
                <div className="segmented">
                  {([
                    ['balanced', 'Fast HD'],
                    ['high', 'High quality'],
                  ] as const).map(([value, label]) => (
                    <label key={value} className={quality === value ? 'active' : ''}>
                      <input type="radio" name="quality" checked={quality === value} onChange={() => setQuality(value)} disabled={busy} />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>

            <div className="action-row">
              <button className="secondary-button" type="button" onClick={checkSupport} disabled={busy}>
                Check browser
              </button>
              {rendering ? (
                <button className="danger-button" type="button" onClick={cancelRender}>
                  Cancel render
                </button>
              ) : (
                <button className="primary-button" type="button" onClick={renderVideo} disabled={busy}>
                  <SparkIcon /> Render my video
                </button>
              )}
            </div>
          </section>

          <aside className="preview-column" aria-label="Video preview and render status">
            <div className="preview-card">
              <div className="preview-heading">
                <div><p className="eyebrow">Live selection</p><h2>{previewUrl ? 'Your finished video' : selectedTemplate.title}</h2></div>
                <span className="resolution-badge">{selectedOutput.width} × {selectedOutput.height}</span>
              </div>

              <div className={`video-stage ${orientation}`}>
                <video
                  key={previewUrl ?? selectedTemplate.source}
                  data-testid={previewUrl ? 'result-video' : 'template-preview'}
                  aria-label={previewUrl ? 'Rendered result preview' : `${selectedTemplate.title} template preview`}
                  src={previewUrl ?? selectedTemplate.source}
                  poster={previewUrl ? undefined : publicAsset('media/bunny-poster.jpg')}
                  controls
                  muted={!previewUrl}
                  loop={!previewUrl}
                  playsInline
                  preload="metadata"
                />
                {!previewUrl && <span className="template-watermark">Template preview</span>}
              </div>

              {resultSummary ? (
                <div className="result-panel" aria-live="polite">
                  <dl>
                    <div><dt>Format</dt><dd>{resultSummary.format}</dd></div>
                    <div><dt>Size</dt><dd>{resultSummary.size}</dd></div>
                    <div><dt>Duration</dt><dd>{resultSummary.duration}</dd></div>
                    <div><dt>Rendered in</dt><dd>{resultSummary.elapsed}</dd></div>
                  </dl>
                  <a className="download-button" href={previewUrl ?? '#'} download={resultSummary.filename}>
                    <DownloadIcon /> Download video
                  </a>
                  <button className="text-button" type="button" onClick={() => void clearResult()}>Clear rendered result</button>
                </div>
              ) : (
                <div className="composition-summary">
                  <div><span className="summary-icon">T</span><span><strong>{selectedTemplate.title}</strong><small>Bundled base layer</small></span></div>
                  <div><span className="summary-icon">V</span><span><strong>{userVideo?.name ?? 'No uploaded video'}</strong><small>{userVideo ? 'Cover-fit foreground layer' : 'Optional foreground layer'}</small></span></div>
                  <div><span className="summary-icon">♪</span><span><strong>{musicMode === 'sample' ? 'Bundled sample' : musicMode === 'upload' ? musicFile?.name : 'No soundtrack'}</strong><small>{musicMode === 'none' ? 'Silent export' : `${musicVolume}% volume with fades`}</small></span></div>
                </div>
              )}
            </div>

            <div className={`status-card ${statusTone}`} aria-live="polite">
              <div className="status-head">
                <span className="status-indicator" />
                <strong>{phase}</strong>
                <span>{Math.round(progress * 100)}%</span>
              </div>
              <progress aria-label="Render progress" max="1" value={progress}>{Math.round(progress * 100)}%</progress>
              <p>{statusMessage}</p>
              {support && (
                <div className="support-facts">
                  <span>{support.status}</span>
                  <span>{support.recommendedOutput?.format.toUpperCase() ?? 'No codec'}</span>
                  <span>{support.features.webCodecs.available ? 'WebCodecs' : 'No WebCodecs'}</span>
                </div>
              )}
            </div>

            <p className="device-note">Rendering speed and available formats depend on this browser, GPU, codecs, source media, and output size.</p>
          </aside>
        </div>
      </main>

      <footer>
        <span>YumCut Video Ads</span>
        <span>React 19 · Vite 8 · local-first media processing</span>
      </footer>
    </div>
  );
}

export default App;
