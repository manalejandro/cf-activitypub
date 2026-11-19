"use client";

import type { FieldDot, RGB } from "./field-background-sim";

/**
 * WebGPU renderer for `FieldBackground` — the upgrade layer, never the floor.
 *
 * `@use-gpu/*` is WebGPU-only with no WebGL fallback, so this module is
 * imported dynamically only after the Canvas2D layer is already drawing and
 * only when `navigator.gpu` exists. It replaces the *renderer*: the field
 * simulation (seeding, advection, links) stays in `field-background-sim.ts`
 * and is shared with the Canvas2D path, so a device loss can hand the same
 * dots back to the 2D layer without a visual jump.
 *
 * Only `@use-gpu/webgpu/mjs/web.mjs` is imported (adapter + device mounting);
 * the barrel re-exports React/Live components that this layer does not use.
 */

export interface GPUFieldStyle {
  accent: RGB;
  muted: RGB;
  /** Master opacity, already clamped by the caller. */
  opacity: number;
}

export interface GPUFieldOptions {
  width: number;
  height: number;
  dpr: number;
  links: boolean;
  style: GPUFieldStyle;
}

export interface GPUField {
  resize(width: number, height: number, dpr: number): void;
  setStyle(style: GPUFieldStyle): void;
  /** `links` is a flat list of dot-index pairs from `collectFieldLinks`. */
  draw(dots: FieldDot[], links: number[], px: number, py: number): void;
  destroy(): void;
}

const SHADER = /* wgsl */ `
struct Uniforms {
  resolution: vec2f,
  offset: vec2f,
  accent: vec4f,
  muted: vec4f,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct PointOut {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
};

@vertex
fn vsPoint(
  @builtin(vertex_index) vertexIndex: u32,
  @location(0) center: vec2f,
  @location(1) radius: f32,
) -> PointOut {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let corner = corners[vertexIndex];
  // One extra pixel so the anti-aliased edge is never clipped.
  let p = center + u.offset + corner * (radius + 1.0);

  var out: PointOut;
  out.position = vec4f(
    p.x / u.resolution.x * 2.0 - 1.0,
    1.0 - p.y / u.resolution.y * 2.0,
    0.0,
    1.0,
  );
  out.local = corner;
  return out;
}

@fragment
fn fsPoint(in: PointOut) -> @location(0) vec4f {
  let alpha = smoothstep(1.0, 0.4, length(in.local)) * u.accent.a;
  return vec4f(u.accent.rgb * alpha, alpha);
}

@vertex
fn vsLine(@builtin(vertex_index) vertexIndex: u32, @location(0) p: vec2f) -> @builtin(position) vec4f {
  let q = p + u.offset;
  return vec4f(
    q.x / u.resolution.x * 2.0 - 1.0,
    1.0 - q.y / u.resolution.y * 2.0,
    0.0,
    1.0,
  );
}

@fragment
fn fsLine() -> @location(0) vec4f {
  return vec4f(u.muted.rgb * u.muted.a, u.muted.a);
}
`;

const UNIFORM_FLOATS = 12;

export async function mountGPUField(
  canvas: HTMLCanvasElement,
  options: GPUFieldOptions,
  onLost: () => void
): Promise<GPUField> {
  const { getGPUAdapter, mountGPUDevice, makePresentationContext } = await import(
    "@use-gpu/webgpu/mjs/web.mjs"
  );

  const adapter = await getGPUAdapter();
  const { device } = await mountGPUDevice(adapter, { required: [], optional: [], limits: {} });

  const format = navigator.gpu.getPreferredCanvasFormat();
  // `makePresentationContext` is the library's own canvas setup (context +
  // `configure` with RENDER_ATTACHMENT|COPY_DST|COPY_SRC and premultiplied
  // alpha). It throws when the canvas cannot take a WebGPU context, which is
  // exactly the case the caller falls back to Canvas2D on.
  let context: GPUCanvasContext;
  try {
    context = makePresentationContext(device, canvas, format);
  } catch (err) {
    device.destroy();
    throw err;
  }

  const shaderModule = device.createShaderModule({ code: SHADER });

  // Canvas output is premultiplied, so the source factor is `one`.
  const blend: GPUBlendState = {
    color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  };

  const pointPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: shaderModule,
      entryPoint: "vsPoint",
      buffers: [
        {
          arrayStride: 12,
          stepMode: "instance",
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },
            { shaderLocation: 1, offset: 8, format: "float32" },
          ],
        },
      ],
    },
    fragment: { module: shaderModule, entryPoint: "fsPoint", targets: [{ format, blend }] },
    primitive: { topology: "triangle-list" },
  });

  const linkPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: shaderModule,
      entryPoint: "vsLine",
      buffers: [
        {
          arrayStride: 8,
          stepMode: "vertex",
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
        },
      ],
    },
    fragment: { module: shaderModule, entryPoint: "fsLine", targets: [{ format, blend }] },
    primitive: { topology: "line-list" },
  });

  const uniforms = new Float32Array(UNIFORM_FLOATS);
  const uniformBuffer = device.createBuffer({
    size: uniforms.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const bindGroup = device.createBindGroup({
    layout: pointPipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  let pointBuffer = device.createBuffer({
    size: 12 * 4,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  let linkBuffer = device.createBuffer({
    size: 16 * 4,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  let pointData = new Float32Array(0);
  let linkData = new Float32Array(0);

  let width = Math.max(1, options.width);
  let height = Math.max(1, options.height);
  let style = options.style;
  const linksEnabled = options.links;
  let destroyed = false;

  const applySize = (nextWidth: number, nextHeight: number, dpr: number) => {
    width = Math.max(1, nextWidth);
    height = Math.max(1, nextHeight);
    const ratio = Math.min(2, Math.max(1, dpr));
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  };
  applySize(width, height, options.dpr);

  const fit = (buffer: GPUBuffer, bytes: number): GPUBuffer => {
    if (buffer.size >= bytes) return buffer;
    buffer.destroy();
    return device.createBuffer({
      size: Math.max(bytes, 1024),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  };

  const grow = (array: Float32Array<ArrayBuffer>, length: number): Float32Array<ArrayBuffer> =>
    array.length >= length ? array : new Float32Array(length);

  // A lost device is not an error to surface: the component hands the field
  // back to the Canvas2D floor. `destroy()` also resolves this promise, so
  // the flag keeps a deliberate teardown from looking like a loss.
  device.lost.then(() => {
    if (destroyed) return;
    destroyed = true;
    onLost();
  });

  const draw = (dots: FieldDot[], links: number[], px: number, py: number) => {
    if (destroyed) return;

    uniforms[0] = width;
    uniforms[1] = height;
    uniforms[2] = px;
    uniforms[3] = py;
    uniforms[4] = style.accent[0];
    uniforms[5] = style.accent[1];
    uniforms[6] = style.accent[2];
    uniforms[7] = style.opacity * 0.75;
    uniforms[8] = style.muted[0];
    uniforms[9] = style.muted[1];
    uniforms[10] = style.muted[2];
    uniforms[11] = style.opacity * 0.22;
    device.queue.writeBuffer(uniformBuffer, 0, uniforms);

    const pointFloats = dots.length * 3;
    pointData = grow(pointData, pointFloats);
    for (let i = 0; i < dots.length; i++) {
      const d = dots[i];
      pointData[i * 3] = d.x;
      pointData[i * 3 + 1] = d.y;
      pointData[i * 3 + 2] = d.r;
    }
    pointBuffer = fit(pointBuffer, pointFloats * 4);
    device.queue.writeBuffer(pointBuffer, 0, pointData, 0, pointFloats);

    const linkCount = linksEnabled ? Math.floor(links.length / 2) : 0;
    if (linkCount > 0) {
      const linkFloats = linkCount * 4;
      linkData = grow(linkData, linkFloats);
      for (let k = 0; k < linkCount; k++) {
        const a = dots[links[k * 2]];
        const b = dots[links[k * 2 + 1]];
        linkData[k * 4] = a.x;
        linkData[k * 4 + 1] = a.y;
        linkData[k * 4 + 2] = b.x;
        linkData[k * 4 + 3] = b.y;
      }
      linkBuffer = fit(linkBuffer, linkFloats * 4);
      device.queue.writeBuffer(linkBuffer, 0, linkData, 0, linkFloats);
    }

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });

    if (linkCount > 0) {
      pass.setPipeline(linkPipeline);
      pass.setBindGroup(0, bindGroup);
      pass.setVertexBuffer(0, linkBuffer);
      pass.draw(linkCount * 2);
    }
    if (dots.length > 0) {
      pass.setPipeline(pointPipeline);
      pass.setBindGroup(0, bindGroup);
      pass.setVertexBuffer(0, pointBuffer);
      pass.draw(6, dots.length);
    }

    pass.end();
    device.queue.submit([encoder.finish()]);
  };

  return {
    resize(nextWidth, nextHeight, dpr) {
      if (destroyed) return;
      applySize(nextWidth, nextHeight, dpr);
    },
    setStyle(next) {
      style = next;
    },
    draw,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      context.unconfigure();
      device.destroy();
    },
  };
}
