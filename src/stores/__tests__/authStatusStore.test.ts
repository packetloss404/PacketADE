import { beforeEach, describe, expect, it, vi } from "vitest";

const getProviderAuthStatus = vi.hoisted(() => vi.fn());
const getProviderAuthStatusForDir = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({
  getProviderAuthStatus: (...args: unknown[]) => getProviderAuthStatus(...args),
  getProviderAuthStatusForDir: (...args: unknown[]) =>
    getProviderAuthStatusForDir(...args),
  saveCliAccountsSlice: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listen(...args),
}));

import {
  AUTH_STATUS_TTL_MS,
  authStatusKey,
  useAuthStatusStore,
} from "@/stores/authStatusStore";
import { useCliAccountStore } from "@/stores/cliAccountStore";

const READY = { status: "ready" as const, hint: "" };
const LOGIN_REQUIRED = { status: "login_required" as const, hint: "log in" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  useAuthStatusStore.getState().reset();
  useCliAccountStore.setState({ accounts: [] });
  getProviderAuthStatus.mockResolvedValue(READY);
  getProviderAuthStatusForDir.mockResolvedValue(READY);
  listen.mockResolvedValue(() => {});
});

describe("keying", () => {
  it("keys the ambient default separately from each account", () => {
    expect(authStatusKey("claude-oauth")).toBe("claude-oauth");
    expect(authStatusKey("claude-oauth", null)).toBe("claude-oauth");
    expect(authStatusKey("claude-oauth", undefined)).toBe("claude-oauth");
    expect(authStatusKey("claude-oauth", "acct-1")).toBe("claude-oauth::acct-1");
    expect(authStatusKey("claude-oauth", "acct-1")).not.toBe(
      authStatusKey("claude-oauth", "acct-2"),
    );
    expect(authStatusKey("openai-codex", "acct-1")).not.toBe(
      authStatusKey("claude-oauth", "acct-1"),
    );
  });
});

describe("ambient probing", () => {
  it("uses the zero-arg command when no account is selected", async () => {
    await useAuthStatusStore.getState().fetchStatus("claude-oauth");
    expect(getProviderAuthStatus).toHaveBeenCalledWith("claude-oauth");
    expect(getProviderAuthStatusForDir).not.toHaveBeenCalled();
    expect(useAuthStatusStore.getState().getStatus("claude-oauth")).toEqual(READY);
  });

  it("reports probe failures as service_down instead of hanging on loading", async () => {
    getProviderAuthStatus.mockRejectedValueOnce(new Error("ipc down"));
    const entry = await useAuthStatusStore.getState().fetchStatus("ollama");
    expect(entry).toEqual({ status: "service_down", hint: "Status unavailable" });
  });
});

describe("caching", () => {
  it("serves a cached value inside the TTL without re-probing", async () => {
    const store = useAuthStatusStore.getState();
    await store.fetchStatus("claude-oauth");
    await store.fetchStatus("claude-oauth");
    await store.fetchStatus("claude-oauth");
    expect(getProviderAuthStatus).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent probes for the same key onto one call", async () => {
    const store = useAuthStatusStore.getState();
    const [a, b, c] = await Promise.all([
      store.fetchStatus("claude-oauth"),
      store.fetchStatus("claude-oauth"),
      store.fetchStatus("claude-oauth"),
    ]);
    expect(getProviderAuthStatus).toHaveBeenCalledTimes(1);
    expect(a).toEqual(READY);
    expect(b).toEqual(READY);
    expect(c).toEqual(READY);
  });

  it("does not share a cache entry across providers", async () => {
    const store = useAuthStatusStore.getState();
    await store.fetchStatus("claude-oauth");
    await store.fetchStatus("openai-codex");
    expect(getProviderAuthStatus).toHaveBeenCalledTimes(2);
  });

  it("re-probes once the TTL has elapsed", async () => {
    const store = useAuthStatusStore.getState();
    await store.fetchStatus("claude-oauth");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + AUTH_STATUS_TTL_MS + 1);
    await useAuthStatusStore.getState().fetchStatus("claude-oauth");
    expect(getProviderAuthStatus).toHaveBeenCalledTimes(2);
  });

  it("force bypasses the cache and shows a spinner while re-probing", async () => {
    const store = useAuthStatusStore.getState();
    await store.fetchStatus("claude-oauth");
    let resolve: ((v: unknown) => void) | undefined;
    getProviderAuthStatus.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const pending = useAuthStatusStore
      .getState()
      .fetchStatus("claude-oauth", null, { force: true });
    expect(useAuthStatusStore.getState().getStatus("claude-oauth")).toBe("loading");
    resolve?.(LOGIN_REQUIRED);
    await pending;
    expect(getProviderAuthStatus).toHaveBeenCalledTimes(2);
    expect(useAuthStatusStore.getState().getStatus("claude-oauth")).toEqual(
      LOGIN_REQUIRED,
    );
  });
});

describe("per-account probing", () => {
  it("probes the account's configDir, not the ambient login", async () => {
    useCliAccountStore.setState({
      accounts: [
        {
          id: "acct-1",
          label: "Client work",
          cli: "claude-code",
          configDir: "/home/u/.claude-client",
          createdAt: 0,
        },
      ],
    });
    await useAuthStatusStore.getState().fetchStatus("claude-oauth", "acct-1");
    expect(getProviderAuthStatusForDir).toHaveBeenCalledWith(
      "claude-oauth",
      "/home/u/.claude-client",
    );
    expect(getProviderAuthStatus).not.toHaveBeenCalled();
  });

  it("caches two accounts of the same provider independently", async () => {
    useCliAccountStore.setState({
      accounts: [
        {
          id: "oss",
          label: "OSS",
          cli: "codex",
          configDir: "/dirs/oss",
          createdAt: 0,
        },
        {
          id: "client",
          label: "Client",
          cli: "codex",
          configDir: "/dirs/client",
          createdAt: 0,
        },
      ],
    });
    getProviderAuthStatusForDir.mockImplementation((_p: string, dir: string) =>
      Promise.resolve(dir === "/dirs/oss" ? READY : LOGIN_REQUIRED),
    );
    const store = useAuthStatusStore.getState();
    await store.fetchStatus("openai-codex", "oss");
    await store.fetchStatus("openai-codex", "client");
    expect(store.getStatus("openai-codex", "oss")).toEqual(READY);
    expect(store.getStatus("openai-codex", "client")).toEqual(LOGIN_REQUIRED);
    // ...and neither of them is the ambient entry.
    expect(store.getStatus("openai-codex")).toBeUndefined();
  });

  it("accepts an explicit configDir override without consulting the store", async () => {
    await useAuthStatusStore
      .getState()
      .fetchStatus("openai-codex", "unregistered", {
        configDir: "/tmp/ad-hoc",
      });
    expect(getProviderAuthStatusForDir).toHaveBeenCalledWith(
      "openai-codex",
      "/tmp/ad-hoc",
    );
  });

  it("never falls back to the ambient probe for a dangling account id", async () => {
    const entry = await useAuthStatusStore
      .getState()
      .fetchStatus("claude-oauth", "deleted-account");
    expect(getProviderAuthStatus).not.toHaveBeenCalled();
    expect(getProviderAuthStatusForDir).not.toHaveBeenCalled();
    expect(entry).toEqual({ status: "service_down", hint: "Account not found" });
  });
});

describe("invalidation", () => {
  it("invalidates exactly one (provider, accountId) key", async () => {
    useCliAccountStore.setState({
      accounts: [
        { id: "a", label: "A", cli: "codex", configDir: "/a", createdAt: 0 },
        { id: "b", label: "B", cli: "codex", configDir: "/b", createdAt: 0 },
      ],
    });
    const store = useAuthStatusStore.getState();
    await store.fetchStatus("openai-codex", "a");
    await store.fetchStatus("openai-codex", "b");
    store.invalidate("openai-codex", "a");
    expect(store.getStatus("openai-codex", "a")).toBeUndefined();
    expect(store.getStatus("openai-codex", "b")).toEqual(READY);
    await useAuthStatusStore.getState().fetchStatus("openai-codex", "a");
    expect(getProviderAuthStatusForDir).toHaveBeenCalledTimes(3);
  });

  it("invalidates a whole provider including all of its accounts", async () => {
    useCliAccountStore.setState({
      accounts: [
        { id: "a", label: "A", cli: "codex", configDir: "/a", createdAt: 0 },
      ],
    });
    const store = useAuthStatusStore.getState();
    await store.fetchStatus("openai-codex");
    await store.fetchStatus("openai-codex", "a");
    await store.fetchStatus("claude-oauth");
    store.invalidate("openai-codex");
    expect(store.getStatus("openai-codex")).toBeUndefined();
    expect(store.getStatus("openai-codex", "a")).toBeUndefined();
    expect(store.getStatus("claude-oauth")).toEqual(READY);
  });

  it("invalidates everything when called with no arguments", async () => {
    const store = useAuthStatusStore.getState();
    await store.fetchStatus("openai-codex");
    await store.fetchStatus("claude-oauth");
    store.invalidate();
    expect(useAuthStatusStore.getState().entries).toEqual({});
  });
});

describe("provider-auth:changed", () => {
  it("subscribes exactly once no matter how many consumers ask", () => {
    const store = useAuthStatusStore.getState();
    store.ensureListener();
    store.ensureListener();
    store.ensureListener();
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen.mock.calls[0][0]).toBe("provider-auth:changed");
  });

  it("routes a payload without accountId to the ambient entry", async () => {
    let handler: ((e: { payload: unknown }) => void) | undefined;
    listen.mockImplementation((_name: string, cb: (e: { payload: unknown }) => void) => {
      handler = cb;
      return Promise.resolve(() => {});
    });
    useAuthStatusStore.getState().ensureListener();
    await Promise.resolve();
    handler?.({ payload: { provider: "claude-oauth", status: LOGIN_REQUIRED } });
    const store = useAuthStatusStore.getState();
    expect(store.getStatus("claude-oauth")).toEqual(LOGIN_REQUIRED);
    expect(store.getStatus("claude-oauth", "acct-1")).toBeUndefined();
  });

  it("routes a payload with accountId to that account only", async () => {
    let handler: ((e: { payload: unknown }) => void) | undefined;
    listen.mockImplementation((_name: string, cb: (e: { payload: unknown }) => void) => {
      handler = cb;
      return Promise.resolve(() => {});
    });
    useAuthStatusStore.getState().ensureListener();
    await Promise.resolve();
    handler?.({
      payload: {
        provider: "openai-codex",
        accountId: "acct-9",
        status: READY,
      },
    });
    const store = useAuthStatusStore.getState();
    expect(store.getStatus("openai-codex", "acct-9")).toEqual(READY);
    expect(store.getStatus("openai-codex")).toBeUndefined();
  });

  it("an event refreshes the cache so the next fetch is served from it", async () => {
    useAuthStatusStore.getState().applyEvent("claude-oauth", null, LOGIN_REQUIRED);
    const entry = await useAuthStatusStore.getState().fetchStatus("claude-oauth");
    expect(entry).toEqual(LOGIN_REQUIRED);
    expect(getProviderAuthStatus).not.toHaveBeenCalled();
  });
});
