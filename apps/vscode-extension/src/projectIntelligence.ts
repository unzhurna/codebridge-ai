import * as vscode from "vscode";
import path from "node:path";

const MAX_FILES = 500;
const MAX_FILE_BYTES = 256_000;
const MAX_TOTAL_BYTES = 4_000_000;
const MAX_RESULTS = 12;
const EXCLUDED = new Set([
  ".git", "node_modules", "vendor", "dist", "build", "coverage", ".next",
  ".turbo", ".venv", "venv", "__pycache__", ".idea", ".vscode"
]);
const SENSITIVE = /(^|\/)(\.env(?:\..*)?|.*\.(pem|key|p12|pfx|crt|cer)|id_rsa|id_ed25519|credentials(?:\.json)?|secrets?\.(json|ya?ml))$/i;
const RULE_FILES = ["AGENTS.md", "README.md", "CONTRIBUTING.md", ".github/copilot-instructions.md"];
const MANIFEST_FILES = ["package.json", "go.mod", "Cargo.toml", "pyproject.toml", "composer.json", "Gemfile", "pom.xml", "build.gradle"];

type SymbolEntry = { name: string; kind: string; line: number };
type FileEntry = { path: string; language: string; bytes: number; imports: string[]; symbols: SymbolEntry[]; text: string };
export type ProjectIndex = {
  generatedAt: string;
  workspace: string;
  technologies: string[];
  manifests: Array<{ path: string; summary: string }>;
  rules: Array<{ path: string; content: string }>;
  files: Array<Omit<FileEntry, "text">>;
  relationships: Array<{ from: string; to: string }>;
  limits: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number; indexedBytes: number; truncated: boolean };
};

function excluded(relative: string): boolean {
  const normalized = relative.replace(/\\/g, "/");
  return normalized.split("/").some((part) => EXCLUDED.has(part)) || SENSITIVE.test(normalized);
}

function languageFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact",
    ".go": "go", ".py": "python", ".php": "php", ".rs": "rust", ".java": "java",
    ".kt": "kotlin", ".rb": "ruby", ".cs": "csharp", ".vue": "vue", ".svelte": "svelte",
    ".json": "json", ".yml": "yaml", ".yaml": "yaml", ".md": "markdown", ".sql": "sql"
  };
  return map[ext] ?? "plaintext";
}

function extractImports(source: string, language: string): string[] {
  const found = new Set<string>();
  const patterns = language === "go"
    ? [/\bimport\s+"([^"]+)"/g, /"([^"\n]+)"/g]
    : [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, /@import\s+["']([^"']+)["']/g];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const value = match[1];
      if (value && (value.startsWith(".") || value.startsWith("@/"))) found.add(value);
      if (found.size >= 100) break;
    }
  }
  return [...found];
}

function extractSymbols(source: string): SymbolEntry[] {
  const patterns: Array<{ kind: string; regex: RegExp }> = [
    { kind: "class", regex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([\w$]+)/gm },
    { kind: "interface", regex: /^\s*(?:export\s+)?interface\s+([\w$]+)/gm },
    { kind: "type", regex: /^\s*(?:export\s+)?type\s+([\w$]+)/gm },
    { kind: "function", regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([\w$]+)/gm },
    { kind: "function", regex: /^\s*(?:export\s+)?(?:const|let)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^\n]*\)|[\w$]+)\s*=>/gm },
    { kind: "struct", regex: /^\s*type\s+([\w$]+)\s+struct\b/gm },
    { kind: "enum", regex: /^\s*(?:export\s+)?enum\s+([\w$]+)/gm }
  ];
  const entries: SymbolEntry[] = [];
  for (const { kind, regex } of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source)) !== null) {
      const name = match[1];
      if (name) entries.push({ name, kind, line: source.slice(0, match.index).split("\n").length });
    }
  }
  return entries.sort((a, b) => a.line - b.line).slice(0, 300);
}

function packageSummary(file: string, text: string): string {
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    if (file.endsWith("package.json")) {
      const deps = { ...((data.dependencies as object) ?? {}), ...((data.devDependencies as object) ?? {}) } as Record<string, unknown>;
      return JSON.stringify({ name: data.name, version: data.version, scripts: data.scripts, dependencies: Object.keys(deps).slice(0, 80) }, null, 2).slice(0, 12_000);
    }
  } catch { /* non-JSON manifest */ }
  return text.slice(0, 12_000);
}

export async function buildProjectIndex(): Promise<{ index: ProjectIndex; internalFiles: FileEntry[] }> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) throw new Error("Open a workspace folder before analyzing the project.");
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(workspace, "**/*"),
    "**/{.git,node_modules,vendor,dist,build,coverage,.next,.turbo,.venv,venv,__pycache__}/**",
    MAX_FILES + 100
  );
  const fileEntries: FileEntry[] = [];
  const manifests: ProjectIndex["manifests"] = [];
  const rules: ProjectIndex["rules"] = [];
  let indexedBytes = 0;
  let truncated = uris.length > MAX_FILES;

  for (const uri of uris.slice(0, MAX_FILES)) {
    const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
    if (excluded(relative)) continue;
    if (indexedBytes >= MAX_TOTAL_BYTES) { truncated = true; break; }
    let bytes: Uint8Array;
    try { bytes = await vscode.workspace.fs.readFile(uri); } catch { continue; }
    if (bytes.byteLength > MAX_FILE_BYTES) { truncated = true; continue; }
    if (indexedBytes + bytes.byteLength > MAX_TOTAL_BYTES) { truncated = true; break; }
    const text = new TextDecoder().decode(bytes);
    indexedBytes += bytes.byteLength;
    if (MANIFEST_FILES.includes(path.basename(relative))) manifests.push({ path: relative, summary: packageSummary(relative, text) });
    if (RULE_FILES.includes(relative)) rules.push({ path: relative, content: text.slice(0, 20_000) });
    if (/\.(ts|tsx|js|jsx|go|py|php|rs|java|kt|rb|cs|vue|svelte)$/.test(relative)) {
      const language = languageFor(relative);
      fileEntries.push({ path: relative, language, bytes: bytes.byteLength, imports: extractImports(text, language), symbols: extractSymbols(text), text });
    }
  }

  const paths = new Set(fileEntries.map((file) => file.path));
  const relationships: ProjectIndex["relationships"] = [];
  for (const file of fileEntries) {
    for (const specifier of file.imports) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), specifier));
      const candidates = [base, ...[".ts", ".tsx", ".js", ".jsx", ".go", ".py", ".php", ".rs", ".java", ".vue"].map((ext) => `${base}${ext}`), ...["index.ts", "index.tsx", "index.js"].map((name) => `${base}/${name}`)];
      const target = candidates.find((candidate) => paths.has(candidate));
      if (target) relationships.push({ from: file.path, to: target });
    }
  }

  const technologies = new Set<string>();
  for (const manifest of manifests) {
    const name = path.basename(manifest.path);
    if (name === "package.json") {
      try {
        const data = JSON.parse(manifest.summary) as { dependencies?: string[] };
        for (const dep of data.dependencies ?? []) technologies.add(dep);
      } catch { /* summary parsing is best-effort */ }
      technologies.add("Node.js");
    }
    if (name === "go.mod") technologies.add("Go");
    if (name === "composer.json") technologies.add("PHP / Composer");
    if (name === "pyproject.toml") technologies.add("Python");
    if (name === "Cargo.toml") technologies.add("Rust");
    if (name === "pom.xml" || name === "build.gradle") technologies.add("JVM");
  }
  for (const file of fileEntries) technologies.add(file.language);

  const index: ProjectIndex = {
    generatedAt: new Date().toISOString(),
    workspace: workspace.name,
    technologies: [...technologies].sort().slice(0, 100),
    manifests,
    rules,
    files: fileEntries.map(({ text: _text, ...metadata }) => metadata),
    relationships,
    limits: { maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES, indexedBytes, truncated }
  };
  return { index, internalFiles: fileEntries };
}

export function searchProjectIndex(indexed: FileEntry[], query: string, limit = MAX_RESULTS) {
  const terms = query.toLowerCase().split(/[^a-z0-9_$.-]+/).filter((term) => term.length > 1).slice(0, 20);
  if (!terms.length) return [];
  return indexed.map((file) => {
    const haystack = `${file.path} ${file.imports.join(" ")} ${file.symbols.map((symbol) => `${symbol.kind} ${symbol.name}`).join(" ")} ${file.text}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (file.path.toLowerCase().includes(term)) score += 8;
      for (const symbol of file.symbols) if (symbol.name.toLowerCase().includes(term)) score += 6;
      if (file.imports.some((item) => item.toLowerCase().includes(term))) score += 3;
      const occurrences = haystack.split(term).length - 1;
      score += Math.min(occurrences, 8);
    }
    return { path: file.path, language: file.language, score, excerpt: file.text.slice(0, 2_000), symbols: file.symbols.slice(0, 40) };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(limit, MAX_RESULTS)));
}

export async function analyzeAndShow(): Promise<ProjectIndex> {
  const { index } = await buildProjectIndex();
  const summary = [
    `# Project Intelligence: ${index.workspace}`,
    `Generated: ${index.generatedAt}`,
    `Files indexed: ${index.files.length}${index.limits.truncated ? " (index truncated by safety limits)" : ""}`,
    `Indexed bytes: ${index.limits.indexedBytes}`,
    `Technologies: ${index.technologies.join(", ") || "Not detected"}`,
    "",
    "## Manifests",
    ...index.manifests.map((item) => `- ${item.path}`),
    "",
    "## Project rules",
    ...index.rules.map((item) => `- ${item.path}`),
    "",
    "## Top-level file index",
    ...index.files.slice(0, 100).map((item) => `- ${item.path} (${item.language}; ${item.symbols.length} symbols; ${item.imports.length} local imports)`),
    "",
    `## Relationships (${index.relationships.length})`,
    ...index.relationships.slice(0, 100).map((item) => `- ${item.from} → ${item.to}`)
  ].join("\n");
  const document = await vscode.workspace.openTextDocument({ language: "markdown", content: summary });
  await vscode.window.showTextDocument(document, { preview: true });
  return index;
}
