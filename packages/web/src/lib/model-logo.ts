import type { BuiltInProviderId } from "@sugabots/contracts";

/**
 * Who makes a model, by what its id says, as the provider whose logo is theirs.
 * Several providers serve others' models (OpenRouter serves Claude), so a
 * model's maker is read from its name before the provider serving it.
 */
const MAKERS: readonly (readonly [RegExp, BuiltInProviderId])[] = [
	[/claude/i, "anthropic"],
	[/(^|[/-])(gpt|o\d|chatgpt)/i, "openai"],
	[/gemini|gemma/i, "gemini"],
	[/grok/i, "xai"],
	[/mistral|mixtral|codestral|magistral|ministral|devstral/i, "mistral"],
	[/deepseek/i, "deepseek"],
];

/**
 * The logo to show for a model: its maker's, read from `modelId`, else that of
 * the provider serving it, else none.
 */
export function modelLogoOf(
	modelId: string | null,
	servedBy: BuiltInProviderId | null,
): BuiltInProviderId | null {
	if (modelId) {
		for (const [pattern, maker] of MAKERS) if (pattern.test(modelId)) return maker;
	}
	return servedBy;
}
