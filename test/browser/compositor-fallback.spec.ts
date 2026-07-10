import { expect, test } from 'playwright/test';

test('Canvas2D fallback wipes can shrink without retaining an earlier path', async ({ page }) => {
  await page.goto('/test/browser/harness/');

  const pixels = await page.evaluate(async () => {
    const moduleUrl = '/src/compositor.ts';
    const { createCompositor } = await import(/* @vite-ignore */ moduleUrl) as
      typeof import('../../src/compositor');
    const source = new OffscreenCanvas(100, 100);
    const sourceContext = source.getContext('2d');
    if (!sourceContext) throw new Error('Source context unavailable.');
    sourceContext.fillStyle = '#ff0000';
    sourceContext.fillRect(0, 0, 100, 100);

    const compositor = createCompositor(100, 100, 'canvas2d');
    const base = {
      source,
      sourceWidth: 100,
      sourceHeight: 100,
      fit: 'cover' as const,
      box: { x: 0, y: 0, width: 1, height: 1 },
      focalPoint: { x: 0.5, y: 0.5 },
      alignment: { x: 0.5, y: 0.5 },
      position: { x: 0, y: 0 },
      scale: 1,
      rotation: 0,
      opacity: 1,
    };
    compositor.clear('#0000ff');
    compositor.draw({ ...base, wipe: { progress: 1, direction: 'right' as const } });
    compositor.clear('#0000ff');
    compositor.draw({ ...base, wipe: { progress: 0.25, direction: 'right' as const } });
    const context = compositor.canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Result context unavailable.');
    const inside = [...context.getImageData(10, 50, 1, 1).data];
    const outside = [...context.getImageData(75, 50, 1, 1).data];
    compositor.dispose();
    return { inside, outside };
  });

  expect(pixels.inside.slice(0, 3)).toEqual([255, 0, 0]);
  expect(pixels.outside.slice(0, 3)).toEqual([0, 0, 255]);
});

test('WebGL compositor pre-scales a source beyond the texture limit', async ({ page }) => {
  await page.goto('/test/browser/harness/');

  const sample = await page.evaluate(async () => {
    const moduleUrl = '/src/compositor.ts';
    const { createCompositor } = await import(/* @vite-ignore */ moduleUrl) as
      typeof import('../../src/compositor');
    const source = new OffscreenCanvas(200, 100);
    const sourceContext = source.getContext('2d');
    if (!sourceContext) throw new Error('Source context unavailable.');
    sourceContext.fillStyle = '#00ff00';
    sourceContext.fillRect(0, 0, 200, 100);

    const compositor = createCompositor(100, 100, 'webgl2');
    (compositor as unknown as { maxTextureSize: number }).maxTextureSize = 64;
    compositor.clear('#0000ff');
    compositor.draw({
      source,
      sourceWidth: 200,
      sourceHeight: 100,
      fit: 'cover',
      box: { x: 0, y: 0, width: 1, height: 1 },
      focalPoint: { x: 0.5, y: 0.5 },
      alignment: { x: 0.5, y: 0.5 },
      position: { x: 0, y: 0 },
      scale: 1,
      rotation: 0,
      opacity: 1,
    });
    compositor.finish();
    const bitmap = await createImageBitmap(compositor.canvas);
    const output = new OffscreenCanvas(100, 100);
    const outputContext = output.getContext('2d', { willReadFrequently: true });
    if (!outputContext) throw new Error('Output context unavailable.');
    outputContext.drawImage(bitmap, 0, 0);
    const pixel = [...outputContext.getImageData(50, 50, 1, 1).data];
    bitmap.close();
    compositor.dispose();
    return pixel;
  });

  expect(sample.slice(0, 3)).toEqual([0, 255, 0]);
});
