import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { resolveEncoder, runFfmpeg, videoCodecArgs } from "@snapotter/media-engine";
import archiver from "archiver";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { runMediaTool } from "../../lib/media-tool.js";
import { createToolRoute } from "../tool-factory.js";

const videoFormatEnum = z.enum(["mp4", "mov", "webm", "avi", "mkv"]);

const settingsSchema = z
  .object({
    format: videoFormatEnum.optional(),
    formats: z.array(videoFormatEnum).min(1).optional(),
    zip: z.boolean().default(false).optional(),
    quality: z.enum(["high", "balanced", "small"]).default("balanced"),
  })
  .refine((s) => Boolean(s.formats?.length || s.format), {
    message: "At least one format must be specified",
  });

const CRF: Record<string, { h264: number; vp9: number }> = {
  high: { h264: 18, vp9: 24 },
  balanced: { h264: 23, vp9: 32 },
  small: { h264: 28, vp9: 40 },
};

const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
};

function videoArgsForFormat(
  format: string,
  quality: "high" | "balanced" | "small",
  inPath: string,
  outPath: string,
): string[] {
  if (format === "webm") {
    return [
      "-i",
      inPath,
      "-c:v",
      resolveEncoder("vp9"),
      "-crf",
      String(CRF[quality].vp9),
      "-b:v",
      "0",
      "-c:a",
      resolveEncoder("opus"),
      outPath,
    ];
  }
  if (format === "avi") {
    return [
      "-i",
      inPath,
      ...videoCodecArgs("h264", CRF[quality].h264),
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      resolveEncoder("mp3"),
      "-b:a",
      "192k",
      outPath,
    ];
  }
  if (format === "mkv") {
    return [
      "-i",
      inPath,
      ...videoCodecArgs("h264", CRF[quality].h264),
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      resolveEncoder("aac"),
      "-b:a",
      "128k",
      outPath,
    ];
  }
  // mp4 and mov
  return [
    "-i",
    inPath,
    ...videoCodecArgs("h264", CRF[quality].h264),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    resolveEncoder("aac"),
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outPath,
  ];
}

export function registerConvertVideo(app: FastifyInstance) {
  createToolRoute(app, {
    toolId: "convert-video",
    settingsSchema,
    process: async () => {
      throw new Error("convert-video is v2-only");
    },
    processV2: async (ctx) => {
      const settings = settingsSchema.parse(ctx.settings);
      const base = ctx.inputs[0].filename.replace(/\.[^.]+$/, "");
      const targetFormats =
        settings.formats && settings.formats.length > 0
          ? settings.formats
          : [settings.format ?? "mp4"];

      if (targetFormats.length === 1) {
        const outFormat = targetFormats[0];
        const outName = `${base}.${outFormat}`;
        const { outPath } = await runMediaTool(ctx, outName, (inPath, out) =>
          videoArgsForFormat(outFormat, settings.quality, inPath, out),
        );
        return {
          scratchPath: outPath,
          filename: outName,
          contentType: CONTENT_TYPES[outFormat],
        };
      }

      // Multiple formats -> process sequentially and zip
      const dir = join(ctx.scratchDir, "media");
      await mkdir(dir, { recursive: true });
      const inPath = join(dir, `in-${ctx.inputs[0].filename.replace(/[^A-Za-z0-9._-]/g, "_")}`);
      await writeFile(inPath, ctx.inputs[0].buffer);

      const outputPaths: string[] = [];
      for (let i = 0; i < targetFormats.length; i++) {
        const fmt = targetFormats[i];
        const outName = `${base}.${fmt}`;
        const outPath = join(dir, outName);
        const args = videoArgsForFormat(fmt, settings.quality, inPath, outPath);
        ctx.report(
          Math.round(5 + (i / targetFormats.length) * 85),
          `Converting to ${fmt.toUpperCase()}`,
        );
        await runFfmpeg(args, { signal: ctx.signal, timeoutMs: 30 * 60_000 });
        outputPaths.push(outPath);
      }

      if (settings.zip) {
        ctx.report(92, "Creating archive");
        const zipPath = join(dir, `${base}_converted.zip`);
        await new Promise<void>((resolve, reject) => {
          const output = createWriteStream(zipPath);
          const archive = archiver("zip", { zlib: { level: 5 } });
          output.on("close", () => resolve());
          archive.on("error", (err: Error) => reject(err));
          archive.pipe(output);
          for (const outPath of outputPaths) {
            archive.file(outPath, { name: basename(outPath) });
          }
          void archive.finalize();
        });

        return {
          scratchPath: zipPath,
          filename: `${base}_converted.zip`,
          contentType: "application/zip",
        };
      }

      // Default: separate downloads (primary output + extraOutputs)
      return {
        scratchPath: outputPaths[0],
        filename: basename(outputPaths[0]),
        contentType: CONTENT_TYPES[targetFormats[0]] || "application/octet-stream",
        extraOutputs: outputPaths.slice(1).map((p, i) => ({
          name: basename(p),
          scratchPath: p,
          contentType: CONTENT_TYPES[targetFormats[i + 1]] || "application/octet-stream",
        })),
      };
    },
  });
}
