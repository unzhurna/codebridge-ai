/**
 * Provider adapters deliberately extract only an individual code block after
 * an explicit user click. They do not scrape entire conversations or prompts.
 */
function extractBlockText(element: HTMLElement): string {
  const codeElement = element.querySelector("code");
  if (codeElement) return codeElement.textContent ?? "";
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".codebridge-send-button").forEach((button) => button.remove());
  return clone.textContent ?? "";
}

type ProviderAdapter = {
  id: "chatgpt" | "gemini" | "claude";
  codeBlocks: string;
  codeText: (element: HTMLElement) => string;
  language: (element: HTMLElement) => string;
};

const adapters: ProviderAdapter[] = [
  {
    id: "chatgpt",
    codeBlocks: "pre",
    codeText: extractBlockText,
    language: (element) => languageFromClass(element.querySelector("code") ?? element)
  },
  {
    id: "gemini",
    codeBlocks: "pre, .code-block",
    codeText: extractBlockText,
    language: (element) => languageFromClass(element.querySelector("code") ?? element)
  },
  {
    id: "claude",
    codeBlocks: "pre",
    codeText: extractBlockText,
    language: (element) => languageFromClass(element.querySelector("code") ?? element)
  }
];

function languageFromClass(element: Element): string {
  const classes = [...element.classList, ...[...element.querySelectorAll("[class]")].flatMap((node) => [...node.classList])];
  const match = classes.join(" ").match(/(?:language-|lang-)([a-z0-9_+#.-]+)/i);
  return match?.[1] ?? "plaintext";
}

function activeAdapter(): ProviderAdapter | undefined {
  if (location.hostname === "chatgpt.com" || location.hostname === "chat.openai.com") return adapters[0];
  if (location.hostname === "gemini.google.com") return adapters[1];
  if (location.hostname === "claude.ai") return adapters[2];
  return undefined;
}

function injectButtons(): void {
  const adapter = activeAdapter();
  if (!adapter) return;
  document.querySelectorAll<HTMLElement>(adapter.codeBlocks).forEach((block) => {
    if (block.dataset.codebridgeReady === "true") return;
    const code = adapter.codeText(block).trim();
    if (!code) return;
    block.dataset.codebridgeReady = "true";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "codebridge-send-button";
    button.textContent = "↗ Open in VS Code";
    button.setAttribute("aria-label", "Send this code block to VS Code for diff review");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const currentCode = adapter.codeText(block).trim();
      button.disabled = true;
      button.textContent = "Sending…";
      chrome.runtime.sendMessage({
        type: "SEND_CODE_PROPOSAL",
        code: currentCode,
        language: adapter.language(block),
        source: adapter.id,
        title: `Code proposal from ${adapter.id}`
      }, (response) => {
        if (chrome.runtime.lastError || !response?.success) {
          button.textContent = "CodeBridge offline";
          button.title = chrome.runtime.lastError?.message ?? response?.message ?? "Could not send code.";
        } else {
          button.textContent = "✓ Sent to VS Code";
          button.title = "VS Code will ask you to choose a target and review the diff before applying.";
        }
        window.setTimeout(() => {
          button.disabled = false;
          button.textContent = "↗ Open in VS Code";
        }, 3500);
      });
    });

    // Keep the action visually separate from the provider's code content.
    block.style.position ||= "relative";
    block.appendChild(button);
  });
}

const style = document.createElement("style");
style.textContent = `
  .codebridge-send-button {
    display: block; margin: 8px 0 0 auto; padding: 6px 10px;
    border: 1px solid #5479d8; border-radius: 7px; background: #172b54;
    color: #dce7ff; font: 600 11px/1.2 system-ui, sans-serif; cursor: pointer;
    position: relative; z-index: 5;
  }
  .codebridge-send-button:hover { background: #23417b; }
  .codebridge-send-button:disabled { opacity: .65; cursor: wait; }
`;
document.documentElement.appendChild(style);

injectButtons();
const observer = new MutationObserver(() => injectButtons());
observer.observe(document.documentElement, { childList: true, subtree: true });
