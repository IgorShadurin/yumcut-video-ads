import { expect, test } from 'playwright/test';

test('mobile browser receives a concrete capability decision and renders when supported', async ({ page }) => {
  await page.goto('/test/browser/harness/');
  await page.waitForFunction(() => 'videoAdsRuntime' in window);

  const evidence = await page.evaluate(async () => {
    const { createVideoAds, secondsToUs } = window.videoAdsRuntime;
    const videoAds = createVideoAds();
    try {
      const durationUs = secondsToUs(0.5);
      const support = await videoAds.detectSupport({
        width: 720,
        height: 1280,
        frameRate: 30,
        durationUs,
        format: 'auto',
        includeAudio: false,
        runPerformanceProbe: true,
      });
      let render: { width: number; height: number; frames: number; size: number } | undefined;
      if (support.supported) {
        const result = await videoAds.render({
          id: 'mobile-capability-render',
          output: { width: 720, height: 1280, frameRate: 30, durationUs, background: '#13223a' },
          tracks: [{
            type: 'visual',
            clips: [{
              type: 'text',
              text: 'MOBILE READY',
              startUs: 0,
              durationUs,
              box: { x: 0.08, y: 0.4, width: 0.84, height: 0.2 },
              style: { fontSize: 52, fontWeight: 800, color: '#ffffff' },
            }],
          }],
        }, { output: 'blob', format: 'auto' });
        render = {
          width: result.width,
          height: result.height,
          frames: result.stats.framesEncoded,
          size: result.fileSize,
        };
      }
      return {
        status: support.status,
        supported: support.supported,
        blockers: support.blockers,
        encoderProbe: support.encoderProbe?.status,
        coarsePointer: matchMedia('(pointer: coarse)').matches,
        render,
      };
    } finally {
      videoAds.dispose();
    }
  });

  expect(['supported', 'degraded', 'unsupported']).toContain(evidence.status);
  expect(evidence.coarsePointer).toBe(true);
  if (evidence.supported) {
    expect(evidence.encoderProbe).toBe('passed');
    expect(evidence.render).toMatchObject({ width: 720, height: 1280, frames: 15 });
    expect(evidence.render!.size).toBeGreaterThan(1_000);
  } else {
    expect(evidence.blockers.length).toBeGreaterThan(0);
  }
});
