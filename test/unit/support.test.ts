import { afterEach, describe, expect, it, vi } from 'vitest';
import { __private__ } from '../../src/support.js';

class FakeOffscreenCanvas {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  getContext(kind: string): unknown {
    if (kind === '2d') return {};
    if (kind !== 'webgl2') return null;
    const context = {
      MAX_TEXTURE_SIZE: 1,
      MAX_RENDERBUFFER_SIZE: 2,
      MAX_VIEWPORT_DIMS: 3,
      getParameter(parameter: number) {
        if (parameter === 1 || parameter === 2) return 4096;
        return new Int32Array([4096, 4096]);
      },
      getExtension() {
        return { loseContext() {} };
      },
    };
    return context;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('composition capability probing', () => {
  it('checks requested dimensions against concrete WebGL2 limits', () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);

    expect(__private__.probeCanvases(1920, 1080)).toMatchObject({
      offscreenAvailable: true,
      webgl2Available: true,
      limits: { maxTextureSize: 4096, maxRenderbufferSize: 4096 },
    });
    expect(__private__.probeCanvases(5000, 3000)).toMatchObject({
      offscreenAvailable: true,
      webgl2Available: false,
    });
    expect(__private__.probeCanvases(5000, 3000).webgl2Reason).toContain('Canvas2D fallback');
  });

  it('keeps fixed container pairs while choosing a size/bitrate-compatible codec level', () => {
    const selection = __private__.selectCodecs({ format: 'webm' }, 1920, 1080, 30);
    expect(selection.eligibleFormats).toEqual(['webm']);
    expect(selection.candidates).toEqual([
      expect.objectContaining({ format: 'mp4', audioCodec: 'mp4a.40.2' }),
      expect.objectContaining({ format: 'webm', videoCodec: 'vp09.00.40.08', audioCodec: 'opus' }),
    ]);
  });

  it('falls back to a software-capable encoder when hardware preference is rejected', async () => {
    const configurations: VideoEncoderConfig[] = [];
    vi.stubGlobal('VideoEncoder', class {
      static async isConfigSupported(config: VideoEncoderConfig): Promise<VideoEncoderSupport> {
        configurations.push(config);
        return {
          config,
          supported: config.hardwareAcceleration === 'no-preference',
        };
      }
    });

    await expect(__private__.probeVideoCodec('vp09.00.21.08', 640, 360, 30, 800_000))
      .resolves.toEqual({
        codec: 'vp09.00.21.08',
        supported: true,
        hardwareAcceleration: false,
      });
    expect(configurations.map((config) => config.hardwareAcceleration)).toEqual([
      'prefer-hardware',
      'no-preference',
    ]);
  });
});
