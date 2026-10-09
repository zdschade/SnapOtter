import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { ProgressCard } from "@/components/common/progress-card";
import { ResultDownloadLink } from "@/components/common/result-download-link";
import { useTranslation } from "@/contexts/i18n-context";
import { useToolProcessor } from "@/hooks/use-tool-processor";
import { format } from "@/lib/format";
import { useFileStore } from "@/stores/file-store";

export type SheetFormat = "xlsx" | "ods" | "csv";

const SHEET_FORMATS: { value: SheetFormat; label: string }[] = [
  { value: "xlsx", label: "XLSX" },
  { value: "ods", label: "ODS" },
  { value: "csv", label: "CSV" },
];

function detectSheetExt(file?: File): string {
  if (!file) return "";
  const typeMap: Record<string, string> = {
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.oasis.opendocument.spreadsheet": "ods",
    "text/csv": "csv",
  };
  if (file.type && typeMap[file.type]) {
    return typeMap[file.type];
  }
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext || "";
}

export interface ConvertSpreadsheetControlsProps {
  settings?: Record<string, unknown>;
  onChange?: (settings: Record<string, unknown>) => void;
}

export function ConvertSpreadsheetControls({
  settings: initial,
  onChange,
}: ConvertSpreadsheetControlsProps) {
  const { t } = useTranslation();
  const s = t.toolSettings["convert-spreadsheet"];
  const [searchParams] = useSearchParams();

  // Read initial format from URL (?formats=csv or ?format=csv or ?to=csv)
  const initialFromUrl = useMemo(() => {
    const raw = searchParams.get("formats") ?? searchParams.get("format") ?? searchParams.get("to");
    if (!raw) return null;
    const requested = raw.split(",").map((f: string) => f.trim().toLowerCase());
    const valid = requested.filter((f: string) =>
      SHEET_FORMATS.some((sf) => sf.value === f),
    ) as SheetFormat[];
    return valid.length > 0 ? valid : null;
  }, [searchParams]);

  const [selectedFormats, setSelectedFormats] = useState<SheetFormat[]>(initialFromUrl ?? ["ods"]);
  const [zipArchive, setZipArchive] = useState(false);

  const initializedRef = useRef(false);
  useEffect(() => {
    if (!initial || initializedRef.current) return;
    initializedRef.current = true;
    if (initial.formats && Array.isArray(initial.formats)) {
      const valid = (initial.formats as string[]).filter((f: string) =>
        SHEET_FORMATS.some((sf) => sf.value === f),
      ) as SheetFormat[];
      if (valid.length > 0) setSelectedFormats(valid);
    } else if (initial.format != null) {
      const f = String(initial.format) as SheetFormat;
      if (SHEET_FORMATS.some((sf) => sf.value === f)) {
        setSelectedFormats([f]);
      }
    }
    if (initial.zip != null) setZipArchive(Boolean(initial.zip));
  }, [initial]);

  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    onChangeRef.current?.({
      formats: selectedFormats,
      format: selectedFormats[0] ?? "ods",
      zip: selectedFormats.length > 1 ? zipArchive : false,
    });
  }, [selectedFormats, zipArchive]);

  const toggleFormat = (fmt: SheetFormat) => {
    setSelectedFormats((prev: SheetFormat[]) => {
      if (prev.includes(fmt)) {
        if (prev.length <= 1) return prev;
        return prev.filter((f: SheetFormat) => f !== fmt);
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
          {SHEET_FORMATS.map((f) => {
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
      <p className="text-[10px] text-muted-foreground">{s.hint}</p>
    </div>
  );
}

export function ConvertSpreadsheetSettings() {
  const { t } = useTranslation();
  const s = t.toolSettings["convert-spreadsheet"];
  const { files } = useFileStore();
  const { processFiles, processAllFiles, processing, error, progress, downloadUrl } =
    useToolProcessor("convert-spreadsheet");

  const [settings, setSettings] = useState<Record<string, unknown>>({});

  const sourceFile = files[0];
  const detectedExt = useMemo(() => detectSheetExt(sourceFile), [sourceFile]);
  const sourceDisplay = detectedExt ? detectedExt.toUpperCase() : "SHEET";

  const hasFile = files.length > 0;
  const targetFormats = (settings.formats as SheetFormat[]) ?? [
    (settings.format as SheetFormat) ?? "ods",
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

      <ConvertSpreadsheetControls settings={settings} onChange={setSettings} />

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
          data-testid="convert-spreadsheet-submit"
          onClick={handleProcess}
          disabled={!hasFile || processing || targetFormats.length === 0}
          className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitLabel}
        </button>
      )}

      {downloadUrl && (
        <ResultDownloadLink href={downloadUrl} testId="convert-spreadsheet-download" />
      )}
    </div>
  );
}
