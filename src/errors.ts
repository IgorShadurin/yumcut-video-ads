export const YUMCUT_VIDEO_ADS_ERROR_CODES = [
  'CORS',
  'FETCH_FAILED',
  'UNSUPPORTED_INPUT_CODEC',
  'UNSUPPORTED_OUTPUT_CODEC',
  'INVALID_PROJECT',
  'INVALID_TIMELINE',
  'INSUFFICIENT_STORAGE',
  'DECODE_FAILED',
  'ENCODE_FAILED',
  'GPU_CONTEXT_LOST',
  'ABORTED',
  'CORRUPT_MEDIA',
  'UNSUPPORTED_ENVIRONMENT',
  'INVALID_SOURCE',
  'CACHE_FAILED',
  'INTERNAL_ERROR',
] as const;

/** Descriptive compatibility alias retained for pre-brand integrations. */
export const VIDEO_ADS_ERROR_CODES = YUMCUT_VIDEO_ADS_ERROR_CODES;

export type YumCutVideoAdsErrorCode = (typeof YUMCUT_VIDEO_ADS_ERROR_CODES)[number];
export type VideoAdsErrorCode = YumCutVideoAdsErrorCode;

export interface YumCutVideoAdsErrorOptions {
  cause?: unknown;
  details?: Readonly<Record<string, unknown>>;
}
export type VideoAdsErrorOptions = YumCutVideoAdsErrorOptions;

/** A stable, serializable error type for failures exposed by the library. */
export class YumCutVideoAdsError extends Error {
  readonly code: YumCutVideoAdsErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: YumCutVideoAdsErrorCode,
    message: string,
    options: YumCutVideoAdsErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'YumCutVideoAdsError';
    this.code = code;

    if (options.details !== undefined) {
      this.details = options.details;
    }
  }

  static from(
    error: unknown,
    code: YumCutVideoAdsErrorCode = 'INTERNAL_ERROR',
    message?: string,
    details?: Readonly<Record<string, unknown>>,
  ): YumCutVideoAdsError {
    if (error instanceof YumCutVideoAdsError) {
      return error;
    }

    const fallbackMessage = error instanceof Error ? error.message : String(error);
    return new YumCutVideoAdsError(code, message ?? fallbackMessage, {
      cause: error,
      ...(details === undefined ? {} : { details }),
    });
  }

  toJSON(): {
    name: string;
    code: YumCutVideoAdsErrorCode;
    message: string;
    details?: Readonly<Record<string, unknown>>;
  } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function isYumCutVideoAdsError(value: unknown): value is YumCutVideoAdsError {
  return value instanceof YumCutVideoAdsError;
}

/** Descriptive compatibility aliases retained for pre-brand integrations. */
export const VideoAdsError = YumCutVideoAdsError;
export type VideoAdsError = YumCutVideoAdsError;
export const isVideoAdsError = isYumCutVideoAdsError;

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new YumCutVideoAdsError('ABORTED', 'The operation was cancelled.', { cause: signal.reason });
  }
}
