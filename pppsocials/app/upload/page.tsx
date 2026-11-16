"use client";

import { useState } from "react";

export default function UploadPage() {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);

  async function handleSubmit(
    e: React.FormEvent
  ) {
    e.preventDefault();

    if (!file) {
      alert("Please select a video file.");
      return;
    }

    const formData = new FormData();

    formData.append("title", title);
    formData.append("description", description);
    formData.append("file", file);

    try {
      const response = await fetch(
        "/api/upload",
        {
          method: "POST",
          body: formData,
        }
      );

      const result = await response.json();
      if (!response.ok) {
        alert(result.message || "Upload failed.");
        return;
      }

      alert(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error("Upload failed:", error);
      alert("Upload failed. Please try again.");
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
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
        >
          Upload Video
        </button>
      </form>
    </main>
  );
}