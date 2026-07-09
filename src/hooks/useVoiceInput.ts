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
      const models = (typeof raw === "string" ? JSON.parse(raw) : raw) as { size: string; downloaded: boolean }[];
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

  // Mirror the latest mode/listening into refs so the unmount cleanup can stop
  // the right backend without re-subscribing on every state change.
  const modeRef = useRef(mode);
  const isListeningRef = useRef(isListening);
  modeRef.current = mode;
  isListeningRef.current = isListening;

  // F38: stop any in-flight recording/recognition when the hook unmounts so a
  // dangling Web Speech listener or native Whisper capture can't outlive the
  // component — leaking the microphone and firing setState after unmount.
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        // Detach handlers first so onend/onerror can't setState post-unmount.
        recognitionRef.current.onresult = null;
        recognitionRef.current.onerror = null;
        recognitionRef.current.onend = null;
        try {
          recognitionRef.current.stop();
        } catch {
          // already stopped / not started — nothing to release
        }
        recognitionRef.current = null;
      }
      if (modeRef.current === "native" && isListeningRef.current) {
        // Fire-and-forget: release the native capture; ignore failures on teardown.
        void stopRecordingCmd().catch(() => {});
      }
    };
  }, []);

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
