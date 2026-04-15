import { useState, useEffect, useCallback } from "react";
import {
  Hammer,
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  FolderOpen,
  AlertCircle,
  ChevronRight,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAppStore } from "@/stores/appStore";

interface ScaffoldTemplate {
  id: string;
  name: string;
  description: string;
  requiredTool: string;
}

const TEMPLATES: ScaffoldTemplate[] = [
  { id: "react-vite", name: "React + Vite", description: "React 19 with TypeScript and Vite bundler", requiredTool: "node" },
  { id: "nextjs", name: "Next.js", description: "Next.js with TypeScript, pnpm, ESLint", requiredTool: "node" },
  { id: "node-express", name: "Node.js Express", description: "Express API server with JSON support", requiredTool: "node" },
  { id: "rust-cli", name: "Rust CLI", description: "Rust binary project via cargo init", requiredTool: "cargo" },
  { id: "python-fastapi", name: "Python FastAPI", description: "FastAPI server with uvicorn", requiredTool: "python" },
  { id: "blank", name: "Blank Project", description: "Empty project with README and .gitignore", requiredTool: "" },
];

interface ScaffoldResult {
  success: boolean;
  project_path: string;
  message: string;
}

export function ScaffoldView() {
  const [step, setStep] = useState(1);
  const [selectedTemplate, setSelectedTemplate] = useState<ScaffoldTemplate | null>(null);
  const [projectName, setProjectName] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [toolStatus, setToolStatus] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ScaffoldResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const projectPath = useLayoutStore((s) => s.projectPath);
  const setActiveView = useAppStore((s) => s.setActiveView);

  // Check available tools on mount
  useEffect(() => {
    invoke<Record<string, boolean>>("check_scaffold_tools")
      .then(setToolStatus)
      .catch(() => {});
  }, []);

  // Default output dir to project path
  useEffect(() => {
    if (projectPath && !outputDir) {
      setOutputDir(projectPath);
    }
  }, [projectPath, outputDir]);

  const handleScaffold = useCallback(async () => {
    if (!selectedTemplate || !projectName.trim() || !outputDir.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const res = await invoke<ScaffoldResult>("scaffold_project", {
        parentDir: outputDir,
        projectName: projectName.trim(),
        template: selectedTemplate.id,
      });
      setResult(res);
      setStep(3);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedTemplate, projectName, outputDir]);

  const handleOpenWorkspace = useCallback(() => {
    if (result?.project_path) {
      useLayoutStore.getState().setProjectPath(result.project_path);
      setActiveView("workspace");
    }
  }, [result, setActiveView]);

  const handleReset = useCallback(() => {
    setStep(1);
    setSelectedTemplate(null);
    setProjectName("");
    setResult(null);
    setError(null);
  }, []);

  const isToolAvailable = (tool: string) => {
    if (!tool) return true;
    return toolStatus[tool] ?? false;
  };

  const canProceedStep1 = selectedTemplate !== null;
  const canProceedStep2 = projectName.trim().length > 0 && outputDir.trim().length > 0;

  return (
    <div className="flex flex-col h-full bg-bg-primary overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-bg-border bg-bg-secondary shrink-0">
        <div className="flex items-center gap-2">
          <Hammer size={14} className="text-accent-blue" />
          <h2 className="text-sm font-medium text-text-primary">Scaffold</h2>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-text-muted">
          <StepIndicator step={1} current={step} label="Template" />
          <ChevronRight size={10} />
          <StepIndicator step={2} current={step} label="Configure" />
          <ChevronRight size={10} />
          <StepIndicator step={3} current={step} label="Result" />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {step === 1 && (
          <TemplateStep
            templates={TEMPLATES}
            selected={selectedTemplate}
            onSelect={setSelectedTemplate}
            isToolAvailable={isToolAvailable}
          />
        )}

        {step === 2 && selectedTemplate && (
          <ConfigStep
            template={selectedTemplate}
            projectName={projectName}
            onProjectNameChange={setProjectName}
            outputDir={outputDir}
            onOutputDirChange={setOutputDir}
            error={error}
            loading={loading}
          />
        )}

        {step === 3 && (
          <ResultStep
            result={result}
            error={error}
            onOpenWorkspace={handleOpenWorkspace}
            onReset={handleReset}
          />
        )}
      </div>

      {/* Footer navigation */}
      {step < 3 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-bg-border bg-bg-secondary shrink-0">
          <div>
            {step > 1 && (
              <button
                onClick={() => setStep(step - 1)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
              >
                <ArrowLeft size={12} />
                Back
              </button>
            )}
          </div>
          <div>
            {step === 1 && (
              <button
                onClick={() => setStep(2)}
                disabled={!canProceedStep1}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent-green/20 text-accent-green rounded hover:bg-accent-green/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next
                <ArrowRight size={12} />
              </button>
            )}
            {step === 2 && (
              <button
                onClick={handleScaffold}
                disabled={!canProceedStep2 || loading}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent-green/20 text-accent-green rounded hover:bg-accent-green/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {loading ? (
                  <>
                    <Loader2 size={12} className="animate-spin" />
                    Scaffolding...
                  </>
                ) : (
                  <>
                    <Hammer size={12} />
                    Create Project
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Step 1: Template selection ---------- */

function TemplateStep({
  templates,
  selected,
  onSelect,
  isToolAvailable,
}: {
  templates: ScaffoldTemplate[];
  selected: ScaffoldTemplate | null;
  onSelect: (t: ScaffoldTemplate) => void;
  isToolAvailable: (tool: string) => boolean;
}) {
  return (
    <div>
      <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wider mb-3">
        Choose a template
      </h3>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {templates.map((t) => {
          const available = isToolAvailable(t.requiredTool);
          const isSelected = selected?.id === t.id;
          return (
            <button
              key={t.id}
              onClick={() => onSelect(t)}
              disabled={!available}
              className={`flex flex-col items-start p-3 rounded-lg border text-left transition-all ${
                isSelected
                  ? "bg-accent-green/10 border-accent-green/40 ring-1 ring-accent-green/30"
                  : available
                    ? "bg-bg-secondary border-bg-border hover:border-text-muted"
                    : "bg-bg-secondary border-bg-border opacity-40 cursor-not-allowed"
              }`}
            >
              <div className="text-xs font-medium text-text-primary mb-1">{t.name}</div>
              <div className="text-[10px] text-text-muted leading-relaxed">{t.description}</div>
              {!available && t.requiredTool && (
                <div className="flex items-center gap-1 mt-2 text-[9px] text-red-400">
                  <AlertCircle size={10} />
                  {t.requiredTool} not found
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- Step 2: Configuration ---------- */

function ConfigStep({
  template,
  projectName,
  onProjectNameChange,
  outputDir,
  onOutputDirChange,
  error,
  loading,
}: {
  template: ScaffoldTemplate;
  projectName: string;
  onProjectNameChange: (v: string) => void;
  outputDir: string;
  onOutputDirChange: (v: string) => void;
  error: string | null;
  loading: boolean;
}) {
  return (
    <div className="max-w-md">
      <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wider mb-3">
        Configure — {template.name}
      </h3>

      <div className="space-y-4">
        <div>
          <label className="block text-[11px] text-text-secondary mb-1">Project Name</label>
          <input
            type="text"
            value={projectName}
            onChange={(e) => onProjectNameChange(e.target.value)}
            placeholder="my-project"
            disabled={loading}
            className="w-full px-3 py-2 text-xs bg-bg-secondary border border-bg-border rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-green/50"
          />
        </div>

        <div>
          <label className="flex items-center gap-1 text-[11px] text-text-secondary mb-1">
            <FolderOpen size={10} />
            Output Directory
          </label>
          <input
            type="text"
            value={outputDir}
            onChange={(e) => onOutputDirChange(e.target.value)}
            placeholder="/path/to/parent"
            disabled={loading}
            className="w-full px-3 py-2 text-xs bg-bg-secondary border border-bg-border rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-green/50"
          />
          <p className="text-[9px] text-text-muted mt-1">
            Project will be created at: {outputDir ? `${outputDir}/${projectName || "..."}` : "..."}
          </p>
        </div>
      </div>

      {error && (
        <div className="mt-4 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-400">
          {error}
        </div>
      )}
    </div>
  );
}

/* ---------- Step 3: Result ---------- */

function ResultStep({
  result,
  error,
  onOpenWorkspace,
  onReset,
}: {
  result: ScaffoldResult | null;
  error: string | null;
  onOpenWorkspace: () => void;
  onReset: () => void;
}) {
  if (error && !result) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center">
        <AlertCircle size={28} className="text-red-400 mb-3" />
        <p className="text-xs text-red-400 mb-1">Scaffold failed</p>
        <p className="text-[10px] text-text-muted max-w-md">{error}</p>
        <button
          onClick={onReset}
          className="mt-4 flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary border border-bg-border rounded-lg hover:border-text-muted transition-colors"
        >
          <ArrowLeft size={12} />
          Start Over
        </button>
      </div>
    );
  }

  if (!result) return null;

  return (
    <div className="flex flex-col items-center justify-center h-full text-center">
      {result.success ? (
        <>
          <Check size={28} className="text-accent-green mb-3" />
          <p className="text-sm font-medium text-text-primary mb-1">Project Created</p>
          <p className="text-[11px] text-text-muted mb-1">{result.message}</p>
          <p className="text-[10px] text-text-muted font-mono">{result.project_path}</p>
          <div className="flex items-center gap-3 mt-5">
            <button
              onClick={onOpenWorkspace}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent-green/20 text-accent-green rounded hover:bg-accent-green/30 transition-colors"
            >
              <FolderOpen size={12} />
              Open Workspace
            </button>
            <button
              onClick={onReset}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary border border-bg-border rounded-lg hover:border-text-muted transition-colors"
            >
              Create Another
            </button>
          </div>
        </>
      ) : (
        <>
          <AlertCircle size={28} className="text-red-400 mb-3" />
          <p className="text-sm font-medium text-text-primary mb-1">Scaffold Failed</p>
          <p className="text-[11px] text-text-muted max-w-md">{result.message}</p>
          <button
            onClick={onReset}
            className="mt-4 flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary border border-bg-border rounded-lg hover:border-text-muted transition-colors"
          >
            <ArrowLeft size={12} />
            Start Over
          </button>
        </>
      )}
    </div>
  );
}

/* ---------- Step indicator ---------- */

function StepIndicator({ step, current, label }: { step: number; current: number; label: string }) {
  const isActive = step === current;
  const isDone = step < current;
  return (
    <span
      className={`px-1.5 py-0.5 rounded ${
        isActive
          ? "bg-accent-green/20 text-accent-green font-medium"
          : isDone
            ? "text-accent-green"
            : "text-text-muted"
      }`}
    >
      {label}
    </span>
  );
}
