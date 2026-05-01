interface IssueBodyProps {
  body: string | null | undefined;
}

export function IssueBody({ body }: IssueBodyProps) {
  if (!body || !body.trim()) {
    return <p className="m-0 text-[11px] text-text-muted">No description.</p>;
  }
  const lines = body.split("\n");
  return (
    <div className="text-[11px] text-text-secondary leading-relaxed">
      {lines.map((line, i) => {
        if (!line.trim()) {
          return <div key={i} className="h-1.5" />;
        }
        if (line.startsWith("## ")) {
          return (
            <div
              key={i}
              className={`text-[11.5px] font-semibold text-text-primary mb-1 ${
                i === 0 ? "" : "mt-2"
              }`}
            >
              {line.slice(3)}
            </div>
          );
        }
        if (line.startsWith("# ")) {
          return (
            <div
              key={i}
              className={`text-xs font-semibold text-text-primary mb-1 ${
                i === 0 ? "" : "mt-2"
              }`}
            >
              {line.slice(2)}
            </div>
          );
        }
        const orderedMatch = line.match(/^(\d+)\.\s+(.*)$/);
        if (orderedMatch) {
          return (
            <div key={i} className="pl-4 mb-0.5">
              <span className="text-text-muted">{orderedMatch[1]}.</span>
              <span> {renderInline(orderedMatch[2])}</span>
            </div>
          );
        }
        if (/^[-*]\s+/.test(line)) {
          return (
            <div key={i} className="pl-4 mb-0.5">
              <span className="text-text-muted">·</span>
              <span> {renderInline(line.replace(/^[-*]\s+/, ""))}</span>
            </div>
          );
        }
        return (
          <div key={i} className="mb-0.5">
            {renderInline(line)}
          </div>
        );
      })}
    </div>
  );
}

function renderInline(text: string) {
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((p, j) => {
    if (p.startsWith("`") && p.endsWith("`")) {
      return (
        <span
          key={j}
          className="font-mono text-[10.5px] bg-bg-tertiary text-text-primary px-1.5 rounded"
        >
          {p.slice(1, -1)}
        </span>
      );
    }
    return <span key={j}>{p.replace(/\*\*([^*]+)\*\*/g, "$1")}</span>;
  });
}
