import { useEffect, useState } from "react";
import { Mic, MicOff, Download, Loader2, Check, HardDrive } from "lucide-react";
import { useDictationStore } from "@/stores/dictationStore";
import type { WhisperModel } from "@/types/dictation";

const MODEL_DESCRIPTIONS: Record<string, { label: string; detail: string }> = {
  tiny:   { label: "Tiny",   detail: "Fastest, lower accuracy" },
  base:   { label: "Base",   detail: "Good balance of speed and accuracy" },
  small:  { label: "Small",  detail: "Better accuracy, moderate speed" },
  medium: { label: "Medium", detail: "High accuracy, slower" },
  large:  { label: "Large",  detail: "Best accuracy, requires more RAM" },
};

function ModelCard({ model, onDownload, isDownloading }: { model: WhisperModel; onDownload: (size: string) => void; isDownloading: boolean }) {
  const desc = MODEL_DESCRIPTIONS[model.size] ?? { label: model.size, detail: "" };

  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-bg-secondary border border-bg-border rounded-lg">
      <HardDrive size={14} className="text-text-muted flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-text-primary">{desc.label}</span>
          <span className="text-[10px] text-text-muted">{model.fileSizeMb} MB</span>
        </div>
        <span className="text-[10px] text-text-muted">{desc.detail}</span>
      </div>
      {model.downloaded ? (
        <span className="flex items-center gap-1 text-[10px] text-accent-green">
          <Check size={10} />
          Ready
        </span>
      ) : (
        <button
          onClick={() => onDownload(model.size)}
          disabled={isDownloading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-medium text-accent-blue bg-accent-blue/15 border border-accent-blue/30 rounded hover:bg-accent-blue/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isDownloading ? (
            <>
              <Loader2 size={10} className="animate-spin" />
              Downloading...
            </>
          ) : (
            <>
              <Download size={10} />
              Download
            </>
          )}
        </button>
      )}
    </div>
  );
}

export function DictationView() {
  const models = useDictationStore((s) => s.models);
  const isRecording = useDictationStore((s) => s.isRecording);
  const isTranscribing = useDictationStore((s) => s.isTranscribing);
  const lastResult = useDictationStore((s) => s.lastResult);
  const status = useDictationStore((s) => s.status);
  const error = useDictationStore((s) => s.error);
  const waveform = useDictationStore((s) => s.waveform);
  const startRecording = useDictationStore((s) => s.startRecording);
  const stopRecording = useDictationStore((s) => s.stopRecording);
  const loadModels = useDictationStore((s) => s.loadModels);
  const downloadModel = useDictationStore((s) => s.downloadModel);
  const clearResult = useDictationStore((s) => s.clearResult);

  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  const hasDownloadedModel = models.some((m) => m.downloaded);

  async function handleDownload(size: string) {
    setDownloadingModel(size);
    try {
      await downloadModel(size);
    } finally {
      setDownloadingModel(null);
    }
  }

  async function handleToggleRecording() {
    if (isRecording) {
      await stopRecording();
    } else {
      clearResult();
      await startRecording();
    }
  }

  const bars: number[] = waveform.length > 0 ? waveform.slice(0, 32) : Array(32).fill(0);

  return (
    <div className="flex flex-1 flex-col items-center overflow-y-auto bg-bg-primary px-8 py-8">
      <div className="w-full max-w-[540px] space-y-6">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Mic size={16} className="text-accent-green" />
          <h1 className="text-sm font-semibold text-text-primary">Dictation</h1>
          <span className="text-[10px] text-text-muted">Native Whisper transcription</span>
        </div>

        {!hasDownloadedModel ? (
          <div className="space-y-4">
            <div className="px-4 py-5 bg-accent-blue/5 border border-accent-blue/20 rounded-lg text-center space-y-2">
              <Download size={24} className="text-accent-blue mx-auto" />
              <p className="text-xs font-medium text-text-primary">Download a model to get started</p>
              <p className="text-[10px] text-text-muted leading-relaxed max-w-[360px] mx-auto">
                Choose a Whisper model below. Smaller models are faster but less accurate.
                You can download multiple models and switch between them later.
              </p>
            </div>

            <div className="space-y-2">
              {models.map((model) => (
                <ModelCard
                  key={model.size}
                  model={model}
                  onDownload={handleDownload}
                  isDownloading={downloadingModel === model.size}
                />
              ))}
              {models.length === 0 && !error && (
                <div className="text-center py-6 text-[11px] text-text-muted">
                  <Loader2 size={14} className="animate-spin mx-auto mb-2" />
                  Loading available models...
                </div>
              )}
              {models.length === 0 && error && (
                <div className="text-center py-6 text-[11px] text-accent-red">
                  Failed to load models: {error}
                  <button
                    onClick={loadModels}
                    className="block mx-auto mt-2 text-[10px] text-accent-green hover:underline"
                  >
                    Retry
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Record button */}
            <div className="flex flex-col items-center gap-4">
              <button
                onClick={handleToggleRecording}
                disabled={isTranscribing}
                className={[
                  "w-20 h-20 rounded-full flex items-center justify-center transition-all",
                  isRecording
                    ? "bg-accent-red/20 border-2 border-accent-red text-accent-red animate-pulse shadow-lg shadow-accent-red/20"
                    : isTranscribing
                    ? "bg-accent-amber/20 border-2 border-accent-amber text-accent-amber cursor-wait"
                    : "bg-accent-green/15 border-2 border-accent-green/40 text-accent-green hover:bg-accent-green/25 hover:border-accent-green/60",
                ].join(" ")}
              >
                {isTranscribing ? (
                  <Loader2 size={28} className="animate-spin" />
                ) : isRecording ? (
                  <MicOff size={28} />
                ) : (
                  <Mic size={28} />
                )}
              </button>
              <span className="text-[11px] text-text-muted">
                {isRecording
                  ? "Recording... click to stop"
                  : isTranscribing
                  ? "Transcribing..."
                  : "Click to start recording"}
              </span>
            </div>

            {/* Waveform visualization */}
            {isRecording && (
              <div className="flex items-end justify-center gap-[2px] h-12">
                {bars.map((level, i) => (
                  <div
                    key={i}
                    className="w-1.5 bg-accent-green/60 rounded-full transition-all duration-75"
                    style={{ height: Math.max(4, level * 48) + "px" }}
                  />
                ))}
              </div>
            )}

            {/* Result */}
            {lastResult && status === "done" && (
              <div className="px-4 py-3 bg-bg-secondary border border-bg-border rounded-lg">
                <div className="flex items-center gap-1.5 mb-2">
                  <Check size={10} className="text-accent-green" />
                  <span className="text-[10px] font-medium text-accent-green">Transcription</span>
                </div>
                <p className="text-xs text-text-primary leading-relaxed whitespace-pre-wrap">
                  {lastResult}
                </p>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="px-4 py-3 bg-accent-red/5 border border-accent-red/20 rounded-lg">
                <p className="text-[11px] text-accent-red">{error}</p>
              </div>
            )}

            {/* Models section */}
            <div className="space-y-2">
              <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">Models</span>
              {models.map((model) => (
                <ModelCard
                  key={model.size}
                  model={model}
                  onDownload={handleDownload}
                  isDownloading={downloadingModel === model.size}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
