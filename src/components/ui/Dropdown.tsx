import {
  useState,
  useRef,
  useEffect,
  useMemo,
  createContext,
  useContext,
  Children,
  isValidElement,
  type ReactNode,
  type ReactElement,
} from "react";
import { ChevronDown } from "lucide-react";

interface DropdownContextValue {
  close: () => void;
  filter: string;
}

const DropdownContext = createContext<DropdownContextValue>({
  close: () => {},
  filter: "",
});

interface DropdownProps {
  trigger: ReactNode;
  children: ReactNode;
  align?: "left" | "right";
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Imperative "open now" channel: incrementing this counter opens the
   * menu (e.g. the `/model` slash command targeting the header model
   * dropdown). Leave undefined for purely click-driven dropdowns. */
  openSignal?: number;
}

/**
 * Access the enclosing Dropdown's `close()` from arbitrary content rendered
 * inside it (e.g. a menu section that needs to close its parent after an
 * async action). Outside a Dropdown the context default `close` is a no-op —
 * deliberate, so tests can render menu section content bare.
 */
export function useDropdownClose(): () => void {
  return useContext(DropdownContext).close;
}

function stringifyChildren(node: ReactNode): string {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(stringifyChildren).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode } | undefined;
    return stringifyChildren(props?.children);
  }
  return "";
}

function isDropdownItemElement(node: ReactNode): node is ReactElement<DropdownItemProps> {
  return isValidElement(node) && node.type === DropdownItem;
}

export function Dropdown({
  trigger,
  children,
  align = "left",
  searchable = false,
  searchPlaceholder = "Search…",
  openSignal,
}: DropdownProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (openSignal !== undefined && openSignal > 0) setOpen(true);
  }, [openSignal]);
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Reset filter when menu closes; focus input when it opens
  useEffect(() => {
    if (!open) {
      setFilter("");
    } else if (searchable) {
      // defer focus until after the input is mounted
      const id = window.setTimeout(() => {
        searchInputRef.current?.focus();
      }, 0);
      return () => window.clearTimeout(id);
    }
  }, [open, searchable]);

  const normalizedFilter = filter.trim().toLowerCase();

  // Count visible DropdownItems so we can show an empty state.
  const visibleItemCount = useMemo(() => {
    if (!searchable || normalizedFilter === "") {
      // When no active filter, all items are visible by definition.
      let count = 0;
      Children.forEach(children, (child) => {
        if (isDropdownItemElement(child)) count += 1;
      });
      return count;
    }
    let count = 0;
    Children.forEach(children, (child) => {
      if (isDropdownItemElement(child)) {
        const text = stringifyChildren(child.props.children).toLowerCase();
        if (text.includes(normalizedFilter)) count += 1;
      }
    });
    return count;
  }, [children, searchable, normalizedFilter]);

  const contextValue = useMemo<DropdownContextValue>(
    () => ({
      close: () => setOpen(false),
      filter: searchable ? normalizedFilter : "",
    }),
    [searchable, normalizedFilter],
  );

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (filter !== "") {
        setFilter("");
      } else {
        setOpen(false);
      }
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2 py-1 text-ui text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
      >
        {trigger}
        <ChevronDown
          size={10}
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <DropdownContext.Provider value={contextValue}>
          <div
            className={`absolute top-full mt-1 ${align === "right" ? "right-0" : "left-0"} z-50 min-w-[160px] bg-bg-elevated border border-bg-border rounded-md shadow-xl py-1`}
          >
            {searchable && (
              <div className="px-1 pb-1">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder={searchPlaceholder}
                  className="w-full bg-bg-primary border border-bg-border text-ui px-2 py-1 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green rounded"
                />
              </div>
            )}
            {children}
            {searchable && normalizedFilter !== "" && visibleItemCount === 0 && (
              <div className="text-ui text-text-muted px-2 py-1">
                No matches
              </div>
            )}
          </div>
        </DropdownContext.Provider>
      )}
    </div>
  );
}

interface DropdownItemProps {
  onClick?: () => void;
  children: ReactNode;
}

export function DropdownItem({ onClick, children }: DropdownItemProps) {
  const { close, filter } = useContext(DropdownContext);
  const hidden = useMemo(() => {
    if (!filter) return false;
    const text = stringifyChildren(children).toLowerCase();
    return !text.includes(filter);
  }, [children, filter]);

  if (hidden) return null;

  return (
    <button
      onClick={() => {
        onClick?.();
        close();
      }}
      className="w-full text-left px-3 py-1.5 text-ui text-text-primary hover:bg-bg-hover transition-colors"
    >
      {children}
    </button>
  );
}
