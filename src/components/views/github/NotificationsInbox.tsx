import {
  AlertCircle,
  Bell,
  Check,
  ExternalLink,
  GitPullRequest,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useGitHubStore } from "@/stores/githubStore";
import { timeAgo } from "@/components/views/github/shared";
import type { GithubNotification } from "@/lib/tauri";

// Cross-repo notifications inbox. Notifications are global to the
// authenticated user (not repo-scoped), so this surface renders regardless
// of the selected repository. Fetched lazily by GitHubView when the Inbox
// sub-tab is first opened; a manual refresh button re-fetches on demand.

function subjectIcon(subjectType: string): React.ReactNode {
  switch (subjectType) {
    case "PullRequest":
      return <GitPullRequest size={11} className="text-accent-purple" />;
    case "Issue":
      return <AlertCircle size={11} className="text-accent-green" />;
    default:
      return <Bell size={11} className="text-accent-blue" />;
  }
}

// GitHub delivers `reason` as snake_case (e.g. `review_requested`). Present it
// as a readable lowercase phrase.
function humanizeReason(reason: string): string {
  return reason.replace(/_/g, " ");
}

export function NotificationsInbox() {
  const notifications = useGitHubStore((s) => s.notifications);
  const isLoading = useGitHubStore((s) => s.notificationsLoading);
  const error = useGitHubStore((s) => s.notificationsError);
  const fetchNotifications = useGitHubStore((s) => s.fetchNotifications);
  const markNotificationRead = useGitHubStore((s) => s.markNotificationRead);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-bg-border bg-bg-secondary flex-shrink-0">
        <Bell size={11} className="text-text-muted" />
        <span className="text-[11px] font-semibold text-text-primary">
          Inbox
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void fetchNotifications()}
          disabled={isLoading}
          title="Refresh notifications"
          className="inline-flex items-center gap-1 text-[10px] text-text-muted hover:text-text-secondary transition-colors px-1.5 py-1 disabled:opacity-50"
        >
          <RefreshCw size={10} className={isLoading ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 px-4 py-2 bg-accent-red/10 border-b border-accent-red/20 flex-shrink-0">
          <AlertCircle size={12} className="text-accent-red" />
          <span className="text-[11px] text-accent-red flex-1">{error}</span>
        </div>
      )}

      {isLoading && notifications.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 size={16} className="animate-spin text-text-muted" />
        </div>
      ) : notifications.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-[11px] text-text-muted">
          No unread notifications.
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {notifications.map((n) => (
            <NotificationRow
              key={n.id}
              notification={n}
              onMarkRead={() => void markNotificationRead(n.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface NotificationRowProps {
  notification: GithubNotification;
  onMarkRead: () => void;
}

function NotificationRow({ notification: n, onMarkRead }: NotificationRowProps) {
  return (
    <div
      className={`flex items-start gap-2.5 px-4 py-2.5 border-b border-bg-border transition-colors hover:bg-bg-secondary ${
        n.unread ? "bg-accent-blue/[0.04]" : ""
      }`}
    >
      <span className="mt-0.5 flex-shrink-0">{subjectIcon(n.subjectType)}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {n.unread && (
            <span className="w-1.5 h-1.5 rounded-full bg-accent-blue flex-shrink-0" />
          )}
          <a
            href={n.htmlUrl}
            target="_blank"
            rel="noreferrer"
            onClick={onMarkRead}
            className={`text-[11px] truncate hover:underline ${
              n.unread
                ? "text-text-primary font-medium"
                : "text-text-secondary"
            }`}
            title={n.title}
          >
            {n.title}
          </a>
          <ExternalLink size={9} className="text-text-muted flex-shrink-0" />
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] text-text-muted truncate">
            {n.repository}
          </span>
          <span className="text-[10px] text-text-muted">·</span>
          <span className="text-[10px] text-text-muted">
            {humanizeReason(n.reason)}
          </span>
          {n.updatedAt && (
            <>
              <span className="text-[10px] text-text-muted">·</span>
              <span className="text-[10px] text-text-muted flex-shrink-0">
                {timeAgo(n.updatedAt)} ago
              </span>
            </>
          )}
        </div>
      </div>
      {n.unread && (
        <button
          type="button"
          onClick={onMarkRead}
          title="Mark as read"
          className="flex-shrink-0 inline-flex items-center gap-1 text-[10px] text-text-muted hover:text-accent-green transition-colors px-1.5 py-0.5"
        >
          <Check size={11} />
        </button>
      )}
    </div>
  );
}
