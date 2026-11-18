"use client";

import { useCallback, useEffect, useState } from "react";

type Channel = { id: string; title: string };
type Publication = {
  id: string;
  channelTitle: string;
  status: string;
  requestedPrivacy: string;
  actualPrivacy: string | null;
  uploadPercent: number | null;
  message: string | null;
  youtubeVideoId: string | null;
  createdAt: string;
  canResolve: number;
};
type PublishingStatus = { enabled: boolean; channels: Channel[]; publications: Publication[] };

export default function YouTubePublish({ videoId, filename, originalTitle, originalDescription, open }: {
  videoId: string;
  filename: string;
  originalTitle: string;
  originalDescription: string;
  open: boolean;
}) {
  const [data, setData] = useState<PublishingStatus | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState(originalTitle);
  const [description, setDescription] = useState(originalDescription);
  const [privacy, setPrivacy] = useState("public");
  const [madeForKids, setMadeForKids] = useState("");
  const [syntheticMedia, setSyntheticMedia] = useState("");
  const [certify, setCertify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const titleValid = !!title.trim() && Array.from(title).length <= 100 && !/[<>]/.test(title);
  const descriptionValid = new TextEncoder().encode(description).length <= 5000 && !/[<>]/.test(description);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/library/publish/youtube?video=${encodeURIComponent(videoId)}`, {
      cache: "no-store", signal,
    });
    if (!response.ok) throw new Error("Unable to load YouTube upload status.");
    setData(await response.json());
  }, [videoId]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const load = () => {
      void refresh(controller.signal).catch(() => {
        if (!controller.signal.aborted) setError("Unable to load YouTube upload status. Refresh before retrying.");
      });
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [open, refresh]);

  async function publish() {
    if (busy || !selected.length || !titleValid || !descriptionValid || !madeForKids || !syntheticMedia || !certify ||
        !window.confirm(`Upload this video to ${selected.length} selected YouTube channel(s) with ${privacy} privacy?`)) return;
    setBusy(true);
    setError("");
    try {
      for (const channelId of selected) {
        const response = await fetch("/api/library/publish/youtube", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: crypto.randomUUID(), videoId, filename, channelId, title, description, privacy,
            madeForKids: madeForKids === "yes", syntheticMedia: syntheticMedia === "yes", certify,
          }),
        });
        if (!response.ok) {
          const result: { message?: string } = await response.json();
          throw new Error(result.message || "Unable to start the upload.");
        }
      }
      setSelected([]);
      setCertify(false);
      await refresh();
    } catch (error) {
      setError(`${error instanceof Error ? error.message : "Upload request failed."} Check status and YouTube Studio before retrying; some selected channels may already have started.`);
      try {
        await refresh();
      } catch {
        setError("Unable to refresh status. Check YouTube Studio and refresh this page before retrying.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function resolve(id: string) {
    if (busy || !window.confirm("Have you checked YouTube Studio for this upload? Resolving an uncertain result allows another attempt, which could create a duplicate.")) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/library/publish/youtube", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, confirm: true }),
      });
      if (!response.ok) throw new Error("Unable to resolve this upload.");
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to resolve this upload.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-3 max-w-2xl rounded border p-4" aria-label="Upload to YouTube">
      <h3 className="font-semibold">Upload to YouTube</h3>
      <p className="mt-2 text-sm">Shorts must be square or vertical and at most three minutes. The app checks these properties before uploading, but YouTube decides how to classify the video. Videos are not converted.</p>
      <p className="mt-2 text-sm">Previously connected channels must be reconnected in Settings to grant upload access. YouTube may change the requested privacy; check the result in YouTube Studio.</p>
      {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
      {!data && !error && <p className="mt-2">Loading YouTube upload status...</p>}
      {data && !data.enabled && <p className="mt-2">YouTube connection is disabled. Ask an administrator to configure it in Settings.</p>}
      {data?.enabled && !data.channels.length && <p className="mt-2">No YouTube channels are connected. Ask an administrator to connect one in Settings.</p>}
      {!!data?.channels.length && (
        <fieldset disabled={busy} className="mt-3">
          <legend className="font-medium">Choose YouTube channels</legend>
          {data.channels.map((channel) => (
            <label key={channel.id} className="block">
              <input type="checkbox" checked={selected.includes(channel.id)}
                onChange={(event) => setSelected((current) => event.target.checked
                  ? [...current, channel.id] : current.filter((id) => id !== channel.id))} />
              {" "}{channel.title}
            </label>
          ))}
          <label className="mt-3 block">YouTube title
            <input className="block w-full border p-1" value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          {!titleValid && <p className="text-sm text-red-700">Enter a title of 1-100 characters without &lt; or &gt;.</p>}
          <label className="mt-3 block">YouTube description
            <textarea className="block w-full border p-1" rows={4} value={description}
              onChange={(event) => setDescription(event.target.value)} />
          </label>
          {!descriptionValid && <p className="text-sm text-red-700">The description must be at most 5,000 UTF-8 bytes and cannot contain &lt; or &gt;.</p>}
          <label className="mt-3 block">Privacy
            <select className="ml-2 border p-1" value={privacy} onChange={(event) => setPrivacy(event.target.value)}>
              <option value="public">Public</option>
              <option value="private">Private</option>
              <option value="unlisted">Unlisted</option>
            </select>
          </label>
          <label className="mt-3 block">Is this video made for kids?
            <select className="ml-2 border p-1" value={madeForKids} onChange={(event) => setMadeForKids(event.target.value)}>
              <option value="">Choose one</option><option value="yes">Yes</option><option value="no">No</option>
            </select>
          </label>
          <label className="mt-3 block">Does this video contain realistic altered or synthetic media?
            <select className="ml-2 border p-1" value={syntheticMedia} onChange={(event) => setSyntheticMedia(event.target.value)}>
              <option value="">Choose one</option><option value="yes">Yes</option><option value="no">No</option>
            </select>
          </label>
          <p className="mt-1 text-sm"><a className="underline" href="https://support.google.com/youtube/answer/14328491" target="_blank" rel="noreferrer">Learn about altered content disclosure</a>.</p>
          <label className="mt-3 block">
            <input type="checkbox" checked={certify} onChange={(event) => setCertify(event.target.checked)} />
            {" "}I certify this video complies with the <a className="underline" href="https://www.youtube.com/howyoutubeworks/policies/community-guidelines/" target="_blank" rel="noreferrer">YouTube Community Guidelines</a>.
          </label>
          <button type="button" disabled={!selected.length || !titleValid || !descriptionValid || !madeForKids || !syntheticMedia || !certify}
            onClick={() => void publish()} className="mt-3 rounded bg-blue-700 px-4 py-2 text-white disabled:opacity-50">
            {busy ? "Working..." : "Upload to YouTube"}
          </button>
        </fieldset>
      )}
      {!!data?.publications.length && (
        <div className="mt-4">
          <h4 className="font-medium">Recent YouTube uploads</h4>
          <ul>
            {data.publications.map((item) => (
              <li key={item.id} className="mt-2">
                {item.channelTitle}: {item.status} ({item.createdAt} UTC)
                {" "}(requested: {item.requestedPrivacy}; actual: {item.actualPrivacy ?? "not confirmed"})
                {item.youtubeVideoId && <>{" "}<a className="underline" href={`https://www.youtube.com/watch?v=${encodeURIComponent(item.youtubeVideoId)}`} target="_blank" rel="noreferrer">View on YouTube</a></>}
                {item.message && <p>{item.message}</p>}
                {item.status === "uploading" && (
                  <div>
                    <progress className="block w-full max-w-sm" max={100} value={item.uploadPercent ?? undefined}
                      aria-label={`Upload progress for ${item.channelTitle}`} />
                    <span className="text-sm">{item.uploadPercent === null ? "Preparing upload..." : `${item.uploadPercent}% acknowledged by YouTube.`}</span>
                  </div>
                )}
                {item.status === "queued" && <progress className="block w-full max-w-sm" aria-label={`Queued for ${item.channelTitle}`} />}
                {!!item.canResolve && (
                  <button type="button" disabled={busy} onClick={() => void resolve(item.id)}
                    className="mt-1 rounded border px-2 py-1 disabled:opacity-50">
                    Resolve after checking YouTube Studio
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm">Keep the app running during uploads. If the result is uncertain, check YouTube Studio before resolving or retrying to avoid duplicates. Interrupted jobs can be resolved after 90 minutes.</p>
        </div>
      )}
    </section>
  );
}
