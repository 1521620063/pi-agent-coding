// Wire types are local declarations, based on PI 1.5.2. No PI runtime is bundled.
export type JsonObject = { [key: string]: any };
export type PiRecord = JsonObject & { type: string };
export type RpcCommand = PiRecord & { id?: string };
export type ExtensionUiResponse = { type: 'extension_ui_response'; id: string } & ({ value: string } | { confirmed: boolean } | { cancelled: true });
export type ImageContent = { type: 'image'; data: string; mimeType: string };
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export interface Model { id: string; provider: string; name?: string; input: string[]; contextWindow?: number }
export interface SlashCommand { name: string; description?: string; source: 'extension' | 'prompt' | 'skill' }
export interface AgentMessage extends JsonObject { role: string; content: string | JsonObject[]; timestamp?: number }
export interface SessionStats extends JsonObject { cost?: number; tokens?: JsonObject; contextUsage?: { tokens: number | null; percent: number | null; contextWindow: number } }
export interface ExtensionUiRequest extends PiRecord { type: 'extension_ui_request'; id: string; method: string; timeout?: number }
export function isObject(value: unknown): value is JsonObject { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function parseRecord(value: unknown): PiRecord {
  if (!isObject(value) || typeof value.type !== 'string') throw new Error('Invalid PI record: expected an object with type');
  if (value.type === 'response' && (typeof value.command !== 'string' || typeof value.success !== 'boolean' || (value.id !== undefined && typeof value.id !== 'string'))) throw new Error('Invalid PI response');
  if (value.type === 'extension_ui_request' && (typeof value.id !== 'string' || typeof value.method !== 'string')) throw new Error('Invalid extension UI request');
  return value as PiRecord;
}
