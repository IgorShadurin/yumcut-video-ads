import { resolve } from 'node:path';
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from 'playwright/test';

const FIXTURES = {
  video: resolve('test/fixtures/media/bunny-square.webm'),
  music: resolve('test/fixtures/media/yumcut-demo-music.ogg'),
};

interface RuntimeErrors {
  console: string[];
  page: string[];
}

interface DemoCheck {
  prefix: '/nextjs/' | '/react/' | '/vanilla/';
  ready(page: Page): Promise<void>;
  upload(page: Page): Promise<void>;
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

async function requestWithoutRedirect(
  request: APIRequestContext,
  path: string,
): Promise<void> {
  const response = await request.get(path, { maxRedirects: 0 });
  expect(response.status(), path).toBe(308);
  expect(response.headers().location, path).toBe(`${path}/`);
}

async function expectMime(
  request: APIRequestContext,
  path: string,
  mime: RegExp,
): Promise<void> {
  const response = await request.head(path);
  expect(response.status(), path).toBe(200);
  expect(response.headers()['content-type'], path).toMatch(mime);
  expect(response.headers()['x-content-type-options'], path).toBe('nosniff');
}

async function expectPlayableVideo(video: Locator): Promise<{
  duration: number;
  width: number;
  height: number;
}> {
  await expect(video).toBeVisible();
  return video.evaluate(async (element: HTMLVideoElement) => {
    if (element.readyState < HTMLMediaElement.HAVE_METADATA) {
      await new Promise<void>((resolveMetadata, rejectMetadata) => {
        const timeout = window.setTimeout(
          () => rejectMetadata(new Error('Timed out waiting for result metadata.')),
          20_000,
        );
        element.addEventListener('loadedmetadata', () => {
          window.clearTimeout(timeout);
          resolveMetadata();
        }, { once: true });
        element.addEventListener('error', () => {
          window.clearTimeout(timeout);
          rejectMetadata(new Error(element.error?.message ?? 'Result video failed to load.'));
        }, { once: true });
        element.load();
      });
    }
    return {
      duration: element.duration,
      width: element.videoWidth,
      height: element.videoHeight,
    };
  });
}

test('serves the hub, canonical routes, strict assets, and range-capable media', async ({ page, request }) => {
  const errors = await watchRuntimeErrors(page);
  const health = await request.get('/healthz');
  expect(health.status()).toBe(200);
  expect(await health.text()).toBe('ok\n');
  expect(health.headers()['cache-control']).toContain('no-store');

  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Build the cut/i })).toBeVisible();
  await expect(page.locator('main a[href="/nextjs/"]')).toBeVisible();
  await expect(page.locator('main a[href="/react/"]')).toBeVisible();
  await expect(page.locator('main a[href="/vanilla/"]')).toBeVisible();
  await expect(page.locator('a[href="/media/"]')).toBeVisible();
  expectNoRuntimeErrors(errors);

  for (const path of ['/nextjs', '/react', '/vanilla', '/media']) {
    await requestWithoutRedirect(request, path);
  }

  await expectMime(request, '/media/bunny-template.mp4', /^video\/mp4(?:;|$)/);
  await expectMime(request, '/media/bunny-square.webm', /^video\/webm(?:;|$)/);
  await expectMime(request, '/media/yumcut-demo-music.ogg', /^audio\/ogg(?:;|$)/);
  await expectMime(request, '/media/bunny-poster.jpg', /^image\/jpeg(?:;|$)/);
  await expectMime(
    request,
    '/nextjs/vendor/yumcut-render-worker.js',
    /^application\/javascript(?:;|$)/,
  );

  const range = await request.get('/media/bunny-template.mp4', {
    headers: { Range: 'bytes=0-1023' },
  });
  expect(range.status()).toBe(206);
  expect(range.headers()['accept-ranges']).toBe('bytes');
  expect(range.headers()['content-length']).toBe('1024');
  expect(range.headers()['content-range']).toMatch(/^bytes 0-1023\/\d+$/);
  expect(range.headers()['content-type']).toMatch(/^video\/mp4(?:;|$)/);
  expect((await range.body()).byteLength).toBe(1024);

  for (const path of [
    '/media/does-not-exist.mp4',
    '/nextjs/_next/static/does-not-exist.js',
    '/nextjs/media/does-not-exist.mp4',
    '/react/assets/does-not-exist.js',
    '/vanilla/assets/does-not-exist.js',
  ]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(404);
    expect(response.headers()['content-type'], path).toMatch(/^text\/plain/);
    expect(await response.text(), path).toBe('Not found\n');
  }
});

const demos: readonly DemoCheck[] = [
  {
    prefix: '/nextjs/',
    async ready(page) {
      await expect(page.getByRole('heading', { name: /Turn a template into a finished ad/i })).toBeVisible();
      await expect(page.getByTestId('render-button')).toBeEnabled({ timeout: 60_000 });
      await expect(page.getByLabel(/Preview Bunny classic/i)).toHaveAttribute(
        'src',
        '/nextjs/media/bunny-template.mp4',
      );
      await page.getByRole('button', { name: 'Check this browser' }).click();
      await expect(page.getByTestId('notice')).toContainText(
        /Support check complete|unsupported/i,
        { timeout: 60_000 },
      );
    },
    async upload(page) {
      await page.getByTestId('overlay-input').setInputFiles(FIXTURES.video);
      await expect(page.getByText('bunny-square.webm', { exact: true })).toBeVisible();
      await page.getByTestId('music-input').setInputFiles(FIXTURES.music);
      await expect(page.getByText('yumcut-demo-music.ogg', { exact: true })).toBeVisible();
    },
  },
  {
    prefix: '/react/',
    async ready(page) {
      await expect(page.getByTestId('react-vite-demo')).toBeVisible();
      await expect(page.getByTestId('template-preview')).toHaveAttribute(
        'src',
        '/react/media/bunny-template.mp4',
      );
      await page.getByRole('button', { name: 'Check browser' }).click();
      await expect(page.locator('.status-head strong')).toHaveText(
        /Browser ready|Needs attention/,
        { timeout: 60_000 },
      );
    },
    async upload(page) {
      await page.locator('#video-upload').setInputFiles(FIXTURES.video);
      await expect(
        page.locator('label[for="video-upload"]').getByText('bunny-square.webm', { exact: true }),
      ).toBeVisible();
      await page.locator('#music-upload').setInputFiles(FIXTURES.music);
      await expect(
        page.locator('label[for="music-upload"]').getByText('yumcut-demo-music.ogg', { exact: true }),
      ).toBeVisible();
    },
  },
  {
    prefix: '/vanilla/',
    async ready(page) {
      await expect(page.getByRole('heading', { name: /Turn a template into/i })).toBeVisible();
      await expect(page.locator('#template-preview')).toHaveAttribute(
        'src',
        '/vanilla/media/bunny-template.mp4',
      );
      await page.locator('#support-button').click();
      await expect(page.locator('#progress-stage')).toHaveText('Check complete', { timeout: 60_000 });
      await expect(page.locator('#status-pill')).not.toHaveText('Not checked');
    },
    async upload(page) {
      await page.locator('#overlay-video').setInputFiles(FIXTURES.video);
      await expect(page.locator('#overlay-video-name')).toContainText('bunny-square.webm');
      await page.locator('#music-file').setInputFiles(FIXTURES.music);
      await expect(page.locator('#music-file-name')).toContainText('yumcut-demo-music.ogg');
    },
  },
];

for (const demo of demos) {
  test(`${demo.prefix} is self-contained, error-free, and accepts local media`, async ({ page }) => {
    const errors = await watchRuntimeErrors(page);
    const sameOriginPaths: string[] = [];
    const badResponses: string[] = [];
    const onRequest = (browserRequest: { url(): string }) => {
      const url = new URL(browserRequest.url());
      if (url.origin === 'http://127.0.0.1:4399') sameOriginPaths.push(url.pathname);
    };
    const onResponse = (response: { status(): number; url(): string }) => {
      const url = new URL(response.url());
      if (
        url.origin === 'http://127.0.0.1:4399'
        && response.status() >= 400
        && url.pathname !== '/favicon.ico'
      ) {
        badResponses.push(`${response.status()} ${url.pathname}`);
      }
    };
    page.on('request', onRequest);
    page.on('response', onResponse);

    await page.goto(demo.prefix);
    await demo.ready(page);
    await demo.upload(page);

    page.off('request', onRequest);
    page.off('response', onResponse);
    const leaks = sameOriginPaths.filter(
      (path) => path !== '/favicon.ico' && !path.startsWith(demo.prefix),
    );
    expect(leaks, `Resources escaped ${demo.prefix}`).toEqual([]);
    expect(badResponses, `Failed resources under ${demo.prefix}`).toEqual([]);
    expect(sameOriginPaths.some((path) => path.includes('/media/'))).toBe(true);
    expectNoRuntimeErrors(errors);
  });
}

test('Next.js showcase produces a real 360x360 video through its prefixed worker', async ({ page }) => {
  const errors = await watchRuntimeErrors(page);
  await page.goto('/nextjs/');
  await expect(page.getByTestId('render-button')).toBeEnabled({ timeout: 60_000 });

  await page.getByTestId('overlay-input').setInputFiles(FIXTURES.video);
  await page.getByTestId('music-input').setInputFiles(FIXTURES.music);
  await page.getByRole('radio', { name: 'square' }).check();
  await page.getByLabel('Resolution').selectOption('quick');

  const workerLoaded = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/nextjs/vendor/yumcut-render-worker.js',
    { timeout: 120_000 },
  );
  await page.getByTestId('render-button').click();

  const workerResponse = await workerLoaded;
  expect(workerResponse.status()).toBe(200);
  expect(workerResponse.headers()['content-type']).toMatch(/^application\/javascript(?:;|$)/);

  const resultVideo = page.getByTestId('result-preview');
  await expect(resultVideo).toBeVisible({ timeout: 240_000 });
  await expect(page.getByTestId('progress')).toHaveJSProperty('value', 1);
  await expect(page.getByTestId('notice')).toContainText('Render complete');
  await expect(page.getByTestId('download-link')).toHaveAttribute('href', /^blob:/);
  const metadata = await expectPlayableVideo(resultVideo);
  expect(metadata.width).toBe(360);
  expect(metadata.height).toBe(360);
  expect(metadata.duration).toBeGreaterThan(0.8);
  expectNoRuntimeErrors(errors);
});
