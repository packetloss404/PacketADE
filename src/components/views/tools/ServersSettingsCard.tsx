import { useState } from "react";
import { Server, Plus, Pencil, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { useServerStore } from "@/stores/serverStore";
import { ServerFormModal } from "@/components/servers/ServerFormModal";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";
import { summarizeServerUsage, serverUsageWarnings } from "@/lib/serverUsage";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useFlightStore } from "@/stores/flightStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { ServerConfig } from "@/types/server";
import { deleteSshPassword, setSshPassword } from "@/lib/tauri";
import type { ServerFormSubmission } from "@/components/servers/ServerFormModal";

/**
 * The ONLY reachable remote-host manager. `ServersView.tsx` used to hold a
 * `window.confirm` here, but nothing ever routed to it (every "open servers"
 * handler navigates to Settings), so in practice a 10px hover trash icon
 * destroyed a live SSH host record with no confirmation at all. The confirm
 * now lives here, on the shared styled idiom, and names both the host and the
 * work currently riding on it.
 */
export function ServersSettingsCard() {
  const servers = useServerStore((s) => s.servers);
  const addServerPersisted = useServerStore((s) => s.addServerPersisted);
  const updateServerPersisted = useServerStore((s) => s.updateServerPersisted);
  const deleteServerRecordPersisted = useServerStore((s) => s.deleteServerRecordPersisted);
  const restoreServerRecordPersisted = useServerStore((s) => s.restoreServerRecordPersisted);

  const [showForm, setShowForm] = useState(false);
  const [editingServer, setEditingServer] = useState<ServerConfig | null>(null);
  // Usage is snapshotted when the confirm opens, so the warning text the user
  // agreed to is the text that was on screen.
  const [pendingDelete, setPendingDelete] = useState<{
    server: ServerConfig;
    warnings: string[];
  } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

  // Legacy records saved before host-key pinning existed. `ServerFormModal`
  // will not let a new one through unpinned, so this only ever counts records
  // that predate the gate — see the banner below for why it matters.
  const unpinnedCount = servers.filter((server) => !server.hostFingerprint).length;

  async function applyPasswordAction(submission: ServerFormSubmission) {
    if (submission.passwordAction.kind === "set") {
      await setSshPassword(submission.serverId, submission.passwordAction.password);
    } else if (submission.passwordAction.kind === "delete") {
      await deleteSshPassword(submission.serverId);
    }
  }

  async function handleAdd(submission: ServerFormSubmission) {
    await applyPasswordAction(submission);
    try {
      await addServerPersisted(submission.config, submission.serverId);
    } catch (saveError) {
      if (submission.passwordAction.kind === "set") {
        try {
          await deleteSshPassword(submission.serverId);
        } catch (cleanupError) {
          throw new Error(
            `Server record was not saved (${errorMessage(saveError)}), and the new OS credential could not be cleaned up (${errorMessage(cleanupError)}). Retry Save to reconcile it.`,
            { cause: cleanupError },
          );
        }
      }
      throw saveError;
    }
  }

  async function handleEdit(submission: ServerFormSubmission) {
    if (editingServer) {
      const previous = editingServer;
      await updateServerPersisted(editingServer.id, submission.config);
      try {
        await applyPasswordAction(submission);
      } catch (credentialError) {
        try {
          await updateServerPersisted(previous.id, previous);
        } catch (rollbackError) {
          throw new Error(
            `Credential update failed (${errorMessage(credentialError)}), and the server record rollback also failed (${errorMessage(rollbackError)}). The form remains open; reload Settings before retrying.`,
            { cause: rollbackError },
          );
        }
        throw new Error(
          `Credential update failed and the previous server configuration was restored: ${errorMessage(credentialError)}`,
          { cause: credentialError },
        );
      }
    }
  }

  function requestDelete(server: ServerConfig) {
    const usage = summarizeServerUsage(server.id, {
      connectionStates: useServerStore.getState().connectionStates,
      conversations: useAgentTaskStore.getState().conversations,
      flights: useFlightStore.getState().flights,
      workspaces: useWorkspaceStore.getState().workspaces,
    });
    setPendingDelete({ server, warnings: serverUsageWarnings(usage) });
    setDeleteError(null);
  }

  async function confirmDelete() {
    if (!pendingDelete || deleteBusy) return;
    const server = pendingDelete.server;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const removed = await deleteServerRecordPersisted(server.id);
      try {
        await deleteSshPassword(server.id);
      } catch (credentialError) {
        try {
          await restoreServerRecordPersisted(removed);
        } catch (rollbackError) {
          throw new Error(
            `The host record was removed, but credential cleanup failed (${errorMessage(credentialError)}) and the record could not be restored (${errorMessage(rollbackError)}). The credential may still require manual cleanup in the OS credential manager.`,
            { cause: rollbackError },
          );
        }
        throw new Error(
          `Credential cleanup failed, so the host record was restored. Retry deletion: ${errorMessage(credentialError)}`,
          { cause: credentialError },
        );
      }
      setPendingDelete(null);
    } catch (error) {
      setDeleteError(errorMessage(error));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-bg-border bg-bg-secondary p-4">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-text-primary">
          <Server size={12} className="text-accent-blue" />
          Remote Servers
        </h3>
        <button
          onClick={() => {
            setEditingServer(null);
            setShowForm(true);
          }}
          className="hover:bg-accent-green/10 flex items-center gap-1 rounded px-2 py-1 text-[11px] text-accent-green transition-colors"
        >
          <Plus size={11} />
          Add Server
        </button>
      </div>

      {/* Host-key pinning banner.
          FAULT this closes: `ServerFormModal` gates every NEW host on pinning,
          but entries saved before pinning existed carry no `hostFingerprint`,
          and `buildSshArgs` (src/lib/ssh.ts) quietly drops those to
          `StrictHostKeyChecking=accept-new` — TOFU. The composer already
          discloses this at connect time and tells the user to "verify it on
          the Servers page to pin the key"... and this page, the page it names,
          showed nothing at all to distinguish a pinned host from an unpinned
          one. The Host key column below is the other half of that sentence. */}
      {unpinnedCount > 0 && (
        <div className="mb-3 flex items-start gap-1.5 rounded border border-accent-amber/30 bg-accent-amber/5 px-2.5 py-1.5">
          <ShieldAlert size={11} className="mt-px shrink-0 text-accent-amber" />
          <p className="text-[10px] leading-snug text-text-secondary">
            <span className="font-medium text-accent-amber">
              {unpinnedCount} host{unpinnedCount === 1 ? "" : "s"} without a pinned key.
            </span>{" "}
            Connections to {unpinnedCount === 1 ? "it" : "them"} trust whatever key the
            machine presents on first contact, so a first connect cannot detect an
            impostor. Open the host and use &quot;Verify host key&quot; to pin its
            fingerprint; existing setups keep working either way.
          </p>
        </div>
      )}

      {servers.length === 0 ? (
        <p className="py-6 text-center text-[10px] text-text-muted">
          No servers configured. Add one to connect workspaces to remote machines.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-bg-border">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="bg-bg-primary text-left text-text-muted">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Host</th>
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Auth</th>
                <th className="px-3 py-2 font-medium">Host key</th>
                <th className="w-16 px-3 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {servers.map((server) => (
                <tr
                  key={server.id}
                  className="border-t border-bg-border transition-colors hover:bg-bg-hover"
                >
                  <td className="px-3 py-2 font-medium text-text-primary">{server.name}</td>
                  <td className="px-3 py-2 text-text-secondary">
                    {server.host}
                    {server.port !== 22 ? `:${server.port}` : ""}
                  </td>
                  <td className="px-3 py-2 text-text-secondary">{server.username}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[9px] ${
                        server.authMethod === "agent"
                          ? "bg-accent-green/15 text-accent-green"
                          : server.authMethod === "key"
                            ? "bg-accent-blue/15 text-accent-blue"
                            : "bg-accent-amber/15 text-accent-amber"
                      }`}
                    >
                      {server.authMethod === "agent"
                        ? "SSH Agent"
                        : server.authMethod === "key"
                          ? "Key File"
                          : "Password"}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {server.hostFingerprint ? (
                      <span
                        title={server.hostFingerprint}
                        className="bg-accent-green/15 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] text-accent-green"
                      >
                        <ShieldCheck size={9} />
                        Pinned
                      </span>
                    ) : (
                      // Clickable: the fix for an unpinned host lives behind
                      // the edit form's "Verify host key" block, so the badge
                      // that reports the problem is also the way to reach it.
                      <button
                        onClick={() => {
                          setEditingServer(server);
                          setShowForm(true);
                        }}
                        aria-label={`Pin host key for ${server.name}`}
                        title="This host is trusted on first sight (TOFU). Click to fetch and pin its key."
                        className="bg-accent-amber/15 hover:bg-accent-amber/25 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] text-accent-amber transition-colors"
                      >
                        <ShieldAlert size={9} />
                        Not pinned
                      </button>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => {
                          setEditingServer(server);
                          setShowForm(true);
                        }}
                        className="p-1 text-text-muted transition-colors hover:text-accent-blue"
                        title="Edit"
                      >
                        <Pencil size={10} />
                      </button>
                      <button
                        onClick={() => requestDelete(server)}
                        className="p-1 text-text-muted transition-colors hover:text-accent-red"
                        title={`Delete ${server.name}`}
                        aria-label={`Delete ${server.name}`}
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add/Edit modal */}
      {showForm && (
        <ServerFormModal
          onClose={() => {
            setShowForm(false);
            setEditingServer(null);
          }}
          onSubmit={editingServer ? handleEdit : handleAdd}
          initial={editingServer ?? undefined}
        />
      )}

      {pendingDelete && (
        <ConfirmDeleteModal
          title="Delete remote host?"
          entityName={`${pendingDelete.server.name} (${pendingDelete.server.username}@${pendingDelete.server.host}:${pendingDelete.server.port})`}
          description="is removed from this app, and its stored SSH password is removed from the OS credential store. Nothing on the remote machine is deleted."
          warnings={deleteError ? [deleteError, ...pendingDelete.warnings] : pendingDelete.warnings}
          warningTitle={deleteError ? "Deletion did not complete" : undefined}
          confirmLabel={deleteBusy ? "Deleting…" : "Delete host"}
          onConfirm={() => void confirmDelete()}
          onClose={() => {
            if (!deleteBusy) setPendingDelete(null);
          }}
        />
      )}
    </div>
  );
}
