import {
  BRIDGE_HOST,
  BRIDGE_PATH,
  BRIDGE_PORT,
  bridgeEventSchema,
  createEvent
} from "@codebridge/protocol";

type BridgeStatus = "offline" | "connecting" | "connected" | "unauthorized";

let socket: WebSocket | undefined;
let status: BridgeStatus = "offline";
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let pendingContext: { resolve: (value: any) => void; timer: ReturnType<typeof setTimeout>; requestId: string } | undefined;
let pendingProject: { resolve: (value: any) => void; timer: ReturnType<typeof setTimeout>; requestId: string } | undefined;
let pendingPair:
  | { resolve: (value: { success: boolean; message: string }) => void; timer: ReturnType<typeof setTimeout> }
  | undefined;

const endpoint = `ws://${BRIDGE_HOST}:${BRIDGE_PORT}${BRIDGE_PATH}`;

async function getToken(): Promise<string | undefined> {
  const result = await chrome.storage.local.get("sessionToken");
  return typeof result.sessionToken === "string" ? result.sessionToken : undefined;
}

function broadcastStatus(): void {
  chrome.runtime.sendMessage({ type: "BRIDGE_STATUS", status }).catch(() => undefined);
}

function setStatus(next: BridgeStatus): void {
  status = next;
  broadcastStatus();
}

function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 2500);
}

function connect(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  setStatus("connecting");

  try {
    socket = new WebSocket(endpoint);
  } catch {
    setStatus("offline");
    scheduleReconnect();
    return;
  }

  socket.onopen = async () => {
    const token = await getToken();
    if (token) {
      socket?.send(JSON.stringify(createEvent("AUTH_REQUEST", "browser", { token })));
    } else {
      setStatus("unauthorized");
    }

    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(createEvent("PING", "browser", { at: Date.now() })));
      }
    }, 20_000);
  };

  socket.onmessage = async (event) => {
    let raw: unknown;
    try {
      raw = JSON.parse(String(event.data));
    } catch {
      return;
    }

    const parsed = bridgeEventSchema.safeParse(raw);
    if (!parsed.success) return;

    const message = parsed.data;
    if (message.type === "AUTH_RESULT") {
      setStatus(message.payload.success === true ? "connected" : "unauthorized");
    }

    if (message.type === "CONTEXT_RESULT" && pendingContext && message.payload.requestId === pendingContext.requestId) {
      clearTimeout(pendingContext.timer);
      pendingContext.resolve({ success: true, context: message.payload.context });
      pendingContext = undefined;
    }

    if (message.type === "PROJECT_INTELLIGENCE_RESULT" && pendingProject && message.payload.requestId === pendingProject.requestId) {
      clearTimeout(pendingProject.timer);
      pendingProject.resolve({ success: true, result: { index: message.payload.index, query: message.payload.query, matches: message.payload.matches } });
      pendingProject = undefined;
    }

    if (message.type === "ERROR") {
      const errorMessage = String(message.payload.message ?? "Bridge request failed.");
      if (pendingContext) {
        clearTimeout(pendingContext.timer);
        pendingContext.resolve({ success: false, message: errorMessage });
        pendingContext = undefined;
      }
      if (pendingProject) {
        clearTimeout(pendingProject.timer);
        pendingProject.resolve({ success: false, message: errorMessage });
        pendingProject = undefined;
      }
    }

    if (message.type === "PAIR_RESULT" && pendingPair) {
      clearTimeout(pendingPair.timer);
      const success = message.payload.success === true;
      const token = message.payload.sessionToken;
      if (success && typeof token === "string") {
        await chrome.storage.local.set({ sessionToken: token });
        pendingPair.resolve({ success: true, message: "Paired successfully." });
      } else {
        pendingPair.resolve({ success: false, message: "Pairing code is invalid or expired." });
      }
      pendingPair = undefined;
      if (success) setStatus("connected");
    }
  };

  socket.onerror = () => setStatus("offline");
  socket.onclose = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    setStatus("offline");
    scheduleReconnect();
  };
}

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
connect();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_STATUS") {
    sendResponse({ status });
    return false;
  }

  if (message?.type === "PAIR_WITH_CODE") {
    const code = String(message.code ?? "").replace(/\s/g, "");
    if (!/^\d{6}$/.test(code)) {
      sendResponse({ success: false, message: "Enter a valid 6-digit pairing code." });
      return false;
    }

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      sendResponse({ success: false, message: "Bridge is offline. Start pairing from VS Code first." });
      return false;
    }

    if (pendingPair) {
      clearTimeout(pendingPair.timer);
      pendingPair.resolve({ success: false, message: "Pairing request replaced." });
    }

    const timer = setTimeout(() => {
      pendingPair?.resolve({ success: false, message: "Pairing timed out." });
      pendingPair = undefined;
    }, 10_000);

    pendingPair = {
      resolve: sendResponse,
      timer
    };

    socket.send(JSON.stringify(createEvent("PAIR_REQUEST", "browser", { code })));
    return true;
  }

  if (message?.type === "REQUEST_CONTEXT") {
    if (status !== "connected" || !socket || socket.readyState !== WebSocket.OPEN) {
      sendResponse({ success: false, message: "Connect to VS Code before sharing context." });
      return false;
    }
    if (pendingContext) {
      clearTimeout(pendingContext.timer);
      pendingContext.resolve({ success: false, message: "Previous context request was replaced." });
    }
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingContext?.resolve({ success: false, message: "VS Code did not respond to the context request." });
      pendingContext = undefined;
    }, 15_000);
    pendingContext = { resolve: sendResponse, timer, requestId };
    socket.send(JSON.stringify(createEvent("CONTEXT_REQUEST", "browser", {
      includeActiveFile: message.includeActiveFile === true,
      includeSelection: message.includeSelection !== false
    }, requestId)));
    return true;
  }

  if (message?.type === "REQUEST_PROJECT_INTELLIGENCE") {
    if (status !== "connected" || !socket || socket.readyState !== WebSocket.OPEN) {
      sendResponse({ success: false, message: "Connect to VS Code before analyzing the project." });
      return false;
    }
    if (pendingProject) {
      clearTimeout(pendingProject.timer);
      pendingProject.resolve({ success: false, message: "Previous project analysis request was replaced." });
    }
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingProject?.resolve({ success: false, message: "VS Code did not respond to project analysis." });
      pendingProject = undefined;
    }, 30_000);
    pendingProject = { resolve: sendResponse, timer, requestId };
    socket.send(JSON.stringify(createEvent("PROJECT_INTELLIGENCE_REQUEST", "browser", {
      query: typeof message.query === "string" ? message.query.slice(0, 500) : ""
    }, requestId)));
    return true;
  }

  if (message?.type === "SEND_CODE_PROPOSAL") {
    if (status !== "connected" || !socket || socket.readyState !== WebSocket.OPEN) {
      sendResponse({ success: false, message: "Connect CodeBridge to VS Code first." });
      return false;
    }
    const code = typeof message.code === "string" ? message.code : "";
    const language = typeof message.language === "string" ? message.language.slice(0, 40) : "plaintext";
    const source = typeof message.source === "string" ? message.source.slice(0, 80) : "browser-ai";
    if (!code.trim() || code.length > 200_000) {
      sendResponse({ success: false, message: "Code is empty or exceeds the 200 KB transfer limit." });
      return false;
    }
    socket.send(JSON.stringify(createEvent("AI_CODE_PROPOSAL", "browser", {
      code, language, source, title: typeof message.title === "string" ? message.title.slice(0, 160) : "AI code proposal"
    })));
    sendResponse({ success: true, message: "Code proposal sent to VS Code." });
    return false;
  }

  if (message?.type === "DISCONNECT") {
    chrome.storage.local.remove("sessionToken").then(() => {
      setStatus("unauthorized");
      sendResponse({ success: true });
    });
    return true;
  }

  return false;
});
