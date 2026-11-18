# Provider orchestration boundary

CodeBridge supports a provider-neutral workflow contract, but v0.6.0 deliberately does not automate private web-chat APIs or scrape entire conversations. ChatGPT, Gemini, and Claude remain browser-side user-mediated adapters: the developer explicitly selects/copies a prompt, context, or code proposal.

A future provider adapter should implement a narrow interface:

```ts
export interface ProviderAdapter {
  readonly id: "chatgpt" | "gemini" | "claude";
  canHandle(url: URL): boolean;
  extractSelectedResponse(selection: string): { text: string; codeBlocks: string[] };
  buildContextPrompt(input: { instruction: string; context: string }): string;
}
```

The adapter must not silently read unrelated chat history, upload workspace contents without confirmation, or bypass provider access controls. Browser DOM selectors are volatile and must be isolated per provider with graceful failure behavior.
