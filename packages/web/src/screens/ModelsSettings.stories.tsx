import type { ModelProvider, ProviderModel, SystemAgent } from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
// The dialog is portalled to the body, so reaching it means `screen`.
import { expect, screen, within } from "storybook/test";
import preview from "#storybook/preview";
import {
	accountManager,
	chief,
	growthDesk,
	leadResearcher,
	linearHandler,
	oncall,
} from "@/shell/story-fixtures.ts";
import { Dialog } from "@/ui/dialog.tsx";
import { AddProviderDialog, ModelsSettings, SystemModelSettings } from "./ModelsSettings.tsx";
import { ProviderSettings } from "./ProviderSettings.tsx";

const WORKSPACE = "0199a3a0-0000-7000-8000-000000000001";
const workspace = {
	id: WORKSPACE,
	name: "Nitric",
	slug: "nitric",
	createdAt: "2026-09-01T00:00:00.000Z",
};

let nextModel = 0;
function model(
	modelId: string,
	displayName: string | null,
	enabled: boolean,
	capabilities: ProviderModel["capabilities"] = ["tools"],
): ProviderModel {
	nextModel += 1;
	return {
		id: `0199a3a0-0000-7000-8000-000000000${String(300 + nextModel)}`,
		modelId,
		displayName,
		capabilities,
		disabledCapabilities: [],
		contextLength: null,
		enabled,
		source: "fetched",
	};
}

function provider(
	n: number,
	preset: ModelProvider["preset"],
	name: string,
	models: ProviderModel[],
	over: Partial<ModelProvider> = {},
): ModelProvider {
	return {
		id: `0199a3a0-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`,
		workspaceId: WORKSPACE,
		preset,
		name,
		baseUrl: "https://api.example.com/v1",
		apiFormat: "openai",
		active: true,
		status: "connected",
		hasApiKey: true,
		apiKeyHint: "4f2a",
		customHeaders: [],
		modelCount: models.length,
		enabledModelCount: models.filter((one) => one.enabled).length,
		lastTestedAt: null,
		lastTestError: null,
		models,
		...over,
	};
}

const anthropic = provider(1, "anthropic", "Anthropic", [
	model("claude-opus", "Claude Opus", false, ["tools", "vision", "reasoning"]),
	model("claude-sonnet", "Claude Sonnet", true, ["tools", "vision", "reasoning"]),
	model("claude-haiku", "Claude Haiku", true, ["tools", "vision"]),
]);
const openai = provider(2, "openai", "OpenAI", [
	model("gpt-5", "GPT-5", true, ["tools", "vision", "images", "reasoning"]),
	model("gpt-5-mini", "GPT-5 mini", false, ["tools", "vision", "reasoning"]),
	model("gpt-5-nano", "GPT-5 nano", false, ["tools"]),
]);
const ollama = provider(
	3,
	"ollama",
	"Ollama",
	[model("qwen3.5:4b", "Qwen 3.5 4B", true), model("llama3.2", null, false)],
	{ baseUrl: "http://127.0.0.1:11434/v1", hasApiKey: false, apiKeyHint: null },
);
const makers = [
	"meta-llama",
	"deepseek",
	"moonshotai",
	"anthropic",
	"openai",
	"google",
	"mistralai",
	"qwen",
];
const openrouter = provider(
	4,
	"openrouter",
	"OpenRouter",
	Array.from({ length: 32 }, (_, index) => {
		const maker = makers[index % makers.length] as string;
		return model(
			`${maker}/model-${index + 1}`,
			`${maker.split("-")[0]} model ${index + 1}`,
			index < 3,
			["tools", ...(index % 2 === 0 ? (["vision"] as const) : [])],
		);
	}),
);
const providers = [anthropic, openai, ollama, openrouter];

const bots = [
	{ ...growthDesk, model: "claude-sonnet" },
	{ ...accountManager, model: "claude-sonnet" },
	{ ...chief, model: "claude-sonnet" },
	{ ...leadResearcher, model: "claude-haiku" },
	{ ...linearHandler, model: "claude-haiku" },
	{ ...oncall, model: "gpt-5" },
];

const systemAgents: SystemAgent[] = (["summarise", "facilitate"] as const).map((key) => ({
	key,
	name: key === "summarise" ? "Scribe" : "Facilitator",
	description: null,
	color: "ice",
	face: "pill",
	model: "claude-haiku",
}));

function Preview({ children }: { children: ReactNode }) {
	const [queryClient] = useState(() => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		client.setQueryData(["workspaces"], [workspace]);
		client.setQueryData(["workspace-standing", WORKSPACE], {
			role: "admin",
			permissions: {
				createPods: true,
				manageProviders: true,
				manageMembers: true,
				configureBuiltInAgents: true,
			},
		});
		client.setQueryData(["model-providers", WORKSPACE], providers);
		client.setQueryData(["agents", WORKSPACE], bots);
		client.setQueryData(["built-in-agents", WORKSPACE], systemAgents);
		return client;
	});
	useEffect(() => () => queryClient.clear(), [queryClient]);
	return (
		<QueryClientProvider client={queryClient}>
			<div className="min-h-screen bg-background">{children}</div>
		</QueryClientProvider>
	);
}

const meta = preview.meta({
	title: "Views/ModelsSettings",
	component: ModelsSettings,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	decorators: [
		(Story, context) => (
			<Preview key={context.id}>
				<Story />
			</Preview>
		),
	],
});

/** The system bots' model, then each provider with how many models are on and the bots using them. */
export const Overview = meta.story({
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("link", { name: /System agents use/ })).toHaveTextContent(
			"Claude Haiku",
		);
		await expect(canvas.getByRole("link", { name: /Anthropic/ })).toHaveTextContent(
			"2 of 3 models on",
		);
		await expect(canvas.getByRole("button", { name: "Add provider" })).toBeInTheDocument();
	},
});

/** A provider with a few models: its key, which models are on (listed first), and who uses each. */
export const Provider = meta.story({
	render: () => <ProviderSettings providerId={anthropic.id} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Anthropic" })).toBeInTheDocument();
		await expect(canvas.getByText("Not used yet")).toBeInTheDocument();
		await expect(canvas.getByRole("switch", { name: "Bots can use Claude Opus" })).toHaveAttribute(
			"aria-checked",
			"false",
		);
		await expect(
			canvas.getAllByRole("switch").map((toggle) => toggle.getAttribute("aria-checked")),
		).toEqual(["true", "true", "false"]);
		await expect(canvas.getByRole("button", { name: "Disconnect Anthropic" })).toBeInTheDocument();
	},
});

/** A provider that resells hundreds of models: a search, which also finds them by who makes them. */
export const LargeCatalog = meta.story({
	render: () => <ProviderSettings providerId={openrouter.id} />,
	play: async ({ canvas, userEvent }) => {
		const search = await canvas.findByRole("searchbox", { name: "Search models" });
		await expect(search).toHaveAttribute("placeholder", "Search 32 models");
		await userEvent.type(search, "deepseek");
		await expect(canvas.getAllByRole("switch")).toHaveLength(4);
	},
});

/** A server you run: its address, and a key only if you set one. */
export const LocalServer = meta.story({
	render: () => <ProviderSettings providerId={ollama.id} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByText(ollama.baseUrl)).toBeInTheDocument();
		await expect(canvas.getByText("None")).toBeInTheDocument();
	},
});

/** One model for every system bot, from the models that are switched on. */
export const SystemAgents = meta.story({
	render: () => <SystemModelSettings />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "System agents" })).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Claude Opus" })).toBeNull();
		await expect(canvas.getByRole("button", { name: "GPT-5" })).toBeInTheDocument();
	},
});

function AddProviderPreview() {
	return (
		<Dialog open>
			<AddProviderDialog providers={providers} done={() => {}} onAdded={async () => {}} />
		</Dialog>
	);
}

/** Adding a provider: the catalog, minus what is already connected, and a custom one. */
export const AddProvider = meta.story({
	render: () => <AddProviderPreview />,
	play: async () => {
		const dialog = await screen.findByRole("dialog", { name: "Add provider" });
		await expect(within(dialog).queryByRole("button", { name: /^Anthropic/ })).toBeNull();
		await expect(within(dialog).getByRole("button", { name: /^Groq/ })).toBeInTheDocument();
		await expect(
			within(dialog).getByRole("button", { name: /Custom provider/ }),
		).toBeInTheDocument();
	},
});

/** A preset's one step: its key, with where to get one. */
export const AddProviderKey = meta.story({
	render: () => <AddProviderPreview />,
	play: async ({ userEvent }) => {
		const dialog = await screen.findByRole("dialog", { name: "Add provider" });
		await userEvent.click(within(dialog).getByRole("button", { name: /^Groq/ }));
		const step = await screen.findByRole("dialog", { name: "Groq" });
		await expect(within(step).getByRole("button", { name: "Add" })).toBeDisabled();
		await expect(within(step).getByRole("button", { name: "Back" })).toBeInTheDocument();
	},
});

/** Anything else that speaks the OpenAI or Anthropic format. */
export const AddCustomProvider = meta.story({
	render: () => <AddProviderPreview />,
	play: async ({ userEvent }) => {
		const dialog = await screen.findByRole("dialog", { name: "Add provider" });
		await userEvent.click(within(dialog).getByRole("button", { name: /Custom provider/ }));
		const step = await screen.findByRole("dialog", { name: "Custom provider" });
		await expect(within(step).getByRole("radio", { name: "OpenAI" })).toBeChecked();
	},
});
