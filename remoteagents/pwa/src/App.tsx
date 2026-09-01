import {
  MAX_INLINE_PAYLOAD_BYTES,
  REMOTE_PROTOCOL_VERSION,
  validateRemoteEnvelopeV1,
} from "@packetbench/remoteagents-shared";

const foundationEnvelope = validateRemoteEnvelopeV1({
  v: 1,
  envelopeId: "env_foundation",
  traceId: "trace_foundation",
  accountId: "acct_dev",
  hostId: "host_dev",
  channel: "presence",
  type: "host.offline",
  streamId: "host_dev:presence",
  createdAt: "2026-09-01T00:00:00Z",
  payload: { online: false },
});

export function App() {
  return (
    <main>
      <section className="shell" aria-labelledby="remote-agents-title">
        <p className="eyebrow">PacketBench</p>
        <h1 id="remote-agents-title">Remote Agents</h1>
        <p className="summary">
          Sprint 0 foundation shell. Account sign-in, host presence, and device trust land behind
          the feature gate in later slices.
        </p>
        <dl>
          <div>
            <dt>Protocol</dt>
            <dd>v{REMOTE_PROTOCOL_VERSION}</dd>
          </div>
          <div>
            <dt>Inline ceiling</dt>
            <dd>{MAX_INLINE_PAYLOAD_BYTES / 1024} KiB</dd>
          </div>
          <div>
            <dt>Schema</dt>
            <dd>{foundationEnvelope.ok ? "ready" : "invalid"}</dd>
          </div>
          <div>
            <dt>Relay</dt>
            <dd>feature off</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
