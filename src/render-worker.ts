/// <reference lib="webworker" />

import { VideoAdsError } from './errors';
import { renderProject } from './renderer-engine';
import type {
  SerializedWorkerError,
  WorkerRequest,
  WorkerResponse,
} from './worker-protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const controllers = new Map<number, AbortController>();
const queuedCancellations = new Map<number, string>();
let queue = Promise.resolve();
let disposed = false;

function serializeError(error: unknown): SerializedWorkerError {
  if (error instanceof VideoAdsError) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: 'INTERNAL_ERROR',
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  return { name: 'Error', message: String(error), code: 'INTERNAL_ERROR' };
}

function post(response: WorkerResponse): void {
  scope.postMessage(response);
}

async function handleRender(request: Extract<WorkerRequest, { type: 'render' }>): Promise<void> {
  if (disposed) return;
  const controller = new AbortController();
  controllers.set(request.id, controller);
  const queuedReason = queuedCancellations.get(request.id);
  if (queuedReason !== undefined) {
    queuedCancellations.delete(request.id);
    controller.abort(queuedReason);
  }
  try {
    const result = await renderProject(request.project, request.options, {
      signal: controller.signal,
      onProgress: (progress) => post({ type: 'progress', id: request.id, progress }),
    });
    post({ type: 'result', id: request.id, result });
  } catch (error) {
    post({ type: 'error', id: request.id, error: serializeError(error) });
  } finally {
    controllers.delete(request.id);
  }
}

scope.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === 'cancel') {
    const reason = request.reason ?? 'Cancelled by caller';
    const controller = controllers.get(request.id);
    if (controller) controller.abort(reason);
    else queuedCancellations.set(request.id, reason);
    return;
  }
  if (request.type === 'dispose') {
    disposed = true;
    for (const controller of controllers.values()) controller.abort('Renderer disposed');
    controllers.clear();
    queuedCancellations.clear();
    void queue.finally(() => scope.close());
    return;
  }
  queue = queue.then(() => handleRender(request), () => handleRender(request));
});

export {};
