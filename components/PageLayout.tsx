import { FieldBackground } from "./FieldBackground";

interface PageLayoutProps {
  sidebar?: React.ReactNode;
  children: React.ReactNode;
  rightPanel?: React.ReactNode;
}

export function PageLayout({ sidebar, children, rightPanel }: PageLayoutProps) {
  return (
    <div className="page-grid">
      {/* The instance's signature field, continued from the landing into the
          app: fixed behind the grid so it drifts through the two outer
          channels while the content band stays opaque. The width gate matters
          — below ~1160px the side channels collapse and the canvas would burn
          frames behind the content. */}
      <FieldBackground
        density={12}
        opacity={0.45}
        linkDistance={110}
        minWidth={1160}
        style={{ position: "fixed", inset: 0, zIndex: -1 }}
      />
      <div className="page-inner">
        {sidebar && <aside className="page-sidebar">{sidebar}</aside>}
        <main className="page-main">{children}</main>
        {rightPanel && <div className="page-right">{rightPanel}</div>}
      </div>
    </div>
  );
}
