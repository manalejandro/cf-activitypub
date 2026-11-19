"use client";

import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import {
  FIELD_TAU,
  advectField,
  collectFieldLinks,
  parseCssColor,
  seedField,
} from "./field-background-sim";
import type { FieldDot, RGB } from "./field-background-sim";
import type { GPUField } from "./field-background-gpu";

/**
 * The instance's signature background: a slow flow field of dots linked by
 * faint vectors, drawn behind the content of the public pages.
 *
 * Two layers, deliberately:
 *  - a Canvas2D field that ships with **no dependencies** and runs everywhere;
 *  - a WebGPU upgrade (`@use-gpu/webgpu`, instanced points + a WGSL flow
 *    field) that only mounts when `navigator.gpu` exists. use.gpu is
 *    WebGPU-only with no WebGL fallback, so the 2D layer is not a progressive
 *    enhancement of the GPU one — it is the floor it stands on, and a lost
 *    device hands the same dots back to it.
 *
 * Both layers run the same simulation (`field-background-sim.ts`); only the
 * drawing differs.
 *
 * Cost discipline (this sits on the pages everybody loads first):
 *  - the dot budget is area-based and capped, halved on coarse pointers;
 *  - DPR is capped at 2 (3 on phones is invisible and 2.25x the fill);
 *  - it stops on `prefers-reduced-motion` (one static frame, no GPU download),
 *    when the tab is hidden, and when the element scrolls out of view;
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
  /**
   * Only run above this viewport width. The app's ambient layer is fixed
   * behind the content columns and can only be seen in the outer gutters,
   * which do not exist below ~1160px — animating a canvas nobody can see is
   * pure battery. Unset means "always".
   */
  minWidth?: number;
  className?: string;
  style?: CSSProperties;
}

const MAX_DPR = 2;
const DEFAULT_ACCENT: RGB = [79 / 255, 70 / 255, 229 / 255];
const DEFAULT_MUTED: RGB = [108 / 255, 115 / 255, 127 / 255];

export function FieldBackground({
  density = 16,
  opacity = 0.5,
  links = true,
  linkDistance = 96,
  parallax = true,
  minWidth,
  className,
  style,
}: FieldBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gpuCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const gpuCanvas = gpuCanvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    // No 2D context (jsdom, a locked-down browser, a failed canvas): the
    // element stays an inert, invisible layer instead of throwing, and the
    // GPU layer is not attempted — it upgrades a working floor, never replaces
    // one.
    if (!ctx) return;

    const clampOpacity = Math.min(1, Math.max(0, opacity));
    const clampDensity = Math.min(60, Math.max(4, density));
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const coarse =
      typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
    const maxDist = Math.max(24, linkDistance);
    // A width gate keeps the ambient layer (fixed behind the app grid) from
    // burning frames where it is hidden behind the content band.
    const wideQuery =
      minWidth && typeof window.matchMedia === "function"
        ? window.matchMedia(`(min-width: ${minWidth}px)`)
        : null;
    let wideEnough = !wideQuery || wideQuery.matches;

    let dots: FieldDot[] = [];
    // Reused every frame so linking allocates nothing.
    const linkIndices: number[] = [];
    let width = 0;
    let height = 0;
    let dpr = 1;
    let raf = 0;
    let running = false;
    let visible = true;
    let cancelled = false;
    let pointerX = 0;
    let pointerY = 0;
    let accent = "#4f46e5";
    let muted = "#6c737f";
    let accentRgb: RGB = DEFAULT_ACCENT;
    let mutedRgb: RGB = DEFAULT_MUTED;
    let gpu: GPUField | null = null;
    let gpuRequested = false;

    const readColors = () => {
      const styles = getComputedStyle(wrap);
      accent = styles.getPropertyValue("--accent").trim() || accent;
      muted = styles.getPropertyValue("--text-muted").trim() || muted;
      accentRgb = parseCssColor(accent, DEFAULT_ACCENT);
      mutedRgb = parseCssColor(muted, DEFAULT_MUTED);
      gpu?.setStyle({ accent: accentRgb, muted: mutedRgb, opacity: clampOpacity });
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
      dots = seedField(width, height, { density: clampDensity, coarse });
      readColors();
      gpu?.resize(width, height, dpr);
    };

    const syncLinks = () => {
      if (links) collectFieldLinks(dots, maxDist, linkIndices);
      else linkIndices.length = 0;
    };

    const draw2d = (px: number, py: number) => {
      ctx.clearRect(0, 0, width, height);
      ctx.globalAlpha = clampOpacity;

      if (links && linkIndices.length) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = muted;
        ctx.globalAlpha = clampOpacity * 0.22;
        ctx.beginPath();
        for (let k = 0; k < linkIndices.length; k += 2) {
          const a = dots[linkIndices[k]];
          const b = dots[linkIndices[k + 1]];
          ctx.moveTo(a.x + px, a.y + py);
          ctx.lineTo(b.x + px, b.y + py);
        }
        ctx.stroke();
      }

      ctx.fillStyle = accent;
      ctx.globalAlpha = clampOpacity * 0.75;
      ctx.beginPath();
      for (const d of dots) {
        ctx.moveTo(d.x + px + d.r, d.y + py);
        ctx.arc(d.x + px, d.y + py, d.r, 0, FIELD_TAU);
      }
      ctx.fill();
      ctx.globalAlpha = 1;
    };

    const frame = () => {
      if (!wideEnough) return;
      const px = parallax ? pointerX * 10 : 0;
      const py = parallax ? pointerY * 10 : 0;
      syncLinks();
      if (gpu) gpu.draw(dots, linkIndices, px, py);
      else draw2d(px, py);
    };

    const stop = () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    const step = (now: number) => {
      if (!running) return;
      advectField(dots, width, height, now / 1000);
      frame();
      raf = requestAnimationFrame(step);
    };

    const start = () => {
      if (running || reduceMotion || !visible || document.hidden || !wideEnough) return;
      running = true;
      raf = requestAnimationFrame(step);
    };

    /** A lost device (or a failed mount) returns the field to the 2D floor. */
    const restore2d = () => {
      gpu = null;
      if (gpuCanvas) gpuCanvas.style.display = "none";
      canvas.style.display = "block";
      frame();
      start();
    };

    const mountGpu = async () => {
      if (gpuRequested || reduceMotion || !gpuCanvas || !wideEnough) return;
      gpuRequested = true;
      if (typeof navigator === "undefined" || !navigator.gpu) return;

      let field: GPUField | null = null;
      try {
        const { mountGPUField } = await import("./field-background-gpu");
        field = await mountGPUField(
          gpuCanvas,
          {
            width,
            height,
            dpr,
            links,
            style: { accent: accentRgb, muted: mutedRgb, opacity: clampOpacity },
          },
          () => {
            if (!cancelled) restore2d();
          }
        );
      } catch {
        field = null;
      }

      if (cancelled) {
        field?.destroy();
        return;
      }
      if (!field) return;

      gpu = field;
      canvas.style.display = "none";
      gpuCanvas.style.display = "block";
      // The loop may be paused (hidden tab, off-screen, still frame): draw the
      // first GPU frame now so swapping the canvases never leaves a blank.
      frame();
    };

    resize();
    // Reduced motion: one composed still frame, no animation loop and no GPU
    // download at all.
    frame();
    if (!reduceMotion) start();
    void mountGpu();

    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
      resize();
      // While running, the next frame repaints at the new size; a paused or
      // reduced-motion layer needs the explicit repaint.
      if (!running) frame();
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

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    const onPointer = (e: PointerEvent) => {
      const rect = wrap.getBoundingClientRect();
      pointerX = ((e.clientX - rect.left) / Math.max(1, rect.width) - 0.5) * 2;
      pointerY = ((e.clientY - rect.top) / Math.max(1, rect.height) - 0.5) * 2;
    };
    // The palette lands on the root (`PaletteApplier`), possibly after this
    // effect ran: re-read the tokens so the field wears the user's accent
    // instead of the mount-time default.
    const onPalette = () => {
      readColors();
      if (!running) frame();
    };
    const themeObserver =
      typeof MutationObserver !== "undefined" ? new MutationObserver(onPalette) : null;
    themeObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "style"],
    });
    const onWideChange = () => {
      wideEnough = wideQuery?.matches ?? true;
      if (!wideEnough) {
        stop();
        return;
      }
      resize();
      frame();
      void mountGpu();
      start();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("cf-ap:palette-change", onPalette);
    wideQuery?.addEventListener("change", onWideChange);
    if (parallax && !reduceMotion) window.addEventListener("pointermove", onPointer, { passive: true });

    return () => {
      cancelled = true;
      stop();
      gpu?.destroy();
      gpu = null;
      ro?.disconnect();
      io?.disconnect();
      themeObserver?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("cf-ap:palette-change", onPalette);
      wideQuery?.removeEventListener("change", onWideChange);
      window.removeEventListener("pointermove", onPointer);
    };
  }, [density, opacity, links, linkDistance, parallax, minWidth]);

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
      <canvas
        ref={gpuCanvasRef}
        style={{ display: "none", position: "absolute", inset: 0, width: "100%", height: "100%" }}
      />
    </div>
  );
}

export default FieldBackground;
