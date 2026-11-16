export default function Home() {
  return (
    <main>
      <h1 className="text-4xl font-bold mb-4">
        PPP Socials
      </h1>

      <p className="text-lg">
        Upload once. Publish everywhere.
      </p>

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <div className="border rounded-lg p-4 bg-white shadow">
          <h2 className="font-bold">
            Upload Videos
          </h2>
          <p>Create new social media content.</p>
        </div>

        <div className="border rounded-lg p-4 bg-white shadow">
          <h2 className="font-bold">
            Media Library
          </h2>
          <p>View and manage uploaded videos.</p>
        </div>

        <div className="border rounded-lg p-4 bg-white shadow">
          <h2 className="font-bold">
            Publishing
          </h2>
          <p>Coming soon: YouTube, Facebook, Instagram and TikTok.</p>
        </div>
      </div>
    </main>
  );
}