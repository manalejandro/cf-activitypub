/**
 * Shared simulation for the two rendering layers of `FieldBackground`.
 *
 * The Canvas2D floor and the WebGPU upgrade must move identically: the GPU
 * layer replaces the renderer, never the field. Keeping the seeding, the flow
 * angle, the advection and the link neighbourhood here means a dot budget, a
 * wrap rule or a palette change can never drift between them.
 */

export const FIELD_TAU = Math.PI * 2;

/** Hard ceiling for the dot budget (a coarse pointer gets half). */
export const FIELD_MAX_DOTS = 190;

/**
 * Angle of the flow at a point: layered trig instead of a noise texture, which
 * keeps the bundle at zero and is smooth enough at this speed.
 */
export function fieldAngle(x: number, y: number, t: number): number {
  return (
    Math.sin(x * 0.85 + t * 0.55) * 0.62 +
    Math.cos(y * 1.05 - t * 0.4) * 0.58 +
    Math.sin((x + y) * 0.45 + t * 0.22) * 0.34
  );
}

export interface FieldDot {
  x: number;
  y: number;
  /** Per-dot phase and speed so the field never looks like a grid marching. */
  phase: number;
  speed: number;
  r: number;
}

export interface SeedFieldOptions {
  /** Dots per 10,000 px²; the caller clamps it. */
  density: number;
  /** Coarse pointers get half the dots: a finger never sees the difference. */
  coarse: boolean;
}

/** Seed a jittered grid: no clumps and no empty holes, unlike uniform random. */
export function seedField(width: number, height: number, { density, coarse }: SeedFieldOptions): FieldDot[] {
  const area = Math.max(1, width * height);
  const budget = coarse ? FIELD_MAX_DOTS / 2 : FIELD_MAX_DOTS;
  const count = Math.max(12, Math.min(budget, Math.round((area / 10_000) * (coarse ? density / 2 : density))));
  const cols = Math.max(1, Math.round(Math.sqrt((count * width) / Math.max(1, height))));
  const rows = Math.max(1, Math.ceil(count / cols));
  const jitter = Math.min(width / cols, height / rows) * 0.42;

  return Array.from({ length: count }, (_, i): FieldDot => {
    const cx = ((i % cols) + 0.5) * (width / cols);
    const cy = (Math.floor(i / cols) + 0.5) * (height / rows);
    return {
      x: cx + (Math.random() - 0.5) * jitter * 2,
      y: cy + (Math.random() - 0.5) * jitter * 2,
      phase: Math.random() * FIELD_TAU,
      speed: 0.55 + Math.random() * 0.75,
      r: 0.7 + Math.random() * 1.5,
    };
  });
}

/** Advect along the flow, wrapping around the edges so the field is endless. */
export function advectField(dots: FieldDot[], width: number, height: number, t: number): void {
  for (const d of dots) {
    const a = fieldAngle(d.x / 190, d.y / 190, t * 0.35 + d.phase);
    d.x += Math.cos(a) * d.speed * 0.35;
    d.y += Math.sin(a) * d.speed * 0.35;
    if (d.x < -20) d.x = width + 20;
    else if (d.x > width + 20) d.x = -20;
    if (d.y < -20) d.y = height + 20;
    else if (d.y > height + 20) d.y = -20;
  }
}

/**
 * Pairs of dot indices closer than `maxDist`, collected through a spatial
 * bucket so linking stays linear instead of O(n²) per frame. The caller owns
 * the output array and reuses it across frames.
 *
 * Coordinates are world-space: both renderers apply the pointer parallax as a
 * uniform offset, so moving the pointer never rebuilds the neighbourhood.
 */
export function collectFieldLinks(dots: FieldDot[], maxDist: number, out: number[] = []): number[] {
  out.length = 0;
  const cell = Math.max(1, maxDist);
  const buckets = new Map<number, number[]>();

  for (let i = 0; i < dots.length; i++) {
    const d = dots[i];
    const key = Math.floor(d.x / cell) * 100000 + Math.floor(d.y / cell);
    const list = buckets.get(key);
    if (list) list.push(i);
    else buckets.set(key, [i]);
  }

  for (let i = 0; i < dots.length; i++) {
    const a = dots[i];
    const gx = Math.floor(a.x / cell);
    const gy = Math.floor(a.y / cell);
    for (let ox = 0; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        if (ox === 0 && oy < 0) continue;
        const list = buckets.get((gx + ox) * 100000 + (gy + oy));
        if (!list) continue;
        for (const j of list) {
          if (j <= i) continue;
          const b = dots[j];
          if (Math.hypot(a.x - b.x, a.y - b.y) > maxDist) continue;
          out.push(i, j);
        }
      }
    }
  }

  return out;
}

export type RGB = readonly [number, number, number];

/**
 * Resolve a CSS custom-property colour to unit RGB for the GPU layer.
 *
 * The tokens are hex (`#4f46e5`) and the custom palettes derive hex from HSL,
 * so the parser covers hex and `rgb()/rgba()` and falls back to the caller's
 * default for anything else rather than throwing inside a render loop.
 */
export function parseCssColor(value: string, fallback: RGB): RGB {
  const text = (value ?? "").trim();

  const hex = /^#([0-9a-f]{3,8})$/i.exec(text);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      const [r, g, b] = digits.split("").map((c) => parseInt(c + c, 16));
      return [r / 255, g / 255, b / 255];
    }
    if (digits.length === 6 || digits.length === 8) {
      return [
        parseInt(digits.slice(0, 2), 16) / 255,
        parseInt(digits.slice(2, 4), 16) / 255,
        parseInt(digits.slice(4, 6), 16) / 255,
      ];
    }
    return fallback;
  }

  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text);
  if (rgb) {
    return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255];
  }

  return fallback;
}
