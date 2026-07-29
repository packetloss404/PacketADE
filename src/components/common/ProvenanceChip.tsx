import { useState } from "react";
import { ChevronDown, ShieldQuestion } from "lucide-react";
import {
  displayOrigin,
  shouldDisplayProvenance,
} from "@/lib/provenance";
import { useProvenanceAuditStore } from "@/stores/provenanceAuditStore";
import type { ProvenanceEnvelope } from "@/types/provenance";

export function ProvenanceChip({
  envelope,
  force = false,
}: {
  envelope?: ProvenanceEnvelope;
  force?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const showSourceChips = useProvenanceAuditStore(
    (state) => state.settings.showSourceChips,
  );
  if (
    !envelope ||
    !showSourceChips ||
    (!force && !shouldDisplayProvenance(envelope))
  ) {
    return null;
  }

  const broken = envelope.integrity.state === "unknown";
  return (
    <span className="relative shrink-0">
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        aria-expanded={open}
        aria-label={`Source: ${envelope.identity.label}`}
        className={`inline-flex items-center gap-1 rounded border px-1 py-0.5 text-meta ${
          broken
            ? "border-accent-amber/40 bg-accent-amber/10 text-accent-amber"
            : "border-accent-blue/30 bg-accent-blue/10 text-accent-blue"
        }`}
      >
        <ShieldQuestion size={9} />
        {displayOrigin(envelope.origin)}
        <ChevronDown size={8} className={open ? "rotate-180" : ""} />
      </button>
      {open && (
        <span
          role="status"
          className="absolute right-0 top-full z-40 mt-1 block w-72 rounded-md border border-bg-border bg-bg-elevated p-2 text-left shadow-xl"
          onClick={(event) => event.stopPropagation()}
        >
          <span className="block text-ui font-medium text-text-primary">
            {envelope.identity.label}
          </span>
          {envelope.identity.locator && (
            <span className="mt-0.5 block break-all font-mono text-meta text-text-secondary">
              {envelope.identity.locator}
            </span>
          )}
          <span className="mt-1 block text-meta text-text-muted">
            Authority: {envelope.authority.replaceAll("_", " ")} · Integrity:{" "}
            {envelope.integrity.state}
          </span>
          {envelope.integrity.transforms.length > 0 && (
            <span className="block text-meta text-text-muted">
              Transforms: {envelope.integrity.transforms.join(", ")}
            </span>
          )}
          {envelope.integrity.contentHash && (
            <span className="block truncate font-mono text-meta text-text-muted">
              {envelope.integrity.hashAlgorithm}:{envelope.integrity.contentHash}
            </span>
          )}
          {envelope.lineage.parentIds.length > 0 && (
            <span className="block text-meta text-text-muted">
              Parents: {envelope.lineage.parentIds.length}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
