import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { ProgressCard } from "@/components/common/progress-card";
import { ResultDownloadLink } from "@/components/common/result-download-link";
import { useTranslation } from "@/contexts/i18n-context";
import { useToolProcessor } from "@/hooks/use-tool-processor";
import { format } from "@/lib/format";
import { useFileStore } from "@/stores/file-store";

const POPULAR_FORMATS = ["png", "jpg", "webp", "avif", "gif", "tiff"] as const;
const OTHER_FORMATS = [
  "heic",
  "heif",
  "jxl",
  "bmp",
  "ico",
  "jp2",
  "qoi",
  "ppm",
  "eps",
  "tga",
] as const;
const OUTPUT_FORMATS = [...POPULAR_FORMATS, ...OTHER_FORMATS] as const;
const LOSSY_FORMATS = ["jpg", "jpeg", "webp", "avif", "heic", "heif", "jxl", "jp2"];

const FORMAT_LABELS: Record<string, string> = {
  jpg: "JPG",
  png: "PNG",
  webp: "WebP",
  avif: "AVIF",
  tiff: "TIFF",
  gif: "GIF",
  heic: "HEIC",
  heif: "HEIF",
  jxl: "JXL",
  bmp: "BMP",
  ico: "ICO",
  jp2: "JP2",
  qoi: "QOI",
  ppm: "PPM",
  eps: "EPS",
  tga: "TGA",
};

function detectSourceExt(file?: File): string {
  if (!file) return "";
  const typeMap: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/avif": "avif",
    "image/gif": "gif",
    "image/tiff": "tiff",
    "image/bmp": "bmp",
    "image/x-icon": "ico",
    "image/vnd.adobe.photoshop": "psd",
    "image/heic": "heic",
    "image/heif": "heif",
  };
  if (file.type && typeMap[file.type]) {
    return typeMap[file.type];
  }
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext || "";
}

export interface ConvertControlsProps {
  settings?: Record<string, unknown>;
  onChange?: (settings: Record<string, unknown>) => void;
}

export function ConvertControls({ settings: initialSettings, onChange }: ConvertControlsProps) {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();

  // Read initial format from URL (?formats=png or ?format=png or ?to=png)
  const initialFromUrl = useMemo(() => {
    const raw = searchParams.get("formats") ?? searchParams.get("format") ?? searchParams.get("to");
    if (!raw) return null;
    const requested = raw.split(",").map((f) => f.trim().toLowerCase());
    const valid = requested.filter((f) => (OUTPUT_FORMATS as readonly string[]).includes(f));
    return valid.length > 0 ? valid : null;
  }, [searchParams]);

  const [selectedFormats, setSelectedFormats] = useState<string[]>(initialFromUrl ?? ["png"]);
  const [zipArchive, setZipArchive] = useState(false);
  const [quality, setQuality] = useState(85);
  const [showMoreFormats, setShowMoreFormats] = useState(false);

  const initializedRef = useRef(false);
  useEffect(() => {
    if (!initialSettings || initializedRef.current) return;
    initializedRef.current = true;
    if (initialSettings.formats && Array.isArray(initialSettings.formats)) {
      setSelectedFormats(initialSettings.formats as string[]);
    } else if (initialSettings.format != null) {
      setSelectedFormats([String(initialSettings.format)]);
    }
    if (initialSettings.zip != null) setZipArchive(Boolean(initialSettings.zip));
    if (initialSettings.quality != null) setQuality(Number(initialSettings.quality));
  }, [initialSettings]);

  const hasLossy = selectedFormats.some((f) => LOSSY_FORMATS.includes(f));

  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    const settings: Record<string, unknown> = {
      formats: selectedFormats,
      format: selectedFormats[0] ?? "png",
      zip: selectedFormats.length > 1 ? zipArchive : false,
    };
    if (hasLossy) {
      settings.quality = quality;
    }
    onChangeRef.current?.(settings);
  }, [selectedFormats, zipArchive, quality, hasLossy]);

  const toggleFormat = (fmt: string) => {
    setSelectedFormats((prev: string[]) => {
      if (prev.includes(fmt)) {
        if (prev.length <= 1) return prev; // Keep at least one selected
        return prev.filter((f: string) => f !== fmt);
      }
      return [...prev, fmt];
    });
  };

  return (
    <div className="space-y-4">
      {/* Target formats (multi-select checkboxes) */}
      <div>
        <div className="flex justify-between items-center mb-1.5">
          <label className="text-xs text-muted-foreground font-medium">
            {t.toolSettings.convert.targetFormat}
          </label>
          {selectedFormats.length > 1 && (
            <span className="text-[11px] font-mono text-primary font-medium">
              {selectedFormats.length} selected{zipArchive ? " (ZIP)" : ""}
            </span>
          )}
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          {POPULAR_FORMATS.map((f) => {
            const isChecked = selectedFormats.includes(f);
            return (
              <label
                key={f}
                className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs cursor-pointer select-none transition-colors ${
                  isChecked
                    ? "border-primary bg-primary/10 text-primary font-medium"
                    : "border-border hover:bg-muted text-foreground"
                }`}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggleFormat(f)}
                  className="rounded border-border text-primary focus:ring-primary h-3.5 w-3.5"
                />
                <span>{FORMAT_LABELS[f] ?? f.toUpperCase()}</span>
              </label>
            );
          })}
        </div>

        {showMoreFormats && (
          <div className="grid grid-cols-3 gap-1.5 mt-1.5 pt-1.5 border-t border-border/50">
            {OTHER_FORMATS.map((f) => {
              const isChecked = selectedFormats.includes(f);
              return (
                <label
                  key={f}
                  className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs cursor-pointer select-none transition-colors ${
                    isChecked
                      ? "border-primary bg-primary/10 text-primary font-medium"
                      : "border-border hover:bg-muted text-foreground"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggleFormat(f)}
                    className="rounded border-border text-primary focus:ring-primary h-3.5 w-3.5"
                  />
                  <span>{FORMAT_LABELS[f] ?? f.toUpperCase()}</span>
                </label>
              );
            })}
          </div>
        )}

        <button
          type="button"
          onClick={() => setShowMoreFormats((prev) => !prev)}
          className="mt-2 text-xs text-muted-foreground hover:text-foreground font-medium flex items-center gap-1"
        >
          {showMoreFormats ? "Show fewer formats" : "+ More formats"}
        </button>

        {selectedFormats.length > 1 && (
          <label className="flex items-center gap-2 cursor-pointer select-none text-xs text-foreground mt-2 pt-1 border-t border-border/40">
            <input
              type="checkbox"
              checked={zipArchive}
              onChange={(e) => setZipArchive(e.target.checked)}
              className="rounded border-border text-primary focus:ring-primary h-3.5 w-3.5"
            />
            <span>Download as ZIP archive</span>
          </label>
        )}
      </div>

      {/* Quality slider (lossy only) */}
      {hasLossy && (
        <div>
          <div className="flex justify-between items-center">
            <label htmlFor="convert-quality" className="text-xs text-muted-foreground">
              {t.toolSettings.convert.quality}
            </label>
            <span className="text-xs font-mono text-foreground">{quality}</span>
          </div>
          <input
            id="convert-quality"
            type="range"
            min={1}
            max={100}
            value={quality}
            onChange={(e) => setQuality(Number(e.target.value))}
            className="w-full mt-1"
          />
        </div>
      )}
    </div>
  );
}

export function ConvertSettings() {
  const { t } = useTranslation();
  const { files, currentEntry } = useFileStore();
  const {
    processFiles,
    processAllFiles,
    processing,
    error,
    downloadUrl,
    originalSize,
    processedSize,
    progress,
  } = useToolProcessor("convert");
  const [settings, setSettings] = useState<Record<string, unknown>>({});

  // Detect source format from uploaded file
  const sourceFile = files[0];
  const detectedExt = useMemo(() => detectSourceExt(sourceFile), [sourceFile]);
  const sourceDisplay = detectedExt
    ? detectedExt.toUpperCase()
    : t.toolSettings.convert.unknownFormat;

  const hasFile = files.length > 0;
  const targetFormats = (settings.formats as string[]) ?? [String(settings.format ?? "png")];
  const isMultipleTargets = targetFormats.length > 1;

  const handleProcess = () => {
    if (files.length > 1) {
      processAllFiles(files, settings);
    } else {
      processFiles(files, settings);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (hasFile && !processing && targetFormats.length > 0) handleProcess();
  };

  const submitLabel = useMemo(() => {
    const isZip = Boolean(settings.zip);
    if (files.length > 1) {
      return isMultipleTargets
        ? format(t.toolSettings.convert.submitBatch, { count: files.length }) +
            ` (${targetFormats.length} formats${isZip ? " ZIP" : ""})`
        : format(t.toolSettings.convert.submitBatch, { count: files.length });
    }
    if (isMultipleTargets) {
      return `Convert to ${targetFormats.length} formats${isZip ? " (ZIP)" : ""}`;
    }
    const target = targetFormats[0]?.toUpperCase() ?? "";
    return target ? `Convert to ${target}` : t.toolSettings.convert.submit;
  }, [files.length, isMultipleTargets, targetFormats, settings.zip, t.toolSettings.convert]);

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Source format */}
      {hasFile && (
        <div>
          <p className="text-xs text-muted-foreground">{t.toolSettings.convert.sourceFormat}</p>
          <div className="mt-0.5 px-2 py-1.5 rounded bg-muted text-sm text-foreground uppercase font-mono font-medium">
            {sourceDisplay}
          </div>
        </div>
      )}

      <ConvertControls onChange={setSettings} />

      {/* Error */}
      {error && <p className="text-xs text-destructive-ink">{error}</p>}

      {/* Size info */}
      {originalSize != null && processedSize != null && (
        <div className="text-xs text-muted-foreground space-y-0.5">
          <p>
            {format(t.toolSettings.convert.originalSizeKb, {
              size: (originalSize / 1024).toFixed(1),
            })}
          </p>
          <p>
            {format(t.toolSettings.convert.processedSizeKb, {
              size: (processedSize / 1024).toFixed(1),
            })}
          </p>
        </div>
      )}

      {/* Process */}
      {processing ? (
        <ProgressCard
          active={processing}
          phase={progress.phase === "idle" ? "uploading" : progress.phase}
          label={t.toolSettings.convert.progressLabel}
          stage={progress.stage}
          percent={progress.percent}
          elapsed={progress.elapsed}
        />
      ) : (
        <button
          type="submit"
          data-testid="convert-submit"
          disabled={!hasFile || processing || targetFormats.length === 0}
          className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {submitLabel}
        </button>
      )}

      {/* Download */}
      {downloadUrl && (!currentEntry?.downloads || currentEntry.downloads.length <= 1) && (
        <ResultDownloadLink href={downloadUrl} testId="convert-download" />
      )}
    </form>
  );
}
