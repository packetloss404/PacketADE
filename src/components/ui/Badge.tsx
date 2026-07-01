import type { ReactNode } from "react";

type BadgeTone = "neutral" | "green" | "amber" | "red" | "blue" | "purple";

interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}

const tones: Record<BadgeTone, string> = {
  neutral: "bg-bg-tertiary text-text-muted",
  green: "bg-accent-green/15 text-accent-green",
  amber: "bg-accent-amber/15 text-accent-amber",
  red: "bg-accent-red/15 text-accent-red",
  blue: "bg-accent-blue/15 text-accent-blue",
  purple: "bg-accent-purple/15 text-accent-purple",
};

export function Badge({ tone = "neutral", children, className = "" }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
