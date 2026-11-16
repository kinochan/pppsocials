"use client";

import { useEffect, useState } from "react";

type Video = {
  id: string;
  title: string;
  description: string | null;
};

export default function LibraryPage() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [failedVideos, setFailedVideos] = useState<string[]>([]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadVideos() {
      try {
        const response = await fetch("/api/library", { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error(`Library request failed: ${response.status}`);
        const data: Video[] = await response.json();
        setVideos(data);
        setStatus("ready");
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error("Failed to load library:", error);
        setStatus("error");
      }
    }

    void loadVideos();
    return () => controller.abort();
  }, []);

  return (
    <main className="p-8">
      <h1 className="text-3xl font-bold mb-6">Video Library</h1>

      {status === "loading" && <p>Loading videos...</p>}
      {status === "error" && <p role="alert">Unable to load videos. Please try again later.</p>}
      {status === "ready" && videos.length === 0 && <p>No videos uploaded yet.</p>}
      {status === "ready" && videos.length > 0 && (
        <div className="grid gap-6">
          {videos.map((video) => (
            <div key={video.id} className="border rounded-lg p-4 shadow">
              <h2 className="font-semibold mb-3">{video.title}</h2>
              {video.description && <p className="mb-3 whitespace-pre-wrap">{video.description}</p>}
              <video
                controls
                preload="metadata"
                className="w-full max-w-2xl"
                src={`/api/library/${video.id}`}
                onError={() => setFailedVideos((current) => [...current, video.id])}
              >
                Your browser does not support video playback.
              </video>
              {failedVideos.includes(video.id) && (
                <p role="alert">Unable to play this video. The file may be missing or unsupported by your browser.</p>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
