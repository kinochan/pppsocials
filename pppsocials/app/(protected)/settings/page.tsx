"use client";

import { useEffect, useState } from "react";

type InstagramStatus =
  | { enabled: false }
  | { enabled: true; accounts: { id: string; username: string }[] | null };

type FacebookStatus =
  | { enabled: false }
  | { enabled: true; pages: { id: string; name: string }[] | null };

type YouTubeStatus =
  | { enabled: false }
  | { enabled: true; channels: { id: string; title: string }[] };

type TikTokStatus =
  | { enabled: false }
  | { enabled: true; uploadEnabled: boolean; directEnabled: boolean; accounts: { id: string; displayName: string }[] };

export default function SettingsPage() {
  const [status, setStatus] = useState<InstagramStatus | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [facebookStatus, setFacebookStatus] = useState<FacebookStatus | null>(null);
  const [facebookError, setFacebookError] = useState("");
  const [facebookResult, setFacebookResult] = useState("");
  const [youtubeStatus, setYouTubeStatus] = useState<YouTubeStatus | null>(null);
  const [youtubeError, setYouTubeError] = useState("");
  const [youtubeResult, setYouTubeResult] = useState("");
  const [tiktokStatus, setTikTokStatus] = useState<TikTokStatus | null>(null);
  const [tiktokError, setTikTokError] = useState("");
  const [tiktokResult, setTikTokResult] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("instagram");
    const facebookOutcome = params.get("facebook");
    const youtubeOutcome = params.get("youtube");
    const tiktokOutcome = params.get("tiktok");
    if (outcome || facebookOutcome || youtubeOutcome || tiktokOutcome) window.history.replaceState(null, "", "/settings");

    async function loadStatus() {
      try {
        const response = await fetch("/api/instagram/status", { cache: "no-store" });
        if (!response.ok) throw new Error("Status request failed");
        setStatus(await response.json());
        if (outcome === "connected") setResult("Instagram connection saved.");
        if (outcome === "cancelled") setError("Instagram authorization was cancelled or rejected.");
        if (outcome === "invalid-state") setError("The connection request expired or was invalid. Please try again.");
        if (outcome === "failed") setError("Could not connect Instagram. Check the server logs and try again.");
      } catch {
        setError("Could not load Instagram connection status. Check the server configuration and database.");
      }
    }
    void loadStatus();

    async function loadFacebookStatus() {
      try {
        const response = await fetch("/api/facebook/status", { cache: "no-store" });
        if (!response.ok) throw new Error("Status request failed");
        setFacebookStatus(await response.json());
        if (facebookOutcome === "connected") setFacebookResult("Facebook Pages saved.");
        if (facebookOutcome === "cancelled") setFacebookError("Facebook authorization was cancelled or rejected.");
        if (facebookOutcome === "invalid-state") setFacebookError("The connection request expired or was invalid. Please try again.");
        if (facebookOutcome === "failed") setFacebookError("Could not connect Facebook. Check the server logs and try again.");
      } catch {
        setFacebookError("Could not load Facebook connection status. Check the server configuration and database.");
      }
    }
    void loadFacebookStatus();

    async function loadYouTubeStatus() {
      try {
        const response = await fetch("/api/youtube/status", { cache: "no-store" });
        if (!response.ok) throw new Error("Status request failed");
        setYouTubeStatus(await response.json());
        if (youtubeOutcome === "connected") setYouTubeResult("YouTube channel saved.");
        if (youtubeOutcome === "cancelled") setYouTubeError("YouTube authorization was cancelled or rejected.");
        if (youtubeOutcome === "invalid-state") setYouTubeError("The connection request expired or was invalid. Please try again.");
        if (youtubeOutcome === "failed") setYouTubeError("Could not connect YouTube. Check the server logs and try again.");
      } catch {
        setYouTubeError("Could not load YouTube connection status. Check the server configuration and database.");
      }
    }
    void loadYouTubeStatus();

    async function loadTikTokStatus() {
      try {
        const response = await fetch("/api/tiktok/status", { cache: "no-store" });
        if (!response.ok) throw new Error("Status request failed");
        setTikTokStatus(await response.json());
        if (tiktokOutcome === "connected") setTikTokResult("TikTok account saved.");
        if (tiktokOutcome === "cancelled") setTikTokError("TikTok authorization was cancelled or rejected.");
        if (tiktokOutcome === "invalid-state") setTikTokError("The connection request expired or was invalid. Please try again.");
        if (tiktokOutcome === "failed") setTikTokError("Could not connect TikTok. Check the server logs and try again.");
      } catch {
        setTikTokError("Could not load TikTok connection status. Check the server configuration and database.");
      }
    }
    void loadTikTokStatus();
  }, []);

  return (
    <main className="max-w-2xl mx-auto sm:p-8">
      <h1 className="text-3xl font-bold mb-6">Settings</h1>
      <section className="border rounded-lg p-4 bg-white shadow">
        <h2 className="text-xl font-semibold mb-3">Instagram</h2>
        <p className="mb-3">
          Connect one or more professional Instagram accounts to prepare for publishing.
          You can connect accounts from additional Meta business portfolios without replacing saved accounts.
          Meta will request access to the account and the permissions configured in your Meta app.
        </p>
        {result && <p role="status" className="mb-3 text-green-700">{result}</p>}
        {error && <p role="alert" className="mb-3 text-red-700">{error}</p>}
        {!status && !error && <p>Loading connection status...</p>}
        {status && !status.enabled && (
          <p>Instagram connection is disabled. See the server setup instructions in the README.</p>
        )}
        {status?.enabled && (
          <>
            {status.accounts ? (
              <>
                <p className="mb-2">Saved accounts (connection not checked with Meta):</p>
                <ul className="list-disc pl-6 mb-3">
                  {status.accounts.map((account) => <li key={account.id}>@{account.username}</li>)}
                </ul>
              </>
            ) : <p className="mb-3">No Instagram account connected.</p>}
            <form action="/api/instagram/connect" method="post">
              <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">
                {status.accounts ? "Connect another Instagram account" : "Connect Instagram"}
              </button>
            </form>
          </>
        )}
      </section>
      <section className="border rounded-lg p-4 bg-white shadow mt-6">
        <h2 className="text-xl font-semibold mb-3">TikTok</h2>
        <p className="mb-3">
          Connect TikTok accounts one at a time.
          {tiktokStatus?.enabled && tiktokStatus.uploadEnabled
            ? " Grant video upload access and reconnect existing accounts to send videos to TikTok's inbox."
            : " Video uploads require additional configuration and permission."}
          {tiktokStatus?.enabled && tiktokStatus.directEnabled &&
            " Reconnect accounts and grant Direct Post permission to post directly."}
        </p>
        {tiktokResult && <p role="status" className="mb-3 text-green-700">{tiktokResult}</p>}
        {tiktokError && <p role="alert" className="mb-3 text-red-700">{tiktokError}</p>}
        {!tiktokStatus && !tiktokError && <p>Loading connection status...</p>}
        {tiktokStatus && !tiktokStatus.enabled && (
          <p>TikTok connection is disabled. See the server setup instructions in the README.</p>
        )}
        {tiktokStatus?.enabled && (
          <>
            {tiktokStatus.accounts.length > 0 ? (
              <>
                <p className="mb-2">Saved accounts (connection not checked with TikTok):</p>
                <ul className="list-disc pl-6 mb-3">
                  {tiktokStatus.accounts.map((account) => <li key={account.id}>{account.displayName}</li>)}
                </ul>
              </>
            ) : <p className="mb-3">No TikTok accounts connected.</p>}
            <form action="/api/tiktok/connect" method="post">
              <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">
                Connect a TikTok account
              </button>
            </form>
          </>
        )}
      </section>
      <section className="border rounded-lg p-4 bg-white shadow mt-6">
        <h2 className="text-xl font-semibold mb-3">YouTube Shorts</h2>
        <p className="mb-3">
          Connect YouTube channels one at a time. This requests access to identify
          the channel and upload videos. Reconnect existing channels to grant upload access.
        </p>
        {youtubeResult && <p role="status" className="mb-3 text-green-700">{youtubeResult}</p>}
        {youtubeError && <p role="alert" className="mb-3 text-red-700">{youtubeError}</p>}
        {!youtubeStatus && !youtubeError && <p>Loading connection status...</p>}
        {youtubeStatus && !youtubeStatus.enabled && (
          <p>YouTube connection is disabled. See the server setup instructions in the README.</p>
        )}
        {youtubeStatus?.enabled && (
          <>
            {youtubeStatus.channels.length > 0 ? (
              <>
                <p className="mb-2">Saved channels (connection not checked with Google):</p>
                <ul className="list-disc pl-6 mb-3">
                  {youtubeStatus.channels.map((channel) => <li key={channel.id}>{channel.title}</li>)}
                </ul>
              </>
            ) : <p className="mb-3">No YouTube channels connected.</p>}
            <form action="/api/youtube/connect" method="post">
              <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">
                Connect a YouTube channel
              </button>
            </form>
          </>
        )}
      </section>
      <section className="border rounded-lg p-4 bg-white shadow mt-6">
        <h2 className="text-xl font-semibold mb-3">Facebook Pages</h2>
        <p className="mb-3">Connect Facebook Pages to prepare for publishing Stories.</p>
        {facebookResult && <p role="status" className="mb-3 text-green-700">{facebookResult}</p>}
        {facebookError && <p role="alert" className="mb-3 text-red-700">{facebookError}</p>}
        {!facebookStatus && !facebookError && <p>Loading connection status...</p>}
        {facebookStatus && !facebookStatus.enabled && (
          <p>Facebook connection is disabled. See the server setup instructions in the README.</p>
        )}
        {facebookStatus?.enabled && (
          <>
            {facebookStatus.pages ? (
              <>
                <p className="mb-2">Saved Pages (connection not checked with Meta):</p>
                <ul className="list-disc pl-6 mb-3">
                  {facebookStatus.pages.map((page) => <li key={page.id}>{page.name}</li>)}
                </ul>
              </>
            ) : <p className="mb-3">No Facebook Pages connected.</p>}
            <form action="/api/facebook/connect" method="post">
              <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">
                {facebookStatus.pages ? "Reconnect or replace Pages" : "Connect Facebook Pages"}
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}