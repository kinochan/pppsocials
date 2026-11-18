"use client";

import { useCallback, useEffect, useState } from "react";

type Creator = {
  nickname: string;
  privacy: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxDuration: number;
};
type Post = {
  id: string; accountName: string; status: string; message: string | null;
  createdAt: string; canCheck: number; canResolve: number;
};
type Data = { enabled: boolean; accounts: { id: string; displayName: string }[]; posts: Post[] };
const privacyLabels: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "Everyone", MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers", SELF_ONLY: "Only me",
};

export default function TikTokDirectPost({ videoId, filename, title, description, open }: {
  videoId: string; filename: string; title: string; description: string; open: boolean;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [account, setAccount] = useState("");
  const [creator, setCreator] = useState<Creator | null>(null);
  const [caption, setCaption] = useState(description || title);
  const [privacy, setPrivacy] = useState("");
  const [comment, setComment] = useState(false);
  const [duet, setDuet] = useState(false);
  const [stitch, setStitch] = useState(false);
  const [disclosure, setDisclosure] = useState(false);
  const [brandOrganic, setBrandOrganic] = useState(false);
  const [brandContent, setBrandContent] = useState(false);
  const [aiGenerated, setAiGenerated] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/library/publish/tiktok-direct?video=${encodeURIComponent(videoId)}`, {
      cache: "no-store", signal,
    });
    if (!response.ok) throw new Error("Unable to load TikTok Direct Post status.");
    setData(await response.json());
  }, [videoId]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const load = () => { void refresh(controller.signal).catch(() => {
      if (!controller.signal.aborted) setError("Unable to load TikTok Direct Post status.");
    }); };
    load();
    const timer = window.setInterval(load, 5000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [open, refresh]);

  useEffect(() => {
    if (!open || !account) return;
    const controller = new AbortController();
    void fetch(`/api/library/publish/tiktok-direct?video=${encodeURIComponent(videoId)}&creator=${encodeURIComponent(account)}`, {
      cache: "no-store", signal: controller.signal,
    }).then(async (response) => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Unable to load TikTok creator settings.");
      setCreator(result);
    }).catch((error) => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Unable to load creator settings.");
    });
    return () => controller.abort();
  }, [account, open, videoId]);

  const valid = !!creator && !!privacy && caption.length <= 2200 && consent &&
    (!disclosure || brandContent || brandOrganic) && !(brandContent && privacy === "SELF_ONLY");

  async function submit() {
    if (busy || !valid || !creator || !window.confirm(
      `Post this video to ${creator.nickname} on TikTok with ${privacyLabels[privacy]} privacy?`
    )) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/library/publish/tiktok-direct", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: crypto.randomUUID(), videoId, filename, accountId: account, title: caption, privacy,
          comment, duet, stitch, disclosure, brandOrganic, brandContent, aiGenerated, confirm: true,
        }),
      });
      if (!response.ok) {
        const result: { message?: string } = await response.json();
        throw new Error(result.message || "Unable to start TikTok posting.");
      }
      setConsent(false);
      await refresh();
    } catch (error) {
      setError(`${error instanceof Error ? error.message : "Unable to start TikTok posting."} Check status and TikTok before retrying.`);
      try { await refresh(); } catch { setError("Unable to refresh status. Check TikTok before retrying."); }
    } finally { setBusy(false); }
  }

  const check = useCallback(async (id: string, action: "check" | "resolve") => {
    const response = await fetch("/api/library/publish/tiktok-direct", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action, confirm: action === "resolve" }),
    });
    if (!response.ok) {
      const result: { message?: string } = await response.json();
      throw new Error(result.message || "Unable to check TikTok status.");
    }
    await refresh();
  }, [refresh]);

  const checkable = data?.posts.find((item) => item.canCheck)?.id;
  useEffect(() => {
    if (!open || !checkable) return;
    const timer = window.setInterval(() => {
      void check(checkable, "check").catch((error) => {
        setError(error instanceof Error ? error.message : "Unable to check TikTok status.");
      });
    }, 15000);
    return () => window.clearInterval(timer);
  }, [check, checkable, open]);

  async function resolve(id: string) {
    if (busy || !window.confirm("Have you checked TikTok? Resolving allows a retry that may create a duplicate.")) return;
    setBusy(true);
    setError("");
    try { await check(id, "resolve"); }
    catch (error) { setError(error instanceof Error ? error.message : "Unable to resolve the post."); }
    finally { setBusy(false); }
  }

  return (
    <section className="mt-3 max-w-2xl rounded border p-4" aria-label="Post directly to TikTok">
      <h3 className="font-semibold">Post directly to TikTok</h3>
      <p className="mt-2 text-sm">TikTok may take several minutes to process a post. Unaudited clients may be limited to private accounts and private posts.</p>
      {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
      {!data && !error && <p>Loading TikTok Direct Post status...</p>}
      {data && !data.enabled && <p className="mt-2">Direct Post is disabled. Ask an administrator to configure it.</p>}
      {data?.enabled && !data.accounts.length && <p className="mt-2">No TikTok accounts connected.</p>}
      {!!data?.accounts.length && (
        <fieldset className="mt-3" disabled={busy}>
          <label className="block">TikTok account
            <select className="ml-2 border p-1" value={account} onChange={(event) => {
              setError(""); setCreator(null); setPrivacy(""); setComment(false); setDuet(false);
              setStitch(false); setConsent(false); setAccount(event.target.value);
            }}>
              <option value="">Choose one</option>
              {data.accounts.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
            </select>
          </label>
          {account && !creator && !error && <p>Loading creator settings...</p>}
          {creator && <>
            <p className="mt-2">Posting as {creator.nickname}. Maximum video duration: {creator.maxDuration} seconds.</p>
            <label className="mt-2 block">Caption
              <textarea className="block w-full border p-1" rows={3} value={caption} onChange={(event) => setCaption(event.target.value)} />
            </label>
            {caption.length > 2200 && <p role="alert">Caption must be at most 2,200 UTF-16 characters.</p>}
            <label className="mt-2 block">Privacy
              <select className="ml-2 border p-1" value={privacy} onChange={(event) => setPrivacy(event.target.value)}>
                <option value="">Choose one</option>
                {creator.privacy.map((item) => <option key={item} value={item} disabled={item === "SELF_ONLY" && brandContent}>
                  {privacyLabels[item] ?? item}
                </option>)}
              </select>
            </label>
            {(brandContent || (privacy === "SELF_ONLY" && disclosure)) &&
              <p className="text-sm">Branded content visibility cannot be set to private.</p>}
            <label className="block"><input type="checkbox" checked={comment} disabled={creator.commentDisabled}
              onChange={(event) => setComment(event.target.checked)} /> Allow comments</label>
            <label className="block"><input type="checkbox" checked={duet} disabled={creator.duetDisabled}
              onChange={(event) => setDuet(event.target.checked)} /> Allow Duet</label>
            <label className="block"><input type="checkbox" checked={stitch} disabled={creator.stitchDisabled}
              onChange={(event) => setStitch(event.target.checked)} /> Allow Stitch</label>
            <label className="mt-2 block"><input type="checkbox" checked={disclosure} onChange={(event) => {
              setDisclosure(event.target.checked);
              if (!event.target.checked) { setBrandOrganic(false); setBrandContent(false); }
            }} /> This content promotes me, a brand, product, or service</label>
            {disclosure && <>
              <label className="block"><input type="checkbox" checked={brandOrganic} onChange={(event) => setBrandOrganic(event.target.checked)} /> Your brand</label>
              <label className="block"><input type="checkbox" checked={brandContent} disabled={privacy === "SELF_ONLY"}
                onChange={(event) => setBrandContent(event.target.checked)} /> Branded content</label>
              {!brandOrganic && !brandContent && <p className="text-sm">You need to indicate if your content promotes yourself, a third party, or both.</p>}
              {(brandOrganic || brandContent) && <p className="text-sm">Your video will be labeled as {brandContent ? "Paid partnership" : "Promotional content"}.</p>}
            </>}
            <label className="mt-2 block"><input type="checkbox" checked={aiGenerated} onChange={(event) => setAiGenerated(event.target.checked)} /> This video is AI-generated</label>
            <label className="mt-2 block"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
              {" "}By posting, you agree to TikTok&apos;s{" "}
              {brandContent && <><a className="underline" href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noreferrer">Branded Content Policy</a> and </>}
              <a className="underline" href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer">Music Usage Confirmation</a>.
            </label>
            <button type="button" disabled={!valid} onClick={() => void submit()}
              className="mt-3 rounded bg-blue-700 px-4 py-2 text-white disabled:opacity-50">Post to TikTok</button>
          </>}
        </fieldset>
      )}
      {!!data?.posts.length && <div className="mt-4"><h4 className="font-medium">Recent TikTok posts</h4>
        <ul>{data.posts.map((post) => <li key={post.id} className="mt-2">
          {post.accountName}: {post.status} ({post.createdAt} UTC)
          {post.message && <p>{post.message}</p>}
          {!!post.canCheck && <button type="button" disabled={busy} onClick={() => void check(post.id, "check").catch((error) => setError(error.message))}
            className="mr-2 mt-1 rounded border px-2 py-1 disabled:opacity-50">Check TikTok status</button>}
          {!!post.canResolve && <button type="button" disabled={busy} onClick={() => void resolve(post.id)}
            className="mt-1 rounded border px-2 py-1 disabled:opacity-50">Resolve after checking TikTok</button>}
        </li>)}</ul>
        <p className="mt-2 text-sm">Check TikTok before retrying uncertain posts to avoid duplicates. Interrupted attempts can be resolved after 90 minutes.</p>
      </div>}
    </section>
  );
}
