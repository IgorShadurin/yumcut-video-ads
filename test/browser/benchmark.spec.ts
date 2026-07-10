import { writeFile } from 'node:fs/promises';
import { expect, test } from 'playwright/test';

interface BenchmarkHarness {
  render(): Promise<{
    status: string;
    support: {
      status: string;
      supported: boolean;
      recommendedOutput?: { format: string; videoCodec: string; audioCodec?: string };
      warnings: readonly string[];
    } | null;
    result: {
      format: string;
      mimeType: string;
      durationUs: number;
      fileSize: number;
      stats: {
        elapsedMs: number;
        framesEncoded: number;
        framesDropped: number;
        bytesWritten: number;
        decodeMs?: number;
        composeMs?: number;
        encodeMs?: number;
      };
    } | null;
    wallClockMs: number | null;
  }>;
}

test('records a short labelled browser performance sample', async ({ page, browserName }, testInfo) => {
  await page.goto('/test/browser/harness/');
  await page.waitForFunction(() => 'videoAdsHarness' in window);

  const environment = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGiB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
  }));
  const measured = await page.evaluate(async () => {
    const memory = performance as Performance & {
      memory?: { usedJSHeapSize: number };
    };
    let peakJsHeapBytes = memory.memory?.usedJSHeapSize;
    const sampler = setInterval(() => {
      peakJsHeapBytes = Math.max(peakJsHeapBytes ?? 0, memory.memory?.usedJSHeapSize ?? 0);
    }, 25);
    try {
      const state = await (window as unknown as { videoAdsHarness: BenchmarkHarness }).videoAdsHarness.render();
      peakJsHeapBytes = Math.max(peakJsHeapBytes ?? 0, memory.memory?.usedJSHeapSize ?? 0);
      return { state, peakJsHeapBytes };
    } finally {
      clearInterval(sampler);
    }
  });
  const { state } = measured;
  expect(state.status).toBe('complete');
  expect(state.result).not.toBeNull();
  expect(state.wallClockMs).not.toBeNull();

  const result = state.result!;
  const durationMs = result.durationUs / 1000;
  const report = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    project: testInfo.project.name,
    browserName,
    environment,
    workload: {
      width: 640,
      height: 360,
      frameRate: 30,
      durationSeconds: result.durationUs / 1_000_000,
      layers: ['silent H.264 video', 'silent VP9 video', 'JPEG image', 'text', 'Opus audio'],
    },
    support: state.support,
    output: {
      format: result.format,
      mimeType: result.mimeType,
      fileSize: result.fileSize,
    },
    timings: {
      wallClockMs: state.wallClockMs,
      engineElapsedMs: result.stats.elapsedMs,
      realTimeFactor: state.wallClockMs! / durationMs,
      decodeMs: result.stats.decodeMs,
      composeMs: result.stats.composeMs,
      encodeMs: result.stats.encodeMs,
    },
    frames: {
      encoded: result.stats.framesEncoded,
      dropped: result.stats.framesDropped,
    },
    memory: {
      peakJsHeapBytes: measured.peakJsHeapBytes,
      note: 'Chromium JS heap only; decoder, encoder, GPU, and Blob backing stores are outside this counter.',
    },
    note: 'Informational sample only; no universal speed threshold is applied across machines.',
  };

  expect(report.frames.encoded).toBeGreaterThan(0);
  expect(report.output.fileSize).toBeGreaterThan(10_000);
  expect(report.timings.wallClockMs).toBeGreaterThan(0);

  const reportPath = testInfo.outputPath('browser-benchmark.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await testInfo.attach('browser-benchmark', { path: reportPath, contentType: 'application/json' });
});
