import { lazy } from "react";
import { Diamond } from "lucide-react";
import type { ModuleManifest } from "@/types/modules";

// Lazy-loaded so QualityView's markdown stack (react-markdown +
// react-syntax-highlighter, ~247KB vendor-markdown) stays out of the entry
// chunk. The module-view render site in App.tsx is already wrapped in Suspense.
const QualityView = lazy(() =>
  import("@/components/views/QualityView").then((m) => ({ default: m.QualityView })),
);

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
