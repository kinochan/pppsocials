"use client";

import { useEffect, useState } from "react";

type User = { id: string; email: string; role: string | null; banned: boolean | null };

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/users?offset=${offset}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load users.");
        const result: { users: User[]; total: number } = await response.json();
        setUsers(result.users);
        setTotal(result.total);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.error("Could not load users:", error);
        setMessage("Unable to load users.");
      });
    return () => controller.abort();
  }, [offset, refresh]);

  async function update(body: Record<string, string>, form?: HTMLFormElement) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result: { message?: string } = await response.json();
      if (!response.ok) throw new Error(result.message || "Unable to update user.");
      form?.reset();
      setMessage(result.message || "Updated.");
      setRefresh((value) => value + 1);
    } catch (error) {
      console.error("User administration failed:", error);
      setMessage(error instanceof Error ? error.message : "Unable to update user.");
    } finally {
      setBusy(false);
    }
  }

  function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void update({ action: "create", email: String(data.get("email")), password: String(data.get("password")), role: String(data.get("role")) }, form);
  }

  function reset(event: React.FormEvent<HTMLFormElement>, userId: string) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (!window.confirm("Reset this password and sign out all of this user's sessions?")) return;
    void update({ action: "reset", userId, password: String(data.get("password")) }, form);
  }

  return (
    <main style={{ maxWidth: 700, margin: "2rem auto", fontFamily: "sans-serif" }}>
      <h1>Users</h1>
      <p>Only administrators can manage users. Share passwords privately.</p>
      <h2>Create a user</h2>
      <form onSubmit={create} style={{ display: "grid", gap: 10 }}>
        <label>Email <input name="email" type="email" required maxLength={191} /></label>
        <label>Temporary password <input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>
        <label>Role <select name="role"><option value="user">Standard</option><option value="admin">Administrator</option></select></label>
        <button disabled={busy}>Create user</button>
      </form>
      {message && <p role="status">{message}</p>}
      <h2>Existing users</h2>
      {users.map((user) => (
        <section key={user.id} style={{ border: "1px solid #ccc", padding: 12, marginBottom: 12 }}>
          <strong>{user.email}</strong> — {user.role === "admin" ? "Administrator" : "Standard"}{user.banned ? " (disabled)" : ""}
          <form onSubmit={(event) => reset(event, user.id)} style={{ marginTop: 10 }}>
            <label>New password <input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>{" "}
            <button disabled={busy}>Reset password</button>
          </form>
          {user.role === "user" && (
            <button type="button" disabled={busy} style={{ marginTop: 10 }} onClick={() => {
              const action = user.banned ? "enable" : "disable";
              if (window.confirm(`${action === "disable" ? "Disable" : "Enable"} ${user.email}?`)) {
                void update({ action, userId: user.id });
              }
            }}>{user.banned ? "Enable user" : "Disable user"}</button>
          )}
        </section>
      ))}
      <button disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button>{" "}
      <button disabled={busy || offset + 50 >= total} onClick={() => setOffset(offset + 50)}>Next</button>
    </main>
  );
}
