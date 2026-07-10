# YumCut Video Ads

Create finished video ads inside the browser. YumCut Video Ads combines a reusable
template with a customer's video, product imagery, copy, voice-over, or music and
exports one MP4 or WebM—without first sending those source files to a rendering
backend.

The library is built for products that need a real video workflow rather than a
canvas preview. It inspects the actual media, preserves aspect ratios, crops around
focal points, mixes audio, encodes every frame, and muxes a playable output file.
WebCodecs, a worker-based WebGL2 compositor, bounded decode/encode queues, browser
storage, and streaming output keep the hot path fast and memory-aware.

Desktop Chromium is the primary performance target. Mobile and other modern
browsers are supported when their concrete codecs and APIs permit it. There is no
artificial duration or resolution gate: 360p through 4K and timelines up to five
minutes are the qualification range, while `detectSupport()` and `analyze()` tell
your UI when a specific device/profile is supported, degraded, or blocked.

## Highlights

- Local browser processing: media does not leave the page unless your application sends it elsewhere.
- Remote templates through normal HTTP caching, range requests where the server supports them, or explicit persistent prefetching.
- Ordered visual and audio tracks with trims, looping, opacity, fades, focal-point cropping, placement, rotation, and transitions.
- Aspect-ratio-safe `cover` and `contain` layout. Sources are cropped or fitted without stretching; lower layers or the default blurred background fill otherwise empty space instead of injecting black bars.
- MP4 (H.264/AAC) and WebM (VP9/Opus), selected from the browser's real encoder support.
- Abortable renders, structured progress, media inspection, storage estimates, and stable error codes.
- WebGL2 compositor with a worker Canvas 2D fallback. WebCodecs encoding requests hardware acceleration when the browser provides it.

`yumcut-video-ads` deliberately does not hide unsupported codecs behind an ffmpeg.wasm fallback. Large WASM transcodes can be too slow and memory-heavy for this use case; unsupported input or output is reported before the render when possible.

## Product use cases

### Template-driven product ads

Keep a branded background video on a CDN, let a merchant select it, then place an
uploaded product demo in a picture-in-picture region with a logo, headline, and
music bed. Cache the public template once and reuse it for later variants.

### UGC and creator ads

Take a vertical phone clip, crop it safely into a 9:16 campaign layout, add a
horizontal or square brand asset without stretching, mix narration with music,
and export a ready-to-preview deliverable on the creator's device.

### Social format variants

Use the same sources to build 16:9, 1:1, and 9:16 outputs. `cover`, `contain`,
normalized placement boxes, and focal points make the crop decision explicit;
blurred source backgrounds can fill unused space without black bars.

### Localized and personalized creative

Replace headlines, calls to action, product images, or audio while keeping the
master template stable. Generate variants sequentially and reuse cached assets to
avoid repeat downloads and unnecessary memory pressure.

### Privacy-sensitive preview and export

Customer files remain in the browser unless your application deliberately uploads
them. This suits preflight tools, internal brand portals, and editors where an
immediate local preview is preferable to a render-server round trip.

YumCut Video Ads is not a server batch-render farm or a universal legacy-codec
transcoder. For unattended high-volume rendering, DRM sources, or codecs the
browser cannot decode/encode, use a server media pipeline and treat the browser
library as the interactive front end.

## Install

```sh
npm install yumcut-video-ads
```

Until an npm release is published, install the current repository directly:

```sh
npm install github:IgorShadurin/yumcut-video-ads
```

For local library development, the demos use `"yumcut-video-ads": "file:../.."`;
npm links that dependency to the repository checkout so rebuilding the root package
is immediately visible to every consumer.

The package is ESM-only and targets modern browsers. Your application must run from HTTPS or `localhost` for all secure-context browser APIs to be available.

Vite and other bundlers that process `new URL(..., import.meta.url)` emit the
default render worker automatically. With a bundler that leaves package-relative
worker URLs untouched (notably a plain esbuild application build), emit
`yumcut-video-ads/worker` as a separate asset and pass its public URL explicitly:

```ts
const yumcut = createYumCutVideoAds({
  workerUrl: '/assets/yumcut-video-ads-render-worker.js',
});
```

## Runnable demo applications

The repository includes three complete consumers. Each one contains the licensed
demo templates, lets you choose a bundled video, upload your own video and music,
checks the selected output profile, renders with progress/cancellation, and
previews or downloads the final file.

| Consumer | Location | What it verifies |
| --- | --- | --- |
| Next.js App Router | [`demos/nextjs`](./demos/nextjs) | Client-only media UI inside an SSR framework |
| React + Vite | [`demos/react-vite`](./demos/react-vite) | Modern component integration and worker bundling |
| Vanilla TypeScript | [`demos/vanilla`](./demos/vanilla) | Framework-free DOM integration and the smallest setup |

Build every consumer from the repository root:

```sh
npm run build
npm run build:demos
```

See each demo README for its development command. The source media attribution and
reproducible checksums are documented in [`MEDIA_LICENSES.md`](./MEDIA_LICENSES.md).

## Deploy the demo hub on Coolify

The repository is ready to deploy as one application. It builds a landing page and
all three editors, serves video byte ranges, exposes a health check, and needs no
secrets, volumes, databases, or application environment variables.

For the lowest-configuration Coolify deployment:

1. Create a **Public Repository** application from
   `https://github.com/IgorShadurin/yumcut-video-ads` on the `main` branch.
2. Keep the default **Nixpacks** build pack and deploy. The committed
   [`nixpacks.toml`](./nixpacks.toml) installs, builds, and starts the complete hub.
3. If the Coolify version asks for an exposed port, use `3000`. Set the optional
   health-check path to `/healthz`; no environment variables are required.

The generated HTTPS domain serves:

| Path | Application |
| --- | --- |
| `/` | Demo chooser |
| `/nextjs/` | Next.js App Router editor |
| `/react/` | React + Vite editor |
| `/vanilla/` | Vanilla TypeScript editor |
| `/media/` | Bundled media and attribution |
| `/healthz` | Container/application health (`200 ok`) |

HTTPS is important because WebCodecs and related browser APIs require a secure
context outside localhost. The application listens on Coolify's injected `PORT`
and streams large media from disk instead of loading it into the server process.

Two repository-defined alternatives are also available:

- Choose **Dockerfile**, leave the path as `Dockerfile`, and expose port `80`.
- Choose **Docker Compose** and deploy the root `docker-compose.yml`; its Coolify
  service URL variable, health check, port, and build are already declared.

To exercise the same production build locally:

```sh
npm ci
npm run build:showcase
npm start
```

Then open `http://localhost:3000`. For the container path, run
`docker compose up --build` and open the URL assigned by your container platform.

## Quick start

```ts
import {
  createYumCutVideoAds,
  secondsToUs,
  type Project,
} from 'yumcut-video-ads';

const yumcut = createYumCutVideoAds();

const support = await yumcut.detectSupport({
  width: 1920,
  height: 1080,
  frameRate: 30,
  durationUs: secondsToUs(30),
  format: 'auto',
});

if (!support.supported) {
  throw new Error(support.blockers.join('\n'));
}

const project: Project = {
  output: {
    width: 1920,
    height: 1080,
    frameRate: 30,
    durationUs: secondsToUs(30),
    background: { type: 'blur', blurRadius: 28, dim: 0.25 },
  },
  tracks: [
    {
      type: 'visual',
      clips: [
        {
          type: 'video',
          source: {
            type: 'url',
            url: 'https://cdn.example.com/templates/launch.mp4',
            cache: 'browser',
          },
          startUs: 0,
          durationUs: secondsToUs(30),
          fit: 'cover',
          focalPoint: { x: 0.5, y: 0.5 },
        },
      ],
    },
    {
      type: 'visual',
      clips: [
        {
          type: 'image',
          source: logoFile,
          startUs: 0,
          durationUs: secondsToUs(30),
          box: { x: 0.72, y: 0.06, width: 0.22, height: 0.18 },
          fit: 'contain',
          transitionIn: { type: 'fade', durationUs: secondsToUs(0.35) },
        },
      ],
    },
    {
      type: 'audio',
      volume: 0.8,
      clips: [
        {
          type: 'audio',
          source: musicFile,
          startUs: 0,
          durationUs: secondsToUs(30),
          loop: true,
          fadeInUs: secondsToUs(0.25),
          fadeOutUs: secondsToUs(0.5),
        },
      ],
    },
  ],
};

const analysis = await yumcut.analyze(project, {
  format: 'auto',
  quality: 'balanced',
  output: 'blob',
});
if (analysis.status === 'unsupported') {
  throw new Error(analysis.blockers.join('\n'));
}

const controller = new AbortController();
const result = await yumcut.render(project, {
  format: 'auto',
  quality: 'balanced',
  output: 'blob',
  signal: controller.signal,
  onProgress(progress) {
    console.log(progress.stage, Math.round(progress.progress * 100), progress.message);
  },
});

if (result.blob) {
  const previewUrl = URL.createObjectURL(result.blob);
  document.querySelector('video')!.src = previewUrl;
}

// Release the worker, decoded frames, and graphics resources.
yumcut.dispose();
```

All public times are integer microseconds. Use `secondsToUs()`, `millisecondsToUs()`, `usToSeconds()`, and `usToMilliseconds()` instead of accumulating floating-point frame times.

## Projects and tracks

Tracks are composited in array order. Later visual tracks appear over earlier tracks. Audio tracks are mixed together; a video clip may also contribute its embedded audio unless it is muted.

### Visual clips

A visual track accepts `video`, `image`, and `text` clips. Every clip has `startUs` and `durationUs`; media clips may also specify `trimStartUs` and `loop`.

```ts
const foreground = {
  type: 'video' as const,
  source: foregroundFile,
  startUs: secondsToUs(2),
  durationUs: secondsToUs(8),
  trimStartUs: secondsToUs(1),
  box: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
  fit: 'cover' as const,
  focalPoint: { x: 0.65, y: 0.4 },
  opacity: 0.92,
  rotationDegrees: -2,
  transitionIn: { type: 'slide' as const, durationUs: secondsToUs(0.4), direction: 'right' as const },
  transitionOut: { type: 'fade' as const, durationUs: secondsToUs(0.3) },
};
```

Layout coordinates are normalized to the output frame. `{ x: 0, y: 0, width: 1, height: 1 }` fills it. `cover` preserves aspect ratio while cropping around `focalPoint`; `contain` preserves the complete source. `alignment`, `position`, `scale`, and `rotationDegrees` provide additional placement control.

The output `background` can be a CSS color or blur settings:

```ts
output: {
  width: 1080,
  height: 1920,
  frameRate: 30,
  background: {
    type: 'blur',
    blurRadius: 32,
    dim: 0.2,
    fallbackColor: '#101218',
  },
}
```

### Text

```ts
{
  type: 'text',
  text: 'A clear call to action',
  startUs: 0,
  durationUs: secondsToUs(5),
  box: { x: 0.08, y: 0.72, width: 0.84, height: 0.18 },
  style: {
    fontFamily: 'Inter, system-ui, sans-serif',
    fontWeight: 700,
    fontSize: 72,
    lineHeight: 80,
    color: '#ffffff',
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    padding: 24,
    textAlign: 'center',
    verticalAlign: 'middle',
  },
}
```

`fontSize`, `lineHeight`, stroke width, and padding are output pixels. Load web fonts before starting a render if exact text metrics matter. A worker can only use fonts that the page/browser has made available.

### Audio

Audio is mixed as 48 kHz stereo. Clip and track volume multiply together. Mono sources are upmixed, multichannel sources are downmixed, fades are applied on the output timeline, and the final mix is peak-limited.

```ts
{
  type: 'audio',
  volume: 0.7,
  clips: [{
    type: 'audio',
    source: narrationFile,
    startUs: secondsToUs(1.5),
    durationUs: secondsToUs(12),
    trimStartUs: 0,
    fadeInUs: secondsToUs(0.1),
    fadeOutUs: secondsToUs(0.25),
  }],
}
```

## Sources, CORS, and caching

`MediaSource` accepts a URL string, `URL`, `File`, `Blob`, `ArrayBuffer`, typed-array view, or a descriptor:

```ts
const publicTemplate = {
  type: 'url' as const,
  // Put the public asset version in its URL so cache identity is unambiguous.
  url: 'https://media.example.com/template.mp4?v=2026-07',
  credentials: 'omit' as const,
  cache: 'persistent' as const,
};

const authenticatedTemplate = {
  type: 'url' as const,
  url: 'https://media.example.com/account/template.mp4',
  credentials: 'include' as const,
  headers: { Authorization: 'Bearer …' },
  cache: 'browser' as const,
};
```

Cross-origin servers must allow your page origin with `Access-Control-Allow-Origin`. For efficient seeking, servers should also support byte ranges and expose relevant response headers. Browser security rules prevent the library from reading opaque responses; a URL that plays in a plain `<video>` element is not necessarily readable through WebCodecs.

Cache modes are:

- `browser`: use normal fetch/HTTP cache behavior.
- `persistent`: first look for an explicitly prefetched complete response in Cache Storage, then use the network if it is absent.
- `none`: request the source without storing or reusing it.

Persistent prefetch is explicit:

```ts
const entry = await yumcut.cache.prefetch(publicTemplate, {
  signal: controller.signal,
});

console.log(entry.sizeBytes, await yumcut.cache.estimate());
await yumcut.cache.remove(publicTemplate);
// Or remove all assets owned by this library instance/cache:
await yumcut.cache.clear();
```

Prefetch downloads the complete file. Persistent entries are URL-keyed and therefore accept only public media without custom headers or non-`omit` credentials; authenticated or header-variant media must use `browser`/`none`, or a distinct signed URL. Check storage estimates and make sure the user understands the bandwidth/storage cost before caching large templates. Cache entries contain third-party media under its original license; your application remains responsible for permission, attribution, retention, and deletion policy.

## Capability detection

Use `detectSupport()` for a prospective output and `analyze()` once the real project is known:

```ts
const support = await yumcut.detectSupport({
  width: 2160,
  height: 3840,
  frameRate: 30,
  durationUs: secondsToUs(60),
  format: 'auto',
  runPerformanceProbe: true,
});

switch (support.status) {
  case 'supported':
    break;
  case 'degraded':
    console.warn(support.warnings);
    break;
  case 'unsupported':
    console.error(support.blockers);
    break;
}
```

`supported` means the required browser primitives and a requested encoder configuration are available. `degraded` means rendering can continue with a fallback or warning, such as Canvas 2D compositing or unavailable persistent storage. It is not a guarantee of real-time rendering. `unsupported` includes concrete blockers for the caller to show to the user.

`runPerformanceProbe` performs a small encoder sanity check. It can catch a broken implementation but cannot predict full-project throughput, device throttling, or memory pressure.

`analyze(project, options)` additionally inspects the actual sources and reports media metadata, codec decodability, trim/source-duration issues, HDR and GPU pre-scaling warnings, estimated output bytes, estimated temporary bytes, and available storage. Pass the same `format`, `quality`, bitrates, and output target class that you intend to use for `render()` so its encoder and storage decision matches the real job. Analysis may fetch source metadata or byte ranges.

## Inspect media

```ts
const info = await yumcut.inspect(fileOrUrl);

console.log({
  durationSeconds: usToSeconds(info.durationUs),
  codedSize: [info.width, info.height],
  displaySize: [info.displayWidth, info.displayHeight],
  rotation: info.rotationDegrees,
  pixelAspectRatio: info.pixelAspectRatio,
  videoCodec: info.videoCodec,
  audioCodec: info.audioCodec,
  hdr: info.hdr,
});
```

Display rotation and pixel aspect ratio are normalized during composition. HDR input is detected and currently rendered to SDR output with a degradation warning; HDR preservation is not part of the current output contract.

## Output and large renders

`render()` accepts:

- `output: 'blob'` for a convenient in-memory result.
- `output: 'auto'` to let the library choose between Blob and temporary browser-backed storage.
- `{ type: 'writable', writable }` for an application-provided `WritableStream<Uint8Array>`.
- `{ type: 'file', fileHandle }` for a File System Access API handle.

Blob output is convenient but the completed file must fit in available memory. Prefer a writable/file target for long or high-bitrate renders when the browser supports it. Every result reports where the completed artifact lives through `artifactStorage`:

- `memory`: `blob` contains an in-memory result. No release step is needed.
- `opfs`: automatic output selected an Origin Private File System file. `blob` is available for preview or download, and `release()` removes that result's backing file when you are finished with it.
- `external`: bytes were written to the supplied writable stream or file handle. The caller owns that destination and the result has no `blob`.

Keep an OPFS artifact while a preview, object URL, upload, or download is still reading it. Revoke object URLs and then release it:

```ts
const result = await yumcut.render(project, { output: 'auto' });
const preview = document.querySelector('video')!;

if (result.blob) {
  const previewUrl = URL.createObjectURL(result.blob);
  preview.src = previewUrl;

  // Call this after playback, upload, or download no longer needs the file.
  async function discardPreview() {
    preview.pause();
    preview.removeAttribute('src');
    preview.load();
    URL.revokeObjectURL(previewUrl);
    await result.release?.();
  }
}
```

`release()` is idempotent, including after bulk cleanup. Use `yumcut.cleanupTemporaryOutputs()` only to recover orphaned automatic outputs after a crash or abandoned page, and only when no render or returned OPFS result is active; it removes every auto-output file owned by the library on the current origin.

The default `quality: 'balanced'` bitrate is resolution/frame-rate aware. `quality: 'high'`, `videoBitrate`, and `audioBitrate` let callers trade size, speed, and quality. A higher bitrate does not make a slow device faster and cannot restore detail missing from a source.

Automatic format selection prefers MP4 when the requested H.264/AAC encoder pair is available, then WebM with VP9/Opus. Use `format: 'mp4'` or `format: 'webm'` when your delivery pipeline requires a particular container; the render will fail clearly if the browser cannot produce it.

`result.durationUs` is the requested composition timeline. Some browser audio encoders add codec priming or a final AAC/Opus frame, so a media element or probe may report a container duration a few audio frames longer even though the video track ends at the requested time.

## Progress, cancellation, and errors

Progress stages are `fetching`, `analyzing`, `decoding`, `composing`, `encoding`, and `finalizing`. Overall `progress` is always in the range `0..1`.

```ts
import { isYumCutVideoAdsError } from 'yumcut-video-ads';

try {
  await yumcut.render(project, { signal, onProgress });
} catch (error) {
  if (isYumCutVideoAdsError(error)) {
    console.error(error.code, error.message, error.details);
  } else {
    throw error;
  }
}
```

Stable codes cover CORS/fetch failures, unsupported codecs, invalid projects/timelines, insufficient storage, decode/encode failures, GPU context loss, cancellation, corrupt media, cache failures, and unsupported environments. Cancellation and failure release active frames, decoders, encoders, textures, and partial temporary resources. `dispose()` cancels active work and releases session resources, but deliberately does not delete completed OPFS results that the caller may still be reading; release those results explicitly or use orphan cleanup later.

## Browser and mobile guidance

Current Chromium desktop is the primary target. Firefox, Safari, Android, and iOS support varies by OS/browser version, codec, output size, and device. Do not infer support from a user-agent string; show the result of `detectSupport()` for the intended profile.

For mobile browsers:

- Start with 720p or 1080p at 30 fps and analyze before offering larger presets.
- Prefer shorter projects and writable output where supported.
- Expect backgrounding, thermal throttling, low-power mode, and storage pressure to interrupt a render.
- Keep the page visible and prevent the device from sleeping where your product and platform allow it.
- Treat 4K support as device-specific even when codec configuration succeeds.

The library bounds decoded frames and encoder queue depth, closes browser media resources promptly, and performs composition in a worker. Those measures reduce peak memory; they cannot override browser process limits.

## Performance measurement

`RenderResult.stats` reports measured elapsed time, frames encoded/dropped, bytes written, and available decode/compose/encode timing. Record these values on representative customer devices and content. There is no universal “real-time” claim: remote fetch behavior, input codecs, overlay count, output codec, resolution, GPU, encoder, and power state all matter.

For meaningful comparisons, keep the same browser version, machine power mode, source files, output dimensions, frame rate, and bitrates. Warm and cold HTTP/cache runs should be reported separately.

The checked-in [browser baseline](./benchmarks/chromium-macos-arm64-2026-07-10.json) records the real mixed-media workload plus 360p, 720p, 1080p, 4K, and five-minute 4K qualification. See [benchmark instructions](./benchmarks/README.md) for the opt-in long-run commands and comparison caveats.

## Playground and development

These commands apply to a repository checkout. The published package contains the runtime, declarations, documentation, and benchmark records, not the development playground or tests.

```sh
npm install
npm run dev
```

Open the printed localhost URL. The playground can use a CORS-enabled template URL or local template file, add local video/image/audio overlays, prefetch and clear a persistent template cache, inspect support, analyze the concrete project, render, preview the result, and show measured stats.

```sh
npm run typecheck
npm run test:unit
npm run verify:media
npm run build
npm run test:browser
npm run build:demos
npm run test:demos
# Or run the complete sequence:
npm run test:all
```

`test:demos` performs fresh locked installs and production builds for Next.js,
React/Vite, and vanilla Vite before opening them in Chromium. Browser and
benchmark tests can optionally download the pinned full source movie, which is
ignored by Git and never included in the npm package. Test results on one machine
are regression data, not a performance guarantee for another device.

## Content licensing and privacy

The package is MIT-licensed; media passed to it is not. You are responsible for
the rights to download, cache, transform, publish, and distribute every template
and overlay. Preserve required credits for Creative Commons or stock content and
do not assume that “free to use” permits advertising, modification, or
redistribution.

The checked-in demo videos are attributed CC BY 3.0 derivatives with audio
removed. Demo music is generated from synthetic tones. Exact sources, changes,
license links, and checksums are in [`MEDIA_LICENSES.md`](./MEDIA_LICENSES.md) and
[`test/fixtures/manifest.json`](./test/fixtures/manifest.json). The npm package's
`files` allowlist excludes demos and fixtures, so no sample media is shipped to
npm consumers.

YumCut Video Ads has no telemetry, account system, analytics endpoint, or render
service. `File` and `Blob` inputs stay inside the current browser process. Output
is returned in memory, written to an application-provided destination, or stored
temporarily in origin-private browser storage according to the requested output
mode.

Network activity happens only when your application supplies a URL. That request
reveals the normal HTTP metadata to its host and can send credentials only when
you explicitly configure them. Persistent Cache Storage is restricted to public,
header-free assets and forces `credentials: 'omit'`; authenticated media stays on
the normal browser-fetch path. Do not put long-lived secrets in URLs. Revoke
preview object URLs, call `result.release()` for temporary OPFS results, and offer
cache deletion controls when your product retains downloaded templates.

## License

`yumcut-video-ads` is MIT-licensed. Distributed bundles include Mediabunny under
MPL-2.0; see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
