import Link from "next/link";
import { headers } from "next/headers";
import { Suspense } from "react";
import { currentUser } from "@/src/lib/access";
import SignOut from "@/app/components/SignOut";

export const metadata = {
  title: "PPP Socials",
  description: "Cross-Platform Social Video Posting",
};

async function Navigation() {
  const user = await currentUser(await headers());
  if (!user) return null;
  return (
    <nav style={{ display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "center" }}>
      <Link href="/">Dashboard</Link>
      <Link href="/upload">Upload</Link>
      <Link href="/library">Library</Link>
      {user.role === "admin" && <><Link href="/settings">Settings</Link><Link href="/users">Users</Link></>}
      <SignOut />
    </nav>
  );
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-gray-100 min-h-screen">
        <Suspense fallback={null}><Navigation /></Suspense>

        <div className="max-w-7xl mx-auto p-6">
          {children}
        </div>
      </body>
    </html>
  );
}