import type { JSX } from "react";
import { Loader2 } from "lucide-react";

type Props = {
  size?: number;
  className?: string;
  label?: string;
};

export function Spinner({ size = 12, className = "", label }: Props): JSX.Element {
  return (
    <Loader2
      size={size}
      className={`animate-spin motion-reduce:animate-none text-current ${className}`}
      role="status"
      aria-label={label ?? "Loading"}
    />
  );
}
