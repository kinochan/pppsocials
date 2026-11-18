"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function SignOut() {
  const [error, setError] = useState("");
  const router = useRouter();
  async function signOut() {
    try {
      const response = await fetch("/api/auth/sign-out", { method: "POST" });
      if (!response.ok) throw new Error("Sign out failed.");
      router.replace("/login");
      router.refresh();
    } catch (error) {
      console.error("Sign out failed:", error);
      setError("Unable to sign out. Please try again.");
    }
  }
  return <span className="max-w-full break-words"><button type="button" className="cursor-pointer underline" onClick={signOut}>Sign out</button> {error && <span role="alert">{error}</span>}</span>;
}
