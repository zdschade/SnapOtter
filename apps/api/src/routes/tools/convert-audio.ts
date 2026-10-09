import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { probeMedia, resolveEncoder, runFfmpeg } from "@snapotter/media-engine";
import archiver from "archiver";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { runMediaTool } from "../../lib/media-tool.js";
import { createToolRoute } from "../tool-factory.js";

// libmp3lame clamps the bitrate silently above these: MPEG-2.5 (8 kHz) tops out
// at 64 kbps, MPEG-2 (16/22.05 kHz) at 160 kbps. Reject instead of degrading.
const MP3_BITRATE_CAPS: Record<number, number> = { 8000: 64, 16000: 160, 22050: 160 };

const audioFormatEnum = z.enum(["mp3", "wav", "ogg", "flac", "m4a"]);

const settingsSchema = z
  .object({
    format: audioFormatEnum.optional(),
    formats: z.array(audioFormatEnum).min(1).optional(),
    zip: z.boolean().default(false).optional(),
    bitrateKbps: z.number().int().min(32).max(320).default(192),
    // Omitted = preserve the source sample rate (no -ar flag).
    sampleRate: z
      .union(
        [
          z.literal(8000),
          z.literal(16000),
          z.literal(22050),
          z.literal(32000),
          z.literal(44100),
          z.literal(48000),
          z.literal(96000),
        ],
        {
          errorMap: () => ({
            message: "must be one of 8000, 16000, 22050, 32000, 44100, 48000, 96000",
          }),
        },
      )
      .optional(),
  })
  .refine((s) => Boolean(s.formats?.length || s.format), {
    message: "At least one format must be specified",
  })
  .superRefine((val, ctx) => {
    const targetFormats =
      val.formats && val.formats.length > 0 ? val.formats : [val.format ?? "mp3"];
    if (!targetFormats.includes("mp3") || !val.sampleRate) return;
    if (val.sampleRate === 96000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sampleRate"],
        message: "MP3 output supports sample rates up to 48000 Hz",
      });
      return;
    }
    const cap = MP3_BITRATE_CAPS[val.sampleRate];
    if (cap && val.bitrateKbps > cap) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bitrateKbps"],
        message: `MP3 at ${val.sampleRate} Hz supports at most ${cap} kbps`,
      });
    }
  });

const CONTENT_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
};

function audioArgsForFormat(
  format: string,
  inPath: string,
  outPath: string,
  bitrateKbps: number,
  sampleRate?: number,
): string[] {
  const rate = sampleRate ? ["-ar", String(sampleRate)] : [];
  switch (format) {
    case "wav":
      return ["-i", inPath, "-vn", "-c:a", "pcm_s16le", ...rate, outPath];
    case "ogg": {
      // libvorbis ABR (-b:a) fails with "encoder setup failed" when the bitrate is
      // too high for the source sample rate (e.g. 8 kHz). Use quality VBR (-q:a),
      // which adapts to the rate. Map bitrate -> quality (~bitrate/32: 192k -> q6).
      const quality = (bitrateKbps / 32).toFixed(1);
      return [
        "-i",
        inPath,
        "-vn",
        "-c:a",
        resolveEncoder("vorbis"),
        "-q:a",
        quality,
        ...rate,
        outPath,
      ];
    }
    case "flac":
      return ["-i", inPath, "-vn", "-c:a", "flac", ...rate, outPath];
    case "m4a":
      return ["-i", inPath, "-vn", "-c:a", "aac", "-b:a", `${bitrateKbps}k`, ...rate, outPath];
    default:
      return [
        "-i",
        inPath,
        "-vn",
        "-c:a",
        resolveEncoder("mp3"),
        "-b:a",
        `${bitrateKbps}k`,
        ...rate,
        outPath,
      ];
  }
}

export function registerConvertAudio(app: FastifyInstance) {
  createToolRoute(app, {
    toolId: "convert-audio",
    settingsSchema,
    process: async () => {
      throw new Error("convert-audio is v2-only");
    },
    processV2: async (ctx) => {
      const settings = settingsSchema.parse(ctx.settings);
      const base = ctx.inputs[0].filename.replace(/\.[^.]+$/, "");
      const targetFormats =
        settings.formats && settings.formats.length > 0
          ? settings.formats
          : [settings.format ?? "mp3"];

      if (targetFormats.length === 1) {
        const outFormat = targetFormats[0];
        const outName = `${base}.${outFormat}`;
        const { outPath } = await runMediaTool(ctx, outName, (inPath, out) =>
          audioArgsForFormat(outFormat, inPath, out, settings.bitrateKbps, settings.sampleRate),
        );
        return {
          scratchPath: outPath,
          filename: outName,
          contentType: CONTENT_TYPES[outFormat],
        };
      }

      // Multiple target formats -> process sequentially and zip
      const dir = join(ctx.scratchDir, "media");
      await mkdir(dir, { recursive: true });
      const inPath = join(dir, `in-${ctx.inputs[0].filename.replace(/[^A-Za-z0-9._-]/g, "_")}`);
      await writeFile(inPath, ctx.inputs[0].buffer);

      const outputPaths: string[] = [];
      for (let i = 0; i < targetFormats.length; i++) {
        const fmt = targetFormats[i];
        const outName = `${base}.${fmt}`;
        const outPath = join(dir, outName);
        const args = audioArgsForFormat(
          fmt,
          inPath,
          outPath,
          settings.bitrateKbps,
          settings.sampleRate,
        );
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
