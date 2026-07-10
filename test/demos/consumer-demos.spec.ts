import { resolve } from 'node:path';
import { expect, test, type Locator, type Page, type TestInfo } from 'playwright/test';

const FIXTURES = {
  video: resolve('test/fixtures/media/bunny-square.webm'),
  music: resolve('test/fixtures/media/yumcut-demo-music.ogg'),
};

interface RuntimeErrors {
  console: string[];
  page: string[];
}

async function watchRuntimeErrors(page: Page): Promise<RuntimeErrors> {
  const errors: RuntimeErrors = { console: [], page: [] };
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const url = message.location().url;
      errors.console.push(url ? `${message.text()} (${url})` : message.text());
    }
  });
  page.on('pageerror', (error) => errors.page.push(error.message));
  return errors;
}

function expectNoRuntimeErrors(errors: RuntimeErrors): void {
  expect(errors.page, `Uncaught page errors:\n${errors.page.join('\n')}`).toEqual([]);
  expect(errors.console, `Console errors:\n${errors.console.join('\n')}`).toEqual([]);
}

async function readPlayableVideo(video: Locator): Promise<{
  duration: number;
  width: number;
  height: number;
  before: number;
  after: number;
  readyState: number;
}> {
  await expect(video).toBeVisible();
  return video.evaluate(async (element: HTMLVideoElement) => {
    if (element.readyState < HTMLMediaElement.HAVE_METADATA) {
      await new Promise<void>((resolveMetadata, rejectMetadata) => {
        const timeout = window.setTimeout(
          () => rejectMetadata(new Error('Timed out waiting for rendered video metadata.')),
          20_000,
        );
        element.addEventListener('loadedmetadata', () => {
          window.clearTimeout(timeout);
          resolveMetadata();
        }, { once: true });
        element.addEventListener('error', () => {
          window.clearTimeout(timeout);
          rejectMetadata(new Error(element.error?.message ?? 'Rendered video failed to load.'));
        }, { once: true });
        element.load();
      });
    }

    element.muted = true;
    element.currentTime = Math.min(0.1, Math.max(0, element.duration / 4));
    if (element.seeking) {
      await new Promise<void>((resolveSeek) => element.addEventListener('seeked', () => resolveSeek(), { once: true }));
    }
    const before = element.currentTime;
    await element.play();
    await new Promise((resolvePlayback) => window.setTimeout(resolvePlayback, 350));
    element.pause();

    return {
      duration: element.duration,
      width: element.videoWidth,
      height: element.videoHeight,
      before,
      after: element.currentTime,
      readyState: element.readyState,
    };
  });
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test('vanilla TypeScript demo accepts media and renders a playable bundled composition', async ({ page }, testInfo) => {
  const errors = await watchRuntimeErrors(page);
  await page.goto('http://127.0.0.1:4191/');
  await expect(page.getByRole('heading', { name: /Turn a template into/i })).toBeVisible();

  const template = page.locator('#template-select');
  await expect(template.locator('option')).toHaveCount(3);
  for (const value of ['/media/bunny-template.mp4', '/media/bunny-square.webm', '/media/bunny-4k.mp4']) {
    await template.selectOption(value);
    await expect(page.locator('#template-preview')).toHaveAttribute('src', value);
  }

  await expect(page.locator('#overlay-video')).toHaveAttribute('accept', /video/);
  await page.locator('#overlay-video').setInputFiles(FIXTURES.video);
  await expect(page.locator('#overlay-video-name')).toContainText('bunny-square.webm');
  await expect(page.locator('#music-file')).toHaveAttribute('accept', /audio/);
  await page.locator('#music-file').setInputFiles(FIXTURES.music);
  await expect(page.locator('#music-file-name')).toContainText('yumcut-demo-music.ogg');
  await attachScreenshot(page, testInfo, 'vanilla-upload-controls');

  await page.locator('#orientation').selectOption('square');
  await page.locator('#resolution').selectOption('720');
  await expect(page.locator('#output-summary')).toContainText('720 × 720');
  await page.locator('#render-button').click();

  const resultVideo = page.locator('#result-video');
  await expect(resultVideo).toHaveClass(/ready/, { timeout: 240_000 });
  await expect(page.locator('#progress-stage')).toHaveText('Render complete');
  await expect(page.locator('#progress')).toHaveJSProperty('value', 1);
  await expect(page.locator('#download-link')).not.toHaveClass(/disabled/);
  const metadata = await readPlayableVideo(resultVideo);
  expect(metadata.width).toBe(720);
  expect(metadata.height).toBe(720);
  expect(metadata.duration).toBeGreaterThan(0.8);
  expect(metadata.readyState).toBeGreaterThanOrEqual(2);
  expect(metadata.after).toBeGreaterThan(metadata.before);
  await attachScreenshot(page, testInfo, 'vanilla-render-complete');
  expectNoRuntimeErrors(errors);
});

test('React 19 + Vite demo accepts media and renders a playable bundled composition', async ({ page }, testInfo) => {
  const errors = await watchRuntimeErrors(page);
  await page.goto('http://127.0.0.1:4192/');
  await expect(page.getByTestId('react-vite-demo')).toBeVisible();

  const templates = [
    { name: 'Classic motion', preview: /Classic motion template preview/ },
    { name: 'Social square', preview: /Social square template preview/ },
    { name: 'High-detail source', preview: /High-detail source template preview/ },
  ];
  for (const choice of templates) {
    const radio = page.getByRole('radio', { name: choice.name });
    await radio.click();
    await expect(radio).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('template-preview')).toHaveAttribute('aria-label', choice.preview);
  }

  await expect(page.locator('#video-upload')).toHaveAttribute('accept', /video/);
  await page.locator('#video-upload').setInputFiles(FIXTURES.video);
  await expect(page.locator('label[for="video-upload"]').getByText('bunny-square.webm', { exact: true })).toBeVisible();
  await expect(page.locator('#music-upload')).toHaveAttribute('accept', /audio/);
  await page.locator('#music-upload').setInputFiles(FIXTURES.music);
  await expect(page.locator('label[for="music-upload"]').getByText('yumcut-demo-music.ogg', { exact: true })).toBeVisible();
  await attachScreenshot(page, testInfo, 'react-upload-controls');

  await page.getByRole('radio', { name: '16:9 Landscape' }).check();
  await page.getByRole('radio', { name: 'Fast HD' }).check();
  await page.getByRole('button', { name: /Render my video/i }).click();

  const resultVideo = page.getByTestId('result-video');
  await expect(resultVideo).toBeVisible({ timeout: 240_000 });
  await expect(page.getByRole('progressbar', { name: 'Render progress' })).toHaveJSProperty('value', 1);
  await expect(page.getByRole('link', { name: /Download video/i })).toHaveAttribute('href', /^blob:/);
  const metadata = await readPlayableVideo(resultVideo);
  expect(metadata.width).toBe(1280);
  expect(metadata.height).toBe(720);
  expect(metadata.duration).toBeGreaterThan(0.8);
  expect(metadata.readyState).toBeGreaterThanOrEqual(2);
  expect(metadata.after).toBeGreaterThan(metadata.before);
  await attachScreenshot(page, testInfo, 'react-render-complete');
  expectNoRuntimeErrors(errors);
});

test('Next.js App Router demo accepts media and renders a playable bundled composition', async ({ page }, testInfo) => {
  const errors = await watchRuntimeErrors(page);
  await page.goto('http://127.0.0.1:4193/');
  await expect(page.getByRole('heading', { name: /Turn a template into a finished ad/i })).toBeVisible();

  const template = page.getByTestId('template-select');
  await expect(template.locator('option')).toHaveCount(3);
  for (const choice of [
    { value: 'classic', preview: /Preview Bunny classic/ },
    { value: 'square', preview: /Preview Bunny social square/ },
    { value: '4k', preview: /Preview Bunny 4K surface/ },
  ]) {
    await template.selectOption(choice.value);
    await expect(page.getByLabel(choice.preview)).toBeVisible();
  }

  await expect(page.getByTestId('overlay-input')).toHaveAttribute('accept', /video/);
  await page.getByTestId('overlay-input').setInputFiles(FIXTURES.video);
  await expect(page.getByText('bunny-square.webm', { exact: true })).toBeVisible();
  await expect(page.getByTestId('music-input')).toHaveAttribute('accept', /audio/);
  await page.getByTestId('music-input').setInputFiles(FIXTURES.music);
  await expect(page.getByText('yumcut-demo-music.ogg', { exact: true })).toBeVisible();
  await attachScreenshot(page, testInfo, 'next-upload-controls');

  await expect(page.getByTestId('render-button')).toBeEnabled({ timeout: 30_000 });
  await page.getByRole('radio', { name: 'square' }).check();
  await page.getByLabel('Resolution').selectOption('quick');
  await page.getByTestId('render-button').click();

  const resultVideo = page.getByTestId('result-preview');
  await expect(resultVideo).toBeVisible({ timeout: 240_000 });
  await expect(page.getByTestId('progress')).toHaveJSProperty('value', 1);
  await expect(page.getByTestId('notice')).toContainText('Render complete');
  await expect(page.getByTestId('download-link')).toHaveAttribute('href', /^blob:/);
  const metadata = await readPlayableVideo(resultVideo);
  expect(metadata.width).toBe(360);
  expect(metadata.height).toBe(360);
  expect(metadata.duration).toBeGreaterThan(0.8);
  expect(metadata.readyState).toBeGreaterThanOrEqual(2);
  expect(metadata.after).toBeGreaterThan(metadata.before);
  await attachScreenshot(page, testInfo, 'next-render-complete');
  expectNoRuntimeErrors(errors);
});

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const layout = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
}

async function expectMobileControl(page: Page, control: Locator): Promise<void> {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(391);
}

test.describe('mobile viewport smoke', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test('vanilla controls fit and browser support resolves', async ({ page }, testInfo) => {
    const errors = await watchRuntimeErrors(page);
    await page.goto('http://127.0.0.1:4191/');
    await expectMobileControl(page, page.locator('#template-select'));
    await expectMobileControl(page, page.locator('label[for="overlay-video"]'));
    await expectMobileControl(page, page.locator('#render-button'));
    await page.locator('#support-button').click();
    await expect(page.locator('#progress-stage')).toHaveText('Check complete', { timeout: 60_000 });
    await expect(page.locator('#status-pill')).not.toHaveText('Not checked');
    await expectNoHorizontalOverflow(page);
    await attachScreenshot(page, testInfo, 'vanilla-mobile');
    expectNoRuntimeErrors(errors);
  });

  test('React controls fit and browser support resolves', async ({ page }, testInfo) => {
    const errors = await watchRuntimeErrors(page);
    await page.goto('http://127.0.0.1:4192/');
    await expectMobileControl(page, page.getByRole('radiogroup', { name: 'Video template' }));
    await expectMobileControl(page, page.locator('label[for="video-upload"]'));
    await expectMobileControl(page, page.getByRole('button', { name: /Render my video/i }));
    await page.getByRole('button', { name: 'Check browser' }).click();
    await expect(page.locator('.status-head strong')).toHaveText(/Browser ready|Needs attention/, { timeout: 60_000 });
    await expectNoHorizontalOverflow(page);
    await attachScreenshot(page, testInfo, 'react-mobile');
    expectNoRuntimeErrors(errors);
  });

  test('Next.js controls fit and browser support resolves', async ({ page }, testInfo) => {
    const errors = await watchRuntimeErrors(page);
    await page.goto('http://127.0.0.1:4193/');
    await expect(page.getByTestId('render-button')).toBeEnabled({ timeout: 30_000 });
    await expectMobileControl(page, page.getByTestId('template-select'));
    await expectMobileControl(page, page.getByTestId('overlay-input').locator('..'));
    await expectMobileControl(page, page.getByTestId('render-button'));
    await page.getByRole('button', { name: 'Check this browser' }).click();
    await expect(page.getByTestId('notice')).toContainText(/Support check complete|unsupported/, { timeout: 60_000 });
    await expectNoHorizontalOverflow(page);
    await attachScreenshot(page, testInfo, 'next-mobile');
    expectNoRuntimeErrors(errors);
  });
});
