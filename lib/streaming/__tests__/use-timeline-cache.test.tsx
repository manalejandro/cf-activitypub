import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useEffect, useState } from "react";
import { useTimelineCache } from "@/lib/streaming/use-timeline-cache";
import { setTimelineCache, clearTimelineCache, getTimelineCache } from "@/lib/streaming/timeline-cache";

type S = { id: string };

let lastSetStatuses: ((updater: (prev: S[]) => S[]) => void) | null = null;

let fetchResults: Record<string, S[]> = {
  local: [{ id: "L1" }, { id: "L2" }],
  federated: [{ id: "F1" }, { id: "F2" }],
};

let fetchShouldFail: Record<string, boolean> = {};

function Feed({ feedKey }: { feedKey: string }) {
  const { statuses, setStatuses } = useTimelineCache<S>(feedKey, async () => {
    if (fetchShouldFail[feedKey]) throw new Error("fetch failed");
    const items = fetchResults[feedKey] ?? [];
    return { items, hasMore: false };
  });
  useEffect(() => {
    lastSetStatuses = setStatuses;
  });
  return (
    <div>
      {statuses.map((s) => (
        <div key={s.id} data-testid={`st-${s.id}`}>
          {s.id}
        </div>
      ))}
    </div>
  );
}

function App() {
  const [key, setKey] = useState("local");
  return (
    <div>
      <button onClick={() => setKey("federated")}>go-federated</button>
      <button onClick={() => setKey("local")}>go-local</button>
      <Feed feedKey={key} />
    </div>
  );
}

const scrollSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

beforeEach(() => {
  clearTimelineCache("local");
  clearTimelineCache("federated");
  lastSetStatuses = null;
  fetchResults = {
    local: [{ id: "L1" }, { id: "L2" }],
    federated: [{ id: "F1" }, { id: "F2" }],
  };
  fetchShouldFail = {};
  scrollSpy.mockClear();
});

afterEach(() => {
  clearTimelineCache("local");
  clearTimelineCache("federated");
  lastSetStatuses = null;
  scrollSpy.mockClear();
});

function cacheLocal() {
  setTimelineCache("local", {
    items: [{ id: "L1" }, { id: "L2" }],
    hasMore: false,
    scrollY: 800,
    fetchedAt: Date.now(),
    ready: true,
  });
}

function cacheFederated() {
  setTimelineCache("federated", {
    items: [{ id: "F1" }, { id: "F2" }],
    hasMore: false,
    scrollY: 200,
    fetchedAt: Date.now(),
    ready: true,
  });
}

describe("useTimelineCache tab switching", () => {
  it("restores each feed's own items and scroll position when switching back and forth", async () => {
    cacheLocal();
    cacheFederated();

    render(<App />);
    expect(await screen.findByTestId("st-L1")).toBeTruthy();
    expect(screen.queryByTestId("st-F1")).toBeNull();
    expect(scrollSpy).not.toHaveBeenCalled();

    await act(async () => {
      screen.getByText("go-federated").click();
    });
    expect(await screen.findByTestId("st-F1")).toBeTruthy();
    expect(screen.queryByTestId("st-L1")).toBeNull();
    expect(scrollSpy).toHaveBeenCalledWith(0, 200);

    scrollSpy.mockClear();
    await act(async () => {
      screen.getByText("go-local").click();
    });
    expect(await screen.findByTestId("st-L1")).toBeTruthy();
    expect(screen.queryByTestId("st-F1")).toBeNull();
    expect(scrollSpy).toHaveBeenCalledWith(0, 800);
  });

  it("starts a never-opened feed at the top instead of inheriting the previous scroll", async () => {
    cacheLocal();

    render(<App />);
    expect(await screen.findByTestId("st-L1")).toBeTruthy();

    await act(async () => {
      screen.getByText("go-federated").click();
    });
    expect(await screen.findByTestId("st-F1")).toBeTruthy();
    expect(scrollSpy).toHaveBeenCalledWith(0, 0);
  });

  it("still applies streamed updates after a feed is restored from cache", async () => {
    cacheLocal();

    render(<App />);
    expect(await screen.findByTestId("st-L1")).toBeTruthy();

    // Switch away and back so the local feed goes through the cached restore path.
    await act(async () => {
      screen.getByText("go-federated").click();
    });
    await screen.findByTestId("st-F1");
    await act(async () => {
      screen.getByText("go-local").click();
    });
    expect(await screen.findByTestId("st-L1")).toBeTruthy();

    // Simulate a streaming "update" event prepending a new status.
    await act(async () => {
      lastSetStatuses?.((prev) => [{ id: "LNEW" }, ...prev]);
    });
    expect(screen.getByTestId("st-LNEW")).toBeTruthy();
    const cached = getTimelineCache<{ id: string }>("local");
    expect(cached?.items.map((s) => s.id)).toContain("LNEW");
  });

  it("refetches a fresh cached feed in the background on tab switch so new posts appear", async () => {
    cacheLocal();

    render(<App />);
    expect(await screen.findByTestId("st-L1")).toBeTruthy();

    // Server now has a new local status; the cached feed must not stay frozen.
    fetchResults.local = [{ id: "LNEW" }, { id: "L1" }, { id: "L2" }];

    await act(async () => {
      screen.getByText("go-federated").click();
    });
    expect(await screen.findByTestId("st-F1")).toBeTruthy();

    await act(async () => {
      screen.getByText("go-local").click();
    });
    expect(await screen.findByTestId("st-LNEW")).toBeTruthy();
    expect(screen.getByTestId("st-L1")).toBeTruthy();
  });

  it("keeps the absolute scroll position on tab switch instead of re-anchoring to the first item", async () => {
    cacheLocal(); // remembered at 800

    render(<App />);
    expect(await screen.findByTestId("st-L1")).toBeTruthy();
    scrollSpy.mockClear();

    fetchResults.local = [{ id: "LNEW" }, { id: "L1" }, { id: "L2" }];

    await act(async () => {
      screen.getByText("go-federated").click();
    });
    await screen.findByTestId("st-F1");

    scrollSpy.mockClear();
    await act(async () => {
      screen.getByText("go-local").click();
    });
    expect(await screen.findByTestId("st-LNEW")).toBeTruthy();
    expect(screen.getByTestId("st-L1")).toBeTruthy();

    // The restore lands only on the feed's own offset (800) or the top (0).
    // A re-anchor to the first cached item would scroll somewhere in between.
    expect(scrollSpy.mock.calls.every(([, y]) => y === 0 || y === 800)).toBe(true);
  });

  it("a failed background refetch keeps the cached feed instead of wiping it", async () => {
    cacheLocal();

    render(<App />);
    expect(await screen.findByTestId("st-L1")).toBeTruthy();

    // Server request starts failing; switch away and back.
    fetchShouldFail.local = true;
    await act(async () => {
      screen.getByText("go-federated").click();
    });
    await screen.findByTestId("st-F1");
    await act(async () => {
      screen.getByText("go-local").click();
    });

    // The cached items survive (they used to be replaced by the empty page).
    expect(await screen.findByTestId("st-L1")).toBeTruthy();
    expect(screen.getByTestId("st-L2")).toBeTruthy();
    expect(getTimelineCache<{ id: string }>("local")?.items.map((s) => s.id)).toEqual(["L1", "L2"]);
  });
});

// A fetch whose resolution the test controls, one deferred per call (in order).
type Page = { items: { id: string }[]; hasMore: boolean };
let gatedCalls: Array<(page: Page) => void> = [];

function gatedFetchPage(): Promise<Page> {
  return new Promise<Page>((resolve) => {
    gatedCalls.push(resolve);
  });
}

function GatedApp() {
  const [key, setKey] = useState("local");
  const { statuses } = useTimelineCache<{ id: string }>(key, gatedFetchPage, {
    refetchOnMount: true,
  });
  return (
    <div>
      <button onClick={() => setKey("federated")}>go-federated</button>
      {statuses.map((s) => (
        <div key={s.id} data-testid={`st-${s.id}`}>
          {s.id}
        </div>
      ))}
    </div>
  );
}

describe("useTimelineCache cancelled fetches", () => {
  beforeEach(() => {
    gatedCalls = [];
  });

  /**
   * Regression: switching local → federated while the local feed was still
   * closing a pagination gap merged the local page into the federated feed
   * (the gap loop `break`s on cancel and then fell through to `setStatuses`),
   * and wrote the federated items into the local cache entry.
   */
  it("drops a cancelled feed's gap page instead of merging it into the new feed", async () => {
    cacheLocal();
    cacheFederated();
    render(<GatedApp />);

    // Call 0: the local background refetch. Its page does not reach the cached
    // window, so the hook starts closing the gap (call 1) and awaits it — the
    // merge only happens once that page lands.
    await act(async () => {});
    await act(async () => {
      gatedCalls[0]({ items: [{ id: "L9" }], hasMore: true });
    });
    // The gap page is now in flight (call index 1).
    expect(gatedCalls.length).toBe(2);

    // Switch feeds with the gap page still in flight, then resolve it: it
    // belongs to the local feed and must go nowhere.
    await act(async () => {
      screen.getByText("go-federated").click();
    });
    expect(await screen.findByTestId("st-F1")).toBeTruthy();
    await act(async () => {
      gatedCalls[1]({ items: [{ id: "L8" }, { id: "L1" }], hasMore: true });
    });
    // Call 2 is the federated feed's own page.
    await act(async () => {
      gatedCalls[2]({ items: [{ id: "F1" }, { id: "F2" }], hasMore: false });
    });

    expect(screen.queryByTestId("st-L8")).toBeNull();
    expect(screen.queryByTestId("st-L9")).toBeNull();
    expect(screen.queryByTestId("st-F1")).toBeTruthy();
    expect(screen.queryByTestId("st-F2")).toBeTruthy();

    const federated = getTimelineCache<{ id: string }>("federated")?.items.map((s) => s.id) ?? [];
    expect(federated.filter((id) => id.startsWith("L"))).toEqual([]);
    // The cancelled run must not write the other feed's items into its own
    // entry either: the local cache keeps exactly what it had.
    expect(getTimelineCache<{ id: string }>("local")?.items.map((s) => s.id)).toEqual(["L1", "L2"]);
  });
});