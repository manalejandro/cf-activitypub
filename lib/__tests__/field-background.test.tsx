// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
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
});
