// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { FieldBackground } from "@/components/FieldBackground";

/**
 * jsdom has no 2D canvas context, no `matchMedia` and no observers: this pins
 * the robustness contract — the layer must render inert and never throw in a
 * browser that cannot draw it (the same path covers a locked-down WebView).
 */
describe("FieldBackground", () => {
  it("renders an inert, hidden layer without a canvas context", () => {
    const { container } = render(<FieldBackground />);
    const wrap = container.firstElementChild as HTMLElement;

    expect(wrap.getAttribute("aria-hidden")).toBe("true");
    expect(wrap.style.pointerEvents).toBe("none");
    expect(wrap.style.position).toBe("absolute");
    expect(container.querySelector("canvas")).toBeTruthy();
  });

  it("takes per-placement token overrides so a dark hero can retint it", () => {
    const { container } = render(
      <FieldBackground style={{ ["--accent" as string]: "#cbcfff", zIndex: 0 }} />
    );
    const wrap = container.firstElementChild as HTMLElement;
    expect(wrap.style.getPropertyValue("--accent")).toBe("#cbcfff");
    expect(wrap.style.zIndex).toBe("0");
  });

  it("clamps nothing at the DOM level but keeps props optional", () => {
    const { container } = render(<FieldBackground density={999} opacity={5} links={false} />);
    expect(container.querySelector("canvas")).toBeTruthy();
  });

  it("never asks for a WebGPU context when the browser cannot provide one", () => {
    const requested: string[] = [];
    const fake2d = new Proxy(
      {},
      {
        get: (target, prop) =>
          prop in target ? Reflect.get(target, prop) : () => {},
        set: (target, prop, value) => {
          Reflect.set(target, prop, value);
          return true;
        },
      }
    );

    const spy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(((type: string) => {
        requested.push(type);
        return type === "2d" ? fake2d : null;
      }) as typeof HTMLCanvasElement.prototype.getContext);

    try {
      render(<FieldBackground />);
      expect(requested).toContain("2d");
      expect(requested).not.toContain("webgpu");
    } finally {
      spy.mockRestore();
    }
  });
});
