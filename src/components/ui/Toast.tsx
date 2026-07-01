import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  createContext,
  useContext,
  type ReactNode,
} from "react";
import { X } from "lucide-react";

type ToastVariant = "default" | "error" | "success";

interface ToastOptions {
  variant?: ToastVariant;
  /** Auto-dismiss delay in ms. Pass 0 to disable auto-dismiss. Defaults to 5000. */
  duration?: number;
}

interface Toast {
  id: number;
  message: string;
  variant: ToastVariant;
  duration: number;
}

interface ToastContextValue {
  show: (message: string, opts?: ToastOptions) => void;
  error: (message: string) => void;
  success: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION = 5000;

const variants: Record<ToastVariant, string> = {
  default: "bg-bg-elevated border-bg-border text-text-primary",
  error: "bg-bg-elevated border-accent-red/30 text-accent-red",
  success: "bg-bg-elevated border-accent-green/30 text-accent-green",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback((message: string, opts?: ToastOptions) => {
    const id = ++idRef.current;
    const duration = opts?.duration ?? DEFAULT_DURATION;
    setToasts((prev) => [
      ...prev,
      { id, message, variant: opts?.variant ?? "default", duration },
    ]);
  }, []);

  const contextValue = useMemo<ToastContextValue>(
    () => ({
      show,
      error: (message: string) => show(message, { variant: "error" }),
      success: (message: string) => show(message, { variant: "success" }),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <div className="fixed bottom-4 inset-x-0 z-[60] flex flex-col items-center gap-2 pointer-events-none">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [entered, setEntered] = useState(false);

  // Trigger enter transition on mount.
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Auto-dismiss unless duration is 0.
  useEffect(() => {
    if (toast.duration <= 0) return;
    const id = window.setTimeout(() => onDismiss(toast.id), toast.duration);
    return () => window.clearTimeout(id);
  }, [toast.id, toast.duration, onDismiss]);

  const isError = toast.variant === "error";

  return (
    <div
      role="alert"
      aria-live={isError ? "assertive" : "polite"}
      className={`pointer-events-auto flex items-start gap-2 max-w-[90vw] w-[360px] px-3 py-2 rounded border text-xs shadow-xl transition duration-200 motion-reduce:transition-none ${
        entered ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
      } ${variants[toast.variant]}`}
    >
      <span className="flex-1 min-w-0 break-words leading-snug">{toast.message}</span>
      <button
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss"
        className="flex-shrink-0 -mr-1 p-0.5 text-text-muted hover:text-text-primary transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}
