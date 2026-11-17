import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { currentUser } from "@/src/lib/access";

async function Protected({ children }: { children: React.ReactNode }) {
  const user = await currentUser(await headers());
  if (!user) redirect("/login");
  return children;
}

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={null}><Protected>{children}</Protected></Suspense>;
}
