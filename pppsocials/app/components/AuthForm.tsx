"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function AuthForm({ setup = false }: { setup?: boolean }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(setup ? "/api/setup" : "/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: data.get("email"),
          password: data.get("password"),
          ...(setup ? { secret: data.get("secret") } : { rememberMe: false }),
        }),
      });
      if (!response.ok) {
        const result = await response.json();
        setMessage(setup ? (result.message || "Setup failed.") :
          response.status === 429 ? "Too many attempts. Please wait and try again." : "Unable to sign in. Check your email and password.");
      } else if (setup) {
        form.reset();
        setMessage("Administrator created. You can now sign in.");
      } else {
        router.replace("/");
        router.refresh();
      }
    } catch (error) {
      console.error("Authentication request failed:", error);
      setMessage("Unable to reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto my-8 max-w-[420px] sm:my-12">
      <h1 className="mb-6 text-3xl font-bold">{setup ? "First administrator setup" : "Sign in to PPP Socials"}</h1>
      <form onSubmit={submit} className="grid gap-3">
        {setup && <label>Setup secret<input name="secret" type="password" autoComplete="off" required className="mt-1 block w-full rounded border bg-white p-2" /></label>}
        <label>Email<input name="email" type="email" autoComplete="username" required maxLength={191} className="mt-1 block w-full rounded border bg-white p-2" /></label>
        <label>Password<input name="password" type="password" autoComplete={setup ? "new-password" : "current-password"} required minLength={12} maxLength={128} className="mt-1 block w-full rounded border bg-white p-2" /></label>
        <button type="submit" disabled={busy} className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50">{busy ? "Please wait..." : setup ? "Create administrator" : "Sign in"}</button>
      </form>
      {message && <p role="status" className="mt-4">{message}</p>}
      {setup && <p className="mt-4"><a className="text-blue-700 underline" href="/login">Go to sign in</a></p>}
    </main>
  );
}
