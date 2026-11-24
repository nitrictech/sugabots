import { Schema } from "effect";
import type { ProviderModelCapability } from "./model-providers.ts";

/** The path an OpenAI-compatible server serves its API from, Ollama included. */
export const OPENAI_COMPATIBLE_PATH = "/v1";

export const builtInProviderIdSchema = Schema.Literals([
	"anthropic",
	"openai",
	"chatgpt",
	"openrouter",
	"gemini",
	"groq",
	"xai",
	"supergrok",
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
export type BuiltInProviderId = typeof builtInProviderIdSchema.Type;

/**
 * The dialects the API speaks: a provider's variation on its protocol, such as
 * how it lists models. Code lives in the API; a built-in provider only names the one it
 * is read in. `openai-compatible` is the plain protocol and what a custom
 * OpenAI-format endpoint gets.
 */
const providerDialectIdSchema = Schema.Literals([
	"openai-compatible",
	"anthropic",
	"openrouter",
	"ollama",
	"chatgpt",
	"gemini",
]);
export type ProviderDialectId = typeof providerDialectIdSchema.Type;

interface StarterModel {
	modelId: string;
	displayName: string;
	capabilities: ProviderModelCapability[];
	contextLength: number;
}

/**
 * A built-in provider: the defaults and the face of a provider we know
 * about. A built-in provider is data and nothing else. What a workspace configures from
 * it — its own key, perhaps its own URL — is a provider.
 *
 * `hosting` says where the server usually is. A remote built-in provider is a service
 * with a fixed address that wants a key; a local one is something you run
 * yourself, so its address is the interesting field and a key is unusual.
 */
export type BuiltInProvider = BuiltInDefaults & BuiltInCredential;

interface BuiltInDefaults {
	id: BuiltInProviderId;
	name: string;
	baseUrl: string;
	apiFormat: "openai" | "anthropic";
	/** How the API reads this provider; see `ProviderDialectId`. */
	dialect: ProviderDialectId;
	hosting: "remote" | "local";
	/** One line for the picker: what this is, or where the key comes from. */
	hint: string;
	/** Models worth offering before discovery has run, if the API lists none. */
	models: StarterModel[];
}

/**
 * What the provider needs before it answers: an API key, nothing (a key is
 * optional), or a member signing in to `signIn` with their subscription, or a
 * key in its place.
 */
type BuiltInCredential =
	| { credential: "api-key" | "optional" }
	| { credential: "sign-in"; signIn: SignInServiceId };

/** The services a member signs a provider in to with their subscription, in place of a key. */
export type SignInServiceId = "chatgpt" | "xai";

/** Each sign-in service as the sign-in button names it. */
export const signInServiceNames = {
	chatgpt: "ChatGPT",
	xai: "xAI",
} as const satisfies Record<SignInServiceId, string>;

const local = (port: number) => `http://127.0.0.1:${port}${OPENAI_COMPATIBLE_PATH}`;

export const builtInProviders: readonly BuiltInProvider[] = [
	{
		id: "anthropic",
		name: "Anthropic",
		baseUrl: "https://api.anthropic.com",
		apiFormat: "anthropic",
		dialect: "anthropic",
		hosting: "remote",
		credential: "api-key",
		hint: "Claude models. Keys are issued at console.anthropic.com.",
		models: [],
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
		models: [],
	},
	{
		id: "chatgpt",
		name: "ChatGPT",
		baseUrl: "https://chatgpt.com/backend-api/codex",
		apiFormat: "openai",
		dialect: "chatgpt",
		hosting: "remote",
		credential: "sign-in",
		signIn: "chatgpt",
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
		dialect: "gemini",
		hosting: "remote",
		credential: "api-key",
		hint: "Google's Gemini models. Keys are issued at aistudio.google.com.",
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
		id: "supergrok",
		name: "SuperGrok",
		baseUrl: "https://api.x.ai/v1",
		apiFormat: "openai",
		dialect: "openai-compatible",
		hosting: "remote",
		credential: "sign-in",
		signIn: "xai",
		hint: "Grok models on your SuperGrok or X Premium+ plan, signed in the way Grok Build does. Unofficial.",
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

const byId = new Map(builtInProviders.map((builtIn) => [builtIn.id, builtIn]));

export function providerBuiltIn(id: BuiltInProviderId): BuiltInProvider {
	const builtIn = byId.get(id);
	if (!builtIn) throw new Error(`No built-in provider named ${id}`);
	return builtIn;
}

/**
 * The built-in providers every workspace starts with. They are seeded rather than added
 * and cannot be removed; the other built-in providers are added from the picker.
 */
export const seededBuiltIns: readonly BuiltInProviderId[] = [
	"anthropic",
	"openai",
	"chatgpt",
	"ollama",
];

/** A provider bots reach with no key or sign-in, such as a model server on your own machine. */
export function builtInTakesNoCredential(builtIn: BuiltInProviderId | null): boolean {
	return !builtInSignsIn(builtIn) && !builtInRequiresApiKey(builtIn);
}

/** A provider made from no built-in provider is a custom model provider, and those want a key. */
export function builtInRequiresApiKey(builtIn: BuiltInProviderId | null): boolean {
	return builtIn === null ? true : providerBuiltIn(builtIn).credential === "api-key";
}

/** Whether a provider made from this built-in provider is signed in to rather than given a key. */
export function builtInSignsIn(builtIn: BuiltInProviderId | null): boolean {
	return builtInSignInService(builtIn) !== undefined;
}

/** The service a provider made from this built-in provider is signed in to, if it is signed in to rather than given a key. */
export function builtInSignInService(
	builtIn: BuiltInProviderId | null,
): SignInServiceId | undefined {
	if (builtIn === null) return undefined;
	const found = providerBuiltIn(builtIn);
	return found.credential === "sign-in" ? found.signIn : undefined;
}
