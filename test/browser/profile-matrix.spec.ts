import { writeFile } from 'node:fs/promises';
import { expect, test } from 'playwright/test';

const runMatrix = process.env.YUMCUT_VIDEO_ADS_PROFILE_MATRIX === '1';
const runFiveMinute = process.env.YUMCUT_VIDEO_ADS_FIVE_MINUTE === '1';

test('records the opt-in 360p through 4K render matrix', async ({ page }, testInfo) => {
  test.skip(!runMatrix, 'Set YUMCUT_VIDEO_ADS_PROFILE_MATRIX=1 to run the resolution matrix.');
  test.setTimeout(15 * 60_000);
  await page.goto('/test/browser/harness/');
  await page.waitForFunction(() => 'videoAdsRuntime' in window);

  const profiles = [
    { name: '360p', width: 640, height: 360, durationUs: 500_000 },
    { name: '720p', width: 1280, height: 720, durationUs: 500_000 },
    { name: '1080p', width: 1920, height: 1080, durationUs: 500_000 },
    { name: '4k', width: 3840, height: 2160, durationUs: 500_000 },
    ...(runFiveMinute
      ? [{ name: '4k-five-minute', width: 3840, height: 2160, durationUs: 300_000_000 }]
      : []),
  ];

  const results = await page.evaluate(async (matrix) => {
    const runtime = window.videoAdsRuntime;
    const videoAds = runtime.createVideoAds();
    const source = new URL('/test/fixtures/media/bunny-template.mp4', location.href).href;
    const source4k = new URL('/test/fixtures/media/bunny-4k.mp4', location.href).href;
    const measured: Array<Record<string, unknown>> = [];
    try {
      for (const profile of matrix) {
        const project: import('../../src/index').Project = {
          id: `matrix-${profile.name}`,
          output: {
            width: profile.width,
            height: profile.height,
            frameRate: 30,
            durationUs: profile.durationUs,
            background: '#172033',
          },
          tracks: [{
            type: 'visual',
            clips: [{
              type: 'video',
              source: profile.width >= 3840 ? source4k : source,
              startUs: 0,
              durationUs: profile.durationUs,
              loop: true,
              muted: true,
              fit: 'cover',
            }],
          }],
        };
        const support = await videoAds.detectSupport({
          width: profile.width,
          height: profile.height,
          frameRate: 30,
          durationUs: profile.durationUs,
          format: 'auto',
        });
        if (!support.supported) {
          measured.push({ ...profile, supported: false, blockers: support.blockers });
          continue;
        }
        let output: import('../../src/index').RenderOutputTarget = 'blob';
        let opfsRoot: FileSystemDirectoryHandle | undefined;
        let opfsName: string | undefined;
        if (profile.durationUs >= 60_000_000) {
          opfsRoot = await navigator.storage.getDirectory();
          opfsName = `yumcut-video-ads-${profile.name}.mp4`;
          const fileHandle = await opfsRoot.getFileHandle(opfsName, { create: true });
          output = { type: 'file', fileHandle };
        }
        const wallStart = performance.now();
        const result = await videoAds.render(project, { output, format: 'auto' });
        let actualFileSize = result.blob?.size;
        if (opfsRoot && opfsName) {
          actualFileSize = (await (await opfsRoot.getFileHandle(opfsName)).getFile()).size;
          await opfsRoot.removeEntry(opfsName);
        }
        measured.push({
          ...profile,
          supported: true,
          format: result.format,
          fileSize: result.fileSize,
          actualFileSize,
          frames: result.stats.framesEncoded,
          wallClockMs: performance.now() - wallStart,
          stats: result.stats,
        });
      }
    } finally {
      videoAds.dispose();
    }
    return measured;
  }, profiles);

  for (const result of results) {
    expect(result.supported, JSON.stringify(result)).toBe(true);
    expect(Number(result.frames)).toBeGreaterThan(0);
    expect(Number(result.fileSize)).toBeGreaterThan(1_000);
  }

  const output = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    browser: testInfo.project.name,
    results,
    note: runFiveMinute
      ? 'Includes the explicitly enabled five-minute 4K stress profile.'
      : 'Short real-media encode/composition qualification; set YUMCUT_VIDEO_ADS_FIVE_MINUTE=1 for the long stress profile.',
  };
  const path = testInfo.outputPath('resolution-matrix.json');
  await writeFile(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await testInfo.attach('resolution-matrix', { path, contentType: 'application/json' });
});
