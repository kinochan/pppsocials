import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1 className="text-4xl font-bold mb-4">
        MBA Social Hub
      </h1>

      <p className="text-lg">
        Upload once. Publish everywhere.
      </p>

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <Link href="/upload" className="block border rounded-lg p-4 bg-white shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-blue-700">
          <h2 className="font-bold">
            Upload Videos
          </h2>
          <p>Create new social media content.</p>
        </Link>

        <Link href="/library" className="block border rounded-lg p-4 bg-white shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-blue-700">
          <h2 className="font-bold">
            Media Library
          </h2>
          <p>View and manage uploaded videos.</p>
        </Link>

        <Link href="/library" className="block border rounded-lg p-4 bg-white shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-blue-700">
          <h2 className="font-bold">
            Publishing
          </h2>
          <p>Choose a video in the library to publish.</p>
        </Link>
      </div>
    </main>
  );
}