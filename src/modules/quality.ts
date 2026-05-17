import { Diamond } from "lucide-react";
import { QualityView } from "@/components/views/QualityView";
import type { ModuleManifest } from "@/types/modules";

export const qualityModule: ModuleManifest = {
  id: "quality",
  name: "Code Quality",
  description: "Lint, type-check, complexity and test metrics for the current project",
  icon: Diamond,
  iconColor: "text-accent-amber",
  component: QualityView,
  category: "analysis",
  order: 5,
  enabledByDefault: true,
};
