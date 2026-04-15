import { useState, useCallback, useRef, useEffect } from "react";
import { listWhisperModels, startRecordingCmd, stopRecordingCmd } from "@/lib/tauri";

type VoiceMode = "web" | "native";

interface UseVoiceInputReturn {
  isListening: boolean;
  transcript: string;
  startListening: () => void;
  stopListening: () => void;
  isSupported: boolean;
  mode: VoiceMode;
}

// Web Speech API types — not in all TS libs
interface SpeechRecognitionEvent {
  results: { [index: number]: { [index: number]: { transcript: string } }; length: number };
}

interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

// Cache native availability check across all hook instances
let nativeAvailableCache: boolean | null = null;
let nativeCheckPromise: Promise<boolean> | null = null;

async function checkNativeAvailable(): Promise<boolean> {
  if (nativeAvailableCache !== null) return nativeAvailableCache;
  if (nativeCheckPromise) return nativeCheckPromise;

  nativeCheckPromise = (async () => {
    try {
      const raw = await listWhisperModels();
      const models = JSON.parse(raw) as { size: string; downloaded: boolean }[];
      nativeAvailableCache = models.some((m) => m.downloaded);
      return nativeAvailableCache;
    } catch {
      nativeAvailableCache = false;
      return false;
    }
  })();

  return nativeCheckPromise;
}

const webSpeechSupported =
  typeof window !== "undefined" &&
  ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

/**
 * Voice input hook with automatic native Whisper detection.
 * If a Whisper model is downloaded, uses native mode; otherwise falls back to Web Speech API.
 * Pass an explicit mode to override auto-detection.
 */
export function useVoiceInput(explicitMode?: VoiceMode): UseVoiceInputReturn {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [detectedMode, setDetectedMode] = useState<VoiceMode>(webSpeechSupported ? "web" : "web");
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);

  // Auto-detect native Whisper on mount (only if no explicit mode given)
  useEffect(() => {
    if (explicitMode) return;
    checkNativeAvailable().then((available) => {
      if (available) setDetectedMode("native");
    });
  }, [explicitMode]);

  const mode = explicitMode ?? detectedMode;

  // Native mode is always considered supported; web mode depends on browser API
  const isSupported = mode === "native" ? true : webSpeechSupported;

  const startListening = useCallback(() => {
    if (mode === "native") {
      setIsListening(true);
      setTranscript("");
      startRecordingCmd().catch(() => {
        setIsListening(false);
      });
      return;
    }

    // Web Speech API path
    if (!webSpeechSupported) return;

    const w = window as unknown as Record<string, new () => SpeechRecognitionInstance>;
    const SpeechRecognitionCtor = w.SpeechRecognition || w.webkitSpeechRecognition;
    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalTranscript = "";
      for (let i = 0; i < event.results.length; i++) {
        finalTranscript += event.results[i][0].transcript;
      }
      setTranscript(finalTranscript);
    };

    recognition.onerror = () => {
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
    setTranscript("");
  }, [mode]);

  const stopListening = useCallback(() => {
    if (mode === "native") {
      setIsListening(false);
      stopRecordingCmd()
        .then((result) => {
          setTranscript(result);
        })
        .catch(() => {
          // error handled silently
        });
      return;
    }

    // Web Speech API path
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsListening(false);
  }, [mode]);

  return {
    isListening,
    transcript,
    startListening,
    stopListening,
    isSupported,
    mode,
  };
}
