import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { currentUser } from "@/src/lib/access";

async function AdminContent({ children }: { children: React.ReactNode }) {
  const user = await currentUser(await headers());
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");
  return children;
}

export default function AdminGuard({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={null}><AdminContent>{children}</AdminContent></Suspense>;
}
