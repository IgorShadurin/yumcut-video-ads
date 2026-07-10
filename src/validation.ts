import { VideoAdsError } from './errors.js';
import { projectDurationUs } from './timeline.js';
import type {
  AudioClip,
  BaseClip,
  BaseMediaClip,
  ClipAudioOptions,
  ClipLayout,
  MediaSource,
  Point,
  Project,
  ProjectOutput,
  Rect,
  SupportProfile,
  TextClip,
  Track,
  Transition,
  VisualClip,
} from './types.js';

export type ValidationIssueCode =
  | 'INVALID_PROJECT'
  | 'INVALID_OUTPUT'
  | 'INVALID_DIMENSION'
  | 'INVALID_FRAME_RATE'
  | 'INVALID_DURATION'
  | 'INVALID_TRACK'
  | 'INVALID_CLIP'
  | 'INVALID_SOURCE'
  | 'INVALID_LAYOUT'
  | 'INVALID_AUDIO'
  | 'INVALID_TRANSITION'
  | 'DUPLICATE_ID'
  | 'EMPTY_TRACK'
  | 'CLIPPED_BY_OUTPUT';

export interface ValidationIssue {
  code: ValidationIssueCode;
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: readonly ValidationIssue[];
  errors: readonly ValidationIssue[];
  warnings: readonly ValidationIssue[];
}

export const DEFAULT_FRAME_RATE = 30;
export const MIN_FRAME_RATE = 1;
export const MAX_FRAME_RATE = 60;

export function validateProject(project: Project): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!isObject(project)) {
    addError(issues, 'INVALID_PROJECT', '$', 'Project must be an object.');
    return resultFrom(issues);
  }

  validateOutput(project.output, '$.output', issues);

  if (!Array.isArray(project.tracks)) {
    addError(issues, 'INVALID_PROJECT', '$.tracks', 'Project tracks must be an array.');
    return resultFrom(issues);
  }

  if (project.tracks.length === 0) {
    addError(issues, 'INVALID_PROJECT', '$.tracks', 'Project must contain at least one track.');
  }

  const trackIds = new Set<string>();
  const clipIds = new Set<string>();
  let clipCount = 0;

  project.tracks.forEach((track, trackIndex) => {
    const path = `$.tracks[${trackIndex}]`;
    validateTrack(track, path, issues, clipIds);
    if (!isObject(track)) {
      return;
    }
    clipCount += Array.isArray(track.clips) ? track.clips.length : 0;

    if (track.id !== undefined) {
      if (trackIds.has(track.id)) {
        addError(issues, 'DUPLICATE_ID', `${path}.id`, `Duplicate track id "${track.id}".`);
      }
      trackIds.add(track.id);
    }
  });

  if (clipCount === 0 && project.tracks.length > 0) {
    addError(issues, 'INVALID_PROJECT', '$.tracks', 'Project must contain at least one clip.');
  }

  if (
    isOutputShapeUsable(project.output) &&
    project.output.durationUs !== undefined &&
    project.tracks.every((track) => isObject(track) && Array.isArray(track.clips))
  ) {
    try {
      const naturalDurationUs = Math.max(
        0,
        ...project.tracks.flatMap((track) =>
          (track.clips as readonly BaseClip[]).map((clip) => clip.startUs + clip.durationUs),
        ),
      );
      if (naturalDurationUs > project.output.durationUs) {
        addWarning(
          issues,
          'CLIPPED_BY_OUTPUT',
          '$.output.durationUs',
          'The explicit output duration ends before one or more clips.',
        );
      }
    } catch {
      // Individual invalid timeline values already produce more precise issues.
    }
  }

  return resultFrom(issues);
}

export function assertValidProject(project: Project): void {
  const validation = validateProject(project);
  if (!validation.valid) {
    throw new VideoAdsError('INVALID_PROJECT', validation.errors[0]?.message ?? 'Project is invalid.', {
      details: { issues: validation.issues },
    });
  }
}

export function validateSupportProfile(profile: SupportProfile): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!isObject(profile)) {
    addError(issues, 'INVALID_PROJECT', '$', 'Support profile must be an object.');
    return resultFrom(issues);
  }

  if ((profile.width === undefined) !== (profile.height === undefined)) {
    addError(
      issues,
      'INVALID_DIMENSION',
      '$',
      'Support profile width and height must be supplied together.',
    );
  }
  if (profile.width !== undefined) {
    validateDimension(profile.width, '$.width', issues);
  }
  if (profile.height !== undefined) {
    validateDimension(profile.height, '$.height', issues);
  }
  if (profile.frameRate !== undefined) {
    validateFrameRate(profile.frameRate, '$.frameRate', issues);
  }
  if (profile.durationUs !== undefined) {
    validatePositiveTime(profile.durationUs, '$.durationUs', issues);
  }
  if (profile.format !== undefined && !['auto', 'mp4', 'webm'].includes(profile.format)) {
    addError(issues, 'INVALID_OUTPUT', '$.format', 'Format must be "auto", "mp4", or "webm".');
  }
  if (profile.includeAudio !== undefined && typeof profile.includeAudio !== 'boolean') {
    addError(issues, 'INVALID_OUTPUT', '$.includeAudio', 'includeAudio must be a boolean.');
  }
  if (profile.quality !== undefined && profile.quality !== 'balanced' && profile.quality !== 'high') {
    addError(issues, 'INVALID_OUTPUT', '$.quality', 'Quality must be "balanced" or "high".');
  }
  if (profile.videoBitrate !== undefined) {
    validatePositiveFinite(profile.videoBitrate, '$.videoBitrate', issues, 'Video bitrate');
  }
  if (profile.audioBitrate !== undefined) {
    validatePositiveFinite(profile.audioBitrate, '$.audioBitrate', issues, 'Audio bitrate');
  }

  return resultFrom(issues);
}

export function isValidMediaSource(source: unknown): source is MediaSource {
  if (typeof source === 'string') {
    return source.trim().length > 0;
  }
  if (typeof URL !== 'undefined' && source instanceof URL) {
    return true;
  }
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    return true;
  }
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    return true;
  }
  if (!isRecord(source)) {
    return false;
  }
  if (source.type === 'url') {
    const url = source.url;
    return (typeof url === 'string' && url.trim().length > 0) ||
      (typeof URL !== 'undefined' && url instanceof URL);
  }
  if (source.type === 'buffer') {
    return source.data instanceof ArrayBuffer || ArrayBuffer.isView(source.data);
  }
  return false;
}

/** Convenience helper for callers that need the resolved, validated duration. */
export function validatedProjectDurationUs(project: Project): number {
  assertValidProject(project);
  return projectDurationUs(project);
}

function validateOutput(output: ProjectOutput, path: string, issues: ValidationIssue[]): void {
  if (!isObject(output)) {
    addError(issues, 'INVALID_OUTPUT', path, 'Project output must be an object.');
    return;
  }

  validateDimension(output.width, `${path}.width`, issues);
  validateDimension(output.height, `${path}.height`, issues);
  if (output.frameRate !== undefined) {
    validateFrameRate(output.frameRate, `${path}.frameRate`, issues);
  }
  if (output.durationUs !== undefined) {
    validatePositiveTime(output.durationUs, `${path}.durationUs`, issues);
  }

  if (typeof output.background === 'object' && output.background !== null) {
    if (output.background.type !== 'blur') {
      addError(issues, 'INVALID_OUTPUT', `${path}.background`, 'Unknown background type.');
    }
    if (output.background.blurRadius !== undefined) {
      validateNonNegativeFinite(
        output.background.blurRadius,
        `${path}.background.blurRadius`,
        issues,
        'Blur radius',
        'INVALID_OUTPUT',
      );
    }
    if (
      output.background.dim !== undefined &&
      (!Number.isFinite(output.background.dim) || output.background.dim < 0 || output.background.dim > 1)
    ) {
      addError(issues, 'INVALID_OUTPUT', `${path}.background.dim`, 'Background dim must be from 0 to 1.');
    }
  } else if (output.background !== undefined && typeof output.background !== 'string') {
    addError(issues, 'INVALID_OUTPUT', `${path}.background`, 'Background must be a color or blur options.');
  }
}

function validateTrack(
  track: Track,
  path: string,
  issues: ValidationIssue[],
  clipIds: Set<string>,
): void {
  if (!isObject(track) || (track.type !== 'visual' && track.type !== 'audio')) {
    addError(issues, 'INVALID_TRACK', path, 'Track type must be "visual" or "audio".');
    return;
  }
  if (!Array.isArray(track.clips)) {
    addError(issues, 'INVALID_TRACK', `${path}.clips`, 'Track clips must be an array.');
    return;
  }
  if (track.clips.length === 0) {
    addWarning(issues, 'EMPTY_TRACK', `${path}.clips`, 'Empty tracks have no effect.');
  }
  if (track.type === 'audio' && track.volume !== undefined) {
    validateNonNegativeFinite(track.volume, `${path}.volume`, issues, 'Track volume');
  }

  track.clips.forEach((clip, clipIndex) => {
    const clipPath = `${path}.clips[${clipIndex}]`;
    if (track.type === 'visual') {
      validateVisualClip(clip, clipPath, issues);
    } else {
      validateAudioClip(clip, clipPath, issues);
    }
    if (!isObject(clip)) {
      return;
    }
    if (clip.id !== undefined) {
      if (clipIds.has(clip.id)) {
        addError(issues, 'DUPLICATE_ID', `${clipPath}.id`, `Duplicate clip id "${clip.id}".`);
      }
      clipIds.add(clip.id);
    }
  });
}

function validateVisualClip(clip: VisualClip, path: string, issues: ValidationIssue[]): void {
  if (!isObject(clip) || !['video', 'image', 'text'].includes(clip.type)) {
    addError(issues, 'INVALID_CLIP', path, 'Visual track clips must be video, image, or text.');
    return;
  }
  validateBaseClip(clip, path, issues);
  validateLayout(clip, path, issues);

  if (clip.type === 'text') {
    validateTextClip(clip, path, issues);
    return;
  }

  validateMediaClip(clip, path, issues);
  if (clip.type === 'video') {
    validateClipAudio(clip, path, issues);
  }
}

function validateAudioClip(clip: AudioClip, path: string, issues: ValidationIssue[]): void {
  if (!isObject(clip) || clip.type !== 'audio') {
    addError(issues, 'INVALID_CLIP', path, 'Audio tracks may only contain audio clips.');
    return;
  }
  validateBaseClip(clip, path, issues);
  validateMediaClip(clip, path, issues);
  validateClipAudio(clip, path, issues);
}

function validateBaseClip(clip: BaseClip, path: string, issues: ValidationIssue[]): void {
  validateNonNegativeTime(clip.startUs, `${path}.startUs`, issues);
  validatePositiveTime(clip.durationUs, `${path}.durationUs`, issues);
  if (
    clip.opacity !== undefined &&
    (!Number.isFinite(clip.opacity) || clip.opacity < 0 || clip.opacity > 1)
  ) {
    addError(issues, 'INVALID_CLIP', `${path}.opacity`, 'Opacity must be from 0 to 1.');
  }
  if (clip.transitionIn !== undefined) {
    validateTransition(clip.transitionIn, clip.durationUs, `${path}.transitionIn`, issues);
  }
  if (clip.transitionOut !== undefined) {
    validateTransition(clip.transitionOut, clip.durationUs, `${path}.transitionOut`, issues);
  }
}

function validateMediaClip(clip: BaseMediaClip, path: string, issues: ValidationIssue[]): void {
  if (!isValidMediaSource(clip.source)) {
    addError(issues, 'INVALID_SOURCE', `${path}.source`, 'Media source is empty or unsupported.');
  }
  if (clip.trimStartUs !== undefined) {
    validateNonNegativeTime(clip.trimStartUs, `${path}.trimStartUs`, issues);
  }
}

function validateClipAudio(clip: ClipAudioOptions & BaseClip, path: string, issues: ValidationIssue[]): void {
  if (clip.volume !== undefined) {
    validateNonNegativeFinite(clip.volume, `${path}.volume`, issues, 'Clip volume');
  }
  if (clip.fadeInUs !== undefined) {
    validateFade(clip.fadeInUs, clip.durationUs, `${path}.fadeInUs`, issues);
  }
  if (clip.fadeOutUs !== undefined) {
    validateFade(clip.fadeOutUs, clip.durationUs, `${path}.fadeOutUs`, issues);
  }
}

function validateTextClip(clip: TextClip, path: string, issues: ValidationIssue[]): void {
  if (typeof clip.text !== 'string' || clip.text.length === 0) {
    addError(issues, 'INVALID_CLIP', `${path}.text`, 'Text content must not be empty.');
  }
  if (!isObject(clip.style)) {
    addError(issues, 'INVALID_CLIP', `${path}.style`, 'Text style is required.');
    return;
  }
  validatePositiveFinite(clip.style.fontSize, `${path}.style.fontSize`, issues, 'Font size');
  if (clip.style.lineHeight !== undefined) {
    validatePositiveFinite(clip.style.lineHeight, `${path}.style.lineHeight`, issues, 'Line height');
  }
  if (clip.style.strokeWidth !== undefined) {
    validateNonNegativeFinite(
      clip.style.strokeWidth,
      `${path}.style.strokeWidth`,
      issues,
      'Stroke width',
      'INVALID_CLIP',
    );
  }
  if (clip.style.padding !== undefined) {
    validateNonNegativeFinite(
      clip.style.padding,
      `${path}.style.padding`,
      issues,
      'Text padding',
      'INVALID_CLIP',
    );
  }
}

function validateLayout(layout: ClipLayout, path: string, issues: ValidationIssue[]): void {
  if (layout.fit !== undefined && layout.fit !== 'cover' && layout.fit !== 'contain') {
    addError(issues, 'INVALID_LAYOUT', `${path}.fit`, 'Fit must be "cover" or "contain".');
  }
  if (layout.box !== undefined) {
    validateNormalizedRect(layout.box, `${path}.box`, issues);
  }
  if (layout.focalPoint !== undefined) {
    validateNormalizedPoint(layout.focalPoint, `${path}.focalPoint`, issues);
  }
  if (layout.alignment !== undefined) {
    validateNormalizedPoint(layout.alignment, `${path}.alignment`, issues);
  }
  if (layout.position !== undefined) {
    validateFinitePoint(layout.position, `${path}.position`, issues);
  }
  if (layout.rotationDegrees !== undefined && !Number.isFinite(layout.rotationDegrees)) {
    addError(issues, 'INVALID_LAYOUT', `${path}.rotationDegrees`, 'Rotation must be finite.');
  }
  if (layout.scale !== undefined) {
    validatePositiveFinite(layout.scale, `${path}.scale`, issues, 'Scale');
  }
}

function validateTransition(
  transition: Transition,
  clipDurationUs: number,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!isObject(transition) || !['fade', 'slide', 'wipe'].includes(transition.type)) {
    addError(issues, 'INVALID_TRANSITION', path, 'Transition type must be fade, slide, or wipe.');
    return;
  }
  validatePositiveTime(transition.durationUs, `${path}.durationUs`, issues);
  if (Number.isFinite(clipDurationUs) && transition.durationUs > clipDurationUs) {
    addError(
      issues,
      'INVALID_TRANSITION',
      `${path}.durationUs`,
      'Transition cannot be longer than its clip.',
    );
  }
  if (
    transition.direction !== undefined &&
    !['left', 'right', 'up', 'down'].includes(transition.direction)
  ) {
    addError(issues, 'INVALID_TRANSITION', `${path}.direction`, 'Unknown transition direction.');
  }
}

function validateFade(value: number, clipDurationUs: number, path: string, issues: ValidationIssue[]): void {
  validateNonNegativeTime(value, path, issues);
  if (Number.isFinite(clipDurationUs) && value > clipDurationUs) {
    addError(issues, 'INVALID_AUDIO', path, 'Audio fade cannot be longer than its clip.');
  }
}

function validateDimension(value: number, path: string, issues: ValidationIssue[]): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value % 2 !== 0) {
    addError(issues, 'INVALID_DIMENSION', path, 'Output dimensions must be positive even integers.');
  }
}

function validateFrameRate(value: number, path: string, issues: ValidationIssue[]): void {
  if (!Number.isFinite(value) || value < MIN_FRAME_RATE || value > MAX_FRAME_RATE) {
    addError(issues, 'INVALID_FRAME_RATE', path, 'Frame rate must be from 1 to 60 fps.');
  }
}

function validateNormalizedRect(rect: Rect, path: string, issues: ValidationIssue[]): void {
  if (!isObject(rect)) {
    addError(issues, 'INVALID_LAYOUT', path, 'Layout box must be a normalized rectangle.');
    return;
  }
  validateNormalizedPoint(rect, path, issues);
  if (
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.width > 1 ||
    rect.height > 1 ||
    rect.x + rect.width > 1 + Number.EPSILON ||
    rect.y + rect.height > 1 + Number.EPSILON
  ) {
    addError(issues, 'INVALID_LAYOUT', path, 'Layout box must fit inside normalized 0..1 coordinates.');
  }
}

function validateNormalizedPoint(point: Point, path: string, issues: ValidationIssue[]): void {
  if (
    !isObject(point) ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.x > 1 ||
    point.y < 0 ||
    point.y > 1
  ) {
    addError(issues, 'INVALID_LAYOUT', path, 'Point must use normalized 0..1 coordinates.');
  }
}

function validateFinitePoint(point: Point, path: string, issues: ValidationIssue[]): void {
  if (!isObject(point) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    addError(issues, 'INVALID_LAYOUT', path, 'Position must contain finite normalized coordinates.');
  }
}

function validatePositiveTime(value: number, path: string, issues: ValidationIssue[]): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    addError(issues, 'INVALID_DURATION', path, 'Duration must be a positive safe integer in microseconds.');
  }
}

function validateNonNegativeTime(value: number, path: string, issues: ValidationIssue[]): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    addError(issues, 'INVALID_DURATION', path, 'Timestamp must be a non-negative safe integer in microseconds.');
  }
}

function validatePositiveFinite(
  value: number,
  path: string,
  issues: ValidationIssue[],
  label = 'Value',
): void {
  if (!Number.isFinite(value) || value <= 0) {
    addError(issues, 'INVALID_CLIP', path, `${label} must be a positive finite number.`);
  }
}

function validateNonNegativeFinite(
  value: number,
  path: string,
  issues: ValidationIssue[],
  label = 'Value',
  code: ValidationIssueCode = 'INVALID_AUDIO',
): void {
  if (!Number.isFinite(value) || value < 0) {
    addError(issues, code, path, `${label} must be a non-negative finite number.`);
  }
}

function resultFrom(issues: ValidationIssue[]): ValidationResult {
  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  return { valid: errors.length === 0, issues, errors, warnings };
}

function addError(
  issues: ValidationIssue[],
  code: ValidationIssueCode,
  path: string,
  message: string,
): void {
  issues.push({ code, severity: 'error', path, message });
}

function addWarning(
  issues: ValidationIssue[],
  code: ValidationIssueCode,
  path: string,
  message: string,
): void {
  issues.push({ code, severity: 'warning', path, message });
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value);
}

function isOutputShapeUsable(output: ProjectOutput): boolean {
  return isObject(output) && Number.isSafeInteger(output.durationUs);
}
