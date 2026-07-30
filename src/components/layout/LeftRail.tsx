import { useAppStore } from "@/stores/appStore";
import { railFooterRoutes, railPrimaryRoutes, resolveViewRouteId } from "@/lib/routeRegistry";

/**
 * Left Rail. Placement, order, icon and label all come from the D4 route
 * registry (`@/lib/routeRegistry`) — this component no longer keeps its own
 * route list (audit P1-9).
 */
export function LeftRail() {
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const activeRouteId = resolveViewRouteId(activeView);

  return (
    <div className="flex w-11 flex-shrink-0 flex-col items-center gap-0.5 border-r border-bg-border bg-bg-secondary py-2">
      {railPrimaryRoutes().map((it) => {
        const isActive = activeRouteId === it.id;
        const Icon = it.icon;
        return (
          <button
            key={it.id}
            onClick={() => setActiveView(it.id)}
            title={it.label}
            className={`relative grid h-8 w-8 place-items-center rounded-md transition-colors ${
              isActive
                ? "bg-bg-elevated text-text-primary"
                : "text-text-muted hover:bg-bg-tertiary hover:text-text-primary"
            }`}
          >
            {isActive && (
              <span
                className="absolute -left-2 bottom-1.5 top-1.5 w-0.5 rounded-sm"
                style={{ background: "var(--color-accent-green)" }}
              />
            )}
            <Icon size={15} />
          </button>
        );
      })}

      <div className="flex-1" />

      {railFooterRoutes().map((it) => {
        const Icon = it.icon;
        return (
          <button
            key={it.id}
            onClick={() => setActiveView(it.id)}
            title={it.label}
            className={`grid h-8 w-8 place-items-center rounded-md transition-colors ${
              activeRouteId === it.id
                ? "bg-bg-elevated text-text-primary"
                : "text-text-muted hover:bg-bg-tertiary hover:text-text-primary"
            }`}
          >
            <Icon size={15} />
          </button>
        );
      })}
    </div>
  );
}
