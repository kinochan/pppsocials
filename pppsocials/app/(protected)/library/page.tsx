"use client";

import { useEffect, useState } from "react";
import StoryPublish from "@/app/components/StoryPublish";

type Video = {
  id: string;
  title: string;
  description: string | null;
  filename: string;
  original_filename: string | null;
};

export default function LibraryPage() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [failedVideos, setFailedVideos] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [message, setMessage] = useState("");

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

  async function deleteVideo(video: Video) {
    if (deleting || !window.confirm(`Delete "${video.title}" and its video file? This cannot be undone.`)) return;
    setDeleting(video.id);
    setMessage("");
    try {
      const response = await fetch(`/api/library/${video.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: video.filename }),
      });
      const result: { message?: string; warning?: string } = await response.json();
      if (!response.ok) throw new Error(result.message || "Unable to delete the video.");
      setVideos((current) => current.filter((item) => item.id !== video.id));
      setMessage(result.warning || "Video deleted.");
    } catch (error) {
      console.error("Failed to delete video:", error);
      setMessage(error instanceof Error ? error.message : "Unable to delete the video.");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <main className="p-2 sm:p-8">
      <h1 className="text-3xl font-bold mb-6">Video Library</h1>

      {status === "loading" && <p>Loading videos...</p>}
      {status === "error" && <p role="alert">Unable to load videos. Please try again later.</p>}
      {message && <p role="status" className="mb-4">{message}</p>}
      {status === "ready" && videos.length === 0 && <p>No videos uploaded yet.</p>}
      {status === "ready" && videos.length > 0 && (
        <div className="grid gap-6">
          {videos.map((video) => (
            <div key={video.id} className="border rounded-lg p-4 shadow">
              <h2 className="font-semibold mb-3">{video.title}</h2>
              <p className="mb-3 break-all text-sm">
                {video.original_filename ?? video.filename.replace(/^[0-9a-f-]{36}-/i, "")}
                {!video.original_filename && " (older upload: filename may be approximate)"}
              </p>
              {video.description && <p className="mb-3 whitespace-pre-wrap">{video.description}</p>}
              <video
                controls
                preload="metadata"
                className="w-full max-w-2xl max-h-[50vh] object-contain bg-black"
                style={{ display: "block", width: "100%", maxWidth: "42rem", maxHeight: "50vh", objectFit: "contain" }}
                src={`/api/library/${video.id}`}
                onError={() => setFailedVideos((current) => [...current, video.id])}
              >
                Your browser does not support video playback.
              </video>
              {failedVideos.includes(video.id) && (
                <p role="alert">Unable to play this video. The file may be missing or unsupported by your browser.</p>
              )}
              <StoryPublish videoId={video.id} filename={video.filename} />
              <button
                type="button"
                disabled={deleting !== null}
                onClick={() => void deleteVideo(video)}
                className="mt-3 rounded bg-red-700 px-4 py-2 text-white disabled:opacity-50"
              >
                {deleting === video.id ? "Deleting..." : "Delete video"}
              </button>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
