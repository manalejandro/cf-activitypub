// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mountGPUField } from "@/components/field-background-gpu";

/**
 * jsdom has no WebGPU, which is exactly the browser this upgrade must refuse.
 * The failure has to be a rejected promise (the component catches it and keeps
 * the Canvas2D floor), never a thrown import or a half-configured canvas.
 */
describe("mountGPUField", () => {
  it("rejects when the browser has no WebGPU adapter", async () => {
    const canvas = document.createElement("canvas");
    await expect(
      mountGPUField(
        canvas,
        {
          width: 100,
          height: 100,
          dpr: 1,
          links: true,
          style: { accent: [0, 0, 0], muted: [0, 0, 0], opacity: 0.5 },
        },
        () => {}
      )
    ).rejects.toThrow(/WebGPU/);
  });
});
