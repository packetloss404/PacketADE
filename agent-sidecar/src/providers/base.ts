import type {
  Emit,
  EditResponseRequest,
  PermissionResponseRequest,
  RetryRequest,
  SendMessageRequest,
  SetModelRequest,
  SetPermissionModeRequest,
  StartSessionRequest,
} from "../protocol.js";

// A ProviderHandler owns a single session's lifecycle. The registry creates
// one per start_session and keeps it until close_session (or process exit).
//
// Protocol v2 (Tier 3 slice B) added `setPermissionMode`, `setModel`, and
// `retry`. Providers that can't honour a given capability can simply leave the
// method off — the registry emits a clean "not supported" error in that case.
export interface ProviderHandler {
  start(req: StartSessionRequest, emit: Emit): Promise<void>;
  sendMessage?(req: SendMessageRequest, emit: Emit): Promise<void>;
  respondPermission?(req: PermissionResponseRequest, emit: Emit): Promise<void>;
  respondEdit?(req: EditResponseRequest, emit: Emit): Promise<void>;
  cancel?(emit: Emit): Promise<void>;
  close?(): Promise<void>;
  setPermissionMode?(req: SetPermissionModeRequest, emit: Emit): Promise<void>;
  setModel?(req: SetModelRequest, emit: Emit): Promise<void>;
  retry?(req: RetryRequest, emit: Emit): Promise<void>;
}
