import { Schema } from "effect";
import type { ProviderModelCapability } from "./model-providers.ts";

/** The path an OpenAI-compatible server serves its API from, Ollama included. */
export const OPENAI_COMPATIBLE_PATH = "/v1";

export const providerPresetIdSchema = Schema.Literals([
	"anthropic",
	"openai",
	"chatgpt",
	"openrouter",
	"gemini",
	"groq",
	"xai",
	"mistral",
	"deepseek",
	"together",
	"fireworks",
	"cerebras",
	"ollama",
	"lmstudio",
	"llamacpp",
	"vllm",
]);
export type ProviderPresetId = typeof providerPresetIdSchema.Type;

/**
 * The dialects the API speaks: a provider's variation on its protocol, such as
 * how it lists models. Code lives in the API; a preset only names the one it
 * is read in. `openai-compatible` is the plain protocol and what a custom
 * OpenAI-format endpoint gets.
 */
export const providerDialectIdSchema = Schema.Literals([
	"openai-compatible",
	"anthropic",
	"openrouter",
	"ollama",
	"chatgpt",
]);
export type ProviderDialectId = typeof providerDialectIdSchema.Type;

export interface StarterModel {
	modelId: string;
	displayName: string;
	capabilities: ProviderModelCapability[];
	contextLength: number;
}

/**
 * One entry in the catalog: the defaults and the face of a provider we know
 * about. A preset is data and nothing else. What a workspace configures from
 * it — its own key, perhaps its own URL — is a provider.
 *
 * `hosting` says where the server usually is. A remote preset is a service
 * with a fixed address that wants a key; a local one is something you run
 * yourself, so its address is the interesting field and a key is unusual.
 */
export interface ProviderPreset {
	id: ProviderPresetId;
	name: string;
	baseUrl: string;
	apiFormat: "openai" | "anthropic";
	/** How the API reads this provider; see `ProviderDialectId`. */
	dialect: ProviderDialectId;
	hosting: "remote" | "local";
	/**
	 * What the provider needs before it answers: an API key, nothing (a key
	 * is optional), or a person signing in with their ChatGPT subscription.
	 */
	credential: "api-key" | "optional" | "chatgpt-sign-in";
	/** One line for the picker: what this is, or where the key comes from. */
	hint: string;
	/** Models worth offering before discovery has run, if the API lists none. */
	models: StarterModel[];
}

const local = (port: number) => `http://127.0.0.1:${port}${OPENAI_COMPATIBLE_PATH}`;

export const providerCatalog: readonly ProviderPreset[] = [
	{
		id: "anthropic",
		name: "Anthropic",
		baseUrl: "https://api.anthropic.com",
		apiFormat: "anthropic",
		dialect: "anthropic",
		hosting: "remote",
		credential: "api-key",
		hint: "Claude models. Keys are issued at console.anthropic.com.",
		models: [
			{
				modelId: "claude-opus-4",
				displayName: "Claude Opus 4.1",
				capabilities: ["tools", "vision"],
				contextLength: 200_000,
			},
			{
				modelId: "claude-sonnet-4-20250514",
				displayName: "Claude Sonnet 4",
				capabilities: ["tools", "vision"],
				contextLength: 200_000,
			},
			{
				modelId: "claude-3-5-haiku-20241022",
				displayName: "Claude 3.5 Haiku",
				capabilities: ["tools", "vision"],
				contextLength: 200_000,
			},
		],
	},
	{
		id: "openai",
		name: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		apiFormat: "openai",
		dialect: "openai-compatible",
		hosting: "remote",
		credential: "api-key",
		hint: "GPT models. Keys are issued at platform.openai.com.",
		models: [
			{
				modelId: "gpt-5",
				displayName: "GPT-5",
				capabilities: ["tools", "vision", "images"],
				contextLength: 400_000,
			},
			{
				modelId: "gpt-5-mini",
				displayName: "GPT-5 mini",
				capabilities: ["tools", "vision", "images"],
				contextLength: 400_000,
			},
			{
				modelId: "gpt-5-nano",
				displayName: "GPT-5 nano",
				capabilities: ["tools", "vision", "images"],
				contextLength: 400_000,
			},
		],
	},
	{
		id: "chatgpt",
		name: "ChatGPT",
		baseUrl: "https://chatgpt.com/backend-api/codex",
		apiFormat: "openai",
		dialect: "chatgpt",
		hosting: "remote",
		credential: "chatgpt-sign-in",
		hint: "GPT models on your ChatGPT Plus or Pro plan, signed in the way Codex CLI does. Unofficial.",
		models: [],
	},
	{
		id: "openrouter",
		name: "OpenRouter",
		baseUrl: "https://openrouter.ai/api/v1",
		apiFormat: "openai",
		dialect: "openrouter",
		hosting: "remote",
		credential: "api-key",
		hint: "Many providers' models behind one key, issued at openrouter.ai.",
		models: [],
	},
	{
		id: "gemini",
		name: "Google Gemini",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
		apiFormat: "openai",
		dialect: "openai-compatible",
		hosting: "remote",
		credential: "api-key",
		hint: "Gemini models over Google's OpenAI-compatible endpoint. Keys from AI Studio.",
		models: [],
	},
	{
		id: "groq",
		name: "Groq",
		baseUrl: "https://api.groq.com/openai/v1",
		apiFormat: "openai",
		dialect: "openai-compatible",
		hosting: "remote",
		credential: "api-key",
		hint: "Fast open-weight models. Keys are issued at console.groq.com.",
		models: [],
	},
	{
		id: "xai",
		name: "xAI",
		baseUrl: "https://api.x.ai/v1",
		apiFormat: "openai",
		dialect: "openai-compatible",
		hosting: "remote",
		credential: "api-key",
		hint: "Grok models. Keys are issued at console.x.ai.",
		models: [],
	},
	{
		id: "mistral",
		name: "Mistral",
		baseUrl: "https://api.mistral.ai/v1",
		apiFormat: "openai",
		dialect: "openai-compatible",
		hosting: "remote",
		credential: "api-key",
		hint: "Mistral models. Keys are issued at console.mistral.ai.",
		models: [],
	},
	{
		id: "deepseek",
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com/v1",
		apiFormat: "openai",
		dialect: "openai-compatible",
		hosting: "remote",
		credential: "api-key",
		hint: "DeepSeek models. Keys are issued at platform.deepseek.com.",
		models: [],
	},
	{
		id: "together",
		name: "Together AI",
		baseUrl: "https://api.together.xyz/v1",
		apiFormat: "openai",
		dialect: "openai-compatible",
		hosting: "remote",
		credential: "api-key",
		hint: "Hosted open-weight models. Keys are issued at api.together.ai.",
		models: [],
	},
	{
		id: "fireworks",
		name: "Fireworks AI",
		baseUrl: "https://api.fireworks.ai/inference/v1",
		apiFormat: "openai",
		dialect: "openai-compatible",
		hosting: "remote",
		credential: "api-key",
		hint: "Hosted open-weight models. Keys are issued at fireworks.ai.",
		models: [],
	},
	{
		id: "cerebras",
		name: "Cerebras",
		baseUrl: "https://api.cerebras.ai/v1",
		apiFormat: "openai",
		dialect: "openai-compatible",
		hosting: "remote",
		credential: "api-key",
		hint: "Fast open-weight models. Keys are issued at cloud.cerebras.ai.",
		models: [],
	},
	{
		id: "ollama",
		name: "Ollama",
		baseUrl: local(11434),
		apiFormat: "openai",
		dialect: "ollama",
		hosting: "local",
		credential: "optional",
		hint: "Models you run yourself with Ollama. No key; the stock install listens on port 11434.",
		models: [],
	},
	{
		id: "lmstudio",
		name: "LM Studio",
		baseUrl: local(1234),
		apiFormat: "openai",
		dialect: "openai-compatible",
		hosting: "local",
		credential: "optional",
		hint: "LM Studio's local server. No key; it listens on port 1234 once started.",
		models: [],
	},
	{
		id: "llamacpp",
		name: "llama.cpp",
		baseUrl: local(8080),
		apiFormat: "openai",
		dialect: "openai-compatible",
		hosting: "local",
		credential: "optional",
		hint: "A llama-server you run yourself. No key unless you started it with one.",
		models: [],
	},
	{
		id: "vllm",
		name: "vLLM",
		baseUrl: local(8000),
		apiFormat: "openai",
		dialect: "openai-compatible",
		hosting: "local",
		credential: "optional",
		hint: "A vLLM server you run yourself. No key unless you started it with one.",
		models: [],
	},
];

const byId = new Map(providerCatalog.map((preset) => [preset.id, preset]));

export function providerPreset(id: ProviderPresetId): ProviderPreset {
	const preset = byId.get(id);
	if (!preset) throw new Error(`No provider preset named ${id}`);
	return preset;
}

/**
 * The presets every workspace starts with. They are seeded rather than added
 * and cannot be removed; the rest of the catalog is added from the picker.
 */
export const seededPresets: readonly ProviderPresetId[] = [
	"anthropic",
	"openai",
	"chatgpt",
	"ollama",
];

/** A provider made from no preset is a custom endpoint, and those want a key. */
export function presetRequiresApiKey(preset: ProviderPresetId | null): boolean {
	return preset === null ? true : providerPreset(preset).credential === "api-key";
}

/** Whether a provider made from this preset is signed in to rather than given a key. */
export function presetSignsIn(preset: ProviderPresetId | null): boolean {
	return preset !== null && providerPreset(preset).credential === "chatgpt-sign-in";
}

/** Where a stock Ollama install serves its OpenAI-compatible API. */
export const OLLAMA_LOCAL_BASE_URL = providerPreset("ollama").baseUrl;
