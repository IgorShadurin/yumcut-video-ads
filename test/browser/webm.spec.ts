import { expect, test } from 'playwright/test';

test('renders a real VP9/Opus WebM when that exact profile is supported', async ({ page }) => {
  await page.goto('/test/browser/harness/');
  await page.waitForFunction(() => 'videoAdsRuntime' in window);

  const evidence = await page.evaluate(async () => {
    const { createVideoAds, secondsToUs } = window.videoAdsRuntime;
    const videoAds = createVideoAds();
    const durationUs = secondsToUs(0.5);
    try {
      const support = await videoAds.detectSupport({
        width: 320,
        height: 180,
        frameRate: 30,
        durationUs,
        format: 'webm',
        includeAudio: true,
      });
      if (!support.supported) return { supported: false, blockers: support.blockers };
      const result = await videoAds.render({
        id: 'forced-webm',
        output: { width: 320, height: 180, frameRate: 30, durationUs, background: '#17345c' },
        tracks: [
          {
            type: 'visual',
            clips: [{
              type: 'text',
              text: 'WEBM',
              startUs: 0,
              durationUs,
              style: { fontSize: 42, fontWeight: 800, color: '#ffffff' },
            }],
          },
          {
            type: 'audio',
            clips: [{
              type: 'audio',
              source: '/test/fixtures/media/yumcut-demo-music.ogg',
              startUs: 0,
              durationUs,
            }],
          },
        ],
      }, { format: 'webm', output: 'blob' });
      if (!result.blob) throw new Error('WebM render returned no Blob.');
      const url = URL.createObjectURL(result.blob);
      const video = document.createElement('video');
      video.src = url;
      await new Promise<void>((resolve, reject) => {
        video.addEventListener('loadedmetadata', () => resolve(), { once: true });
        video.addEventListener('error', () => reject(video.error), { once: true });
      });
      const preview = { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
      URL.revokeObjectURL(url);
      return {
        supported: true,
        format: result.format,
        mimeType: result.mimeType,
        size: result.fileSize,
        frames: result.stats.framesEncoded,
        preview,
      };
    } finally {
      videoAds.dispose();
    }
  });

  expect(evidence.supported, 'Exact WebM profile should be supported in qualification Chromium.').toBe(true);
  if (!evidence.supported) return;
  expect(evidence.format).toBe('webm');
  expect(evidence.mimeType).toMatch(/^video\/webm/u);
  expect(evidence.size).toBeGreaterThan(1_000);
  expect(evidence.frames).toBe(15);
  expect(evidence.preview).toMatchObject({ width: 320, height: 180 });
  expect(evidence.preview!.duration).toBeGreaterThan(0.45);
});
