"use client";

import { useCallback, useEffect, useState } from "react";

type Upload = {
  id: string;
  accountName: string;
  status: string;
  uploadPercent: number | null;
  message: string | null;
  createdAt: string;
  canCheck: number;
  canResolve: number;
};
type UploadStatus = {
  enabled: boolean;
  accounts: { id: string; displayName: string }[];
  uploads: Upload[];
};

export default function TikTokUpload({ videoId, filename, open }: {
  videoId: string; filename: string; open: boolean;
}) {
  const [data, setData] = useState<UploadStatus | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/library/publish/tiktok?video=${encodeURIComponent(videoId)}`, {
      cache: "no-store", signal,
    });
    if (!response.ok) throw new Error("Unable to load TikTok upload status.");
    setData(await response.json());
  }, [videoId]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const load = () => {
      void refresh(controller.signal).catch(() => {
        if (!controller.signal.aborted) setError("Unable to load TikTok status. Refresh before retrying.");
      });
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [open, refresh]);

  async function send() {
    if (busy || !selected.length || !window.confirm(
      `Send this video to the TikTok inbox of ${selected.length} selected account(s)? You must finish posting in TikTok.`
    )) return;
    setBusy(true);
    setError("");
    try {
      for (const accountId of selected) {
        const response = await fetch("/api/library/publish/tiktok", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: crypto.randomUUID(), videoId, filename, accountId, confirm: true }),
        });
        if (!response.ok) {
          const result: { message?: string } = await response.json();
          throw new Error(result.message || "Unable to start the upload.");
        }
      }
      setSelected([]);
      await refresh();
    } catch (error) {
      setError(`${error instanceof Error ? error.message : "Upload request failed."} Check status and the TikTok inbox before retrying; some selected accounts may already have started.`);
      try { await refresh(); } catch { setError("Unable to refresh status. Check TikTok and refresh this page before retrying."); }
    } finally {
      setBusy(false);
    }
  }

  async function update(id: string, action: "check" | "resolve") {
    if (busy || (action === "resolve" && !window.confirm(
      "Have you checked the TikTok inbox? Resolving this upload allows another attempt, which may send a duplicate."
    ))) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/library/publish/tiktok", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action, confirm: action === "resolve" }),
      });
      if (!response.ok) {
        const result: { message?: string } = await response.json();
        throw new Error(result.message || "Unable to update TikTok status.");
      }
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to update TikTok status.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-3 max-w-2xl rounded border p-4" aria-label="Send to TikTok">
      <h3 className="font-semibold">Send to TikTok inbox</h3>
      <p className="mt-2 text-sm">This does not post the video. Open the TikTok inbox notification to edit, choose privacy and publish. The Library title and description are not sent.</p>
      <p className="mt-2 text-sm">TikTok accepts MP4, MOV and WebM, with additional video restrictions. Existing accounts must be reconnected with upload permission.</p>
      {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
      {!data && !error && <p className="mt-2">Loading TikTok upload status...</p>}
      {data && !data.enabled && <p className="mt-2">TikTok uploads are disabled. Ask an administrator to configure them.</p>}
      {data?.enabled && !data.accounts.length && <p className="mt-2">No TikTok accounts connected. Ask an administrator to connect one in Settings.</p>}
      {!!data?.accounts.length && (
        <fieldset className="mt-3" disabled={busy}>
          <legend className="font-medium">Choose TikTok accounts</legend>
          {data.accounts.map((account) => (
            <label key={account.id} className="block">
              <input type="checkbox" checked={selected.includes(account.id)}
                onChange={(event) => setSelected((current) => event.target.checked
                  ? [...current, account.id] : current.filter((id) => id !== account.id))} />
              {" "}{account.displayName}
            </label>
          ))}
          <button type="button" disabled={!selected.length} onClick={() => void send()}
            className="mt-3 rounded bg-blue-700 px-4 py-2 text-white disabled:opacity-50">
            {busy ? "Working..." : "Send to TikTok inbox"}
          </button>
        </fieldset>
      )}
      {!!data?.uploads.length && (
        <div className="mt-4">
          <h4 className="font-medium">Recent TikTok uploads</h4>
          <ul>
            {data.uploads.map((item) => (
              <li key={item.id} className="mt-2">
                {item.accountName}: {item.status} ({item.createdAt} UTC)
                {item.message && <p>{item.message}</p>}
                {item.status === "uploading" && (
                  <div>
                    <progress className="block w-full max-w-sm" max={100} value={item.uploadPercent ?? undefined}
                      aria-label={`Upload progress for ${item.accountName}`} />
                    <span className="text-sm">{item.uploadPercent === null ? "Preparing upload..." : `${item.uploadPercent}% acknowledged by TikTok.`}</span>
                  </div>
                )}
                {!!item.canCheck && <button type="button" disabled={busy} onClick={() => void update(item.id, "check")}
                  className="mr-2 mt-1 rounded border px-2 py-1 disabled:opacity-50">Check TikTok status</button>}
                {!!item.canResolve && <button type="button" disabled={busy} onClick={() => void update(item.id, "resolve")}
                  className="mt-1 rounded border px-2 py-1 disabled:opacity-50">Resolve after checking TikTok</button>}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm">Keep the app running during upload. Check TikTok before retrying uncertain results. Interrupted uploads can be resolved after 90 minutes.</p>
        </div>
      )}
    </section>
  );
}
