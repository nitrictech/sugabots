/**
 * Who makes a model, by the name a provider that resells many puts before
 * its slash (OpenRouter's `maker/model`), where it isn't the maker's name
 * with a capital.
 */
export const MODEL_MAKER_NAMES: Readonly<Record<string, string>> = {
	openai: "OpenAI",
	"meta-llama": "Meta",
	mistralai: "Mistral",
	deepseek: "DeepSeek",
	"x-ai": "xAI",
	moonshotai: "Moonshot",
	qwen: "Qwen",
};
