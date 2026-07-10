export type LayerFit = 'cover' | 'contain';
export type CompositorImageSource = CanvasImageSource & TexImageSource;

export interface CompositorLayer {
  source: CompositorImageSource;
  sourceWidth: number;
  sourceHeight: number;
  fit: LayerFit;
  box: { x: number; y: number; width: number; height: number };
  focalPoint: { x: number; y: number };
  alignment: { x: number; y: number };
  position: { x: number; y: number };
  scale: number;
  rotation: number;
  opacity: number;
  blur?: number;
  wipe?: {
    progress: number;
    direction: 'left' | 'right' | 'up' | 'down';
  };
}

export interface Compositor {
  readonly canvas: OffscreenCanvas;
  readonly backend: 'webgl2' | 'canvas2d';
  clear(color: string): void;
  draw(layer: CompositorLayer): void;
  finish(): void;
  dispose(): void;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Placement {
  source: Rect;
  destination: Rect;
}

const clamp = (value: number, min = 0, max = 1): number =>
  Math.min(max, Math.max(min, value));

const placementFor = (
  outputWidth: number,
  outputHeight: number,
  layer: CompositorLayer,
): Placement => {
  const sourceAspect = layer.sourceWidth / layer.sourceHeight;
  const focalX = clamp(layer.focalPoint.x);
  const focalY = clamp(layer.focalPoint.y);
  const scale = Math.max(0.0001, layer.scale);
  const box = {
    x: layer.box.x * outputWidth,
    y: layer.box.y * outputHeight,
    width: layer.box.width * outputWidth,
    height: layer.box.height * outputHeight,
  };
  const boxAspect = box.width / box.height;
  const translateX = layer.position.x * outputWidth;
  const translateY = layer.position.y * outputHeight;

  if (layer.fit === 'cover') {
    let sourceWidth = layer.sourceWidth;
    let sourceHeight = layer.sourceHeight;
    if (sourceAspect > boxAspect) {
      sourceWidth = layer.sourceHeight * boxAspect;
    } else {
      sourceHeight = layer.sourceWidth / boxAspect;
    }

    const maxX = layer.sourceWidth - sourceWidth;
    const maxY = layer.sourceHeight - sourceHeight;
    const destinationWidth = box.width * scale;
    const destinationHeight = box.height * scale;

    return {
      source: {
        x: maxX * focalX,
        y: maxY * focalY,
        width: sourceWidth,
        height: sourceHeight,
      },
      destination: {
        x: box.x + (box.width - destinationWidth) / 2 + translateX,
        y: box.y + (box.height - destinationHeight) / 2 + translateY,
        width: destinationWidth,
        height: destinationHeight,
      },
    };
  }

  const baseScale = sourceAspect > boxAspect
    ? box.width / layer.sourceWidth
    : box.height / layer.sourceHeight;
  const destinationWidth = layer.sourceWidth * baseScale * scale;
  const destinationHeight = layer.sourceHeight * baseScale * scale;
  return {
    source: { x: 0, y: 0, width: layer.sourceWidth, height: layer.sourceHeight },
    destination: {
      x: box.x + (box.width - destinationWidth) * clamp(layer.alignment.x) + translateX,
      y: box.y + (box.height - destinationHeight) * clamp(layer.alignment.y) + translateY,
      width: destinationWidth,
      height: destinationHeight,
    },
  };
};

const colorCache = new Map<string, [number, number, number, number]>();

const parseColor = (value: string): [number, number, number, number] => {
  const cached = colorCache.get(value);
  if (cached) return cached;
  const canvas = new OffscreenCanvas(1, 1);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return [0.125, 0.125, 0.125, 1];
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [r = 32, g = 32, b = 32, a = 255] = context.getImageData(0, 0, 1, 1).data;
  const parsed: [number, number, number, number] = [r / 255, g / 255, b / 255, a / 255];
  colorCache.set(value, parsed);
  return parsed;
};

class Canvas2DCompositor implements Compositor {
  readonly backend = 'canvas2d' as const;
  readonly canvas: OffscreenCanvas;
  private readonly context: OffscreenCanvasRenderingContext2D;

  constructor(width: number, height: number) {
    this.canvas = new OffscreenCanvas(width, height);
    const context = this.canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas 2D is not available.');
    this.context = context;
    this.context.imageSmoothingEnabled = true;
    this.context.imageSmoothingQuality = 'high';
  }

  clear(color: string): void {
    this.context.save();
    this.context.globalAlpha = 1;
    this.context.globalCompositeOperation = 'copy';
    this.context.fillStyle = color;
    this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.context.restore();
  }

  draw(layer: CompositorLayer): void {
    const { source, destination } = placementFor(this.canvas.width, this.canvas.height, layer);
    const context = this.context;
    context.save();
    context.globalAlpha = clamp(layer.opacity);
    context.filter = layer.blur ? `blur(${Math.max(0, layer.blur)}px)` : 'none';

    const centerX = destination.x + destination.width / 2;
    const centerY = destination.y + destination.height / 2;
    context.translate(centerX, centerY);
    context.rotate((layer.rotation * Math.PI) / 180);

    if (layer.wipe) {
      const progress = clamp(layer.wipe.progress);
      const localX = -destination.width / 2;
      const localY = -destination.height / 2;
      context.beginPath();
      if (layer.wipe.direction === 'left') {
        context.rect(localX + destination.width * (1 - progress), localY, destination.width * progress, destination.height);
      } else if (layer.wipe.direction === 'right') {
        context.rect(localX, localY, destination.width * progress, destination.height);
      } else if (layer.wipe.direction === 'up') {
        context.rect(localX, localY + destination.height * (1 - progress), destination.width, destination.height * progress);
      } else {
        context.rect(localX, localY, destination.width, destination.height * progress);
      }
      context.clip();
    }

    context.drawImage(
      layer.source,
      source.x,
      source.y,
      source.width,
      source.height,
      -destination.width / 2,
      -destination.height / 2,
      destination.width,
      destination.height,
    );
    context.restore();
  }

  finish(): void {}
  dispose(): void {}
}

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
in vec2 a_localCoord;
uniform vec2 u_resolution;
uniform vec2 u_center;
uniform float u_rotation;
out vec2 v_texCoord;
out vec2 v_localCoord;
void main() {
  vec2 centered = a_position - u_center;
  float c = cos(u_rotation);
  float s = sin(u_rotation);
  vec2 rotated = vec2(centered.x * c - centered.y * s, centered.x * s + centered.y * c) + u_center;
  vec2 zeroToOne = rotated / u_resolution;
  vec2 clip = zeroToOne * 2.0 - 1.0;
  gl_Position = vec4(clip * vec2(1.0, -1.0), 0.0, 1.0);
  v_texCoord = a_texCoord;
  v_localCoord = a_localCoord;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
uniform float u_opacity;
uniform float u_blur;
uniform vec2 u_texel;
uniform vec4 u_wipe;
in vec2 v_texCoord;
in vec2 v_localCoord;
out vec4 outColor;
void main() {
  if (u_wipe.x >= 0.0) {
    float progress = clamp(u_wipe.x, 0.0, 1.0);
    int direction = int(u_wipe.y);
    if ((direction == 0 && v_localCoord.x < 1.0 - progress) ||
        (direction == 1 && v_localCoord.x > progress) ||
        (direction == 2 && v_localCoord.y < 1.0 - progress) ||
        (direction == 3 && v_localCoord.y > progress)) discard;
  }
  vec4 color;
  if (u_blur > 0.0) {
    vec2 stepSize = u_texel * min(u_blur, 48.0) * 0.35;
    color = texture(u_texture, v_texCoord) * 0.20;
    color += texture(u_texture, v_texCoord + vec2(stepSize.x, 0.0)) * 0.12;
    color += texture(u_texture, v_texCoord - vec2(stepSize.x, 0.0)) * 0.12;
    color += texture(u_texture, v_texCoord + vec2(0.0, stepSize.y)) * 0.12;
    color += texture(u_texture, v_texCoord - vec2(0.0, stepSize.y)) * 0.12;
    color += texture(u_texture, v_texCoord + stepSize) * 0.08;
    color += texture(u_texture, v_texCoord - stepSize) * 0.08;
    color += texture(u_texture, v_texCoord + vec2(stepSize.x, -stepSize.y)) * 0.08;
    color += texture(u_texture, v_texCoord + vec2(-stepSize.x, stepSize.y)) * 0.08;
  } else {
    color = texture(u_texture, v_texCoord);
  }
  outColor = vec4(color.rgb, color.a * u_opacity);
}`;

class WebGL2Compositor implements Compositor {
  readonly backend = 'webgl2' as const;
  readonly canvas: OffscreenCanvas;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly positionBuffer: WebGLBuffer;
  private readonly texCoordBuffer: WebGLBuffer;
  private readonly localCoordBuffer: WebGLBuffer;
  private readonly texture: WebGLTexture;
  private readonly maxTextureSize: number;
  private scratchCanvas: OffscreenCanvas | undefined;
  private scratchContext: OffscreenCanvasRenderingContext2D | undefined;
  private readonly locations: {
    position: number;
    texCoord: number;
    localCoord: number;
    resolution: WebGLUniformLocation;
    center: WebGLUniformLocation;
    rotation: WebGLUniformLocation;
    opacity: WebGLUniformLocation;
    blur: WebGLUniformLocation;
    texel: WebGLUniformLocation;
    wipe: WebGLUniformLocation;
  };

  constructor(width: number, height: number) {
    this.canvas = new OffscreenCanvas(width, height);
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      desynchronized: true,
      preserveDrawingBuffer: false,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available.');
    this.gl = gl;
    this.program = this.createProgram(VERTEX_SHADER, FRAGMENT_SHADER);
    this.positionBuffer = gl.createBuffer() ?? this.fail('Unable to create WebGL position buffer.');
    this.texCoordBuffer = gl.createBuffer() ?? this.fail('Unable to create WebGL texture buffer.');
    this.localCoordBuffer = gl.createBuffer() ?? this.fail('Unable to create WebGL local-coordinate buffer.');
    this.texture = gl.createTexture() ?? this.fail('Unable to create WebGL texture.');
    this.maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));

    const uniform = (name: string): WebGLUniformLocation =>
      gl.getUniformLocation(this.program, name) ?? this.fail(`Missing WebGL uniform ${name}.`);
    this.locations = {
      position: gl.getAttribLocation(this.program, 'a_position'),
      texCoord: gl.getAttribLocation(this.program, 'a_texCoord'),
      localCoord: gl.getAttribLocation(this.program, 'a_localCoord'),
      resolution: uniform('u_resolution'),
      center: uniform('u_center'),
      rotation: uniform('u_rotation'),
      opacity: uniform('u_opacity'),
      blur: uniform('u_blur'),
      texel: uniform('u_texel'),
      wipe: uniform('u_wipe'),
    };

    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // The shader/blend function expects straight alpha. Let WebGL normalize
    // DOM/canvas sources to straight-alpha texels during upload.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.localCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 0, 1, 0, 0, 1,
      0, 1, 1, 0, 1, 1,
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.locations.localCoord);
    gl.vertexAttribPointer(this.locations.localCoord, 2, gl.FLOAT, false, 0, 0);
  }

  clear(color: string): void {
    const gl = this.gl;
    const [r, g, b, a] = parseColor(color);
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  draw(layer: CompositorLayer): void {
    const gl = this.gl;
    if (gl.isContextLost()) throw new Error('The WebGL2 GPU context was lost.');
    const effectiveLayer = this.textureSafeLayer(layer);
    const { source, destination } = placementFor(this.canvas.width, this.canvas.height, effectiveLayer);
    const x1 = destination.x;
    const y1 = destination.y;
    const x2 = destination.x + destination.width;
    const y2 = destination.y + destination.height;

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      x1, y1, x2, y1, x1, y2,
      x1, y2, x2, y1, x2, y2,
    ]), gl.STREAM_DRAW);
    gl.enableVertexAttribArray(this.locations.position);
    gl.vertexAttribPointer(this.locations.position, 2, gl.FLOAT, false, 0, 0);

    const u1 = source.x / effectiveLayer.sourceWidth;
    const v1 = source.y / effectiveLayer.sourceHeight;
    const u2 = (source.x + source.width) / effectiveLayer.sourceWidth;
    const v2 = (source.y + source.height) / effectiveLayer.sourceHeight;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      u1, v1, u2, v1, u1, v2,
      u1, v2, u2, v1, u2, v2,
    ]), gl.STREAM_DRAW);
    gl.enableVertexAttribArray(this.locations.texCoord);
    gl.vertexAttribPointer(this.locations.texCoord, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, effectiveLayer.source);
    if (effectiveLayer !== layer) {
      const uploadError = gl.getError();
      if (uploadError !== gl.NO_ERROR) {
        throw new Error(`WebGL texture upload failed with error 0x${uploadError.toString(16)}.`);
      }
    }
    gl.uniform2f(this.locations.resolution, this.canvas.width, this.canvas.height);
    gl.uniform2f(this.locations.center, x1 + destination.width / 2, y1 + destination.height / 2);
    gl.uniform1f(this.locations.rotation, (effectiveLayer.rotation * Math.PI) / 180);
    gl.uniform1f(this.locations.opacity, clamp(effectiveLayer.opacity));
    gl.uniform1f(this.locations.blur, Math.max(0, effectiveLayer.blur ?? 0));
    gl.uniform2f(this.locations.texel, 1 / effectiveLayer.sourceWidth, 1 / effectiveLayer.sourceHeight);

    const direction = effectiveLayer.wipe?.direction === 'left' ? 0
      : effectiveLayer.wipe?.direction === 'right' ? 1
        : effectiveLayer.wipe?.direction === 'up' ? 2 : 3;
    gl.uniform4f(
      this.locations.wipe,
      effectiveLayer.wipe ? clamp(effectiveLayer.wipe.progress) : -1,
      direction,
      0,
      0,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  finish(): void {
    if (this.gl.isContextLost()) throw new Error('The WebGL2 GPU context was lost.');
    this.gl.flush();
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.texture);
    gl.deleteBuffer(this.positionBuffer);
    gl.deleteBuffer(this.texCoordBuffer);
    gl.deleteBuffer(this.localCoordBuffer);
    gl.deleteProgram(this.program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  private createProgram(vertexSource: string, fragmentSource: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type) ?? this.fail('Unable to create WebGL shader.');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader) ?? 'Unknown shader compilation failure.';
        gl.deleteShader(shader);
        throw new Error(message);
      }
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram() ?? this.fail('Unable to create WebGL program.');
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) ?? 'Unknown WebGL program link failure.';
      gl.deleteProgram(program);
      throw new Error(message);
    }
    return program;
  }

  private textureSafeLayer(layer: CompositorLayer): CompositorLayer {
    if (
      layer.sourceWidth <= this.maxTextureSize &&
      layer.sourceHeight <= this.maxTextureSize
    ) return layer;

    const scale = Math.min(
      this.maxTextureSize / layer.sourceWidth,
      this.maxTextureSize / layer.sourceHeight,
    );
    const width = Math.max(1, Math.floor(layer.sourceWidth * scale));
    const height = Math.max(1, Math.floor(layer.sourceHeight * scale));
    if (!this.scratchCanvas) {
      this.scratchCanvas = new OffscreenCanvas(width, height);
      const context = this.scratchCanvas.getContext('2d', { alpha: true });
      if (!context) this.fail('Unable to create a source-resampling canvas.');
      this.scratchContext = context;
    } else if (this.scratchCanvas.width !== width || this.scratchCanvas.height !== height) {
      this.scratchCanvas.width = width;
      this.scratchCanvas.height = height;
    }
    const context = this.scratchContext!;
    context.clearRect(0, 0, width, height);
    context.drawImage(layer.source, 0, 0, width, height);
    return {
      ...layer,
      source: this.scratchCanvas as CompositorImageSource,
      sourceWidth: width,
      sourceHeight: height,
    };
  }

  private fail(message: string): never {
    throw new Error(message);
  }
}

export const createCompositor = (
  width: number,
  height: number,
  preference: 'auto' | 'webgl2' | 'canvas2d' = 'auto',
): Compositor => {
  if (preference !== 'canvas2d') {
    try {
      return new WebGL2Compositor(width, height);
    } catch (error) {
      if (preference === 'webgl2') throw error;
    }
  }
  return new Canvas2DCompositor(width, height);
};

export const __private__ = { placementFor, parseColor };
