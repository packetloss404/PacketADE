import { useState, useCallback, useRef, useEffect } from "react";
import { listAudioDevices, listWhisperModels } from "@/lib/tauri";
import { useDictationStore } from "@/stores/dictationStore";

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

async function checkNativeAvailable(): Promise<boolean> {
  try {
    const [modelRaw, deviceRaw] = await Promise.all([listWhisperModels(), listAudioDevices()]);
    const models = (typeof modelRaw === "string" ? JSON.parse(modelRaw) : modelRaw) as {
      downloaded: boolean;
    }[];
    const devices = (
      typeof deviceRaw === "string" ? JSON.parse(deviceRaw) : deviceRaw
    ) as unknown[];
    return models.some((model) => model.downloaded) && devices.length > 0;
  } catch {
    return false;
  }
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
  const modelReadinessKey = useDictationStore((state) =>
    state.models.map((model) => `${model.size}:${model.downloaded}`).join("|"),
  );
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [detectedMode, setDetectedMode] = useState<VoiceMode>(webSpeechSupported ? "web" : "web");
  const [nativeReady, setNativeReady] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);

  // Re-check native readiness after model installs as well as on mount.
  useEffect(() => {
    let cancelled = false;
    void checkNativeAvailable().then((available) => {
      if (cancelled) return;
      setNativeReady(available);
      if (!explicitMode) setDetectedMode(available ? "native" : "web");
    });
    return () => {
      cancelled = true;
    };
  }, [explicitMode, modelReadinessKey]);

  const mode = explicitMode ?? detectedMode;

  // Native mode requires both a verified model and an active capture device.
  const isSupported = mode === "native" ? nativeReady : webSpeechSupported;

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
        // Discard an abandoned composer recording instead of transcribing it.
        void useDictationStore.getState().cancelRecording();
      }
    };
  }, []);

  const startListening = useCallback(() => {
    if (mode === "native") {
      setIsListening(true);
      setTranscript("");
      void useDictationStore
        .getState()
        .startRecording()
        .then(() => setIsListening(useDictationStore.getState().isRecording));
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
      void useDictationStore
        .getState()
        .stopRecording()
        .then((result) => {
          setTranscript(result);
        })
        .catch((error) => console.warn("[useVoiceInput.stopListening] failed:", error));
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
