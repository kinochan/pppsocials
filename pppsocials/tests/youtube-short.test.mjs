import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(metadata, error) {
  const source = await readFile(path.join(root, "src", "lib", "youtube-short.ts"), "utf8");
  const probeSource = await readFile(path.join(root, "src", "lib", "video-probe.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const exports = {};
  const spawn = (command, args, options) => {
    assert.equal(command, "ffprobe");
    assert.equal(args.at(-1), "/proc/self/fd/3");
    assert.equal(options.stdio[3], 12);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      if (error) child.emit("error", Object.assign(new Error("Missing"), { code: "ENOENT" }));
      else {
        child.stdout.write(JSON.stringify(metadata));
        child.stdout.end();
        child.emit("close", 0);
      }
    });
    return child;
  };
  const probe = {};
  const probeCompiled = ts.transpileModule(probeSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  new Function("require", "exports", "process", probeCompiled)(
    (name) => name === "child_process" ? { spawn } : require(name), probe, { platform: "linux" }
  );
  new Function("require", "exports", compiled)(
    (name) => name === "@/src/lib/video-probe" ? probe : require(name), exports
  );
  return exports;
}

function metadata(width, height, duration, extra = {}) {
  return { streams: [{ width, height, sample_aspect_ratio: "1:1", ...extra }], format: { duration } };
}

test("accepts square, vertical, and correctly rotated videos up to exactly three minutes", async () => {
  for (const data of [
    metadata(1080, 1920, "180.000"),
    metadata(1080, 1080, "3"),
    metadata(1920, 1080, "60", { side_data_list: [{ side_data_type: "Display Matrix", rotation: 90 }] }),
    metadata(1920, 1080, "60", { tags: { rotate: "270" } }),
  ]) {
    const lib = await load(data);
    await lib.validateYouTubeShort({ fd: 12 }, "unused");
  }
});

test("blocks long, landscape, malformed, and uncheckable videos", async () => {
  for (const [data, expected] of [
    [metadata(1080, 1920, "180.001"), /three minutes/],
    [metadata(1920, 1080, "10"), /landscape/],
    [metadata(1080, 1920, "10", { side_data_list: [{ side_data_type: "Display Matrix", rotation: 90 }] }), /landscape/],
    [metadata(1080, 1920, "N/A"), /duration/],
    [metadata(1080, 1920, "10", { sample_aspect_ratio: "bad" }), /aspect ratio/],
    [metadata(1080, 1920, "10", { side_data_list: [{ side_data_type: "Display Matrix" }] }), /orientation/],
  ]) {
    const lib = await load(data);
    await assert.rejects(() => lib.validateYouTubeShort({ fd: 12 }, "unused"), expected);
  }
  const missing = await load(null, true);
  await assert.rejects(() => missing.validateYouTubeShort({ fd: 12 }, "unused"), /ffprobe is not installed/);
});
