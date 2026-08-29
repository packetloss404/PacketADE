/**
 * Static documentation site builder.
 *
 * Renders the Markdown in `docs/src/` into standalone HTML pages in `docs/`,
 * wrapped in a shared shell: left sidebar navigation, an on-this-page table of
 * contents, client-side search, and a light/dark theme toggle.
 *
 * Markdown in, static HTML out. There is no runtime dependency and no server —
 * GitHub Pages serves the result directly — while the content stays diffable in
 * review rather than buried in markup.
 *
 * Usage: `node scripts/build-docs.mjs` (or `pnpm docs:build`).
 */
import { marked } from "marked";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "docs", "src");
const OUT = join(ROOT, "docs", "guide");

/** Site-wide values the shell interpolates. */
const SITE = {
  name: "PacketBench",
  tagline: "Local-first desktop Agent Development Environment",
  repo: "https://github.com/packetloss404/PacketADE",
};

// ---------------------------------------------------------------- navigation

/**
 * The sidebar, in order. `page` is the Markdown basename under `docs/src/`
 * and becomes `<page>.html` at the site root.
 */
const NAV = JSON.parse(readFileSync(join(SRC, "nav.json"), "utf8"));

function allPages() {
  return NAV.flatMap((group) => group.pages);
}

// ------------------------------------------------------------------ markdown

/** Slug used for heading anchors and the on-this-page list. */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * Render one page's Markdown, collecting its h2/h3 headings for the
 * on-this-page rail as a side effect.
 */
function renderMarkdown(md) {
  const headings = [];
  const renderer = new marked.Renderer();

  renderer.heading = function ({ tokens, depth }) {
    const text = this.parser.parseInline(tokens);
    const id = slugify(text);
    if (depth === 2 || depth === 3) headings.push({ id, text, depth });
    return `<h${depth} id="${id}">${text}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>\n`;
  };

  // Fenced blocks get a language label and a copy button.
  renderer.code = function ({ text, lang }) {
    const language = (lang || "").split(/\s+/)[0];
    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<div class="code-block"${language ? ` data-lang="${language}"` : ""}>
<button class="copy" type="button" aria-label="Copy code">Copy</button>
<pre><code>${escaped}</code></pre>
</div>\n`;
  };

  // Blockquotes opening with **Note:** / **Warning:** / **Tip:** become callouts.
  renderer.blockquote = function ({ tokens }) {
    const body = this.parser.parse(tokens);
    const match = body.match(/^\s*<p><strong>(Note|Warning|Tip|Important):<\/strong>/i);
    if (!match) return `<blockquote>${body}</blockquote>\n`;
    const kind = match[1].toLowerCase();
    const stripped = body.replace(/<strong>(Note|Warning|Tip|Important):<\/strong>\s*/i, "");
    return `<div class="callout ${kind}"><div class="callout-title">${match[1]}</div>${stripped}</div>\n`;
  };

  const html = marked.parse(md, { renderer, gfm: true, breaks: false });
  return { html, headings };
}

/** Strip frontmatter-ish leading metadata: `# Title` plus an optional lead line. */
function splitTitle(md, fallback) {
  const m = md.match(/^#\s+(.+)$/m);
  const title = m ? m[1].trim() : fallback;
  return { title, body: md };
}

/** Plain text for the search index, with markup and code fences removed. */
function searchText(md) {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --------------------------------------------------------------------- shell

function sidebar(current) {
  return NAV.map((group) => {
    const items = group.pages
      .map((p) => {
        const active = p.page === current ? ' class="active"' : "";
        return `<li><a href="${p.page}.html"${active}>${p.title}</a></li>`;
      })
      .join("\n");
    return `<div class="nav-group"><div class="nav-group-title">${group.group}</div><ul>${items}</ul></div>`;
  }).join("\n");
}

function tocList(headings) {
  if (headings.length === 0) return "";
  const items = headings
    .map((h) => `<li class="d${h.depth}"><a href="#${h.id}">${h.text}</a></li>`)
    .join("\n");
  return `<nav class="toc" aria-label="On this page"><div class="toc-title">On this page</div><ul>${items}</ul></nav>`;
}

function prevNext(current) {
  const pages = allPages();
  const i = pages.findIndex((p) => p.page === current);
  const prev = i > 0 ? pages[i - 1] : null;
  const next = i >= 0 && i < pages.length - 1 ? pages[i + 1] : null;
  if (!prev && !next) return "";
  const l = prev
    ? `<a class="pn prev" href="${prev.page}.html"><span>Previous</span><strong>${prev.title}</strong></a>`
    : "<span></span>";
  const r = next
    ? `<a class="pn next" href="${next.page}.html"><span>Next</span><strong>${next.title}</strong></a>`
    : "<span></span>";
  return `<div class="prev-next">${l}${r}</div>`;
}

function shell({ title, description, content, toc, current }) {
  const fullTitle = current === "index" ? `${SITE.name} Docs` : `${title} — ${SITE.name} Docs`;
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${fullTitle}</title>
<meta name="description" content="${description.replace(/"/g, "&quot;")}" />
<link rel="icon" href="../icon-192.png" />
<link rel="stylesheet" href="assets/docs.css" />
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="topbar">
  <button class="menu-toggle" aria-label="Toggle navigation" aria-expanded="false">☰</button>
  <a class="brand" href="index.html"><img src="../icon-192.png" alt="" width="24" height="24" /><span>${SITE.name}</span><span class="brand-sub">Docs</span></a>
  <div class="search-wrap">
    <input id="search" type="search" placeholder="Search documentation…" autocomplete="off" aria-label="Search documentation" />
    <div id="search-results" role="listbox" hidden></div>
  </div>
  <nav class="topbar-links">
    <a href="../index.html">Site</a>
    <a href="${SITE.repo}" target="_blank" rel="noopener">GitHub</a>
    <button class="theme-toggle" type="button" aria-label="Toggle theme">◐</button>
  </nav>
</header>
<div class="layout">
  <aside class="sidebar" aria-label="Documentation navigation">${sidebar(current)}</aside>
  <main id="main" class="content">
    <article class="prose">${content}</article>
    ${prevNext(current)}
  </main>
  ${toc}
</div>
<script src="assets/docs.js"></script>
</body>
</html>
`;
}

// --------------------------------------------------------------------- build

function build() {
  mkdirSync(OUT, { recursive: true });
  const pages = allPages();
  const index = [];
  let built = 0;

  for (const entry of pages) {
    const srcPath = join(SRC, `${entry.page}.md`);
    let md;
    try {
      md = readFileSync(srcPath, "utf8");
    } catch {
      console.warn(`[docs] MISSING ${relative(ROOT, srcPath)} — skipped`);
      continue;
    }
    const { title } = splitTitle(md, entry.title);
    const { html, headings } = renderMarkdown(md);
    const description = entry.description || `${title} — ${SITE.name} documentation.`;

    writeFileSync(
      join(OUT, `${entry.page}.html`),
      shell({
        title,
        description,
        content: html,
        toc: tocList(headings),
        current: entry.page,
      }),
      "utf8",
    );

    index.push({
      page: `${entry.page}.html`,
      title,
      group: NAV.find((g) => g.pages.some((p) => p.page === entry.page))?.group ?? "",
      headings: headings.map((h) => ({ id: h.id, text: h.text })),
      text: searchText(md).slice(0, 12000),
    });
    built += 1;
  }

  mkdirSync(join(OUT, "assets"), { recursive: true });
  writeFileSync(join(OUT, "assets", "search-index.json"), JSON.stringify(index), "utf8");
  console.log(`[docs] built ${built}/${pages.length} pages + search index`);
  if (built !== pages.length) {
    console.warn(`[docs] ${pages.length - built} page(s) declared in nav.json have no Markdown yet`);
  }
}

build();
