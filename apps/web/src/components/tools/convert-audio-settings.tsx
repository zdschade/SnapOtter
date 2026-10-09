import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { ProgressCard } from "@/components/common/progress-card";
import { ResultDownloadLink } from "@/components/common/result-download-link";
import { useTranslation } from "@/contexts/i18n-context";
import { useToolProcessor } from "@/hooks/use-tool-processor";
import { format } from "@/lib/format";
import { useFileStore } from "@/stores/file-store";

export type AudioFormat = "mp3" | "wav" | "ogg" | "flac" | "m4a";

const AUDIO_FORMATS: { value: AudioFormat; label: string }[] = [
  { value: "mp3", label: "MP3" },
  { value: "wav", label: "WAV" },
  { value: "ogg", label: "OGG" },
  { value: "flac", label: "FLAC" },
  { value: "m4a", label: "M4A" },
];

const BITRATE_OPTIONS = [96, 128, 192, 256, 320] as const;

const SAMPLE_RATE_OPTIONS = [8000, 16000, 22050, 32000, 44100, 48000, 96000] as const;

// libmp3lame caps at 48 kHz, so MP3 output must not offer 96 kHz.
function sampleRatesFor(formats: AudioFormat[]): number[] {
  const hasMp3 = formats.includes("mp3");
  return hasMp3 ? SAMPLE_RATE_OPTIONS.filter((r) => r <= 48000) : [...SAMPLE_RATE_OPTIONS];
}

// libmp3lame also caps the bitrate at low rates (64 kbps at 8 kHz, 160 kbps at
// 16/22.05 kHz) and would clamp silently; offer only combinations it honors.
function bitratesFor(formats: AudioFormat[], sampleRate: number): number[] {
  const hasMp3 = formats.includes("mp3");
  if (!hasMp3 || !sampleRate || sampleRate >= 32000) return [...BITRATE_OPTIONS];
  if (sampleRate === 8000) return [32, 48, 64];
  return BITRATE_OPTIONS.filter((b) => b <= 160);
}

function reconcileBitrate(bitrateKbps: number, options: number[]): number {
  if (options.includes(bitrateKbps)) return bitrateKbps;
  return options.includes(192) ? 192 : options[options.length - 1];
}

function detectAudioExt(file?: File): string {
  if (!file) return "";
  const typeMap: Record<string, string> = {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
    "audio/x-flac": "flac",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
  };
  if (file.type && typeMap[file.type]) {
    return typeMap[file.type];
  }
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext || "";
}

export interface ConvertAudioControlsProps {
  settings?: Record<string, unknown>;
  onChange?: (settings: Record<string, unknown>) => void;
}

export function ConvertAudioControls({ settings: initial, onChange }: ConvertAudioControlsProps) {
  const { t } = useTranslation();
  const s = t.toolSettings["convert-audio"];
  const [searchParams] = useSearchParams();

  // Read initial format from URL (?formats=wav or ?format=wav or ?to=wav)
  const initialFromUrl = useMemo(() => {
    const raw = searchParams.get("formats") ?? searchParams.get("format") ?? searchParams.get("to");
    if (!raw) return null;
    const requested = raw.split(",").map((f: string) => f.trim().toLowerCase());
    const valid = requested.filter((f: string) =>
      AUDIO_FORMATS.some((af) => af.value === f),
    ) as AudioFormat[];
    return valid.length > 0 ? valid : null;
  }, [searchParams]);

  const [selectedFormats, setSelectedFormats] = useState<AudioFormat[]>(initialFromUrl ?? ["mp3"]);
  const [zipArchive, setZipArchive] = useState(false);
  const [bitrateKbps, setBitrateKbps] = useState(192);
  // 0 = preserve the source sample rate (omit the setting).
  const [sampleRate, setSampleRate] = useState(0);

  const initializedRef = useRef(false);
  useEffect(() => {
    if (!initial || initializedRef.current) return;
    initializedRef.current = true;
    if (initial.formats && Array.isArray(initial.formats)) {
      const valid = (initial.formats as string[]).filter((f: string) =>
        AUDIO_FORMATS.some((af) => af.value === f),
      ) as AudioFormat[];
      if (valid.length > 0) setSelectedFormats(valid);
    } else if (initial.format != null) {
      const f = String(initial.format) as AudioFormat;
      if (AUDIO_FORMATS.some((af) => af.value === f)) {
        setSelectedFormats([f]);
      }
    }
    if (initial.zip != null) setZipArchive(Boolean(initial.zip));
    const rawRate = initial.sampleRate != null ? Number(initial.sampleRate) : 0;
    const rate = sampleRatesFor(selectedFormats).includes(rawRate) ? rawRate : 0;
    if (rate) setSampleRate(rate);
    if (initial.bitrateKbps != null) {
      setBitrateKbps(
        reconcileBitrate(Number(initial.bitrateKbps), bitratesFor(selectedFormats, rate)),
      );
    }
  }, [initial, selectedFormats]);

  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    onChangeRef.current?.({
      formats: selectedFormats,
      format: selectedFormats[0] ?? "mp3",
      zip: selectedFormats.length > 1 ? zipArchive : false,
      bitrateKbps,
      ...(sampleRate ? { sampleRate } : {}),
    });
  }, [selectedFormats, zipArchive, bitrateKbps, sampleRate]);

  const toggleFormat = (fmt: AudioFormat) => {
    setSelectedFormats((prev: AudioFormat[]) => {
      if (prev.includes(fmt)) {
        if (prev.length <= 1) return prev;
        return prev.filter((f: AudioFormat) => f !== fmt);
      }
      return [...prev, fmt];
    });
    const updated = selectedFormats.includes(fmt)
      ? selectedFormats.filter((f: AudioFormat) => f !== fmt)
      : [...selectedFormats, fmt];
    const rate = sampleRatesFor(updated).includes(sampleRate) ? sampleRate : 0;
    if (rate !== sampleRate) setSampleRate(rate);
    setBitrateKbps((b: number) => reconcileBitrate(b, bitratesFor(updated, rate)));
  };

  const handleSampleRateChange = (rate: number) => {
    setSampleRate(rate);
    setBitrateKbps((b: number) => reconcileBitrate(b, bitratesFor(selectedFormats, rate)));
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
          {AUDIO_FORMATS.map((f) => {
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
        <label htmlFor="ca-bitrate" className="text-xs text-muted-foreground">
          {s.bitrate}
        </label>
        <select
          id="ca-bitrate"
          value={bitrateKbps}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => setBitrateKbps(Number(e.target.value))}
          className="w-full mt-0.5 px-2 py-1.5 rounded border border-border bg-background text-sm text-foreground"
        >
          {bitratesFor(selectedFormats, sampleRate).map((br) => (
            <option key={br} value={br}>
              {br} kbps
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="ca-samplerate" className="text-xs text-muted-foreground">
          {s.sampleRate}
        </label>
        <select
          id="ca-samplerate"
          value={sampleRate}
          onChange={(e: ChangeEvent<HTMLSelectElement>) =>
            handleSampleRateChange(Number(e.target.value))
          }
          className="w-full mt-0.5 px-2 py-1.5 rounded border border-border bg-background text-sm text-foreground"
        >
          <option value={0}>{s.sampleRatePreserve}</option>
          {sampleRatesFor(selectedFormats).map((r) => (
            <option key={r} value={r}>
              {r} Hz
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function ConvertAudioSettings() {
  const { t } = useTranslation();
  const s = t.toolSettings["convert-audio"];
  const { files } = useFileStore();
  const { processFiles, processAllFiles, processing, error, progress, downloadUrl } =
    useToolProcessor("convert-audio");

  const [settings, setSettings] = useState<Record<string, unknown>>({});

  const sourceFile = files[0];
  const detectedExt = useMemo(() => detectAudioExt(sourceFile), [sourceFile]);
  const sourceDisplay = detectedExt ? detectedExt.toUpperCase() : "AUDIO";

  const hasFile = files.length > 0;
  const targetFormats = (settings.formats as AudioFormat[]) ?? [
    (settings.format as AudioFormat) ?? "mp3",
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

      <ConvertAudioControls settings={settings} onChange={setSettings} />

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
          data-testid="convert-audio-submit"
          onClick={handleProcess}
          disabled={!hasFile || processing || targetFormats.length === 0}
          className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitLabel}
        </button>
      )}

      {downloadUrl && <ResultDownloadLink href={downloadUrl} testId="convert-audio-download" />}
    </div>
  );
}
