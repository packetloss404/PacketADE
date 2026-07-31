/**
 * The ONE delete confirm for a local Issue — shared by the Kanban card's trash
 * affordance and the detail panel's "Delete issue" footer button, so the two
 * surfaces cannot drift on what deletion costs.
 *
 * Until now an Issue could be created but never removed: `issueStore.deleteIssue`
 * existed with zero UI callers, so local issues accumulated forever while every
 * other entity in the app was deletable.
 *
 * An Issue is not a leaf record. It can be half of a bidirectional Flight link
 * (`Flight.issueIds` ⇄ `Issue.flightId`), it can have been handed off to a live
 * workspace session, and it carries comments, acceptance criteria, and
 * dependency edges pointing at other issues. All of that is disclosed here,
 * before the destructive click, rather than discovered afterwards.
 *
 * Cancel / Esc / X back out with zero mutation: the store is only touched from
 * the confirm button.
 */
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";
import { useIssueStore, type Issue } from "@/stores/issueStore";
import { useFlightStore } from "@/stores/flightStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

interface ConfirmDeleteIssueModalProps {
  issueId: string;
  /** Called after the delete lands — hosts use it to close a detail panel. */
  onDeleted?: () => void;
  /** Called after confirm or cancel — the host clears its pending state. */
  onClose: () => void;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Consequence lines for the confirm callout. Pure, for readability. */
function issueDeleteWarnings(
  issue: Issue,
  flightTitle: string | null,
  workspaceName: string | null,
): string[] {
  const warnings: string[] = [];

  if (flightTitle) {
    warnings.push(`Unlinks it from the flight “${flightTitle}”.`);
  }
  if (workspaceName) {
    warnings.push(
      `It was sent to the workspace “${workspaceName}” — that session keeps running; only the issue record goes.`,
    );
  }

  const commentCount = issue.comments?.length ?? 0;
  if (commentCount > 0) {
    warnings.push(
      `${commentCount} ${plural(commentCount, "comment", "comments")} on this issue ${plural(commentCount, "is", "are")} deleted with it.`,
    );
  }

  const criteriaCount = issue.acceptanceCriteria.length;
  if (criteriaCount > 0) {
    warnings.push(
      `${criteriaCount} acceptance ${plural(criteriaCount, "criterion", "criteria")} ${plural(criteriaCount, "is", "are")} deleted with it.`,
    );
  }

  const depCount = issue.blockedBy.length + issue.blocks.length;
  if (depCount > 0) {
    warnings.push(
      `${depCount} dependency ${plural(depCount, "link", "links")} on other issues ${plural(depCount, "is", "are")} cleared.`,
    );
  }

  return warnings;
}

export function ConfirmDeleteIssueModal({
  issueId,
  onDeleted,
  onClose,
}: ConfirmDeleteIssueModalProps) {
  const issue = useIssueStore((s) => s.issues.find((i) => i.id === issueId));
  const deleteIssue = useIssueStore((s) => s.deleteIssue);
  // Read the flight from either half of the link so a drifted record still
  // gets its consequence disclosed.
  const flight = useFlightStore((s) =>
    s.flights.find((f) => f.id === issue?.flightId || f.issueIds.includes(issueId)),
  );
  const workspace = useWorkspaceStore((s) =>
    issue?.workspaceId ? s.workspaces.find((w) => w.id === issue.workspaceId) : undefined,
  );

  if (!issue) return null;

  const warnings = issueDeleteWarnings(
    issue,
    flight ? flight.title || "Untitled flight" : null,
    issue.workspaceId ? (workspace?.name ?? null) : null,
  );

  const handleConfirm = () => {
    deleteIssue(issueId);
    onDeleted?.();
    onClose();
  };

  return (
    <ConfirmDeleteModal
      title="Delete issue?"
      entityName={`${issue.ticketId}: ${issue.title || "(untitled)"}`}
      description="will be permanently removed from the board."
      warnings={warnings}
      warningTitle="Deleting it also"
      onConfirm={handleConfirm}
      onClose={onClose}
    />
  );
}
