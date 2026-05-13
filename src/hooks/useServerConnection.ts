import { useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { createPtySession, killPty, sshExec as tauriSshExec } from "@/lib/tauri";
import { ptyOutputEvent, ptyExitEvent } from "@/lib/events";
import { useServerStore } from "@/stores/serverStore";
import { buildSshExecArgs, REMOTE_INSTALL_COMMANDS, AGENT_CLI_NAMES } from "@/lib/ssh";
import type { ServerConfig, ConnectionStep } from "@/types/server";

/** Agents to auto-install on connect. */
const AUTO_INSTALL_AGENTS = ["claude-code", "opencode"];

/** Prefix for remote commands that ensures common bin dirs are on PATH.
 *  Non-interactive SSH gets a minimal PATH, missing npm/nvm/cargo/local bins. */
const PATH_PREFIX = 'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.cargo/bin:$HOME/.opencode/bin:$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ 2>/dev/null | tail -1)/bin:/usr/local/bin:$PATH" 2>/dev/null;';

/** Run a one-shot SSH command and collect output.
 *  For password auth, uses a direct process (not PTY) with stdin piping —
 *  Windows OpenSSH ignores PTY stdin for password prompts.
 *  For agent/key auth, uses PTY so interactive SSH features work. */
async function sshExec(
  server: ServerConfig,
  remoteCommand: string,
  ephemeralPassword?: string,
): Promise<{ output: string; success: boolean }> {
  const knownHostsPath = useServerStore.getState().knownHostsPath ?? undefined;
  const args = buildSshExecArgs(server, remoteCommand, knownHostsPath);

  // Password auth: use direct process with stdin piping (bypasses Windows terminal issues)
  if (server.authMethod === "password") {
    try {
      const output = await tauriSshExec(args, ephemeralPassword ?? null);

      const success =
        !output.includes("Permission denied") &&
        !output.includes("Connection refused") &&
        !output.includes("Could not resolve hostname") &&
        !output.includes("Connection timed out") &&
        !output.includes("No route to host");

      return { output, success };
    } catch (e) {
      return { output: String(e), success: false };
    }
  }

  // Agent/key auth: use PTY for interactive SSH
  const sessionId = await createPtySession(
    "",
    120,
    40,
    "ssh",
    args,
  );

  let output = "";
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let resolveExit: (value: boolean) => void = () => {};
  const exitPromise = new Promise<boolean>((resolve) => {
    resolveExit = resolve;
  });

  const [outputUnlisten, exitUnlisten] = await Promise.all([
    listen<string>(ptyOutputEvent(sessionId), (event) => {
      output += event.payload;
    }),
    listen<string>(ptyExitEvent(sessionId), () => {
      resolveExit(true);
    }),
  ]);

  let completed: boolean | undefined;
  try {
    const timeoutPromise = new Promise<boolean>((resolve) => {
      timeoutId = setTimeout(() => resolve(false), 15_000);
    });

    completed = await Promise.race([exitPromise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    outputUnlisten();
    exitUnlisten();
  }

  if (!completed) {
    await killPty(sessionId).catch(() => {});
    return { output: output + "\n[Connection timed out]", success: false };
  }

  const success =
    !output.includes("Permission denied") &&
    !output.includes("Connection refused") &&
    !output.includes("Could not resolve hostname") &&
    !output.includes("Connection timed out") &&
    !output.includes("No route to host");

  return { output, success };
}

function makeSteps(): ConnectionStep[] {
  return [
    { id: "ssh", label: "Connecting via SSH...", status: "pending" },
    { id: "node", label: "Checking for Node.js...", status: "pending" },
    ...AUTO_INSTALL_AGENTS.flatMap((agentId) => {
      const name = AGENT_CLI_NAMES[agentId] ?? agentId;
      return [
        { id: `detect-${agentId}`, label: `Detecting ${name}...`, status: "pending" as const },
        { id: `install-${agentId}`, label: `Installing ${name}...`, status: "pending" as const },
      ];
    }),
    { id: "ready", label: "Ready", status: "pending" },
  ];
}

export function useServerConnection() {
  const abortRef = useRef(false);

  const connect = useCallback(async (server: ServerConfig, password?: string) => {
    const store = useServerStore.getState();
    abortRef.current = false;

    const steps = makeSteps();
    store.setConnectionStatus(server.id, { status: "connecting", steps });

    const updateStep = (stepId: string, updates: Partial<ConnectionStep>) => {
      useServerStore.getState().updateConnectionStep(server.id, stepId, updates);
    };

    const setError = (stepId: string, detail: string) => {
      updateStep(stepId, { status: "error", detail });
      useServerStore.getState().setConnectionStatus(server.id, {
        ...useServerStore.getState().connectionStates[server.id],
        status: "error",
        error: detail,
      });
    };

    const installedAgents: string[] = [];

    // Curry password into all SSH calls for this connection
    const exec = (cmd: string) => sshExec(server, cmd, password);

    try {
      // Step 1: Test SSH connection
      updateStep("ssh", { status: "running" });
      const sshTest = await exec("echo PACKETCODE_CONNECTED");
      if (!sshTest.success || !sshTest.output.includes("PACKETCODE_CONNECTED")) {
        setError("ssh", sshTest.output.trim().slice(0, 200) || "SSH connection failed");
        return;
      }
      updateStep("ssh", { status: "success", detail: "Connected" });

      if (abortRef.current) return;

      // Step 2: Check Node.js
      updateStep("node", { status: "running" });
      const nodeCheck = await exec("node --version 2>/dev/null || echo NOT_FOUND");
      if (nodeCheck.output.includes("NOT_FOUND")) {
        updateStep("node", { status: "error", detail: "Node.js not found — npm-based agents cannot be installed" });
        // Non-fatal: continue, but npm installs will fail
      } else {
        const version = nodeCheck.output.trim().split("\n").pop()?.trim() ?? "";
        updateStep("node", { status: "success", detail: version });
      }

      if (abortRef.current) return;

      // Steps 3+: Detect and install each auto-install agent
      for (const agentId of AUTO_INSTALL_AGENTS) {
        if (abortRef.current) return;

        const cliName = AGENT_CLI_NAMES[agentId] ?? agentId;
        const detectId = `detect-${agentId}`;
        const installId = `install-${agentId}`;

        // Detect — source profile first so PATH includes npm/nvm/local bins
        updateStep(detectId, { status: "running" });
        const detectResult = await exec(`${PATH_PREFIX}which ${cliName} 2>/dev/null && ${cliName} --version 2>/dev/null || echo NOT_FOUND`);

        if (detectResult.output.includes("NOT_FOUND")) {
          updateStep(detectId, { status: "error", detail: "Not installed" });

          // Install
          const installCmd = REMOTE_INSTALL_COMMANDS[agentId];
          if (installCmd) {
            updateStep(installId, { status: "running", label: `Installing ${cliName}...` });
            const installResult = await exec(`${PATH_PREFIX}${installCmd}`);
            if (installResult.success) {
              // Verify install
              const verifyResult = await exec(`${PATH_PREFIX}which ${cliName} 2>/dev/null || echo STILL_NOT_FOUND`);
              if (!verifyResult.output.includes("STILL_NOT_FOUND")) {
                updateStep(installId, { status: "success", detail: "Installed" });
                installedAgents.push(agentId);
              } else {
                updateStep(installId, { status: "error", detail: "Install completed but CLI not found on PATH" });
              }
            } else {
              updateStep(installId, { status: "error", detail: "Installation failed" });
            }
          } else {
            updateStep(installId, { status: "skipped" });
          }
        } else {
          const version = detectResult.output.trim().split("\n").pop()?.trim() ?? "";
          updateStep(detectId, { status: "success", detail: version || "Found" });
          updateStep(installId, { status: "skipped" });
          installedAgents.push(agentId);
        }
      }

      if (abortRef.current) return;

      // Done
      updateStep("ready", { status: "success", detail: `${installedAgents.length} agent(s) available` });

      // Persist detected agents and connection time
      useServerStore.getState().updateServer(server.id, {
        installedAgents,
        lastConnectedAt: Date.now(),
      });

      useServerStore.getState().setConnectionStatus(server.id, {
        ...useServerStore.getState().connectionStates[server.id],
        status: "connected",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      useServerStore.getState().setConnectionStatus(server.id, {
        ...useServerStore.getState().connectionStates[server.id],
        status: "error",
        error: msg,
      });
    }
  }, []);

  const abort = useCallback(() => {
    abortRef.current = true;
  }, []);

  return { connect, abort };
}
