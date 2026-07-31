import { create } from "zustand";
import { saveCliAccountsSlice, type CliAccountDefaults } from "@/lib/tauri";
import { generateId } from "@/lib/storage";
import { logSwallowed } from "@/lib/logSwallowed";
import type { CliAccount, CliAccountCli } from "@/types/cliAccount";

/**
 * Named CLI logins and the sticky per-project choice between them.
 *
 * Modelled on `serverStore`: the store is the single owner of the list and
 * re-sends the whole slice to Rust on every mutation, so the backend never
 * has to merge. Backend is the source of truth across restarts —
 * `hydrateFromBackend` is called once from bootstrap.
 *
 * Two invariants this store enforces so the rest of the app can be naive:
 *   1. A sticky default never outlives the account it names. Deleting an
 *      account prunes every default pointing at it — a dangling pointer would
 *      resolve to `undefined` and silently launch under the ambient login,
 *      which is exactly the cross-account leak multi-account exists to stop.
 *   2. Accounts and defaults are persisted in ONE call, so a crash between
 *      two writes cannot leave a default naming an account that never landed.
 */
interface CliAccountStore {
  accounts: CliAccount[];
  /** `project path -> cli -> account id`. */
  stickyDefaults: CliAccountDefaults;

  // CRUD
  addAccount: (input: Omit<CliAccount, "id" | "createdAt">) => CliAccount;
  updateAccount: (id: string, patch: Partial<CliAccount>) => void;
  /** Removes the record only — the config directory on disk is untouched. */
  deleteAccount: (id: string) => void;
  getAccount: (id: string | null | undefined) => CliAccount | undefined;
  accountsForCli: (cli: CliAccountCli) => CliAccount[];

  // Sticky per-project default
  defaultFor: (projectPath: string, cli: CliAccountCli) => string | null;
  rememberDefault: (
    projectPath: string,
    cli: CliAccountCli,
    accountId: string | null,
  ) => void;

  /** Stamp `lastUsedAt` — drives the "Last used" column in Settings. */
  markUsed: (id: string) => void;

  // Hydration
  hydrateFromBackend: (accounts?: CliAccount[], stickyDefaults?: CliAccountDefaults) => void;
}

function syncToBackend(accounts: CliAccount[], stickyDefaults: CliAccountDefaults) {
  void saveCliAccountsSlice(accounts, stickyDefaults).catch(logSwallowed("cliAccountStore.save"));
}

/** Drop every sticky default that names `accountId`, and any project entry
 *  left empty as a result (so the persisted map does not accumulate husks). */
function pruneDefaults(
  stickyDefaults: CliAccountDefaults,
  accountId: string,
): CliAccountDefaults {
  const next: CliAccountDefaults = {};
  for (const [projectPath, perCli] of Object.entries(stickyDefaults)) {
    const entry: Partial<Record<CliAccountCli, string>> = {};
    for (const [cli, id] of Object.entries(perCli) as [CliAccountCli, string][]) {
      if (id !== accountId) entry[cli] = id;
    }
    if (Object.keys(entry).length > 0) next[projectPath] = entry;
  }
  return next;
}

export const useCliAccountStore = create<CliAccountStore>((set, get) => ({
  accounts: [],
  stickyDefaults: {},

  addAccount: (input) => {
    const account: CliAccount = {
      ...input,
      id: generateId("acct"),
      createdAt: Date.now(),
    };
    set((s) => {
      const accounts = [...s.accounts, account];
      syncToBackend(accounts, s.stickyDefaults);
      return { accounts };
    });
    return account;
  },

  updateAccount: (id, patch) => {
    set((s) => {
      const accounts = s.accounts.map((account) =>
        account.id === id
          ? // `id` and `createdAt` are identity, not settings — a caller
            // passing them in a patch must not be able to rewrite them.
            { ...account, ...patch, id: account.id, createdAt: account.createdAt }
          : account,
      );
      syncToBackend(accounts, s.stickyDefaults);
      return { accounts };
    });
  },

  deleteAccount: (id) => {
    set((s) => {
      const accounts = s.accounts.filter((account) => account.id !== id);
      const stickyDefaults = pruneDefaults(s.stickyDefaults, id);
      syncToBackend(accounts, stickyDefaults);
      return { accounts, stickyDefaults };
    });
  },

  getAccount: (id) => {
    if (!id) return undefined;
    return get().accounts.find((account) => account.id === id);
  },

  accountsForCli: (cli) => get().accounts.filter((account) => account.cli === cli),

  defaultFor: (projectPath, cli) => {
    const state = get();
    const id = state.stickyDefaults[projectPath]?.[cli];
    if (!id) return null;
    // Defensive: a default whose account is gone resolves to "no default"
    // rather than to a dangling id a caller might treat as selected.
    return state.accounts.some((account) => account.id === id) ? id : null;
  },

  rememberDefault: (projectPath, cli, accountId) => {
    set((s) => {
      const current = s.stickyDefaults[projectPath] ?? {};
      const entry: Partial<Record<CliAccountCli, string>> = { ...current };
      if (accountId) {
        entry[cli] = accountId;
      } else {
        // Explicitly choosing "ambient login" clears the sticky default
        // instead of recording a null, so the persisted map stays sparse.
        delete entry[cli];
      }

      const stickyDefaults: CliAccountDefaults = { ...s.stickyDefaults };
      if (Object.keys(entry).length > 0) {
        stickyDefaults[projectPath] = entry;
      } else {
        delete stickyDefaults[projectPath];
      }

      syncToBackend(s.accounts, stickyDefaults);
      return { stickyDefaults };
    });
  },

  markUsed: (id) => {
    set((s) => {
      if (!s.accounts.some((account) => account.id === id)) return s;
      const accounts = s.accounts.map((account) =>
        account.id === id ? { ...account, lastUsedAt: Date.now() } : account,
      );
      syncToBackend(accounts, s.stickyDefaults);
      return { accounts };
    });
  },

  hydrateFromBackend: (accounts, stickyDefaults) => {
    set((s) => ({
      accounts: accounts ?? s.accounts,
      stickyDefaults: stickyDefaults ?? s.stickyDefaults,
    }));
  },
}));
