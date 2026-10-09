import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { convert, detectFormat } from "@snapotter/image-engine";
import archiver from "archiver";
import type { FastifyInstance } from "fastify";
import sharp, { type SharpOptions } from "sharp";
import { z } from "zod";
import {
  encodeBmp,
  encodeEps,
  encodeIco,
  encodeJp2,
  encodeJxl,
  encodePpm,
  encodeQoi,
  encodeTga,
} from "../../lib/format-encoders.js";
import { encodeHeic } from "../../lib/heic-converter.js";
import { withImageEncodeContext } from "../../lib/image-error.js";
import { isSvgBuffer } from "../../lib/svg-sanitize.js";
import { createToolRoute } from "../tool-factory.js";

const execFileAsync = promisify(execFile);

let cachedMagickCmd: string | null = null;

async function findMagickCmd(): Promise<string> {
  if (cachedMagickCmd) return cachedMagickCmd;
  for (const cmd of ["magick", "convert"]) {
    try {
      await execFileAsync(cmd, ["--version"], { timeout: 5_000 });
      cachedMagickCmd = cmd;
      return cmd;
    } catch {
      // try next
    }
  }
  throw new Error("No ImageMagick found. Install imagemagick (provides convert/magick).");
}

function magickArgs(cmd: string, args: string[]): string[] {
  return cmd === "magick" ? ["convert", ...args] : args;
}

const FORMAT_CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  tiff: "image/tiff",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  jxl: "image/jxl",
  bmp: "image/bmp",
  ico: "image/x-icon",
  jp2: "image/jp2",
  qoi: "image/x-qoi",
  psd: "image/vnd.adobe.photoshop",
  ppm: "image/x-portable-pixmap",
  eps: "application/postscript",
  tga: "image/x-tga",
};

const CLI_ENCODERS: Record<string, (buf: Buffer, quality?: number) => Promise<Buffer>> = {
  bmp: encodeBmp,
  eps: encodeEps,
  ico: encodeIco,
  jp2: encodeJp2,
  jxl: encodeJxl,
  ppm: encodePpm,
  qoi: encodeQoi,
  tga: encodeTga,
};

const ANIMATABLE_FORMATS = new Set(["gif", "webp"]);

const rasterFormatEnum = z.enum([
  "jpg",
  "png",
  "webp",
  "avif",
  "tiff",
  "gif",
  "heic",
  "heif",
  "jxl",
  "bmp",
  "ico",
  "jp2",
  "qoi",
  "psd",
  "ppm",
  "eps",
  "tga",
]);

const settingsSchema = z
  .object({
    format: rasterFormatEnum.optional(),
    formats: z.array(rasterFormatEnum).min(1).optional(),
    zip: z.boolean().default(false).optional(),
    quality: z.number().int().min(1).max(100).optional(),
  })
  .refine((s) => Boolean(s.formats?.length || s.format), {
    message: "At least one format must be specified",
  });

async function zipBuffers(files: { name: string; buffer: Buffer }[]): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 5 } });
    const chunks: Buffer[] = [];
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", (err: Error) => reject(err));
    for (const f of files) {
      archive.append(f.buffer, { name: f.name });
    }
    void archive.finalize();
  });
}

async function convertSingleImage(
  inputBuffer: Buffer,
  format: z.infer<typeof rasterFormatEnum>,
  quality: number | undefined,
  filename: string,
  isAnimatedInput: boolean,
): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
  const cliEncoder = CLI_ENCODERS[format];
  const ext = extname(filename);
  const baseName = ext ? filename.slice(0, -ext.length) : filename;
  const contentType = FORMAT_CONTENT_TYPES[format] || "application/octet-stream";

  if (cliEncoder) {
    const outputBuffer = await cliEncoder(inputBuffer, quality);
    return {
      buffer: outputBuffer,
      filename: `${baseName}.${format}`,
      contentType,
    };
  }

  const sharpOpts: SharpOptions = isSvgBuffer(inputBuffer) ? { density: 300 } : {};
  // Preserve animation frames when both input and output are animatable formats
  if (isAnimatedInput && ANIMATABLE_FORMATS.has(format)) {
    sharpOpts.animated = true;
  }
  const image = sharp(inputBuffer, sharpOpts);

  let buffer: Buffer;
  if (format === "psd") {
    const pngBuffer = await image.png().toBuffer();
    const id = randomUUID();
    const inputPath = join(tmpdir(), `psd-enc-in-${id}.png`);
    const outputPath = join(tmpdir(), `psd-enc-out-${id}.psd`);
    try {
      await writeFile(inputPath, pngBuffer);
      const cmd = await findMagickCmd();
      await execFileAsync(cmd, magickArgs(cmd, [inputPath, `psd:${outputPath}`]), {
        timeout: 120_000,
      });
      buffer = await readFile(outputPath);
    } finally {
      await rm(inputPath, { force: true }).catch(() => {});
      await rm(outputPath, { force: true }).catch(() => {});
    }
  } else if (format === "heic" || format === "heif") {
    const pngBuffer = await image.png().toBuffer();
    buffer = await encodeHeic(pngBuffer, quality);
  } else {
    const result = await convert(image, { format: format as any, quality });
    buffer = await result.toBuffer();
  }

  return { buffer, filename: `${baseName}.${format}`, contentType };
}

export function registerConvert(app: FastifyInstance) {
  createToolRoute(app, {
    toolId: "convert",
    settingsSchema,
    process: withImageEncodeContext<z.infer<typeof settingsSchema>>(
      "Image conversion failed",
      (s) => (s.formats?.length ? s.formats.join(",") : (s.format ?? "png")),
      async (inputBuffer, settings, filename) => {
        const detected = await detectFormat(inputBuffer);
        const inputExt = (
          detected !== "unknown" ? detected : extname(filename).toLowerCase().replace(".", "")
        ).toLowerCase();

        let isAnimatedInput = false;
        if (ANIMATABLE_FORMATS.has(inputExt)) {
          try {
            const meta = await sharp(inputBuffer).metadata();
            if (meta.pages && meta.pages > 1) {
              isAnimatedInput = true;
            }
          } catch {
            // ignore
          }
        }

        const targetFormats =
          settings.formats && settings.formats.length > 0
            ? settings.formats
            : [settings.format ?? "png"];

        if (targetFormats.length === 1) {
          return convertSingleImage(
            inputBuffer,
            targetFormats[0],
            settings.quality,
            filename,
            isAnimatedInput,
          );
        }

        // Multiple formats requested
        const results = await Promise.all(
          targetFormats.map((fmt) =>
            convertSingleImage(inputBuffer, fmt, settings.quality, filename, isAnimatedInput),
          ),
        );

        if (settings.zip) {
          const ext = extname(filename);
          const baseName = ext ? filename.slice(0, -ext.length) : filename;
          const zipBuffer = await zipBuffers(
            results.map((r) => ({ name: r.filename, buffer: r.buffer })),
          );

          return {
            buffer: zipBuffer,
            filename: `${baseName}_converted.zip`,
            contentType: "application/zip",
          };
        }

        // Default: separate downloads (primary output + extraOutputs)
        return {
          buffer: results[0].buffer,
          filename: results[0].filename,
          contentType: results[0].contentType,
          extraOutputs: results.slice(1).map((r) => ({
            name: r.filename,
            buffer: r.buffer,
            contentType: r.contentType,
          })),
        };
      },
    ),
  });
}
