import Link from "next/link";
import { headers } from "next/headers";
import { Suspense } from "react";
import { currentUser } from "@/src/lib/access";
import SignOut from "@/app/components/SignOut";
import "./globals.css";

export const metadata = {
  title: "PPP Socials",
  description: "Cross-Platform Social Video Posting",
};

async function Navigation() {
  const user = await currentUser(await headers());
  if (!user) return null;
  return (
    <nav aria-label="Main navigation" className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-gray-900 px-4 py-3 text-white sm:px-6">
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

        <div className="max-w-7xl mx-auto p-4 sm:p-6">
          {children}
        </div>
        <footer className="mx-auto flex max-w-7xl flex-wrap gap-x-5 gap-y-2 px-4 pb-6 text-sm text-gray-600 sm:px-6">
          <Link href="/tos" className="underline underline-offset-2">Terms of Service</Link>
          <Link href="/policy" className="underline underline-offset-2">Privacy Policy</Link>
        </footer>
      </body>
    </html>
  );
}