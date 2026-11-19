import { describe, expect, it } from "vitest";
import {
  FIELD_MAX_DOTS,
  advectField,
  collectFieldLinks,
  parseCssColor,
  seedField,
} from "@/components/field-background-sim";
import type { FieldDot } from "@/components/field-background-sim";

const dot = (x: number, y: number, overrides: Partial<FieldDot> = {}): FieldDot => ({
  x,
  y,
  phase: 0,
  speed: 0,
  r: 1,
  ...overrides,
});

describe("seedField", () => {
  it("caps the dot budget and halves it on coarse pointers", () => {
    expect(seedField(1000, 600, { density: 16, coarse: false })).toHaveLength(FIELD_MAX_DOTS);
    expect(seedField(1000, 600, { density: 16, coarse: true })).toHaveLength(FIELD_MAX_DOTS / 2);
  });

  it("keeps a floor of 12 dots on a tiny surface", () => {
    expect(seedField(10, 10, { density: 4, coarse: false })).toHaveLength(12);
  });

  it("seeds inside the surface", () => {
    for (const d of seedField(400, 300, { density: 20, coarse: false })) {
      expect(d.x).toBeGreaterThanOrEqual(-20);
      expect(d.x).toBeLessThanOrEqual(420);
      expect(d.y).toBeGreaterThanOrEqual(-20);
      expect(d.y).toBeLessThanOrEqual(320);
    }
  });
});

describe("advectField", () => {
  it("wraps a dot that leaves the left edge to the right one", () => {
    const dots = [dot(-100, 10)];
    advectField(dots, 800, 600, 0);
    expect(dots[0].x).toBe(820);
  });

  it("wraps bottom to top", () => {
    const dots = [dot(10, 900)];
    advectField(dots, 800, 600, 0);
    expect(dots[0].y).toBe(-20);
  });
});

describe("collectFieldLinks", () => {
  it("pairs dots under the link distance once, lowest index first", () => {
    const links = collectFieldLinks([dot(0, 0), dot(10, 0), dot(400, 400)], 50);
    expect(links).toEqual([0, 1]);
  });

  it("clears and reuses the caller's array", () => {
    const out = [9, 9, 9];
    collectFieldLinks([dot(0, 0), dot(500, 500)], 50, out);
    expect(out).toEqual([]);
    collectFieldLinks([dot(0, 0), dot(5, 0)], 50, out);
    expect(out).toEqual([0, 1]);
  });

  it("does not pair dots across the distance", () => {
    expect(collectFieldLinks([dot(0, 0), dot(60, 0)], 50)).toEqual([]);
  });
});

describe("parseCssColor", () => {
  const fallback = [0, 0, 0] as const;

  it("reads the hex tokens the palette system writes", () => {
    expect(parseCssColor("#4f46e5", fallback)).toEqual([79 / 255, 70 / 255, 229 / 255]);
    expect(parseCssColor("#fff", fallback)).toEqual([1, 1, 1]);
  });

  it("reads rgb()/rgba()", () => {
    expect(parseCssColor("rgba(10, 20, 30, 0.5)", fallback)).toEqual([10 / 255, 20 / 255, 30 / 255]);
  });

  it("falls back instead of throwing on anything else", () => {
    expect(parseCssColor("oklch(0.7 0.2 260)", fallback)).toBe(fallback);
    expect(parseCssColor("", fallback)).toBe(fallback);
  });
});
