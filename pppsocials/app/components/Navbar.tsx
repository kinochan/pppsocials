import Link from "next/link";

export default function Navbar() {
  return (
    <nav className="bg-gray-900 text-white p-4">
      <div className="flex gap-6">
        <Link href="/">Dashboard</Link>
        <Link href="/upload">Upload</Link>
        <Link href="/library">Library</Link>
        <Link href="/settings">Settings</Link>
      </div>
    </nav>
  );
}