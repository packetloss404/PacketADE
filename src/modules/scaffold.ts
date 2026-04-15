import { Hammer } from "lucide-react";
import { ScaffoldView } from "@/components/views/ScaffoldView";
import type { ModuleManifest } from "@/types/modules";

export const scaffoldModule: ModuleManifest = {
  id: "scaffold",
  name: "Scaffold",
  description: "Create new projects from templates (React, Next.js, Rust, Python, etc.)",
  icon: Hammer,
  iconColor: "text-accent-blue",
  component: ScaffoldView,
  category: "utility",
  order: 20,
  enabledByDefault: true,
};
