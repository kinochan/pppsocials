"use client";

import { useCallback, useEffect, useState } from "react";
import YouTubePublish from "@/app/components/YouTubePublish";

type Account = { id: string; username: string };
type Publication = {
  id: string;
  username: string;
  status: string;
  mediaType: string;
  uploadPercent: number | null;
  message: string | null;
  mediaId: string | null;
  createdAt: string;
  canResolve: number;
};
type PublishingStatus = { enabled: boolean; accounts: Account[]; publications: Publication[] };

export default function StoryPublish({ videoId, filename, title, description }: {
  videoId: string;
  filename: string;
  title: string;
  description: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button type="button" onClick={() => setOpen(!open)} className="rounded bg-blue-700 px-4 py-2 text-white">
        {open ? "Close publishing" : "Publish"}
      </button>
      <div hidden={!open}>
        <PublishSection videoId={videoId} filename={filename} platform="instagram" open={open} />
        <PublishSection videoId={videoId} filename={filename} platform="facebook" open={open} />
        <YouTubePublish videoId={videoId} filename={filename} originalTitle={title} originalDescription={description} open={open} />
        <p className="mt-2 text-sm">TikTok publishing is not available yet.</p>
      </div>
    </div>
  );
}

function PublishSection({ videoId, filename, platform, open }: {
  videoId: string;
  filename: string;
  platform: "instagram" | "facebook";
  open: boolean;
}) {
  const isInstagram = platform === "instagram";
  const label = isInstagram ? "Instagram" : "Facebook";
  const accountLabel = isInstagram ? "accounts" : "Pages";
  const accountName = (name: string) => isInstagram ? `@${name}` : name;
  const endpoint = `/api/library/publish/${platform}`;
  const [data, setData] = useState<PublishingStatus | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`${endpoint}?video=${encodeURIComponent(videoId)}`, {
      cache: "no-store", signal,
    });
    if (!response.ok) throw new Error(`Unable to load ${label} publishing status.`);
    setData(await response.json());
  }, [endpoint, label, videoId]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const load = () => {
      void refresh(controller.signal).catch(() => {
        if (!controller.signal.aborted) setError(`Unable to load ${label} publishing status. Refresh before retrying.`);
      });
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [label, open, refresh]);

  async function publish() {
    if (!selected.length || busy ||
        !window.confirm(`Publish this video to the ${label} Story of ${selected.length} selected ${accountLabel}?`)) return;
    setBusy(true);
    setError("");
    try {
      for (const accountId of selected) {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: crypto.randomUUID(), videoId, filename, accountId, mediaType: "STORIES" }),
        });
        if (!response.ok) {
          const result: { message?: string } = await response.json();
          throw new Error(result.message || "Unable to start publishing.");
        }
      }
      setSelected([]);
      await refresh();
    } catch (error) {
      setError(`${error instanceof Error ? error.message : "Publishing request failed."} Check status and ${label} before retrying; some selected ${accountLabel} may already have started.`);
      try {
        await refresh();
      } catch {
        setError(`Unable to refresh status. Check ${label} and refresh this page before retrying.`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function resolve(id: string) {
    if (busy || !window.confirm(`Have you checked ${label} for this publication? Resolving an uncertain result allows another attempt, which could create a duplicate.`)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, confirm: true }),
      });
      if (!response.ok) throw new Error("Unable to resolve this publication.");
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to resolve this publication.");
    } finally {
      setBusy(false);
    }
  }

  return (
        <section className="mt-3 max-w-2xl rounded border p-4" aria-label={`Publish to ${label}`}>
          <h3 className="font-semibold">Publish a {label} Story</h3>
          <p className="mt-2 text-sm">Stories expire after 24 hours. Meta requires Story videos to be 3-60 seconds{isInstagram && " and at most 100 MB"}; other video specifications also apply. The Library description is not added as text to the Story.</p>
          <p className="mt-2 text-sm">Processing can take several minutes.</p>
          {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
          {!data && !error && <p className="mt-2">Loading publishing status...</p>}
          {data && !data.enabled && <p className="mt-2">{label} connection is disabled. Ask an administrator to configure it in Settings.</p>}
          {data?.enabled && !data.accounts.length && <p className="mt-2">No {label} {accountLabel} are connected. Ask an administrator to connect one in Settings.</p>}
          {!!data?.accounts.length && (
            <>
              <fieldset className="mt-3">
                <legend className="font-medium">Choose {accountLabel}</legend>
                {data.accounts.map((account) => (
                  <label key={account.id} className="block">
                    <input type="checkbox" checked={selected.includes(account.id)} disabled={busy}
                      onChange={(event) => setSelected((current) => event.target.checked
                        ? [...current, account.id] : current.filter((id) => id !== account.id))} />
                    {" "}{accountName(account.username)}
                  </label>
                ))}
              </fieldset>
              <button type="button" disabled={busy || !selected.length} onClick={() => void publish()}
                className="mt-3 rounded bg-blue-700 px-4 py-2 text-white disabled:opacity-50">
                {busy ? "Working..." : `Publish ${label} Story`}
              </button>
            </>
          )}
          {!!data?.publications.length && (
            <div className="mt-4">
              <h4 className="font-medium">Recent {label} publications</h4>
              <ul>
                {data.publications.map((item) => (
                  <li key={item.id} className="mt-2">
                    {accountName(item.username)}: {item.mediaType === "STORIES" ? "Story" : item.mediaType === "REELS" ? "Reel" : `${label} publication`} - {item.status} ({item.createdAt} UTC)
                    {item.mediaId && ` (${label} ID: ${item.mediaId})`}
                    {item.message && <p>{item.message}</p>}
                    {item.status === "uploading" && (
                      <div>
                        <progress className="block w-full max-w-sm" max={100}
                          value={item.uploadPercent ?? undefined}
                          aria-label={`Upload progress for ${accountName(item.username)}`} />
                        <span className="text-sm">
                          {item.uploadPercent === null ? "Preparing upload..."
                            : item.uploadPercent === 100 ? "Meta accepted the upload."
                              : `${item.uploadPercent}% of the file read for transfer to Meta.`}
                        </span>
                      </div>
                    )}
                    {["queued", "processing", "publishing"].includes(item.status) && (
                      <progress className="block w-full max-w-sm" aria-label={`${item.status} for ${accountName(item.username)}`} />
                    )}
                    {!!item.canResolve && (
                      <button type="button" disabled={busy} onClick={() => void resolve(item.id)}
                        className="mt-1 rounded border px-2 py-1 disabled:opacity-50">
                        Resolve after checking {label}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-sm">Upload progress measures the file read for transfer, not Meta&apos;s processing. If a publication remains in progress after a restart, check {label} before resolving or retrying. Interrupted jobs can be resolved after 90 minutes.</p>
            </div>
          )}
        </section>
  );
}
