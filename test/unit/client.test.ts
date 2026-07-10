import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVideoAds } from '../../src/client.js';
import type { Project, RenderResult } from '../../src/types.js';
import type { WorkerRequest, WorkerResponse } from '../../src/worker-protocol.js';

const project: Project = {
  output: { width: 2, height: 2, frameRate: 1, durationUs: 1_000_000 },
  tracks: [{
    type: 'visual',
    clips: [{
      type: 'text',
      text: 'OPFS',
      startUs: 0,
      durationUs: 1_000_000,
      style: { fontSize: 1 },
    }],
  }],
};

class ResultWorker {
  private readonly messageListeners: Array<(event: MessageEvent<WorkerResponse>) => void> = [];

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'message' && typeof listener === 'function') {
      this.messageListeners.push(listener as (event: MessageEvent<WorkerResponse>) => void);
    }
  }

  postMessage(message: WorkerRequest): void {
    if (message.type !== 'render') return;
    const response: WorkerResponse = {
      type: 'result',
      id: message.id,
      result: {
        format: 'mp4',
        mimeType: 'video/mp4',
        width: 2,
        height: 2,
        durationUs: 1_000_000,
        fileSize: 4,
        blob: new Blob(['test'], { type: 'video/mp4' }),
        artifactStorage: 'opfs',
        warnings: [],
        stats: {
          elapsedMs: 1,
          framesEncoded: 1,
          framesDropped: 0,
          bytesWritten: 4,
        },
        __temporaryOutput: {
          directoryName: 'yumcut-video-ads-output',
          fileName: 'yumcut-video-ads-test.mp4',
        },
      },
    };
    queueMicrotask(() => {
      const event = { data: response } as MessageEvent<WorkerResponse>;
      for (const listener of this.messageListeners) listener(event);
    });
  }

  terminate(): void {}
}

function installOpfsMock(): {
  getDirectoryHandle: ReturnType<typeof vi.fn>;
  removeDirectory: ReturnType<typeof vi.fn>;
  removeFile: ReturnType<typeof vi.fn>;
} {
  let directoryExists = true;
  let fileExists = true;

  const removeFile = vi.fn(async () => {
    if (!fileExists) throw new DOMException('Missing output file.', 'NotFoundError');
    fileExists = false;
  });
  const directory = { removeEntry: removeFile } as unknown as FileSystemDirectoryHandle;
  const getDirectoryHandle = vi.fn(async () => {
    if (!directoryExists) throw new DOMException('Missing output directory.', 'NotFoundError');
    return directory;
  });
  const removeDirectory = vi.fn(async () => {
    if (!directoryExists) throw new DOMException('Missing output directory.', 'NotFoundError');
    directoryExists = false;
    fileExists = false;
  });
  const root = {
    getDirectoryHandle,
    removeEntry: removeDirectory,
  } as unknown as FileSystemDirectoryHandle;

  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: vi.fn(async () => root),
    },
  });

  return { getDirectoryHandle, removeDirectory, removeFile };
}

async function renderTemporaryResult(): Promise<{
  result: RenderResult;
  videoAds: ReturnType<typeof createVideoAds>;
}> {
  const worker = new ResultWorker();
  const videoAds = createVideoAds({ workerFactory: () => worker as unknown as Worker });
  const result = await videoAds.render(project, { output: 'auto' });
  return { result, videoAds };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('temporary OPFS result ownership', () => {
  it('releases its file idempotently without serializing the release callback', async () => {
    const opfs = installOpfsMock();
    const { result, videoAds } = await renderTemporaryResult();

    expect(result.release).toBeTypeOf('function');
    expect(Object.prototype.propertyIsEnumerable.call(result, 'release')).toBe(false);
    vi.useFakeTimers();
    videoAds.dispose();
    await result.release?.();
    await result.release?.();
    vi.runAllTimers();

    expect(opfs.getDirectoryHandle).toHaveBeenCalledTimes(1);
    expect(opfs.removeFile).toHaveBeenCalledTimes(1);
  });

  it('treats release as complete after bulk cleanup removed the directory', async () => {
    const opfs = installOpfsMock();
    const { result, videoAds } = await renderTemporaryResult();

    await videoAds.cleanupTemporaryOutputs();
    await expect(result.release?.()).resolves.toBeUndefined();
    await expect(result.release?.()).resolves.toBeUndefined();

    expect(opfs.removeDirectory).toHaveBeenCalledTimes(1);
    expect(opfs.getDirectoryHandle).toHaveBeenCalledTimes(1);
    expect(opfs.removeFile).not.toHaveBeenCalled();
  });
});
