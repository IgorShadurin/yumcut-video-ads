import { writeFile } from 'node:fs/promises';
import { expect, test, type Page } from 'playwright/test';

interface BrowserHarness {
  checkSupport(): Promise<{
    supported: boolean;
    status: string;
    blockers: readonly string[];
    recommendedOutput?: { format: string };
  }>;
  render(): Promise<{
    status: string;
    result: {
      format: string;
      mimeType: string;
      width: number;
      height: number;
      durationUs: number;
      fileSize: number;
      stats: { elapsedMs: number; framesEncoded: number; framesDropped: number; bytesWritten: number };
    } | null;
    preview: { duration: number; videoWidth: number; videoHeight: number; readyState: number } | null;
    progress: Array<{ stage: string; progress: number }>;
    error: string | null;
  }>;
  resultDataUrl(): Promise<string>;
}

async function openHarness(page: Page): Promise<void> {
  await page.goto('/test/browser/harness/');
  await page.waitForFunction(() => 'videoAdsHarness' in window);
}

test('renders, previews, and persists a real mixed-media composition', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await openHarness(page);

  const support = await page.evaluate(() =>
    (window as Window & { videoAdsHarness: BrowserHarness }).videoAdsHarness.checkSupport(),
  );
  expect(support.supported, support.blockers.join('\n')).toBe(true);
  expect(['supported', 'degraded']).toContain(support.status);

  const state = await page.evaluate(() =>
    (window as Window & { videoAdsHarness: BrowserHarness }).videoAdsHarness.render(),
  );
  expect(state.error).toBeNull();
  expect(state.status).toBe('complete');
  expect(state.result).not.toBeNull();
  expect(state.preview).not.toBeNull();

  const result = state.result!;
  const preview = state.preview!;
  expect(['mp4', 'webm']).toContain(result.format);
  expect(result.mimeType).toMatch(/^video\/(?:mp4|webm)/u);
  expect(result.width).toBe(640);
  expect(result.height).toBe(360);
  expect(result.durationUs).toBe(2_500_000);
  expect(result.fileSize).toBeGreaterThan(10_000);
  expect(result.stats.framesEncoded).toBe(75);
  expect(result.stats.framesDropped).toBe(0);
  expect(result.stats.bytesWritten).toBe(result.fileSize);
  expect(preview.videoWidth).toBe(640);
  expect(preview.videoHeight).toBe(360);
  expect(preview.duration).toBeGreaterThanOrEqual(2.4);
  expect(preview.duration).toBeLessThanOrEqual(2.65);
  expect(state.progress.at(-1)?.progress).toBe(1);
  expect(state.progress.some(({ stage }) => stage === 'encoding')).toBe(true);
  expect(pageErrors).toEqual([]);

  const playback = await page.locator('#preview').evaluate(async (video: HTMLVideoElement) => {
    video.muted = true;
    video.currentTime = Math.min(0.8, video.duration / 3);
    await new Promise<void>((resolve) => video.addEventListener('seeked', () => resolve(), { once: true }));
    const before = video.currentTime;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 350));
    video.pause();
    return { before, after: video.currentTime, readyState: video.readyState };
  });
  expect(playback.readyState).toBeGreaterThanOrEqual(2);
  expect(playback.after).toBeGreaterThan(playback.before);

  const visualSample = await page.locator('#preview').evaluate((video: HTMLVideoElement) => {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas 2D unavailable in visual check.');
    context.drawImage(video, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    let colored = 0;
    let samples = 0;
    for (let index = 0; index < pixels.length; index += 64) {
      const r = pixels[index] ?? 0;
      const g = pixels[index + 1] ?? 0;
      const b = pixels[index + 2] ?? 0;
      if (r + g + b < 30) dark += 1;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 12) colored += 1;
      samples += 1;
    }
    return { darkRatio: dark / samples, coloredRatio: colored / samples };
  });
  expect(visualSample.darkRatio).toBeLessThan(0.9);
  expect(visualSample.coloredRatio).toBeGreaterThan(0.03);

  const dataUrl = await page.evaluate(() =>
    (window as Window & { videoAdsHarness: BrowserHarness }).videoAdsHarness.resultDataUrl(),
  );
  const comma = dataUrl.indexOf(',');
  expect(comma).toBeGreaterThan(0);
  const output = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  expect(output.byteLength).toBe(result.fileSize);
  const outputPath = testInfo.outputPath(`mixed-media.${result.format}`);
  await writeFile(outputPath, output);
  await testInfo.attach('rendered-video', { path: outputPath, contentType: result.mimeType });

  const screenshotPath = testInfo.outputPath('rendered-frame.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach('rendered-frame', { path: screenshotPath, contentType: 'image/png' });

  await expect(page.locator('body')).toHaveAttribute('data-state', 'complete');
  await expect(page.locator('#metric-format')).toHaveText(result.format.toUpperCase());
  await expect(page.locator('#progress')).toHaveJSProperty('value', 1);
});
