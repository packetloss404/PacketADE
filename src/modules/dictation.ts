import { lazy } from "react";
import { Mic } from "lucide-react";
import type { ModuleManifest } from "@/types/modules";

const DictationView = lazy(() =>
  import("@/components/views/DictationView").then((m) => ({
    default: m.DictationView,
  })),
);

export const dictationModule: ModuleManifest = {
  id: "dictation",
  name: "Dictation",
  description: "Voice-to-text with local Whisper transcription",
  icon: Mic,
  iconColor: "text-accent-purple",
  component: DictationView,
  category: "integration",
  enabledByDefault: true,
};
