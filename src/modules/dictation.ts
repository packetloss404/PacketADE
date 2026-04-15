import { Mic } from "lucide-react";
import { DictationView } from "@/components/views/DictationView";
import type { ModuleManifest } from "@/types/modules";

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
