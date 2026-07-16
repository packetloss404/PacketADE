import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import { Copy, Check } from "lucide-react";

SyntaxHighlighter.registerLanguage("typescript", typescript);
SyntaxHighlighter.registerLanguage("ts", typescript);
SyntaxHighlighter.registerLanguage("tsx", tsx);
SyntaxHighlighter.registerLanguage("javascript", javascript);
SyntaxHighlighter.registerLanguage("js", javascript);
SyntaxHighlighter.registerLanguage("jsx", jsx);
SyntaxHighlighter.registerLanguage("python", python);
SyntaxHighlighter.registerLanguage("py", python);
SyntaxHighlighter.registerLanguage("rust", rust);
SyntaxHighlighter.registerLanguage("rs", rust);
SyntaxHighlighter.registerLanguage("go", go);
SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("sh", bash);
SyntaxHighlighter.registerLanguage("sql", sql);
SyntaxHighlighter.registerLanguage("css", css);
SyntaxHighlighter.registerLanguage("markdown", markdown);

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

interface CodeBlockProps {
  language: string;
  value: string;
}

function CodeBlock({ language, value }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div className="relative group my-2">
      <button
        type="button"
        onClick={handleCopy}
        className="absolute top-2 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity bg-bg-secondary border border-bg-border rounded px-1.5 py-1 text-text-secondary hover:text-text-primary"
        aria-label="Copy code"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      <SyntaxHighlighter
        language={language}
        style={oneDark}
        customStyle={{
          margin: 0,
          fontSize: "11px",
          borderRadius: "4px",
        }}
        PreTag="div"
      >
        {value.replace(/\n$/, "")}
      </SyntaxHighlighter>
    </div>
  );
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  const classes = ["selectable markdown-content", className]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props) {
            const { className, children, ...rest } = props;
            const match = /language-(\w+)/.exec(className || "");
            const isBlock = !!match;
            const codeText = String(children ?? "");

            if (!isBlock) {
              return (
                <code
                  {...rest}
                  className="bg-bg-secondary px-1 rounded font-mono text-[11px]"
                >
                  {children}
                </code>
              );
            }

            return <CodeBlock language={match[1]} value={codeText} />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
