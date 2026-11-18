import type { FileHandle } from "fs/promises";
import { probeVideo, VideoProbeError } from "@/src/lib/video-probe";

export class ShortsValidationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function validateYouTubeShort(file: FileHandle, filepath: string) {
  let metadata: unknown;
  try {
    metadata = await probeVideo(file, filepath);
  } catch (error) {
    if (error instanceof VideoProbeError) throw new ShortsValidationError(error.message);
    throw error;
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
