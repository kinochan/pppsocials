"use client";

import { useEffect, useState } from "react";

type InstagramStatus =
  | { enabled: false }
  | { enabled: true; accounts: { id: string; username: string }[] | null };

type FacebookStatus =
  | { enabled: false }
  | { enabled: true; pages: { id: string; name: string }[] | null };

export default function SettingsPage() {
  const [status, setStatus] = useState<InstagramStatus | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [facebookStatus, setFacebookStatus] = useState<FacebookStatus | null>(null);
  const [facebookError, setFacebookError] = useState("");
  const [facebookResult, setFacebookResult] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("instagram");
    const facebookOutcome = params.get("facebook");
    if (outcome || facebookOutcome) window.history.replaceState(null, "", "/settings");

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
  }, []);

  return (
    <main className="p-8 max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold mb-6">Settings</h1>
      <section className="border rounded-lg p-4 bg-white shadow">
        <h2 className="text-xl font-semibold mb-3">Instagram</h2>
        <p className="mb-3">
          Connect a professional Instagram account to prepare for publishing.
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
                {status.accounts ? "Reconnect or replace accounts" : "Connect Instagram"}
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