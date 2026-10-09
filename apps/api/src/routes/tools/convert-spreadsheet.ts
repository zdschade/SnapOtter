import type { Buffer } from "node:buffer";
import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { convertDocument } from "@snapotter/doc-engine";
import archiver from "archiver";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../../config.js";
import { createToolRoute } from "../tool-factory.js";

const CONTENT_TYPES: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  csv: "text/csv",
};

const sheetFormatEnum = z.enum(["xlsx", "ods", "csv"]);

const settingsSchema = z
  .object({
    format: sheetFormatEnum.optional(),
    formats: z.array(sheetFormatEnum).min(1).optional(),
    zip: z.boolean().default(false).optional(),
  })
  .refine((s) => Boolean(s.formats?.length || s.format), {
    message: "At least one format must be specified",
  });

export function registerConvertSpreadsheet(app: FastifyInstance) {
  createToolRoute(app, {
    toolId: "convert-spreadsheet",
    settingsSchema,
    process: async () => {
      throw new Error("convert-spreadsheet is v2-only");
    },
    processV2: async (ctx) => {
      const settings = settingsSchema.parse(ctx.settings);
      const input = ctx.inputs[0];
      const base = input.filename.replace(/\.[^.]+$/, "");
      const targetFormats =
        settings.formats && settings.formats.length > 0
          ? settings.formats
          : [settings.format ?? "ods"];

      if (targetFormats.length === 1) {
        const outFormat = targetFormats[0];
        const inputExt = extname(input.filename).toLowerCase();
        if (inputExt === `.${outFormat}`) {
          ctx.report(90, "Done");
          return {
            buffer: input.buffer,
            filename: `${base}.${outFormat}`,
            contentType: CONTENT_TYPES[outFormat],
          };
        }

        // Preserve the real extension so LibreOffice can sniff the input format.
        const sanitized = input.filename.replace(/[^A-Za-z0-9._-]/g, "_");
        const inPath = join(ctx.scratchDir, `in-${sanitized}`);
        await writeFile(inPath, input.buffer);

        ctx.report(10, "Converting");
        const outPath = await convertDocument(inPath, ctx.scratchDir, outFormat, {
          timeoutMs: (env.LIBREOFFICE_TIMEOUT_S || 120) * 1000,
        });
        ctx.report(90, "Done");

        return {
          scratchPath: outPath,
          filename: `${base}.${outFormat}`,
          contentType: CONTENT_TYPES[outFormat],
        };
      }

      // Multiple formats requested
      const sanitized = input.filename.replace(/[^A-Za-z0-9._-]/g, "_");
      const inPath = join(ctx.scratchDir, `in-${sanitized}`);
      await writeFile(inPath, input.buffer);

      const inputExt = extname(input.filename).toLowerCase();
      const outputFiles: { filename: string; path?: string; buffer?: Buffer }[] = [];

      for (let i = 0; i < targetFormats.length; i++) {
        const fmt = targetFormats[i];
        ctx.report(
          Math.round(10 + (i / targetFormats.length) * 80),
          `Converting to ${fmt.toUpperCase()}`,
        );
        if (inputExt === `.${fmt}`) {
          outputFiles.push({ filename: `${base}.${fmt}`, buffer: input.buffer });
        } else {
          const outPath = await convertDocument(inPath, ctx.scratchDir, fmt, {
            timeoutMs: (env.LIBREOFFICE_TIMEOUT_S || 120) * 1000,
          });
          outputFiles.push({ filename: `${base}.${fmt}`, path: outPath });
        }
      }

      if (settings.zip) {
        ctx.report(92, "Creating archive");
        const zipPath = join(ctx.scratchDir, `${base}_converted.zip`);
        await new Promise<void>((resolve, reject) => {
          const output = createWriteStream(zipPath);
          const archive = archiver("zip", { zlib: { level: 5 } });
          output.on("close", () => resolve());
          archive.on("error", (err: Error) => reject(err));
          archive.pipe(output);
          for (const file of outputFiles) {
            if (file.path) {
              archive.file(file.path, { name: file.filename });
            } else if (file.buffer) {
              archive.append(file.buffer, { name: file.filename });
            }
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
      const first = outputFiles[0];
      const rest = outputFiles.slice(1);
      const firstFormat = targetFormats[0];

      return {
        ...(first.path ? { scratchPath: first.path } : { buffer: first.buffer }),
        filename: first.filename,
        contentType: CONTENT_TYPES[firstFormat] || "application/octet-stream",
        extraOutputs: rest.map((file, i) => {
          const fmt = targetFormats[i + 1];
          return {
            name: file.filename,
            ...(file.path ? { scratchPath: file.path } : { buffer: file.buffer }),
            contentType: CONTENT_TYPES[fmt] || "application/octet-stream",
          };
        }),
      };
    },
  });
}
