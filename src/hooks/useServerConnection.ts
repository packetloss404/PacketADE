import { useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { createPtySession, writePty } from "@/lib/tauri";
import { ptyOutputEvent, ptyExitEvent } from "@/lib/events";
import { useServerStore } from "@/stores/serverStore";
import { buildSshExecArgs, REMOTE_INSTALL_COMMANDS, AGENT_CLI_NAMES } from "@/lib/ssh";
import type { ServerConfig, ConnectionStep } from "@/types/server";

/** Agents to auto-install on connect. */
const AUTO_INSTALL_AGENTS = ["claude-code", "opencode"];

/** Run a one-shot SSH command and collect output until exit.
 *  For password auth, detects the password prompt and auto-feeds the password. */
async function sshExec(
  server: ServerConfig,
  remoteCommand: string,
): Promise<{ output: string; success: boolean }> {
  const args = buildSshExecArgs(server, remoteCommand);

  const sessionId = await createPtySession(
    "", // project path doesn't matter for SSH
    120,
    40,
    "ssh",
    args,
  );

  let output = "";

  const outputUnlisten = await listen<string>(ptyOutputEvent(sessionId), (event) => {
    output += event.payload;
  });

  // For password auth, send the password after a delay to let SSH connect
  // and show the prompt. SSH reads from stdin buffer, so timing doesn't
  // need to be exact — the password just needs to arrive while SSH is waiting.
  if (server.authMethod === "password" && server.password) {
    setTimeout(() => {
      void writePty(sessionId, server.password + "\r");
    }, 3000);
  }

  const exitPromise = new Promise<boolean>((resolve) => {
    listen<string>(ptyExitEvent(sessionId), () => {
      resolve(true);
    });
  });

  // Timeout after 20 seconds to allow time for password auth
  const timeoutPromise = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), 20_000);
  });

  const completed = await Promise.race([exitPromise, timeoutPromise]);
  outputUnlisten();

  if (!completed) {
    return { output: output + "\n[Connection timed out]", success: false };
  }

  // Check for common SSH error patterns
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

  const connect = useCallback(async (server: ServerConfig) => {
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

    try {
      // Step 1: Test SSH connection
      updateStep("ssh", { status: "running" });
      const sshTest = await sshExec(server, "echo PACKETCODE_CONNECTED");
      if (!sshTest.success || !sshTest.output.includes("PACKETCODE_CONNECTED")) {
        setError("ssh", sshTest.output.trim().slice(0, 200) || "SSH connection failed");
        return;
      }
      updateStep("ssh", { status: "success", detail: "Connected" });

      if (abortRef.current) return;

      // Step 2: Check Node.js
      updateStep("node", { status: "running" });
      const nodeCheck = await sshExec(server, "node --version 2>/dev/null || echo NOT_FOUND");
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

        // Detect
        updateStep(detectId, { status: "running" });
        const detectResult = await sshExec(server, `which ${cliName} 2>/dev/null && ${cliName} --version 2>/dev/null || echo NOT_FOUND`);

        if (detectResult.output.includes("NOT_FOUND")) {
          updateStep(detectId, { status: "error", detail: "Not installed" });

          // Install
          const installCmd = REMOTE_INSTALL_COMMANDS[agentId];
          if (installCmd) {
            updateStep(installId, { status: "running", label: `Installing ${cliName}...` });
            const installResult = await sshExec(server, installCmd);
            if (installResult.success) {
              // Verify install
              const verifyResult = await sshExec(server, `which ${cliName} 2>/dev/null || echo STILL_NOT_FOUND`);
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
