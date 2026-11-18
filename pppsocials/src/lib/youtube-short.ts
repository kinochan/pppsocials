import { spawn } from "child_process";
import { stat, type FileHandle } from "fs/promises";

export class ShortsValidationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function validateYouTubeShort(file: FileHandle, filepath: string) {
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
      reject(new ShortsValidationError("Unable to check video eligibility with ffprobe."));
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
      reject(new ShortsValidationError(error.code === "ENOENT"
        ? "ffprobe is not installed or not available to the app. Ask an administrator to install it."
        : "Unable to check video eligibility with ffprobe."));
    });
    child.on("close", (code) => {
      if (code !== 0 || tooLarge) reject(new ShortsValidationError("Unable to read video details with ffprobe."));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
  if (!isLinux) {
    const [opened, current] = await Promise.all([file.stat(), stat(filepath)]);
    if (opened.dev !== current.dev || opened.ino !== current.ino ||
        opened.size !== current.size || opened.mtimeMs !== current.mtimeMs) {
      throw new ShortsValidationError("The video file changed while checking eligibility.");
    }
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(output);
  } catch {
    throw new ShortsValidationError("ffprobe returned invalid video details.");
  }
  if (!isRecord(metadata) || !isRecord(metadata.format) || !Array.isArray(metadata.streams) ||
      metadata.streams.length !== 1 || !isRecord(metadata.streams[0])) {
    throw new ShortsValidationError("Could not determine the video duration and dimensions.");
  }
  const stream = metadata.streams[0];
  const duration = Number(metadata.format.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 180) {
    throw new ShortsValidationError("YouTube Shorts must have a known duration of at most three minutes.");
  }
  if (typeof stream.width !== "number" || !Number.isSafeInteger(stream.width) || stream.width <= 0 ||
      typeof stream.height !== "number" || !Number.isSafeInteger(stream.height) || stream.height <= 0) {
    throw new ShortsValidationError("Could not determine the video dimensions.");
  }
  let pixelRatio = 1;
  if (typeof stream.sample_aspect_ratio === "string" && stream.sample_aspect_ratio !== "N/A") {
    const ratio = /^(\d+):(\d+)$/.exec(stream.sample_aspect_ratio);
    if (!ratio || !Number(ratio[1]) || !Number(ratio[2])) {
      throw new ShortsValidationError("Could not determine the video aspect ratio.");
    }
    pixelRatio = Number(ratio[1]) / Number(ratio[2]);
  }
  const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list.filter(isRecord) : [];
  const matrix = sideData.find((item) => item.side_data_type === "Display Matrix");
  const tags = isRecord(stream.tags) ? stream.tags : null;
  const rotationValue = matrix ? matrix.rotation : tags?.rotate;
  const rotation = rotationValue === undefined && !matrix ? 0 : Number(rotationValue);
  if (!Number.isFinite(rotation) || rotation % 90 !== 0) {
    throw new ShortsValidationError("Could not determine the video orientation.");
  }
  const sideways = Math.abs(rotation % 180) === 90;
  const displayWidth = stream.width * pixelRatio;
  const displayHeight = stream.height;
  if ((sideways ? displayHeight : displayWidth) > (sideways ? displayWidth : displayHeight)) {
    throw new ShortsValidationError("YouTube Shorts must be square or vertical, not landscape.");
  }
}
