import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PageLayout } from "@/components/PageLayout";

describe("PageLayout", () => {
  it("renders children", () => {
    render(<PageLayout><p>hello</p></PageLayout>);
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("renders sidebar when provided", () => {
    render(
      <PageLayout sidebar={<nav>Sidebar nav</nav>}>
        <p>main</p>
      </PageLayout>
    );
    expect(screen.getByText("Sidebar nav")).toBeInTheDocument();
  });

  it("renders rightPanel when provided", () => {
    render(
      <PageLayout rightPanel={<aside>Right panel</aside>}>
        <p>main</p>
      </PageLayout>
    );
    expect(screen.getByText("Right panel")).toBeInTheDocument();
  });

  it("does not render sidebar or right panel when not provided", () => {
    const { container } = render(<PageLayout><p>main</p></PageLayout>);
    expect(container.querySelector(".page-sidebar")).toBeNull();
    expect(container.querySelector(".page-right")).toBeNull();
  });

  it("applies correct CSS classes", () => {
    const { container } = render(<PageLayout><p>main</p></PageLayout>);
    expect(container.querySelector(".page-grid")).toBeInTheDocument();
    expect(container.querySelector(".page-inner")).toBeInTheDocument();
    expect(container.querySelector(".page-main")).toBeInTheDocument();
  });

  it("wraps sidebar in aside with page-sidebar class", () => {
    const { container } = render(
      <PageLayout sidebar={<span>side</span>}>
        <p>main</p>
      </PageLayout>
    );
    const aside = container.querySelector("aside.page-sidebar");
    expect(aside).toBeInTheDocument();
    expect(aside).toHaveTextContent("side");
  });

  // The app carries the landing's signature field into its own screens: one
  // ambient, fixed layer behind the grid, visible only through the two outer
  // channels because `.page-inner` is opaque (pinned in globals.css).
  it("mounts the ambient field fixed behind the grid", () => {
    const { container } = render(<PageLayout><p>main</p></PageLayout>);
    const field = container.querySelector(".page-grid > [aria-hidden='true']") as HTMLElement;
    expect(field).toBeInTheDocument();
    expect(field.style.position).toBe("fixed");
    expect(field.style.zIndex).toBe("-1");
    expect(field.querySelector("canvas")).toBeTruthy();
  });
});
