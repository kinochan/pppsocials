import { spawn } from "child_process";
import { stat, type FileHandle } from "fs/promises";

export class VideoProbeError extends Error {}

export async function probeVideo(file: FileHandle, filepath: string): Promise<unknown> {
  const isLinux = process.platform === "linux";
  const input = isLinux ? "/proc/self/fd/3" : filepath;
  const args = [
    "-v", "error", "-protocol_whitelist", "file,pipe",
    "-format_whitelist", "mov,matroska,avi,mpeg,mpegts,flv,ogg",
    "-select_streams", "V",
    "-show_entries", "stream=width,height,sample_aspect_ratio:stream_tags=rotate:stream_side_data_list:format=duration",
    "-of", "json", "-i", input,
  ];
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("ffprobe", args, {
      stdio: ["ignore", "pipe", "ignore", file.fd],
      signal: AbortSignal.timeout(30000),
      windowsHide: true,
    });
    if (!child.stdout) {
      child.kill();
      reject(new VideoProbeError("Unable to check video eligibility with ffprobe."));
      return;
    }
    const chunks: Buffer[] = [];
    let length = 0;
    let tooLarge = false;
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 65536) {
        tooLarge = true;
        child.kill();
      } else {
        chunks.push(chunk);
      }
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(new VideoProbeError(error.code === "ENOENT"
        ? "ffprobe is not installed or not available to the app. Ask an administrator to install it."
        : "Unable to check video eligibility with ffprobe."));
    });
    child.on("close", (code) => {
      if (code !== 0 || tooLarge) reject(new VideoProbeError("Unable to read video details with ffprobe."));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
  if (!isLinux) {
    const [opened, current] = await Promise.all([file.stat(), stat(filepath)]);
    if (opened.dev !== current.dev || opened.ino !== current.ino ||
        opened.size !== current.size || opened.mtimeMs !== current.mtimeMs) {
      throw new VideoProbeError("The video file changed while checking eligibility.");
    }
  }
  try {
    return JSON.parse(output);
  } catch {
    throw new VideoProbeError("ffprobe returned invalid video details.");
  }
}
