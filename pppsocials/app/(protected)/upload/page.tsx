"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Match = {
  id: string;
  title: string;
  description: string | null;
  filename: string;
  original_filename: string | null;
};

export default function UploadPage() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<"idle" | "checking" | "choosing" | "uploading" | "processing" | "error">("idle");
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const activeRequest = useRef<XMLHttpRequest | null>(null);
  const activeCheck = useRef<AbortController | null>(null);
  const busy = status === "checking" || status === "choosing" || status === "uploading" || status === "processing";
  const uploading = status === "uploading" || status === "processing";

  useEffect(() => () => {
    activeCheck.current?.abort();
    activeCheck.current = null;
    const request = activeRequest.current;
    activeRequest.current = null;
    request?.abort();
  }, []);

  async function handleSubmit(
    e: React.FormEvent
  ) {
    e.preventDefault();

    if (activeRequest.current || activeCheck.current || busy) return;
    if (!file) {
      setStatus("error");
      setMessage("Please select a video file.");
      return;
    }
    if (file.size > 1_000_000_000) {
      setStatus("error");
      setMessage("Video must be 1 GB or smaller.");
      return;
    }

    const controller = new AbortController();
    activeCheck.current = controller;
    setStatus("checking");
    setMessage("");
    try {
      const response = await fetch("/api/upload/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Unable to check for existing videos.");
      const found: Match[] = await response.json();
      if (controller.signal.aborted) return;
      if (found.length) {
        setMatches(found);
        setStatus("choosing");
      } else {
        sendUpload();
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error("Failed to check video filenames:", error);
      setStatus("error");
      setMessage("Unable to check for existing videos. Please try again.");
    } finally {
      if (activeCheck.current === controller) activeCheck.current = null;
    }
  }

  function sendUpload(replacement?: Match) {
    if (!file || activeRequest.current) return;
    const formData = new FormData();

    formData.append("title", title);
    formData.append("description", description);
    formData.append("file", file);
    if (replacement) {
      formData.append("replaceId", replacement.id);
      formData.append("expectedFilename", replacement.filename);
    }

    const request = new XMLHttpRequest();
    activeRequest.current = request;
    setStatus("uploading");
    setProgress(null);
    setMessage("");

    request.upload.onprogress = (event) => {
      if (activeRequest.current === request && event.lengthComputable && event.total > 0) {
        setProgress(Math.min(100, Math.floor(event.loaded / event.total * 100)));
      }
    };
    request.upload.onload = () => {
      if (activeRequest.current !== request) return;
      setProgress(100);
      setStatus("processing");
    };
    request.onload = () => {
      if (activeRequest.current !== request) return;
      activeRequest.current = null;
      const result: unknown = request.response;
      const isResult = typeof result === "object" && result !== null;
      if (request.status >= 200 && request.status < 300 && isResult &&
          "success" in result && result.success === true) {
        const params = new URLSearchParams({ upload: replacement ? "replaced" : "complete" });
        if ("warning" in result && typeof result.warning === "string") {
          params.set("warning", result.warning);
        }
        router.push(`/library?${params}`);
      } else {
        const errorMessage = request.status === 413
          ? "The video is too large for the server to accept. The maximum video size is 1 GB."
          : isResult && "message" in result && typeof result.message === "string"
            ? result.message
            : "Upload failed. Please try again.";
        setStatus("error");
        setMessage(errorMessage);
      }
    };
    request.onerror = () => {
      if (activeRequest.current !== request) return;
      activeRequest.current = null;
      setStatus("error");
      setMessage("Upload failed. Check your connection and try again.");
    };
    request.onabort = () => {
      if (activeRequest.current !== request) return;
      activeRequest.current = null;
      setStatus("error");
      setMessage("Upload was interrupted. Please try again.");
    };
    try {
      request.open("POST", "/api/upload");
      request.responseType = "json";
      request.send(formData);
    } catch (error) {
      activeRequest.current = null;
      console.error("Upload failed:", error);
      setStatus("error");
      setMessage("Upload failed. Please try again.");
    }
  }

  return (
    <main className="max-w-2xl mx-auto sm:p-8">
      <h1 className="text-3xl font-bold mb-6">
        Upload Video
      </h1>

      <form
        onSubmit={handleSubmit}
        className="space-y-4"
      >
        <fieldset disabled={busy} className="min-w-0 space-y-4">
        <div>
          <label className="block font-semibold mb-1">
            Title
          </label>

          <input
            type="text"
            value={title}
            onChange={(e) =>
              setTitle(e.target.value)
            }
            className="border p-2 w-full rounded"
            placeholder="Enter video title"
            maxLength={255}
            required
          />
        </div>

        <div>
          <label className="block font-semibold mb-1">
            Description
          </label>

          <textarea
            value={description}
            onChange={(e) =>
              setDescription(e.target.value)
            }
            className="border p-2 w-full rounded"
            rows={5}
            placeholder="Enter video description"
          />
        </div>

        <div>
          <label className="block font-semibold mb-1">
            Video File
          </label>

          <input
            type="file"
            accept="video/*"
            className="block w-full"
            onChange={(e) =>
              setFile(
                e.target.files?.[0] || null
              )
            }
            required
          />
        </div>

        <button
          type="submit"
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {status === "checking" ? "Checking..." : status === "processing" ? "Saving..." : uploading ? "Uploading..." : "Upload Video"}
        </button>
        </fieldset>
        {status === "choosing" && (
          <div className="space-y-3">
            <p>A video with this filename may already exist. Choose the copy to replace, or cancel.</p>
            {matches.map((match) => (
              <div key={match.id} className="rounded border p-3">
                <p className="font-semibold">{match.title}</p>
                <p>Library ID: {match.id}</p>
                {match.description && <p>{match.description}</p>}
                <p className="break-all text-sm">
                  {match.original_filename ?? match.filename.replace(/^[0-9a-f-]{36}-/i, "")}
                  {!match.original_filename && " (older upload: possible match)"}
                </p>
                <video
                  controls
                  preload="none"
                  src={`/api/library/${match.id}`}
                  style={{ display: "block", width: "100%", maxWidth: "42rem", maxHeight: "50vh", objectFit: "contain" }}
                />
                <button
                  type="button"
                  className="mt-2 rounded bg-blue-600 px-4 py-2 text-white"
                  onClick={() => {
                    if (window.confirm(`Replace "${match.title}"? Its video and details will be overwritten.`)) sendUpload(match);
                  }}
                >
                  Replace this video
                </button>
              </div>
            ))}
            <button type="button" className="rounded border px-4 py-2" onClick={() => { setMatches([]); setStatus("idle"); }}>
              Cancel
            </button>
          </div>
        )}
        {uploading && (
          <div>
            <label htmlFor="upload-progress" className="block font-semibold mb-1">
              {status === "processing" ? "Saving video..." : "Uploading video..."}
            </label>
            <progress
              id="upload-progress"
              max={100}
              value={progress ?? undefined}
              className="w-full"
            />
            {progress !== null && <p>{progress}% uploaded</p>}
          </div>
        )}
        {message && <p role={status === "error" ? "alert" : "status"}>{message}</p>}
      </form>
    </main>
  );
}