import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Status = "offline" | "connecting" | "connected" | "unauthorized";
type ProjectIntelligence = { workspace: string; generatedAt: string; technologies: string[]; manifests: Array<{ path: string; summary: string }>; rules: Array<{ path: string; content: string }>; files: Array<{ path: string; language: string; symbols: Array<{ name: string; kind: string; line: number }> }>; relationships: Array<{ from: string; to: string }>; limits: { maxFiles: number; indexedBytes: number; truncated: boolean } };
type WorkspaceContext = {
  workspaceName: string; rootName: string; activeFile?: string; selection?: string;
  activeFileContent?: { path: string; language: string; content: string; truncated: boolean };
  files: string[]; generatedAt: string; limits: { maxFileChars: number; maxTreeEntries: number };
};

function App() {
  const [status, setStatus] = useState<Status>("connecting");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [includeActiveFile, setIncludeActiveFile] = useState(false);
  const [includeSelection, setIncludeSelection] = useState(true);
  const [context, setContext] = useState<WorkspaceContext | undefined>();
  const [busy, setBusy] = useState(false);
  const [project, setProject] = useState<ProjectIntelligence | undefined>();
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Array<{ path: string; language: string; score: number; excerpt: string; symbols: Array<{ name: string; kind: string; line: number }> }>>([]);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_STATUS" }, (response) => {
      if (response?.status) setStatus(response.status as Status);
    });
    const listener = (event: { type?: string; status?: Status }) => {
      if (event.type === "BRIDGE_STATUS" && event.status) setStatus(event.status);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const pair = () => {
    setMessage("Connecting...");
    chrome.runtime.sendMessage({ type: "PAIR_WITH_CODE", code }, (response) => {
      if (chrome.runtime.lastError) { setMessage(chrome.runtime.lastError.message ?? "Could not contact service worker."); return; }
      setMessage(response?.message ?? "No response from bridge.");
      if (response?.success) { setStatus("connected"); setCode(""); }
    });
  };

  const requestContext = () => {
    setBusy(true); setMessage("Reading approved workspace metadata..."); setContext(undefined);
    chrome.runtime.sendMessage({ type: "REQUEST_CONTEXT", includeActiveFile, includeSelection }, (response) => {
      setBusy(false);
      if (chrome.runtime.lastError) { setMessage(chrome.runtime.lastError.message ?? "Context request failed."); return; }
      if (!response?.success) { setMessage(response?.message ?? "Context request failed."); return; }
      setContext(response.context as WorkspaceContext);
      setMessage("Context preview is ready. Review it before sharing with an AI chat.");
    });
  };

  const analyzeProject = () => {
    setBusy(true); setMessage("Analyzing project locally..."); setProject(undefined); setMatches([]);
    chrome.runtime.sendMessage({ type: "REQUEST_PROJECT_INTELLIGENCE", query }, (response) => {
      setBusy(false);
      if (chrome.runtime.lastError) { setMessage(chrome.runtime.lastError.message ?? "Project analysis failed."); return; }
      if (!response?.success) { setMessage(response?.message ?? "Project analysis failed."); return; }
      setProject(response.result.index as ProjectIntelligence);
      setMatches(response.result.matches ?? []);
      setMessage("Project intelligence is ready. Review the metadata before copying it.");
    });
  };

  const disconnect = () => {
    chrome.runtime.sendMessage({ type: "DISCONNECT" }, () => {
      setMessage("Local session token removed."); setStatus("unauthorized"); setContext(undefined);
    });
  };

  const statusLabel = { offline: "Bridge offline", connecting: "Connecting", connected: "Connected", unauthorized: "Pairing required" }[status];
  const preview = context ? JSON.stringify(context, null, 2) : "";
  return <main className="app">
    <header className="header"><div className="brand-mark">CB</div><div><h1>CodeBridge <span>AI</span></h1><p>Browser ↔ VS Code</p></div><div className={`status-dot ${status}`} title={statusLabel} /></header>
    <section className="connection-card"><div className="eyebrow">LOCAL BRIDGE</div><div className="status-row"><strong>{statusLabel}</strong><span className={`pill ${status}`}>{status}</span></div><p>127.0.0.1:47831</p></section>
    {status !== "connected" ? <section className="pairing"><label htmlFor="pairing-code">Pairing code</label><input id="pairing-code" inputMode="numeric" maxLength={6} placeholder="Enter 6-digit code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}/><button disabled={code.length !== 6 || status === "offline"} onClick={pair}>Connect to VS Code</button><p className="hint">In VS Code, run “CodeBridge: Start Pairing” first.</p></section> : <>
      <section className="context-panel"><div className="eyebrow">CONTEXT SHARING</div><h2>Share workspace context</h2><p className="hint">Select what CodeBridge may read. Nothing is sent until you review the preview and copy it.</p>
        <label className="check"><input type="checkbox" checked={includeSelection} onChange={(e) => setIncludeSelection(e.target.checked)}/> Selected code from active editor</label>
        <label className="check"><input type="checkbox" checked={includeActiveFile} onChange={(e) => setIncludeActiveFile(e.target.checked)}/> Entire active file <span className="muted">(up to 120 KB)</span></label>
        <button disabled={busy} onClick={requestContext}>{busy ? "Preparing preview…" : "Generate context preview"}</button>
        <p className="hint">File tree is metadata only. Secrets, .env files, dependencies and build output are excluded.</p>
      </section>
      <section className="context-panel"><div className="eyebrow">PROJECT INTELLIGENCE</div><h2>Understand this project</h2><p className="hint">Analyze source metadata, imports, symbols, manifests and project rules locally. Source file contents are not included in the index response.</p><label htmlFor="project-query">Optional context search</label><input id="project-query" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. authentication service"/><button disabled={busy} onClick={analyzeProject}>{busy ? "Analyzing…" : "Analyze project"}</button></section>
      {project && <section className="preview"><div className="preview-heading"><strong>{project.workspace}</strong><span>{project.files.length} source files</span></div><p className="hint">Technologies: {project.technologies.join(", ") || "Not detected"}</p><p className="hint">{project.relationships.length} local import relationships · {(project.limits.indexedBytes / 1024).toFixed(1)} KB indexed{project.limits.truncated ? " · Index truncated by safety limits" : ""}</p><h3>Project rules</h3>{project.rules.map((rule) => <p className="hint" key={rule.path}>{rule.path}</p>)}<h3>Search matches</h3>{matches.map((match) => <div key={match.path} className="match"><strong>{match.path}</strong><p className="hint">Score {match.score} · {match.language}</p><pre>{match.symbols.slice(0, 8).map((symbol) => `${symbol.kind} ${symbol.name} · line ${symbol.line}`).join("\n") || match.excerpt}</pre></div>)}<button onClick={() => { navigator.clipboard.writeText(JSON.stringify(project, null, 2)).then(() => setMessage("Project index copied. Review before sharing with AI.")); }}>Copy project index</button><button className="secondary" onClick={() => { setProject(undefined); setMatches([]); }}>Clear project preview</button></section>}
      {context && <section className="preview"><div className="preview-heading"><strong>{context.workspaceName}</strong><span>{context.files.length} files</span></div><p className="hint">Active: {context.activeFile ?? "None"}</p>{context.selection && <p className="hint">Selected code: {context.selection.length.toLocaleString()} characters</p>}{context.activeFileContent?.truncated && <p className="warning">Active file was truncated to the configured size limit.</p>}<pre>{preview}</pre><button onClick={() => { navigator.clipboard.writeText(preview).then(() => setMessage("Context JSON copied. Paste it into your AI chat.")); }}>Copy context JSON</button><button className="secondary" onClick={() => setContext(undefined)}>Clear preview</button></section>}
      <section className="connected"><button className="secondary" onClick={disconnect}>Disconnect</button></section>
    </>}
    {message && <div className="message" role="status">{message}</div>}
    <footer>CodeBridge AI · v0.9.0 · Local-first</footer>
  </main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
