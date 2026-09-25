import type { ProviderPresetId } from "@sugabots/contracts";
import anthropic from "../logos/anthropic.svg";
import anthropicDark from "../logos/anthropic-dark.svg";
import cerebras from "../logos/cerebras.svg";
import deepseek from "../logos/deepseek.svg";
import fireworks from "../logos/fireworks.svg";
import gemini from "../logos/gemini.svg";
import groq from "../logos/groq.svg";
import llamacpp from "../logos/llamacpp.svg";
import lmstudio from "../logos/lmstudio.svg";
import mistral from "../logos/mistral.svg";
import ollama from "../logos/ollama.svg";
import ollamaDark from "../logos/ollama-dark.svg";
import openai from "../logos/openai.svg";
import openaiDark from "../logos/openai-dark.svg";
import openrouter from "../logos/openrouter.svg";
import openrouterDark from "../logos/openrouter-dark.svg";
import together from "../logos/together.svg";
import vllm from "../logos/vllm.svg";
import xai from "../logos/xai.svg";
import xaiDark from "../logos/xai-dark.svg";

/**
 * One provider's official logo. The SVG files in logos/ are exactly as the
 * provider publishes them: never redraw or recolour one. To update a logo,
 * download the new file from `source` and change `fetched`.
 */
export interface ProviderLogoAsset {
	/** The logo's URL, for light backgrounds, or for both when `dark` is absent. */
	light: string;
	/** A version for dark backgrounds, where the provider publishes one. */
	dark?: string;
	/** Where the file came from: a brand kit, the provider's site, or its official repo. */
	source: string;
	/** The provider's rules for using its logo, where it publishes them. */
	guidelines?: string;
	/** The date `source` was downloaded, as YYYY-MM-DD. */
	fetched: string;
	/** Anything to know before showing the logo. */
	caution?: string;
	/**
	 * A Tailwind scale that evens out the padding the provider built into the
	 * file, so every mark looks the same size at icon size. The file itself
	 * stays untouched.
	 */
	scale?: string;
}

const FETCHED = "2026-09-25";

export const providerLogos: Record<ProviderPresetId, ProviderLogoAsset> = {
	anthropic: {
		light: anthropic,
		dark: anthropicDark,
		source:
			"https://www.anthropic.com/press-kit (zip: Anthropic logos/2 Anthropic symbol/SVG/Anthropic symbol - Slate.svg and - Ivory.svg)",
		guidelines: "https://www.anthropic.com/legal/trademark-guidelines",
		fetched: FETCHED,
		caution: "Anthropic's trademark guidelines ask for prior approval (marketing@anthropic.com).",
	},
	openai: {
		light: openai,
		dark: openaiDark,
		source:
			"https://cdn.openai.com/brand/openai-logos.zip (OpenAI-logos/SVGs/OAI_OpenAI-Blossom_Black.svg and _White.svg)",
		guidelines: "https://openai.com/brand/",
		fetched: FETCHED,
		// The flower fills about half of its square.
		scale: "scale-175",
	},
	// ChatGPT is OpenAI's product and OpenAI's brand page gives it the same Blossom mark.
	chatgpt: {
		light: openai,
		dark: openaiDark,
		source:
			"https://cdn.openai.com/brand/openai-logos.zip (OpenAI-logos/SVGs/OAI_OpenAI-Blossom_Black.svg and _White.svg)",
		guidelines: "https://openai.com/brand/",
		fetched: FETCHED,
		scale: "scale-175",
	},
	gemini: {
		light: gemini,
		source: "https://www.gstatic.com/images/branding/productlogos/gemini_2026/v1/192px.svg",
		guidelines:
			"https://partnermarketinghub.withgoogle.com/brands/google-gemini/brand-introduction/ (partner login)",
		fetched: FETCHED,
		caution:
			"Google publishes the current mark only as a vector outline around a 252 KB PNG; the pure-vector spark is the superseded one.",
	},
	xai: {
		light: xai,
		dark: xaiDark,
		source:
			"https://data.x.ai/logos/SpaceXAI_Grok_Assets.zip (Grok_Logomark_Dark.svg for light backgrounds, Grok_Logomark_Light.svg for dark)",
		guidelines: "https://x.ai/legal/brand-guidelines",
		fetched: FETCHED,
		caution:
			"This is the Grok logomark; the SpaceXAI symbol is too thin to read at icon size. Use only to refer to xAI, without implying endorsement.",
	},
	mistral: {
		light: mistral,
		source:
			"https://mistral.ai/cms-media/api/documents/file/Mistral_Logos_2026.zip (Icon/Gradient/RGB/SVG/Mistral-Icon-Gradient-RGB.svg)",
		guidelines: "https://mistral.ai/brand",
		fetched: FETCHED,
		// 31 of every 162 units on each side are padding.
		scale: "scale-150",
	},
	openrouter: {
		light: openrouter,
		dark: openrouterDark,
		source:
			"https://openrouter.ai/brand/logos/transparent/glyph/svg/glyph-grape.svg and glyph-volt.svg",
		guidelines: "https://openrouter.ai/brand",
		fetched: FETCHED,
	},
	groq: {
		light: groq,
		source: "https://groq.com/favicon.svg",
		guidelines: "https://groq.com/trademark-policy",
		fetched: FETCHED,
		caution:
			"Groq's trademark policy allows word marks only without written permission (trademark-legal@groq.com).",
	},
	deepseek: {
		light: deepseek,
		source:
			"https://github.com/deepseek-ai/deepseek-harness/blob/master/website/public/favicon.svg",
		guidelines: "https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html",
		fetched: FETCHED,
		caution: "DeepSeek's terms forbid using its logo without permission.",
	},
	together: {
		light: together,
		source:
			"https://www.together.ai/brand (zip: Together AI Logo Suite/SVG/Color+Black/TogetherAI_Logo_021026_Logo.svg)",
		guidelines: "https://www.together.ai/brand",
		fetched: FETCHED,
	},
	fireworks: {
		light: fireworks,
		source: "https://fireworks.ai/icon0.svg (favicon wrapper removed; mark unchanged)",
		fetched: FETCHED,
		caution: "Fireworks publishes no brand kit; this is the site's own icon.",
	},
	cerebras: {
		light: cerebras,
		source: "https://www.cerebras.ai/company/press-kit (Cerebras Logos zip: Cerebras C logo.svg)",
		fetched: FETCHED,
		caution: "No dark-background version as SVG; the black C disappears on dark surfaces.",
	},
	ollama: {
		light: ollama,
		dark: ollamaDark,
		source:
			"https://github.com/ollama/ollama at 7af3931 (docs/ollama-logo.svg, and docs/favicon.svg for dark)",
		fetched: FETCHED,
	},
	lmstudio: {
		light: lmstudio,
		source: "https://lmstudio.ai/assets/marketing/brand/download/logos/lm-studio-icon-color.svg",
		guidelines: "https://lmstudio.ai/brand",
		fetched: FETCHED,
	},
	llamacpp: {
		light: llamacpp,
		source: "https://github.com/ggml-org/llama.cpp at f805c57 (media/llama1-icon-transparent.svg)",
		fetched: FETCHED,
	},
	vllm: {
		light: vllm,
		source: "https://github.com/vllm-project/media-kit at 79b2ea5 (vLLM-Logo.svg)",
		guidelines: "https://github.com/vllm-project/media-kit",
		fetched: FETCHED,
	},
};
