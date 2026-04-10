# Scaffold Plan

Last updated: 2026-04-09

## What Project Scaffolding Does Today

Project scaffolding is implemented across:

- `src/stores/scaffoldStore.ts`
- `src/modules/scaffold.ts`
- `src-tauri/src/commands/scaffold.rs`
- `src/components/views/ScaffoldView.tsx` (via module view)

The current flow:

1. User selects a template from the scaffold wizard
2. User configures project name and parent directory
3. `scaffoldStore.runScaffold()` calls `scaffoldProject(parentDir, projectName, selectedTemplate)`
4. The backend creates the project from the template
5. `checkScaffoldTools()` verifies the required CLI tools are available before scaffolding

The scaffold wizard has three steps: template selection, configuration, and result.

## What Works

- Three-step wizard UX is clear and navigable
- Pre-flight tool check prevents confusing failures mid-scaffold
- Template selection is separated from configuration
- The `ScaffoldResult` type captures both success and failure with a message

## What a Full Plan Would Cover

### Template Ecosystem

1. **Template discovery** — how do users find available templates? Is there a gallery, a search, or just the built-in list?
2. **Template contribution** — can users add their own templates? If so, how? If not, who maintains the built-in templates?
3. **Template versioning** — when a template is updated, do existing projects based on it get notified?
4. **Template categories** — organizing templates by type (web app, CLI tool, library, mobile, etc.) would help discovery

### Scaffold UX Improvements

5. **Scaffold into a workspace** — currently scaffolding creates a directory; it should be able to create a workspace with that project as its context
6. **Scaffold from GitHub URL** — allow providing a GitHub repo URL as a template source
7. **Scaffold preview** — show the files that would be created before running
8. **Scaffold rollback** — if scaffolding partially fails, clean up created files

### Tooling

9. **Tool availability as a first-class check** — `checkScaffoldTools` runs before scaffold but the UX for showing which tools are missing could be improved
10. **Tool installation prompts** — if a required tool is missing, offer to install it or show clear instructions

### Integration With Other Features

11. **Scaffold → flight** — after scaffolding, offer to create a flight for the new project
12. **Scaffold → workspace** — after scaffolding, offer to create a workspace bound to the new project
13. **Memory integration** — scaffold could run a memory scan on the new project automatically after creation

## Known Gaps

### 1. Template list is opaque

Users see template names but not descriptions, file previews, or categories. Choosing a template requires knowing what each one produces.

### 2. No way to add custom templates

There is no user-facing mechanism to add a template beyond whatever is built in.

### 3. Scaffold does not create a workspace

Scaffolding creates a project directory. It does not create a PacketCode workspace bound to that project. This means users scaffold a project and then have to manually create a workspace for it.

### 4. No scaffold → flight flow

After creating a new project, there is no prompt to create a flight to track work on it.

### 5. Template maintenance is unclear

Who adds new templates? Who updates existing ones when frameworks change? There is no process documented for template maintenance.

## Recommendation

This doc is currently a gap audit. A full plan is needed before significant scaffold work begins.

The most impactful single improvement would be: **scaffold → workspace**, so that creating a new project automatically sets up a PacketCode workspace bound to it, rather than requiring manual workspace creation afterward.

## Next Step

Audit what templates are currently available in `src-tauri/src/commands/scaffold.rs` and how they are defined, before planning any of the above improvements.
