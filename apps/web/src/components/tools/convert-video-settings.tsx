import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { ProgressCard } from "@/components/common/progress-card";
import { ResultDownloadLink } from "@/components/common/result-download-link";
import { useTranslation } from "@/contexts/i18n-context";
import { useToolProcessor } from "@/hooks/use-tool-processor";
import { format } from "@/lib/format";
import { useFileStore } from "@/stores/file-store";

export type VideoFormat = "mp4" | "mov" | "webm" | "avi" | "mkv";
export type Quality = "high" | "balanced" | "small";

const VIDEO_FORMATS: { value: VideoFormat; label: string }[] = [
  { value: "mp4", label: "MP4" },
  { value: "mov", label: "MOV" },
  { value: "webm", label: "WebM" },
  { value: "avi", label: "AVI" },
  { value: "mkv", label: "MKV" },
];

function detectVideoExt(file?: File): string {
  if (!file) return "";
  const typeMap: Record<string, string> = {
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "video/x-msvideo": "avi",
    "video/x-matroska": "mkv",
  };
  if (file.type && typeMap[file.type]) {
    return typeMap[file.type];
  }
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext || "";
}

export interface ConvertVideoControlsProps {
  settings?: Record<string, unknown>;
  onChange?: (settings: Record<string, unknown>) => void;
}

export function ConvertVideoControls({ settings: initial, onChange }: ConvertVideoControlsProps) {
  const { t } = useTranslation();
  const s = t.toolSettings["convert-video"];
  const [searchParams] = useSearchParams();

  // Read initial format from URL (?formats=mov or ?format=mov or ?to=mov)
  const initialFromUrl = useMemo(() => {
    const raw = searchParams.get("formats") ?? searchParams.get("format") ?? searchParams.get("to");
    if (!raw) return null;
    const requested = raw.split(",").map((f: string) => f.trim().toLowerCase());
    const valid = requested.filter((f: string) =>
      VIDEO_FORMATS.some((vf) => vf.value === f),
    ) as VideoFormat[];
    return valid.length > 0 ? valid : null;
  }, [searchParams]);

  const [selectedFormats, setSelectedFormats] = useState<VideoFormat[]>(initialFromUrl ?? ["mp4"]);
  const [zipArchive, setZipArchive] = useState(false);
  const [quality, setQuality] = useState<Quality>("balanced");

  const initializedRef = useRef(false);
  useEffect(() => {
    if (!initial || initializedRef.current) return;
    initializedRef.current = true;
    if (initial.formats && Array.isArray(initial.formats)) {
      const valid = (initial.formats as string[]).filter((f: string) =>
        VIDEO_FORMATS.some((vf) => vf.value === f),
      ) as VideoFormat[];
      if (valid.length > 0) setSelectedFormats(valid);
    } else if (initial.format != null) {
      const f = String(initial.format) as VideoFormat;
      if (VIDEO_FORMATS.some((vf) => vf.value === f)) {
        setSelectedFormats([f]);
      }
    }
    if (initial.zip != null) setZipArchive(Boolean(initial.zip));
    if (initial.quality != null) setQuality(initial.quality as Quality);
  }, [initial]);

  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    onChangeRef.current?.({
      formats: selectedFormats,
      format: selectedFormats[0] ?? "mp4",
      zip: selectedFormats.length > 1 ? zipArchive : false,
      quality,
    });
  }, [selectedFormats, zipArchive, quality]);

  const toggleFormat = (fmt: VideoFormat) => {
    setSelectedFormats((prev: VideoFormat[]) => {
      if (prev.includes(fmt)) {
        if (prev.length <= 1) return prev;
        return prev.filter((f: VideoFormat) => f !== fmt);
      }
      return [...prev, fmt];
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <div className="flex justify-between items-center mb-1.5">
          <label className="text-xs text-muted-foreground font-medium">{s.format}</label>
          {selectedFormats.length > 1 && (
            <span className="text-[11px] font-mono text-primary font-medium">
              {selectedFormats.length} selected{zipArchive ? " (ZIP)" : ""}
            </span>
          )}
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {VIDEO_FORMATS.map((f) => {
            const isChecked = selectedFormats.includes(f.value);
            return (
              <label
                key={f.value}
                className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs cursor-pointer select-none transition-colors ${
                  isChecked
                    ? "border-primary bg-primary/10 text-primary font-medium"
                    : "border-border hover:bg-muted text-foreground"
                }`}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggleFormat(f.value)}
                  className="rounded border-border text-primary focus:ring-primary h-3.5 w-3.5"
                />
                <span>{f.label}</span>
              </label>
            );
          })}
        </div>

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

      <div>
        <label htmlFor="cv-quality" className="text-xs text-muted-foreground">
          {s.quality}
        </label>
        <select
          id="cv-quality"
          value={quality}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => setQuality(e.target.value as Quality)}
          className="w-full mt-0.5 px-2 py-1.5 rounded border border-border bg-background text-sm text-foreground"
        >
          <option value="high">{s.high}</option>
          <option value="balanced">{s.balanced}</option>
          <option value="small">{s.small}</option>
        </select>
      </div>
    </div>
  );
}

export function ConvertVideoSettings() {
  const { t } = useTranslation();
  const s = t.toolSettings["convert-video"];
  const { files } = useFileStore();
  const { processFiles, processAllFiles, processing, error, progress, downloadUrl } =
    useToolProcessor("convert-video");

  const [settings, setSettings] = useState<Record<string, unknown>>({});

  const sourceFile = files[0];
  const detectedExt = useMemo(() => detectVideoExt(sourceFile), [sourceFile]);
  const sourceDisplay = detectedExt ? detectedExt.toUpperCase() : "VIDEO";

  const hasFile = files.length > 0;
  const targetFormats = (settings.formats as VideoFormat[]) ?? [
    (settings.format as VideoFormat) ?? "mp4",
  ];
  const isMultipleTargets = targetFormats.length > 1;

  const handleProcess = () => {
    if (files.length > 1) {
      processAllFiles(files, settings);
    } else {
      processFiles(files, settings);
    }
  };

  const submitLabel = useMemo(() => {
    const isZip = Boolean(settings.zip);
    if (files.length > 1) {
      return isMultipleTargets
        ? format(s.submitBatch, { count: files.length }) +
            ` (${targetFormats.length} formats${isZip ? " ZIP" : ""})`
        : format(s.submitBatch, { count: files.length });
    }
    if (isMultipleTargets) {
      return `Convert to ${targetFormats.length} formats${isZip ? " (ZIP)" : ""}`;
    }
    const target = targetFormats[0]?.toUpperCase() ?? "";
    return target ? `Convert to ${target}` : s.submit;
  }, [files.length, isMultipleTargets, targetFormats, settings.zip, s]);

  return (
    <div className="space-y-4">
      {/* Source format */}
      {hasFile && (
        <div>
          <p className="text-xs text-muted-foreground">Source format</p>
          <div className="mt-0.5 px-2 py-1.5 rounded bg-muted text-sm text-foreground uppercase font-mono font-medium">
            {sourceDisplay}
          </div>
        </div>
      )}

      <ConvertVideoControls settings={settings} onChange={setSettings} />

      {error && <p className="text-xs text-destructive-ink">{error}</p>}

      {processing ? (
        <ProgressCard
          active={processing}
          phase={progress.phase === "idle" ? "uploading" : progress.phase}
          label={s.progressLabel}
          stage={progress.stage}
          percent={progress.percent}
          elapsed={progress.elapsed}
        />
      ) : (
        <button
          type="button"
          data-testid="convert-video-submit"
          onClick={handleProcess}
          disabled={!hasFile || processing || targetFormats.length === 0}
          className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitLabel}
        </button>
      )}

      {downloadUrl && <ResultDownloadLink href={downloadUrl} testId="convert-video-download" />}
    </div>
  );
}
