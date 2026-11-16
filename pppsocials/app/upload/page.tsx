"use client";

import { useEffect, useRef, useState } from "react";

export default function UploadPage() {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<"idle" | "uploading" | "processing" | "success" | "error">("idle");
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const activeRequest = useRef<XMLHttpRequest | null>(null);
  const busy = status === "uploading" || status === "processing";

  useEffect(() => () => {
    const request = activeRequest.current;
    activeRequest.current = null;
    request?.abort();
  }, []);

  function handleSubmit(
    e: React.FormEvent
  ) {
    e.preventDefault();

    if (activeRequest.current) return;
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

    const formData = new FormData();

    formData.append("title", title);
    formData.append("description", description);
    formData.append("file", file);

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
        setStatus("success");
        setMessage("Upload complete.");
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
    <main className="p-8 max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold mb-6">
        Upload Video
      </h1>

      <form
        onSubmit={handleSubmit}
        className="space-y-4"
      >
        <fieldset disabled={busy} className="space-y-4">
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
          {status === "processing" ? "Saving..." : busy ? "Uploading..." : "Upload Video"}
        </button>
        </fieldset>
        {busy && (
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