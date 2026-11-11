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

/**
 * Mailboxes that cannot register an account. The API already existed
 * (`/api/v1/admin/canonical_email_blocks`, Mastodon-shaped); this page is what
 * was missing — an automatic block after repeated attempts is invisible
 * everywhere else, so a rejected applicant looks like "the account was created
 * but it is not in the list".
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

  const fetchBlocks = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch("/api/v1/admin/canonical_email_blocks", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { router.push("/login"); return; }
      setBlocks((await res.json()) as EmailBlock[]);
    } catch {
      router.push("/login");
    }
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    Promise.resolve().then(() => void fetchBlocks());
  }, [fetchBlocks]);

  async function unblock(hash: string) {
    if (!token) return;
    setActionLoading(hash);
    try {
      const res = await fetch(`/api/v1/admin/canonical_email_blocks?hash=${encodeURIComponent(hash)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setNotice(t.admin_email_blocks_unblocked);
      await fetchBlocks();
    } catch { /* keep the list as is */ }
    setActionLoading(null);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !newEmail.trim() || busy) return;
    setBusy(true);
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
        await fetchBlocks();
      }
    } catch { /* ignore */ }
    setBusy(false);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: "1.25rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <Icon name="envelope" /> {t.admin_email_blocks}
        </h1>
        {!adding && (
          <button type="button" className="btn btn-outline btn-sm" onClick={() => { setNotice(null); setAdding(true); }}>
            <Icon name="plus" /> {t.admin_email_blocks_add}
          </button>
        )}
      </div>

      <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--text-muted)", maxWidth: "70ch" }}>
        {t.admin_email_blocks_desc}
      </p>

      {notice && (
        <p role="status" style={{ margin: 0, fontSize: "0.85rem", color: "var(--accent)" }}>{notice}</p>
      )}

      {adding && (
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
                <th style={{ padding: "0.5rem" }} />
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
                  <td style={{ padding: "0.5rem", textAlign: "right" }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={actionLoading === b.hash}
                      onClick={() => void unblock(b.hash)}
                    >
                      {actionLoading === b.hash ? "…" : t.admin_email_blocks_unblock}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
