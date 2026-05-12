import type { ComponentType, LazyExoticComponent } from "react";
import type { LucideIcon } from "lucide-react";

export type ModuleCategory = "ai" | "integration" | "utility" | "analysis";

export interface ModuleManifest {
  id: string;
  name: string;
  description: string;
  icon: LucideIcon;
  iconColor: string;
  component: ComponentType | LazyExoticComponent<ComponentType>;
  category: ModuleCategory;
  order?: number;
  enabledByDefault: boolean;
  shortcutHint?: string;
}

export interface ModuleState {
  enabled: boolean;
}
