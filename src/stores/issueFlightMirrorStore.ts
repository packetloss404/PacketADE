import { create } from "zustand";
import { persist } from "zustand/middleware";
import { storageKey } from "@/lib/brand";
import {
  advanceMirrorRecord,
  diffMirrorState,
  embedBodyMarker,
  parseBodyMarker,
  type MirrorFields,
  type MirrorRecord,
} from "@/lib/issueFlightMirror";
import {
  gitHostSetActive,
  githubCloseIssue,
  githubCreateIssue,
  githubCreateRepoMilestone,
  githubGetIssue,
  githubListIssuesPage,
  githubListRepoMilestones,
  githubReopenIssue,
  githubSetIssueLabels,
  githubSetIssueMilestone,
  githubUpdateIssue,
} from "@/lib/tauri";
import { useFlightStore } from "@/stores/flightStore";
import type { Flight, Task } from "@/types/flight";
import type { GitHubIssue, GitHubMilestone } from "@/types/github";

interface FlightMirrorConfig {
  flightId: string;
  enabled: boolean;
  hostConnectionId: string;
  owner: string;
  repo: string;
  records: Record<string, MirrorRecord>;
  lastSyncAt?: number;
  error?: string;
}

interface IssueFlightMirrorStore {
  mirrors: Record<string, FlightMirrorConfig>;
  syncingFlightIds: string[];
  enable: (
    flightId: string,
    target: { hostConnectionId: string; owner: string; repo: string },
  ) => void;
  disable: (flightId: string) => void;
  acknowledgeConflicts: (flightId: string) => void;
  syncFlight: (flightId: string) => Promise<void>;
  syncAll: () => Promise<void>;
}

interface MirrorEntity {
  key: string;
  task?: Task;
  title: string;
  description: string;
  state: "open" | "closed";
  milestone: string;
}

function entitiesForFlight(flight: Flight): MirrorEntity[] {
  const tasks = flight.milestones.flatMap((milestone) =>
    milestone.tasks.map((task) => ({
      key: task.id,
      task,
      title: task.title,
      description: task.description,
      state:
        task.status === "done" || task.status === "cancelled"
          ? ("closed" as const)
          : ("open" as const),
      milestone: flight.title,
    })),
  );
  return tasks.length
    ? tasks
    : [
        {
          key: "__flight__",
          title: flight.title,
          description: flight.objective,
          state: flight.status === "done" || flight.status === "cancelled" ? "closed" : "open",
          milestone: flight.title,
        },
      ];
}

function labelsFromIssue(issue: GitHubIssue): string[] {
  return (issue.labels ?? [])
    .map((label) => (typeof label === "string" ? label : label.name))
    .filter(Boolean);
}

function fieldsFromIssue(issue: GitHubIssue): MirrorFields {
  return {
    title: issue.title,
    state: issue.state === "closed" ? "closed" : "open",
    labels: labelsFromIssue(issue),
    milestone: issue.milestone?.title ?? null,
  };
}

function issueUpdatedAt(issue: GitHubIssue): string {
  return issue.updated_at ?? issue.created_at ?? new Date(0).toISOString();
}

function localFields(entity: MirrorEntity, record?: MirrorRecord): MirrorFields {
  return {
    title: entity.title,
    state: entity.state,
    // Tasks do not currently own labels, so preserve the last agreed host set.
    labels: record?.lastSyncedFields.labels ?? [],
    milestone: entity.milestone,
  };
}

function parseIssue(raw: string): GitHubIssue {
  return JSON.parse(raw) as GitHubIssue;
}

async function listHostIssues(owner: string, repo: string): Promise<GitHubIssue[]> {
  const all: GitHubIssue[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const parsed = JSON.parse(await githubListIssuesPage(owner, repo, "all", page)) as
      | GitHubIssue[]
      | { issues?: GitHubIssue[] };
    const issues = Array.isArray(parsed) ? parsed : (parsed.issues ?? []);
    all.push(...issues);
    if (issues.length < 30) break;
  }
  return all;
}

async function ensureMilestone(
  owner: string,
  repo: string,
  flight: Flight,
): Promise<GitHubMilestone> {
  const milestones = JSON.parse(await githubListRepoMilestones(owner, repo)) as GitHubMilestone[];
  const existing = milestones.find((milestone) => milestone.title === flight.title);
  if (existing) return existing;
  return JSON.parse(
    await githubCreateRepoMilestone(
      owner,
      repo,
      flight.title,
      `Mirrored work for Flight ${flight.id}`,
    ),
  ) as GitHubMilestone;
}

function applyHostPull(flightId: string, entity: MirrorEntity, fields: Partial<MirrorFields>) {
  const flight = useFlightStore.getState().flights.find((candidate) => candidate.id === flightId);
  if (!flight) return;
  if (!entity.task) {
    useFlightStore.getState().updateFlight(flightId, {
      ...(fields.title ? { title: fields.title } : {}),
      ...(fields.milestone ? { title: fields.milestone } : {}),
      ...(fields.state
        ? {
            status:
              fields.state === "closed"
                ? "done"
                : flight.status === "done"
                  ? "active"
                  : flight.status,
          }
        : {}),
    });
    return;
  }
  if (fields.milestone) {
    useFlightStore.getState().updateFlight(flightId, { title: fields.milestone });
  }
  const milestones = flight.milestones.map((milestone) => ({
    ...milestone,
    tasks: milestone.tasks.map((task) =>
      task.id === entity.task?.id
        ? {
            ...task,
            ...(fields.title ? { title: fields.title } : {}),
            ...(fields.state
              ? {
                  status:
                    fields.state === "closed"
                      ? ("done" as const)
                      : task.status === "done"
                        ? ("pending" as const)
                        : task.status,
                }
              : {}),
          }
        : task,
    ),
  }));
  useFlightStore.getState().updateFlight(flightId, { milestones });
}

async function syncEntity(
  config: FlightMirrorConfig,
  flight: Flight,
  entity: MirrorEntity,
  milestone: GitHubMilestone,
  hostIssues: GitHubIssue[],
): Promise<MirrorRecord> {
  let record = config.records[entity.key];
  let issue = record
    ? parseIssue(await githubGetIssue(config.owner, config.repo, record.issueNumber))
    : hostIssues.find((candidate) => {
        const marker = parseBodyMarker(candidate.body ?? "");
        return (
          marker?.flightId === flight.id &&
          (entity.task ? marker.taskId === entity.task.id : !marker.taskId)
        );
      });

  const fields = localFields(entity, record);
  const localRev = flight.updatedAt;
  if (!issue) {
    issue = parseIssue(
      await githubCreateIssue(
        config.owner,
        config.repo,
        entity.title,
        embedBodyMarker(entity.description, flight.id, entity.task?.id),
      ),
    );
    await githubSetIssueMilestone(config.owner, config.repo, issue.number, milestone.number);
    if (entity.state === "closed") {
      issue = parseIssue(await githubCloseIssue(config.owner, config.repo, issue.number));
    } else {
      issue = parseIssue(await githubGetIssue(config.owner, config.repo, issue.number));
    }
    return {
      hostConnectionId: config.hostConnectionId,
      owner: config.owner,
      repo: config.repo,
      issueNumber: issue.number,
      flightId: flight.id,
      ...(entity.task ? { taskId: entity.task.id } : {}),
      lastSyncedLocalRev: localRev,
      lastSyncedHostUpdatedAt: issueUpdatedAt(issue),
      lastSyncedFields: fieldsFromIssue(issue),
      conflicts: [],
    };
  }

  if (!record) {
    record = {
      hostConnectionId: config.hostConnectionId,
      owner: config.owner,
      repo: config.repo,
      issueNumber: issue.number,
      flightId: flight.id,
      ...(entity.task ? { taskId: entity.task.id } : {}),
      lastSyncedLocalRev: localRev,
      lastSyncedHostUpdatedAt: issueUpdatedAt(issue),
      lastSyncedFields: fieldsFromIssue(issue),
      conflicts: [],
    };
  }

  const plan = diffMirrorState(
    { localRev, updatedAt: flight.updatedAt, fields },
    { updatedAt: issueUpdatedAt(issue), fields: fieldsFromIssue(issue) },
    record.lastSyncedFields,
  );
  if (plan.toPull.title || plan.toPull.state) {
    applyHostPull(flight.id, entity, plan.toPull);
  }
  if (plan.toPush.title) {
    issue = parseIssue(
      await githubUpdateIssue(
        config.owner,
        config.repo,
        issue.number,
        plan.toPush.title,
        embedBodyMarker(issue.body ?? entity.description, flight.id, entity.task?.id),
      ),
    );
  }
  if (plan.toPush.labels) {
    issue = parseIssue(
      await githubSetIssueLabels(config.owner, config.repo, issue.number, plan.toPush.labels),
    );
  }
  if (plan.toPush.milestone !== undefined) {
    issue = parseIssue(
      await githubSetIssueMilestone(
        config.owner,
        config.repo,
        issue.number,
        plan.toPush.milestone === null ? null : milestone.number,
      ),
    );
  }
  if (plan.toPush.state && plan.toPush.state !== issue.state) {
    issue = parseIssue(
      plan.toPush.state === "closed"
        ? await githubCloseIssue(config.owner, config.repo, issue.number)
        : await githubReopenIssue(config.owner, config.repo, issue.number),
    );
  }
  issue = parseIssue(await githubGetIssue(config.owner, config.repo, issue.number));
  return advanceMirrorRecord(record, {
    localRev:
      useFlightStore.getState().flights.find((item) => item.id === flight.id)?.updatedAt ??
      localRev,
    hostUpdatedAt: issueUpdatedAt(issue),
    fields: fieldsFromIssue(issue),
    conflicts: plan.conflicts,
  });
}

export const useIssueFlightMirrorStore = create<IssueFlightMirrorStore>()(
  persist(
    (set, get) => ({
      mirrors: {},
      syncingFlightIds: [],
      enable: (flightId, target) =>
        set((state) => ({
          mirrors: {
            ...state.mirrors,
            [flightId]: {
              flightId,
              enabled: true,
              ...target,
              records: state.mirrors[flightId]?.records ?? {},
            },
          },
        })),
      disable: (flightId) =>
        set((state) => ({
          mirrors: {
            ...state.mirrors,
            [flightId]: { ...state.mirrors[flightId], enabled: false },
          },
        })),
      acknowledgeConflicts: (flightId) =>
        set((state) => {
          const mirror = state.mirrors[flightId];
          if (!mirror) return {};
          return {
            mirrors: {
              ...state.mirrors,
              [flightId]: {
                ...mirror,
                records: Object.fromEntries(
                  Object.entries(mirror.records).map(([key, record]) => [
                    key,
                    { ...record, conflicts: [] },
                  ]),
                ),
              },
            },
          };
        }),
      syncFlight: async (flightId) => {
        const config = get().mirrors[flightId];
        const flight = useFlightStore
          .getState()
          .flights.find((candidate) => candidate.id === flightId);
        if (!config?.enabled || !flight || get().syncingFlightIds.includes(flightId)) return;
        set((state) => ({
          syncingFlightIds: [...state.syncingFlightIds, flightId],
          mirrors: {
            ...state.mirrors,
            [flightId]: { ...config, error: undefined },
          },
        }));
        try {
          await gitHostSetActive(config.hostConnectionId);
          const [milestone, hostIssues] = await Promise.all([
            ensureMilestone(config.owner, config.repo, flight),
            listHostIssues(config.owner, config.repo),
          ]);
          const records = { ...config.records };
          for (const entity of entitiesForFlight(flight)) {
            records[entity.key] = await syncEntity(config, flight, entity, milestone, hostIssues);
          }
          set((state) => ({
            mirrors: {
              ...state.mirrors,
              [flightId]: {
                ...state.mirrors[flightId],
                records,
                lastSyncAt: Date.now(),
                error: undefined,
              },
            },
          }));
        } catch (error) {
          set((state) => ({
            mirrors: {
              ...state.mirrors,
              [flightId]: { ...state.mirrors[flightId], error: String(error) },
            },
          }));
        } finally {
          set((state) => ({
            syncingFlightIds: state.syncingFlightIds.filter((id) => id !== flightId),
          }));
        }
      },
      syncAll: async () => {
        if (document.visibilityState !== "visible") return;
        for (const config of Object.values(get().mirrors)) {
          if (config.enabled) await get().syncFlight(config.flightId);
        }
      },
    }),
    {
      name: storageKey("issue-flight-mirrors"),
      partialize: ({ mirrors }) => ({ mirrors }),
    },
  ),
);
