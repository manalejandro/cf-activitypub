"use client";

import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";

/**
 * The instance's signature background: a slow flow field of dots linked by
 * faint vectors, drawn behind the content of the public pages.
 *
 * Two layers, deliberately:
 *  - this Canvas2D field, which ships with **no dependencies** and runs
 *    everywhere;
 *  - a WebGPU upgrade (`@use-gpu/*`, instanced points + a WGSL flow field) that
 *    only mounts when `navigator.gpu` exists AND the packages are installed.
 *    use.gpu is WebGPU-only with no WebGL fallback, so this layer is not a
 *    progressive enhancement of the GPU one — it is the floor it stands on.
 *
 * Cost discipline (this sits on the pages everybody loads first):
 *  - the dot budget is area-based and capped, halved on coarse pointers;
 *  - DPR is capped at 2 (3 on phones is invisible and 2.25x the fill);
 *  - it stops on `prefers-reduced-motion` (one static frame), when the tab is
 *    hidden, and when the element scrolls out of view;
 *  - colours are read from the CSS custom properties, so an installed palette
 *    (`lib/palettes.ts`) retints it without a code change.
 */
export interface FieldBackgroundProps {
  /** Dots per 10,000 px², clamped to [4, 60]. */
  density?: number;
  /** Master opacity, clamped to [0, 1]. Keep it low: text sits on top. */
  opacity?: number;
  /** Draw the faint segments between near dots. */
  links?: boolean;
  /** Distance (px) under which two dots get linked. */
  linkDistance?: number;
  /** Small pointer parallax. */
  parallax?: boolean;
  className?: string;
  style?: CSSProperties;
}

const TAU = Math.PI * 2;
const MAX_DPR = 2;
const MAX_DOTS = 190;

/**
 * Angle of the flow at a point: layered trig instead of a noise texture, which
 * keeps the bundle at zero and is smooth enough at this speed.
 */
function fieldAngle(x: number, y: number, t: number): number {
  return (
    Math.sin(x * 0.85 + t * 0.55) * 0.62 +
    Math.cos(y * 1.05 - t * 0.4) * 0.58 +
    Math.sin((x + y) * 0.45 + t * 0.22) * 0.34
  );
}

interface Dot {
  x: number;
  y: number;
  /** Per-dot phase and speed so the field never looks like a grid marching. */
  phase: number;
  speed: number;
  r: number;
}

export function FieldBackground({
  density = 16,
  opacity = 0.5,
  links = true,
  linkDistance = 96,
  parallax = true,
  className,
  style,
}: FieldBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    // No 2D context (jsdom, a locked-down browser, a failed canvas): the
    // element stays an inert, invisible layer instead of throwing.
    if (!ctx) return;

    const clampOpacity = Math.min(1, Math.max(0, opacity));
    const clampDensity = Math.min(60, Math.max(4, density));
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const coarse =
      typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

    let dots: Dot[] = [];
    let width = 0;
    let height = 0;
    let dpr = 1;
    let raf = 0;
    let running = false;
    let visible = true;
    let pointerX = 0;
    let pointerY = 0;
    let accent = "#4f46e5";
    let muted = "#6c737f";

    const readColors = () => {
      const styles = getComputedStyle(wrap);
      accent = styles.getPropertyValue("--accent").trim() || accent;
      muted = styles.getPropertyValue("--text-muted").trim() || muted;
    };

    const seed = () => {
      const area = Math.max(1, width * height);
      const budget = coarse ? MAX_DOTS / 2 : MAX_DOTS;
      const count = Math.max(12, Math.min(budget, Math.round((area / 10_000) * (coarse ? clampDensity / 2 : clampDensity))));
      dots = new Array(count).fill(null).map((_, i) => {
        // A jittered grid beats uniform random: no clumps, no empty holes.
        const cols = Math.max(1, Math.round(Math.sqrt((count * width) / Math.max(1, height))));
        const rows = Math.max(1, Math.ceil(count / cols));
        const cx = ((i % cols) + 0.5) * (width / cols);
        const cy = (Math.floor(i / cols) + 0.5) * (height / rows);
        const jitter = Math.min(width / cols, height / rows) * 0.42;
        return {
          x: cx + (Math.random() - 0.5) * jitter * 2,
          y: cy + (Math.random() - 0.5) * jitter * 2,
          phase: Math.random() * TAU,
          speed: 0.55 + Math.random() * 0.75,
          r: 0.7 + Math.random() * 1.5,
        };
      });
    };

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      dpr = Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio || 1));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
      readColors();
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      ctx.globalAlpha = clampOpacity;
      const px = parallax ? pointerX * 10 : 0;
      const py = parallax ? pointerY * 10 : 0;
      const maxDist = Math.max(24, linkDistance);

      if (links) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = muted;
        const cell = maxDist;
        // Bucket the dots so linking stays linear instead of O(n^2) per frame.
        const buckets = new Map<number, number[]>();
        for (let i = 0; i < dots.length; i++) {
          const d = dots[i];
          const key = Math.floor((d.x + px) / cell) * 100000 + Math.floor((d.y + py) / cell);
          const list = buckets.get(key);
          if (list) list.push(i);
          else buckets.set(key, [i]);
        }
        ctx.globalAlpha = clampOpacity * 0.22;
        ctx.beginPath();
        for (let i = 0; i < dots.length; i++) {
          const a = dots[i];
          const gx = Math.floor((a.x + px) / cell);
          const gy = Math.floor((a.y + py) / cell);
          for (let ox = 0; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
              if (ox === 0 && oy < 0) continue;
              const list = buckets.get((gx + ox) * 100000 + (gy + oy));
              if (!list) continue;
              for (const j of list) {
                if (j <= i) continue;
                const b = dots[j];
                const dx = a.x - b.x;
                const dy = a.y - b.y;
                const dist = Math.hypot(dx, dy);
                if (dist > maxDist) continue;
                ctx.moveTo(a.x + px, a.y + py);
                ctx.lineTo(b.x + px, b.y + py);
              }
            }
          }
        }
        ctx.stroke();
      }

      ctx.fillStyle = accent;
      ctx.globalAlpha = clampOpacity * 0.75;
      ctx.beginPath();
      for (const d of dots) {
        ctx.moveTo(d.x + px + d.r, d.y + py);
        ctx.arc(d.x + px, d.y + py, d.r, 0, TAU);
      }
      ctx.fill();
      ctx.globalAlpha = 1;
    };

    const step = (now: number) => {
      if (!running) return;
      const t = now / 1000;
      // Advect along the flow; wrap around the edges so the field is endless.
      for (const d of dots) {
        const a = fieldAngle(d.x / 190, d.y / 190, t * 0.35 + d.phase);
        d.x += Math.cos(a) * d.speed * 0.35;
        d.y += Math.sin(a) * d.speed * 0.35;
        if (d.x < -20) d.x = width + 20;
        else if (d.x > width + 20) d.x = -20;
        if (d.y < -20) d.y = height + 20;
        else if (d.y > height + 20) d.y = -20;
      }
      draw();
      raf = requestAnimationFrame(step);
    };

    const start = () => {
      if (running || reduceMotion || !visible || document.hidden) return;
      running = true;
      raf = requestAnimationFrame(step);
    };
    const stop = () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    const onPointer = (e: PointerEvent) => {
      const rect = wrap.getBoundingClientRect();
      pointerX = ((e.clientX - rect.left) / Math.max(1, rect.width) - 0.5) * 2;
      pointerY = ((e.clientY - rect.top) / Math.max(1, rect.height) - 0.5) * 2;
    };

    resize();
    // Reduced motion: one composed still frame, no animation loop at all.
    draw();
    if (!reduceMotion) start();

    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
      resize();
      if (reduceMotion) draw();
    }) : null;
    ro?.observe(wrap);

    const io = typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver((entries) => {
          visible = entries[0]?.isIntersecting ?? true;
          if (visible) start();
          else stop();
        }, { threshold: 0 })
      : null;
    io?.observe(wrap);

    document.addEventListener("visibilitychange", onVisibility);
    if (parallax && !reduceMotion) window.addEventListener("pointermove", onPointer, { passive: true });

    return () => {
      stop();
      ro?.disconnect();
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointermove", onPointer);
    };
  }, [density, opacity, links, linkDistance, parallax]);

  return (
    <div
      ref={wrapRef}
      aria-hidden="true"
      className={className}
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        overflow: "hidden",
        zIndex: 0,
        ...style,
      }}
    >
      <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: "100%" }} />
    </div>
  );
}

export default FieldBackground;
