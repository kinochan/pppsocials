"use client";

import { useEffect, useState } from "react";

export default function LibraryPage() {
  const [files, setFiles] = useState<string[]>([]);

  useEffect(() => {
    async function loadFiles() {
      const response = await fetch(
        "/api/library"
      );

      const data = await response.json();

      setFiles(data);
    }

    loadFiles();
  }, []);

  return (
    <main className="p-8">
      <h1 className="text-3xl font-bold mb-6">
        Video Library
      </h1>

      {files.length === 0 ? (
        <p>No videos uploaded yet.</p>
      ) : (
        <div className="grid gap-6">
          {files.map((file) => (
            <div
              key={file}
              className="border rounded-lg p-4 shadow"
            >
              <h2 className="font-semibold mb-3">
                {file}
              </h2>

              <video
                controls
                className="w-full max-w-2xl rounded"
              >
                <source
                  src={`/uploads/${file}`}
                />
              </video>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}