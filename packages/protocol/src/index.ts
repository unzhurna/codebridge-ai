import { z } from "zod";

export const PROTOCOL_VERSION = "1.0" as const;
export const BRIDGE_HOST = "127.0.0.1" as const;
export const BRIDGE_PORT = 47831;
export const BRIDGE_PATH = "/bridge" as const;

export const eventTypes = [
  "PAIR_REQUEST",
  "PAIR_RESULT",
  "AUTH_REQUEST",
  "AUTH_RESULT",
  "PING",
  "PONG",
  "CONTEXT_REQUEST",
  "CONTEXT_RESULT",
  "AI_CODE_PROPOSAL",
  "AI_CODE_RESULT",
  "PROPOSAL_RESULT",
  "PROJECT_INTELLIGENCE_REQUEST",
  "PROJECT_INTELLIGENCE_RESULT",
  "WORKFLOW_CREATE",
  "WORKFLOW_RESULT",
  "WORKFLOW_UPDATE",
  "AGENT_RUN_START",
  "AGENT_RUN_STOP",
  "AGENT_STATUS",
  "AGENT_TOOL_REQUEST",
  "AGENT_TOOL_RESULT",
  "AGENT_APPROVAL_RESULT",
  "AGENT_SESSION_LIST",
  "AGENT_AUDIT_LOG",
  "ERROR"
] as const;

export const bridgeEventSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1).max(128),
  type: z.enum(eventTypes),
  timestamp: z.number().int().nonnegative(),
  source: z.enum(["browser", "vscode"]),
  payload: z.record(z.string(), z.unknown())
});

export type BridgeEventType = (typeof eventTypes)[number];
export type BridgeEvent = z.infer<typeof bridgeEventSchema>;

export function createEvent<T extends Record<string, unknown>>(
  type: BridgeEventType,
  source: "browser" | "vscode",
  payload: T,
  id = crypto.randomUUID()
): BridgeEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    id,
    type,
    timestamp: Date.now(),
    source,
    payload
  };
}
