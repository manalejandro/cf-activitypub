"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { getToken } from "@/lib/client-api";
import { parseDbDate } from "@/lib/dates";
import { useLocale } from "@/lib/i18n";
import { Icon } from "@/components/Icon";

interface EmailBlock {
  hash: string;
  reference_email: string | null;
  reason: string | null;
  created_at: string;
}

/** The server's own `error` text, when it sent one (never rendered as HTML). */
async function failureDetail(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body?.error === "string" && body.error ? body.error : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Mailboxes that cannot register an account. The API already existed
 * (`/api/v1/admin/canonical_email_blocks`, Mastodon-shaped); this page is what
 * was missing — an automatic block after repeated attempts is invisible
 * everywhere else, so a rejected applicant looks like "the account was created
 * but it is not in the list".
 *
 * Moderators can read it (a blocked mailbox explains a rejected sign-up); only
 * a full administrator can block or unblock, and the controls are hidden
 * instead of failing on click. Every failure is surfaced: a silent `catch` here
 * is exactly what made the section look broken.
 */
export default function AdminEmailBlocksPage() {
  const router = useRouter();
  const { t } = useLocale();
  const token = getToken();

  const [blocks, setBlocks] = useState<EmailBlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newReason, setNewReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<{ code: "forbidden" | "failed"; detail?: string } | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  const fetchBlocks = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      // no-store: a cached copy would resurrect an entry just unblocked.
      const res = await fetch("/api/v1/admin/canonical_email_blocks", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      if (!res.ok) {
        setError({ code: res.status === 403 ? "forbidden" : "failed", detail: await failureDetail(res) });
        return;
      }
      setBlocks((await res.json()) as EmailBlock[]);
    } catch {
      setError({ code: "failed" });
    }
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    Promise.resolve().then(() => void fetchBlocks());
  }, [fetchBlocks]);

  // Only a full administrator may mutate: hide the controls rather than let a
  // moderator click into a 403.
  useEffect(() => {
    if (!token) return;
    fetch("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : null) as Promise<{ roles?: { name?: string }[] } | null>)
      .then((me) => setIsAdmin((me?.roles?.[0]?.name ?? "").toLowerCase() === "admin"))
      .catch(() => {});
  }, [token]);

  async function unblock(block: EmailBlock) {
    if (!token || !isAdmin || busy) return;
    const label = block.reference_email ?? block.hash.slice(0, 12);
    if (!window.confirm(t.admin_email_blocks_confirm.replace("{email}", label))) return;
    setActionLoading(block.hash);
    setError(null);
    let failure: { code: "forbidden" | "failed"; detail?: string } | null = null;
    try {
      const res = await fetch(`/api/v1/admin/canonical_email_blocks?hash=${encodeURIComponent(block.hash)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (res.ok) {
        setNotice(t.admin_email_blocks_unblocked);
      } else {
        setNotice(null);
        failure = { code: res.status === 403 ? "forbidden" : "failed", detail: await failureDetail(res) };
      }
    } catch {
      failure = { code: "failed" };
    }
    // Refetch first (it clears the error), then re-raise what went wrong.
    await fetchBlocks();
    if (failure) setError(failure);
    setActionLoading(null);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !isAdmin || !newEmail.trim() || busy) return;
    setBusy(true);
    setError(null);
    let failure: { code: "forbidden" | "failed"; detail?: string } | null = null;
    try {
      const res = await fetch("/api/v1/admin/canonical_email_blocks", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email: newEmail.trim(), reason: newReason.trim() || undefined }),
      });
      if (res.ok) {
        setNotice(t.admin_email_blocks_blocked);
        setNewEmail("");
        setNewReason("");
        setAdding(false);
      } else {
        setNotice(null);
        failure = { code: res.status === 403 ? "forbidden" : "failed", detail: await failureDetail(res) };
      }
    } catch {
      failure = { code: "failed" };
    }
    await fetchBlocks();
    if (failure) setError(failure);
    setBusy(false);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: "1.25rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <Icon name="envelope" /> {t.admin_email_blocks}
        </h1>
        {isAdmin && !adding && (
          <button type="button" className="btn btn-outline btn-sm" onClick={() => { setNotice(null); setError(null); setAdding(true); }}>
            <Icon name="plus" /> {t.admin_email_blocks_add}
          </button>
        )}
      </div>

      <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--text-muted)", maxWidth: "70ch" }}>
        {t.admin_email_blocks_desc}
      </p>

      {!isAdmin && !loading && (
        <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--text-muted)" }}>
          <Icon name="lock" /> {t.admin_email_blocks_readonly}
        </p>
      )}

      {notice && (
        <p role="status" style={{ margin: 0, fontSize: "0.85rem", color: "var(--accent)" }}>{notice}</p>
      )}
      {error && (
        <p role="alert" style={{ margin: 0, fontSize: "0.85rem", color: "var(--danger)" }}>
          <Icon name="exclamation-triangle" />{" "}
          {error.code === "forbidden" ? t.admin_email_blocks_readonly : t.admin_email_blocks_error}
          {error.detail ? `: ${error.detail}` : ""}
        </p>
      )}

      {isAdmin && adding && (
        <form onSubmit={(e) => void handleAdd(e)} style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: 480 }}>
          <input
            className="input"
            type="email"
            placeholder={t.admin_email_blocks_email_ph}
            aria-label={t.admin_email_blocks_email_ph}
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            autoFocus
            required
          />
          <input
            className="input"
            placeholder={t.admin_reason_ph}
            aria-label={t.admin_reason_ph}
            value={newReason}
            onChange={(e) => setNewReason(e.target.value)}
          />
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button type="submit" className="btn btn-primary btn-sm" disabled={!newEmail.trim() || busy}>
              {busy ? "…" : t.admin_email_blocks_add}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(false)}>
              {t.profile_cancel}
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div style={{ color: "var(--text-muted)", padding: "2rem 0" }}>{t.admin_loading_blocked}</div>
      ) : blocks.length === 0 ? (
        <div style={{ color: "var(--text-muted)", padding: "2rem 0" }}>{t.admin_email_blocks_empty}</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>
                <th style={{ padding: "0.5rem" }}>{t.register_email}</th>
                <th style={{ padding: "0.5rem" }}>{t.admin_email_blocks_col_reason}</th>
                <th style={{ padding: "0.5rem" }}>{t.admin_email_blocks_col_created}</th>
                {isAdmin && <th style={{ padding: "0.5rem" }} />}
              </tr>
            </thead>
            <tbody>
              {blocks.map((b) => (
                <tr key={b.hash} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "0.5rem", wordBreak: "break-all" }}>
                    {b.reference_email ?? <code>{b.hash.slice(0, 12)}</code>}
                  </td>
                  <td style={{ padding: "0.5rem", color: "var(--text-muted)" }}>{b.reason ?? "—"}</td>
                  <td style={{ padding: "0.5rem", whiteSpace: "nowrap", color: "var(--text-muted)" }}>
                    {parseDbDate(b.created_at)?.toLocaleString() ?? b.created_at}
                  </td>
                  {isAdmin && (
                    <td style={{ padding: "0.5rem", textAlign: "right" }}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={actionLoading === b.hash || busy}
                        onClick={() => void unblock(b)}
                      >
                        {actionLoading === b.hash ? "…" : t.admin_email_blocks_unblock}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
