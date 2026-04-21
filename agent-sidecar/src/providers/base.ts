import type {
  Emit,
  EditResponseRequest,
  PermissionResponseRequest,
  SendMessageRequest,
  StartSessionRequest,
} from "../protocol.js";

// A ProviderHandler owns a single session's lifecycle. The registry creates
// one per start_session and keeps it until close_session (or process exit).
export interface ProviderHandler {
  start(req: StartSessionRequest, emit: Emit): Promise<void>;
  sendMessage?(req: SendMessageRequest, emit: Emit): Promise<void>;
  respondPermission?(req: PermissionResponseRequest, emit: Emit): Promise<void>;
  respondEdit?(req: EditResponseRequest, emit: Emit): Promise<void>;
  cancel?(emit: Emit): Promise<void>;
  close?(): Promise<void>;
}
