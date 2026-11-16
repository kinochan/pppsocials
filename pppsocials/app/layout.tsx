import Link from "next/link";

export const metadata = {
  title: "PPP Socials",
  description: "Cross-Platform Social Video Posting",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-gray-100 min-h-screen">
        <nav className="bg-slate-900 text-white shadow">
          <div className="max-w-7xl mx-auto px-6 py-4 flex gap-6">
            <Link
              href="/"
              className="hover:text-blue-400"
            >
              Dashboard
            </Link>

            <Link
              href="/upload"
              className="hover:text-blue-400"
            >
              Upload
            </Link>

            <Link
              href="/library"
              className="hover:text-blue-400"
            >
              Library
            </Link>

            <Link
              href="/settings"
              className="hover:text-blue-400"
            >
              Settings
            </Link>
          </div>
        </nav>

        <div className="max-w-7xl mx-auto p-6">
          {children}
        </div>
      </body>
    </html>
  );
}