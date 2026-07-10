import type { Project, RenderOptions, RenderProgress, RenderResult } from './types';

export type WorkerRenderOptions = Omit<RenderOptions, 'signal' | 'onProgress'> & {
  cacheName?: string;
};

export interface WorkerRenderRequest {
  type: 'render';
  id: number;
  project: Project;
  options: WorkerRenderOptions;
}

export interface WorkerCancelRequest {
  type: 'cancel';
  id: number;
  reason?: string;
}

export interface WorkerDisposeRequest {
  type: 'dispose';
}

export type WorkerRequest = WorkerRenderRequest | WorkerCancelRequest | WorkerDisposeRequest;

export interface WorkerProgressResponse {
  type: 'progress';
  id: number;
  progress: RenderProgress;
}

export interface WorkerResultResponse {
  type: 'result';
  id: number;
  result: RenderResult & {
    __temporaryOutput?: { directoryName: string; fileName: string };
  };
}

export interface SerializedWorkerError {
  name: string;
  message: string;
  code: string;
  details?: Readonly<Record<string, unknown>>;
  stack?: string;
}

export interface WorkerErrorResponse {
  type: 'error';
  id: number;
  error: SerializedWorkerError;
}

export type WorkerResponse = WorkerProgressResponse | WorkerResultResponse | WorkerErrorResponse;
