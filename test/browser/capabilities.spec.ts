import { expect, test } from 'playwright/test';

test('inspects, caches, analyzes, renders portrait, and cancels cleanly', async ({ page }) => {
  await page.goto('/test/browser/harness/');
  await page.waitForFunction(() => 'videoAdsRuntime' in window);

  const evidence = await page.evaluate(async () => {
    const runtime = window.videoAdsRuntime;
    const { createVideoAds, secondsToUs } = runtime;
    const videoAds = createVideoAds();
    const templateUrl = new URL('/test/fixtures/media/bunny-template.mp4', location.href).href;
    const posterUrl = new URL('/test/fixtures/media/bunny-poster.jpg', location.href).href;

    try {
      const cached = await videoAds.cache.prefetch(templateUrl);
      const cacheEstimate = await videoAds.cache.estimate();
      const media = await videoAds.inspect({ type: 'url', url: templateUrl, cache: 'persistent' });
      const durationUs = secondsToUs(1);
      const project: import('../../src/index').Project = {
        id: 'portrait-browser-check',
        output: {
          width: 360,
          height: 640,
          frameRate: 30,
          durationUs,
          background: { type: 'blur', blurRadius: 20, dim: 0.18, fallbackColor: '#172033' },
        },
        tracks: [
          {
            type: 'visual',
            clips: [{
              type: 'video',
              source: { type: 'url', url: templateUrl, cache: 'persistent' },
              startUs: 0,
              durationUs,
              trimStartUs: secondsToUs(0.5),
              fit: 'cover',
              focalPoint: { x: 0.47, y: 0.5 },
              muted: true,
            }],
          },
          {
            type: 'visual',
            clips: [{
              type: 'image',
              source: posterUrl,
              startUs: 0,
              durationUs,
              box: { x: 0.12, y: 0.08, width: 0.76, height: 0.27 },
              fit: 'cover',
              transitionIn: { type: 'fade', durationUs: secondsToUs(0.2) },
            }],
          },
          {
            type: 'visual',
            clips: [{
              type: 'text',
              text: 'PORTRAIT READY',
              startUs: 0,
              durationUs,
              box: { x: 0.08, y: 0.74, width: 0.84, height: 0.13 },
              style: {
                fontSize: 26,
                fontWeight: 800,
                color: '#ffffff',
                backgroundColor: 'rgba(0,0,0,0.58)',
                padding: 8,
                textAlign: 'center',
                verticalAlign: 'middle',
              },
            }],
          },
        ],
      };

      const analysis = await videoAds.analyze(project);
      const result = await videoAds.render(project, { output: 'blob', format: 'auto' });
      if (!result.blob) throw new Error('Portrait render returned no Blob.');
      const url = URL.createObjectURL(result.blob);
      const video = document.createElement('video');
      video.muted = true;
      video.src = url;
      await new Promise<void>((resolve, reject) => {
        video.addEventListener('loadeddata', () => resolve(), { once: true });
        video.addEventListener('error', () => reject(video.error), { once: true });
      });
      video.currentTime = 0.55;
      await new Promise<void>((resolve) => video.addEventListener('seeked', () => resolve(), { once: true }));
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Canvas unavailable.');
      context.drawImage(video, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const points = [
        0,
        (canvas.width - 1) * 4,
        ((canvas.height - 1) * canvas.width) * 4,
        ((canvas.height * canvas.width) - 1) * 4,
      ];
      const cornerBrightness = points.map((offset) =>
        (pixels[offset] ?? 0) + (pixels[offset + 1] ?? 0) + (pixels[offset + 2] ?? 0));
      URL.revokeObjectURL(url);

      const opfsRoot = await navigator.storage.getDirectory();
      const opfsName = 'yumcut-video-ads-playwright-output.mp4';
      const opfsHandle = await opfsRoot.getFileHandle(opfsName, { create: true });
      const shortDurationUs = secondsToUs(0.5);
      const fileResult = await videoAds.render({
        ...project,
        id: 'opfs-file-check',
        output: { ...project.output, durationUs: shortDurationUs },
        tracks: project.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) => ({ ...clip, durationUs: shortDurationUs })),
        })) as import('../../src/index').Project['tracks'],
      }, { output: { type: 'file', fileHandle: opfsHandle }, format: 'mp4' });
      const opfsFile = await opfsHandle.getFile();
      await opfsRoot.removeEntry(opfsName);

      const appendChunks: Uint8Array[] = [];
      const writable = new WritableStream<Uint8Array>({
        write(chunk) {
          appendChunks.push(chunk.slice());
        },
      });
      const appendDurationUs = secondsToUs(0.25);
      const appendResult = await videoAds.render({
        ...project,
        id: 'append-stream-check',
        output: { ...project.output, durationUs: appendDurationUs },
        tracks: project.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) => ({ ...clip, durationUs: appendDurationUs })),
        })) as import('../../src/index').Project['tracks'],
      }, { output: { type: 'writable', writable }, format: 'mp4' });
      const appendBytes = appendChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const appendPrefix = appendChunks[0]
        ? new TextDecoder().decode(appendChunks[0].subarray(4, 8))
        : '';

      const abortController = new AbortController();
      let cancellationCode: string | undefined;
      try {
        await videoAds.render({
          ...project,
          id: 'cancel-check',
          output: { ...project.output, durationUs: secondsToUs(2) },
          tracks: project.tracks.map((track) => ({
            ...track,
            clips: track.clips.map((clip) => ({ ...clip, durationUs: secondsToUs(2) })),
          })) as import('../../src/index').Project['tracks'],
        }, {
          output: 'blob',
          signal: abortController.signal,
          onProgress(progress) {
            if (progress.stage === 'encoding' && progress.progress > 0.1) abortController.abort('browser cancellation test');
          },
        });
      } catch (error) {
        cancellationCode = typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : 'unknown';
      }

      const finalizingController = new AbortController();
      let finalizationCancellationCode: string | undefined;
      try {
        await videoAds.render({
          ...project,
          id: 'finalizing-cancel-check',
          output: { ...project.output, durationUs: secondsToUs(0.25) },
          tracks: project.tracks.map((track) => ({
            ...track,
            clips: track.clips.map((clip) => ({ ...clip, durationUs: secondsToUs(0.25) })),
          })) as import('../../src/index').Project['tracks'],
        }, {
          output: 'blob',
          signal: finalizingController.signal,
          onProgress(progress) {
            if (progress.stage === 'finalizing') finalizingController.abort('finalizing cancellation test');
          },
        });
      } catch (error) {
        finalizationCancellationCode = typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : 'unknown';
      }

      const removed = await videoAds.cache.remove(templateUrl);
      return {
        cachedSize: cached.sizeBytes,
        cacheEntries: cacheEstimate.entries,
        media,
        analysisStatus: analysis.status,
        analysisMediaCount: analysis.media.length,
        result: {
          format: result.format,
          width: result.width,
          height: result.height,
          durationUs: result.durationUs,
          fileSize: result.fileSize,
          frames: result.stats.framesEncoded,
        },
        preview: { width: video.videoWidth, height: video.videoHeight, duration: video.duration },
        cornerBrightness,
        fileOutput: {
          resultSize: fileResult.fileSize,
          actualSize: opfsFile.size,
          hasBlob: fileResult.blob !== undefined,
        },
        appendOutput: {
          resultSize: appendResult.fileSize,
          actualSize: appendBytes,
          prefix: appendPrefix,
          chunks: appendChunks.length,
        },
        cancellationCode,
        finalizationCancellationCode,
        removed,
      };
    } finally {
      videoAds.dispose();
    }
  });

  expect(evidence.cachedSize).toBeGreaterThan(50_000);
  expect(evidence.cacheEntries).toBeGreaterThanOrEqual(1);
  expect(evidence.media.hasVideo).toBe(true);
  expect(evidence.media.durationUs).toBeGreaterThanOrEqual(3_900_000);
  expect(['supported', 'degraded']).toContain(evidence.analysisStatus);
  expect(evidence.analysisMediaCount).toBe(2);
  expect(evidence.result.width).toBe(360);
  expect(evidence.result.height).toBe(640);
  expect(evidence.result.durationUs).toBe(1_000_000);
  expect(evidence.result.frames).toBe(30);
  expect(evidence.result.fileSize).toBeGreaterThan(10_000);
  expect(evidence.preview.width).toBe(360);
  expect(evidence.preview.height).toBe(640);
  expect(evidence.cornerBrightness.every((brightness) => brightness > 15)).toBe(true);
  expect(evidence.fileOutput.resultSize).toBeGreaterThan(5_000);
  expect(evidence.fileOutput.actualSize).toBe(evidence.fileOutput.resultSize);
  expect(evidence.fileOutput.hasBlob).toBe(false);
  expect(evidence.appendOutput.resultSize).toBeGreaterThan(2_000);
  expect(evidence.appendOutput.actualSize).toBe(evidence.appendOutput.resultSize);
  expect(evidence.appendOutput.prefix).toBe('ftyp');
  expect(evidence.appendOutput.chunks).toBeGreaterThan(0);
  expect(evidence.cancellationCode).toBe('ABORTED');
  expect(evidence.finalizationCancellationCode).toBe('ABORTED');
  expect(evidence.removed).toBe(true);
});
