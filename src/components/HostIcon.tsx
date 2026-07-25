// G13: git-host branding. Renders the GitHub mark (lucide) or a Gitea/Forgejo
// mark, so the pane's icon + label follow whichever host the active workspace
// resolves to. `hostLabel` gives the matching display name.

import { Github } from "lucide-react";
import type { GitHostKind } from "@/lib/tauri";

/** Simplified Gitea/Forgejo mark (a mug with a leaf) in the current color. */
function GiteaIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* mug body */}
      <path d="M4 8h12v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8z" />
      {/* handle */}
      <path d="M16 9h2a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2h-2" />
      {/* branch: node → node, the Gitea git motif */}
      <circle cx="8.5" cy="11.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="14.5" r="1.1" fill="currentColor" stroke="none" />
      <path d="M8.5 12.6v.4a1.5 1.5 0 0 0 1.5 1.5h.9" />
      {/* steam */}
      <path d="M9 3c-.6.7-.6 1.3 0 2M13 3c-.6.7-.6 1.3 0 2" />
    </svg>
  );
}

export function HostIcon({
  kind,
  size = 14,
  className,
}: {
  kind: GitHostKind;
  size?: number;
  className?: string;
}) {
  return kind === "gitea" ? (
    <GiteaIcon size={size} className={className} />
  ) : (
    <Github size={size} className={className} />
  );
}
