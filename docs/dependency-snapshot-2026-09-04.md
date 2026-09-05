# Dependency snapshot — 2026-09-04

Reviewed commit: `2f4a10c384508af75a792604fff91b55a16dee26` (`main`).
Tools actually run on this machine: `pnpm audit --json` (root workspace, includes
`remoteagents/*`), `pnpm audit --json` in `agent-sidecar/`, and
`cargo audit --file src-tauri/Cargo.lock` (cargo-audit 0.22.2, advisory DB
1239 entries fetched 2026-09-05). Versions below come from `pnpm-lock.yaml`,
`agent-sidecar/pnpm-lock.yaml`, and `src-tauri/Cargo.lock`, not from
`package.json` ranges.

## Do-not-upgrade list (why each one is pinned where it is)

| Package | Pinned at | Why not to bump during the dark period |
| --- | --- | --- |
| `react-syntax-highlighter` / `refractor` / `prismjs` | 15.6.6 / 3.6.0 / 1.27.0 | Fixing CVE-2024-53382 needs refractor 4 (a major with a different API). react-markdown escapes raw HTML, so DOM clobbering is not reachable here. |
| `@xterm/xterm` | 6.0.0 | `src/hooks/useXterm.ts:66-68` carries a workaround for a 6.0.0 minified-build DECRQM bug; a bump must re-verify OpenCode panes render. |
| `react-mosaic-component` | 7.0.0-beta0 | Beta pin that the pane layout is written against; carries `uuid@11.1.0` (CVE-2026-41907, needs a `buf` argument PacketBench never passes). |
| `vite` | 6.4.1 | Dev-server-only CVEs (below). `vitest.config.ts` and `playwright.config.ts` assume Vite 6 dev-server behaviour; bump only with a full `pnpm gates:full`. |
| `tailwindcss` | 3.4.19 | v4 is a rewrite; theme tokens in `tailwind.config.ts` would need porting. |
| `@anthropic-ai/claude-agent-sdk` | 0.2.116 | Sidecar protocol v11 `Options.env` / `canUseTool` behaviour is asserted by `agent-sidecar/test/*-smoke.mjs`; bumping requires re-running `pnpm sidecar:check`. |
| `@openai/agents` | 0.11.4 | Same reason: `openai-agents-gating-smoke.mjs` pins the observed gating behaviour. |
| `portable-pty` | vendored 0.8.1 | Patched in-tree (`src-tauri/vendor/portable-pty`, allocation-free `close_random_fds`). Never replace with the crates.io version. |
| `keyring` | 3.6.3 | Credential migration code (`LEGACY_KEYRING_SERVICE`) is written against the v3 `Entry` API. |
| `rusqlite` | 0.33.0 (bundled SQLite) | Dictation history schema; `bundled` feature means no system SQLite dependency. |
| `whisper-rs` | 0.16.0 | Native build depends on CMake + libclang; a bump re-runs the whole native build. |
| Node runtime | 24.15.0 (`scripts/node-runtime.js`) | Five SHA-256 digests are pinned; bumping requires replacing all five in one commit. |

## npm advisories — root workspace (`pnpm audit`, 52 findings: 1 critical, 25 high, 21 moderate, 5 low)

All but three are **dev/build-time only** (ESLint, Vite dev server, Tailwind's chokidar,
Babel, jsdom/undici under Vitest, the `tar`/`adm-zip` used by `scripts/fetch-node.js`).
None ship in the packaged app's webview bundle except `prismjs`, `diff`, and `uuid`.

| Severity | Package (installed) | Advisory | Reaches production? | Disposition |
| --- | --- | --- | --- | --- |
| critical | `tar@7.5.13` | CVE-2026-59873 decompression DoS | No — used only by `scripts/fetch-node.js` to unpack the pinned Node tarball whose SHA-256 is verified first. | Leave. Bump to `>=7.5.21` on the next release branch (also clears CVE-2026-53655/-59871/-59875/-73566). |
| high | `adm-zip@0.5.17` | CVE-2026-39244 4GB allocation | No — `scripts/fetch-node.js` (Windows zip). | Leave; bump `>=0.6.0` with the tar bump. |
| high | `vite@6.4.1` | CVE-2026-39363 arbitrary file read via dev-server WebSocket; CVE-2026-39365; CVE-2026-53632 (launch-editor NTLM) | Dev server only (`pnpm dev`). Not in the bundle. | Do not run `pnpm dev` bound to a non-loopback host. Bump to `>=6.4.3` on a release branch. |
| high | `postcss@8.5.6` | CVE-2026-45623 / -73646 / -69153 sourceMappingURL file read; CVE-2026-41305 | Build time only. | Leave. |
| high | `nanoid@3.3.11` | CVE-2026-67214 / -67213 / -73086 | Transitive of postcss; build time. | Leave. |
| high | `minimatch@10.2.2`, `brace-expansion@5.0.3`, `flatted@3.3.3`, `@humanfs/node` | ReDoS / prototype pollution / symlink copy | ESLint only. | Leave. |
| high | `undici@7.24.7` | CVE-2026-9697 TLS bypass via SOCKS5, CVE-2026-9679, CVE-2026-16728 | jsdom under Vitest only. | Leave. |
| high | `browserslist@4.28.1` | CVE-2026-73089 memory growth | Babel/build. | Leave. |
| moderate | `prismjs@1.27.0` | CVE-2024-53382 DOM clobbering | **Yes, shipped** (`MarkdownRenderer.tsx`). Not exploitable: react-markdown v9 renders no raw HTML, so an attacker cannot place the `id`-bearing DOM node the attack needs. | Leave (see do-not-upgrade). |
| moderate | `uuid@11.1.0` | CVE-2026-41907 | Shipped via react-mosaic. Only affects v3/v5/v6 with a caller-supplied buffer; PacketBench calls none of those. | Leave. |
| moderate | `ajv@8.17.1` | CVE-2025-69873 ReDoS with `$data` | `remoteagents/shared` tests only; `$data` not used. | Leave. |
| moderate | `picomatch@2.3.1`/`4.0.3` | CVE-2026-33672 | Build time. | Leave. |
| low | `diff@7.0.0` | CVE-2026-24001 `parsePatch`/`applyPatch` DoS | **Yes, shipped** (`src/components/agents` diff view). PacketBench calls `diffLines`/`createTwoFilesPatch`, not `parsePatch`/`applyPatch`. | Leave; bump `>=8.0.3` when convenient (major). |
| low | `@babel/core@7.29.0`, `postcss-selector-parser@6.1.2` | file read / recursion | Build time. | Leave. |

## npm advisories — `agent-sidecar/` (`pnpm audit` there)

**Corrected 2026-09-05.** The original text here claimed the sidecar lockfile reported
**0 vulnerabilities**. That was wrong: the first run had resolved the parent workspace instead
of the sidecar. `pnpm --ignore-workspace audit` inside `agent-sidecar/` (the same flag
`pnpm sidecar:install` uses) reports **37 advisories across 115 dependencies: 10 high,
24 moderate, 3 low, 0 critical**. These ship: `agent-sidecar/node_modules` is bundled into the
installer as a Tauri resource.

Almost all of them sit in the HTTP **server** half of `@modelcontextprotocol/sdk` — `hono`,
`express`, `body-parser`, `qs`, `ip-address`, `express-rate-limit`. PacketBench's sidecar uses
MCP only as a **client** over stdio (`agent-sidecar/src/mcp-config.ts`, `mcp-capability.ts`),
never starting an HTTP MCP server, so that code is present but not executed. Verify that
assumption before dismissing a future advisory in this tree.

| Severity | Package (installed) | Advisory | Reachable here? | Disposition |
| --- | --- | --- | --- | --- |
| high | `hono@4.12.14` | CVE-2026-54290 CORS middleware reflects any Origin with credentials, plus 11 more hono CVEs (body-limit bypass, JWT scheme, serve-static traversal, cookie injection) | No — pulled in by `@modelcontextprotocol/sdk`'s server transports, which the sidecar never starts | Clears on an MCP SDK bump; see below |
| high | `ws@8.20.1` | CVE-2026-48779 memory exhaustion from tiny fragments | Only if the OpenAI Agents SDK opens a websocket (realtime API); PacketBench uses the non-realtime path | Clears on an `@openai/agents` bump (`>=8.21.0`) |
| moderate | `@anthropic-ai/sdk@0.81.0` | CVE-2026-41686 insecure default file permissions in the local-filesystem memory tool | Only if that memory tool is used; PacketBench does not enable it | Clears on `>=0.91.1` |
| moderate | `qs@6.15.1`, `body-parser@2.2.2`, `ip-address@10.1.0`, `express-rate-limit` | DoS / XSS in the express stack under the MCP SDK | No — server half, not started | Same bump |

**Why this is not a one-line fix.** Every one of these is transitive under
`@anthropic-ai/claude-agent-sdk@0.2.116`, `@modelcontextprotocol/sdk@1.29.0`, and
`@openai/agents@0.11.4` — all three of which are on the do-not-upgrade list above because the
sidecar smoke gates assert their observed behaviour. The correct sequence is: bump the three
SDKs on a branch, run `pnpm sidecar:check` (thirteen smoke gates), then `pnpm gates:full`.
Do not bump them blind during the dark period.

## Rust advisories — `src-tauri/Cargo.lock` (`cargo audit`, 9 vulnerabilities, 25 warnings)

| Advisory | Crate (installed) | Patched in | Reaches production? | Disposition |
| --- | --- | --- | --- | --- |
| RUSTSEC-2026-0258 | `h2@0.4.13` | >=0.4.16 | Yes — every reqwest HTTP/2 client (Anthropic, OpenAI, GitHub, PacketAgent). Impact: a **malicious server** can send unbounded empty DATA frames (client-side memory/CPU DoS). Only reachable from endpoints the user configured. | **Bump first** on the next release: `cargo update -p h2` (semver-compatible, no code change). |
| RUSTSEC-2026-0049 / -0098 / -0099 / -0104 | `rustls-webpki@0.103.9` | >=0.103.13 | Yes — TLS verification for every outbound call. -0098/-0099 accept name constraints they should reject; -0104 is a panic on a crafted CRL (CRLs are not fetched by reqwest's default verifier). Needs a CA that issues constrained sub-CAs to exploit. | **Bump second**: `cargo update -p rustls-webpki` (semver-compatible). |
| RUSTSEC-2026-0037 / -0185 | `quinn-proto@0.11.13` | >=0.11.15 | Only if HTTP/3 is used; reqwest here is built without the `http3` feature, so quinn is compiled in transitively but no endpoint speaks QUIC. | Bump with the others (`cargo update -p quinn-proto`). |
| RUSTSEC-2026-0194 / -0195 | `quick-xml@0.38.4` | >=0.41.0 | Transitive (Tauri/Windows resource tooling). No user-controlled XML is parsed at runtime. | Leave; major bump owned by upstream. |
| unsound: `anyhow@1.0.101`, `memmap2@0.8.0`, `rand@0.7/0.8/0.9`, `glib@0.18.5` | — | — | Soundness notes, not exploitable paths. `memmap2` is under `whisper-rs`; `glib` is Linux-only GTK. | Leave. |
| unmaintained: gtk-rs 0.18 family, `fxhash`, `proc-macro-error`, `serial`, `unic-*` | — | — | Transitive via Tauri (Linux GTK) and `cpal`/`enigo`. | Leave; tracked by Tauri upstream. |
| yanked: `chacha20@0.10.1` | — | — | Transitive; yanked for a metadata reason, no advisory. | Leave. |

## Recommended one-line update for the next release branch (NOT applied now)

```bash
cd src-tauri && cargo update -p h2 -p rustls-webpki -p quinn-proto && cargo test --lib
```

Then `pnpm gates:full`. Do not run `cargo update` without `-p` — the lockfile pins
`tauri 2.10.3` / `wry 0.54.2` / `tao 0.34.5`, and an unscoped update drags the whole
Tauri tree.
