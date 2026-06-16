import { lazy } from "react";
import { Lightbulb } from "lucide-react";
import type { ModuleManifest } from "@/types/modules";

// Lazy-loaded so the Ideation view stays out of the entry chunk; the
// module-view render site in App.tsx is already wrapped in Suspense.
const IdeationView = lazy(() =>
  import("@/components/views/IdeationView").then((m) => ({ default: m.IdeationView })),
);

export const ideationModule: ModuleManifest = {
  id: "ideation",
  name: "Ideation Scanner",
  description: "Scan your codebase for improvement ideas and feature suggestions",
  icon: Lightbulb,
  iconColor: "text-accent-amber",
  component: IdeationView,
  category: "analysis",
  order: 10,
  enabledByDefault: true,
};
