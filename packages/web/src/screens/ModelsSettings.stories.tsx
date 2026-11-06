import {
	type Agent,
	agentColors,
	agentFaces,
	agentShapes,
	type ModelProvider,
	type ProviderModel,
	type SystemAgent,
} from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { type ReactNode, useEffect, useState } from "react";
// The dialog is portalled to the body, so reaching it means `screen`.
import { expect, fn, screen, within } from "storybook/test";
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
import {
	AddProviderDialog,
	DefaultModelSettings,
	ModelsSettings,
	SystemModelSettings,
} from "./ModelsSettings.tsx";
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
		signedIn: false,
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
	{ baseUrl: "http://127.0.0.1:11434/v1", hasApiKey: false },
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
const chatgpt = provider(5, "chatgpt", "ChatGPT", [], {
	baseUrl: "https://chatgpt.com/backend-api/codex",
	active: false,
	status: "signed_out",
	hasApiKey: false,
});
const chatgptSignedIn: ModelProvider = {
	...chatgpt,
	active: true,
	status: "connected",
	signedIn: true,
	models: [model("gpt-5.5", "GPT-5.5", true, ["tools", "vision", "reasoning"])],
	modelCount: 1,
	enabledModelCount: 1,
};
const supergrok = provider(6, "supergrok", "SuperGrok", [], {
	baseUrl: "https://api.x.ai/v1",
	active: false,
	status: "signed_out",
	hasApiKey: false,
});
const providers = [anthropic, openai, ollama, openrouter, chatgpt];

const API = import.meta.env.VITE_API_URL as string;

const bots = [
	{ ...growthDesk, model: "claude-sonnet" },
	{ ...accountManager, model: "claude-sonnet" },
	{ ...chief, model: "claude-sonnet" },
	{ ...leadResearcher, model: "claude-haiku" },
	{ ...linearHandler, model: "claude-haiku" },
	{ ...oncall, model: "gpt-5" },
];

const systemAgents: SystemAgent[] = (["summarise", "compact"] as const).map((key) => ({
	key,
	name: key === "summarise" ? "Scribe" : "Compaction",
	description: null,
	color: "ice",
	face: "pill",
	shape: "circle",
	model: "claude-haiku",
}));

function Preview({
	providers,
	bots,
	defaultModel,
	summariesModel,
	children,
}: {
	providers: readonly ModelProvider[];
	bots: readonly Agent[];
	/** The model new bots start on. */
	defaultModel: string;
	/** The model the system agents use. */
	summariesModel: string;
	children: ReactNode;
}) {
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
				manageUsage: true,
			},
		});
		client.setQueryData(["model-providers", WORKSPACE], providers);
		client.setQueryData(["agents", WORKSPACE], bots);
		client.setQueryData(
			["built-in-agents", WORKSPACE],
			systemAgents.map((agent) => ({ ...agent, model: summariesModel })),
		);
		client.setQueryData(["models", WORKSPACE], {
			models: providers.flatMap((provider) =>
				provider.models
					.filter((model) => model.enabled)
					.map((model) => ({
						providerId: provider.id,
						providerName: provider.name,
						providerPreset: provider.preset,
						providerActive: provider.active,
						modelId: model.modelId,
						displayName: model.displayName,
						capabilities: model.capabilities.filter(
							(capability) => !model.disabledCapabilities.includes(capability),
						),
					})),
			),
			defaultModel,
		});
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
			<Preview
				key={context.id}
				providers={context.parameters.providers ?? providers}
				bots={context.parameters.bots ?? bots}
				defaultModel={context.parameters.defaultModel ?? "claude-sonnet"}
				summariesModel={context.parameters.summariesModel ?? "claude-haiku"}
			>
				<Story />
			</Preview>
		),
	],
});

/** The models new bots and the system bots use, then the popular providers, Connected or with Connect, and any other connected one. */
export const Overview = meta.story({
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("link", { name: /Default for new bots/ }),
		).toHaveTextContent("Claude Sonnet");
		await expect(canvas.getByRole("link", { name: /Summaries/ })).toHaveTextContent("Claude Haiku");
		await expect(canvas.getByRole("link", { name: /Anthropic/ })).toHaveTextContent("Connected");
		await expect(canvas.getAllByRole("button", { name: "Connect" }).length).toBeGreaterThan(0);
		await expect(canvas.getByRole("button", { name: /^Add a provider/ })).toBeInTheDocument();
	},
});

/**
 * A provider with a few models: its key, which models are on (listed first),
 * and who uses each. Sonnet is the default and Haiku the system agents'.
 */
export const Provider = meta.story({
	render: () => <ProviderSettings providerId={anthropic.id} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Anthropic" })).toBeInTheDocument();
		await expect(canvas.getByText(/^Default · 3 bots/)).toBeInTheDocument();
		await expect(canvas.getByText(/^Summaries · 2 bots/)).toBeInTheDocument();
		await expect(canvas.getByText("Not used yet")).toBeInTheDocument();
		await expect(canvas.getByRole("switch", { name: "Bots can use Claude Opus" })).toHaveAttribute(
			"aria-checked",
			"false",
		);
		await expect(
			canvas
				.getAllByRole("switch", { name: /^Bots can use / })
				.map((toggle) => toggle.getAttribute("aria-checked")),
		).toEqual(["true", "true", "false"]);
	},
});

/** Forty bots on GPT-5, and every OpenRouter model switched on. */
const crowdOnGpt5: Agent[] = Array.from({ length: 40 }, (_, index) => ({
	...oncall,
	id: `0199a3a0-0000-7000-8000-000000000${String(500 + index)}`,
	name: `Helper ${index + 1}`,
	handle: `helper-${index + 1}`,
	color: agentColors[index % agentColors.length] as Agent["color"],
	face: agentFaces[index % agentFaces.length] as Agent["face"],
	shape: agentShapes[index % agentShapes.length] as Agent["shape"],
	model: "gpt-5",
}));
const everyModelOn = providers.map((one) =>
	one === openrouter
		? { ...one, models: one.models.map((model) => ({ ...model, enabled: true })) }
		: one,
);

/**
 * Switching off a model many bots run on, with many models to move them to:
 * the faces scroll after a few rows, and a search narrows the models.
 */
export const SwitchOffModelLongLists = meta.story({
	parameters: { bots: crowdOnGpt5, providers: everyModelOn },
	render: () => <ProviderSettings providerId={openai.id} />,
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("switch", { name: "Bots can use GPT-5" }));
		const dialog = await screen.findByRole("dialog", { name: "Switch off GPT-5" });
		const faces = within(dialog).getByRole("list", { name: "Bots on GPT-5" });
		await expect(within(faces).getAllByRole("img")).toHaveLength(40);
		await expect(faces.scrollHeight).toBeGreaterThan(faces.clientHeight);
		const search = within(dialog).getByRole("searchbox", { name: "Search models" });
		await userEvent.type(search, "deepseek");
		await expect(
			within(dialog).getByRole("button", { name: "deepseek model 2" }),
		).toBeInTheDocument();
		await expect(within(dialog).queryByRole("button", { name: "Claude Haiku" })).toBeNull();
		await userEvent.clear(search);
		await userEvent.type(search, "no such model");
		await expect(within(dialog).getByText("No models match.")).toBeInTheDocument();
	},
});

/**
 * Switching off the model new bots start on asks where they move as well as
 * the bots on it, starting both on the same model.
 */
export const SwitchOffDefaultModel = meta.story({
	render: () => <ProviderSettings providerId={anthropic.id} />,
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(
			await canvas.findByRole("switch", { name: "Bots can use Claude Sonnet" }),
		);
		const dialog = await screen.findByRole("dialog", { name: "Switch off Claude Sonnet" });
		await expect(
			within(dialog).getByText(
				"These bots use Claude Sonnet, and so do new bots. Choose the model to move them to.",
			),
		).toBeInTheDocument();
		await expect(
			within(dialog).getByRole("button", { name: "Move new bots to: Claude Haiku" }),
		).toBeInTheDocument();
		await expect(within(dialog).getByRole("button", { name: "Move and switch off" })).toBeEnabled();
	},
});

/**
 * Switching off a provider whose models new bots and summaries use asks where
 * each of those moves, beside each model's bots.
 */
export const SwitchOffProviderWithDefaults = meta.story({
	render: () => <ProviderSettings providerId={anthropic.id} />,
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("switch", { name: "Use Anthropic" }));
		const dialog = await screen.findByRole("dialog", { name: "Switch off Anthropic" });
		await expect(
			within(dialog).getByText(
				"5 bots, new bots, and summaries use Anthropic's models. Choose the model each moves to.",
			),
		).toBeInTheDocument();
		await expect(
			within(dialog).getByRole("button", { name: "Move summaries to: GPT-5" }),
		).toBeInTheDocument();
		await expect(within(dialog).getByRole("button", { name: "Move and switch off" })).toBeEnabled();
	},
});

/**
 * Switching off the only model switched on: there is nothing to move to, so
 * the dialog says to switch another on first and cannot go ahead.
 */
export const SwitchOffLastModel = meta.story({
	parameters: { providers: [openai], defaultModel: "gpt-5", summariesModel: "gpt-5" },
	render: () => <ProviderSettings providerId={openai.id} />,
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("switch", { name: "Bots can use GPT-5" }));
		const dialog = await screen.findByRole("dialog", { name: "Switch off GPT-5" });
		await expect(
			within(dialog).getByText(
				"GPT-5 is the only model switched on. Switch on another first, so there is one to move to.",
			),
		).toBeInTheDocument();
		await expect(
			within(dialog).getByRole("button", { name: "Move and switch off" }),
		).toBeDisabled();
	},
});

/**
 * Switching off a model a bot still runs on asks which model the bot moves
 * to, starting on the one new bots use.
 */
export const SwitchOffModelInUse = meta.story({
	render: () => <ProviderSettings providerId={openai.id} />,
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("switch", { name: "Bots can use GPT-5" }));
		const dialog = await screen.findByRole("dialog", { name: "Switch off GPT-5" });
		await expect(
			within(dialog).getByText("This bot uses GPT-5. Choose the model to move it to."),
		).toBeInTheDocument();
		await userEvent.hover(within(dialog).getByRole("img", { name: "On-call" }));
		await expect(await screen.findByText("On-call")).toBeVisible();
		await expect(
			within(dialog).getByRole("button", { name: "Claude Sonnet", pressed: true }),
		).toBeInTheDocument();
		await expect(
			within(dialog).getByRole("button", { name: "Move bot and switch off" }),
		).toBeEnabled();
	},
});

/**
 * Switching off a provider whose model many bots run on names the first few
 * and counts the rest.
 */
export const SwitchOffProviderLongLists = meta.story({
	parameters: { bots: crowdOnGpt5, providers: everyModelOn },
	render: () => <ProviderSettings providerId={openai.id} />,
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("switch", { name: "Use OpenAI" }));
		const dialog = await screen.findByRole("dialog", { name: "Switch off OpenAI" });
		await expect(
			within(dialog).getByText("Helper 1, Helper 2, Helper 3 and 37 more"),
		).toBeInTheDocument();
	},
});

/**
 * Switching off a provider whose models bots still run on asks, for each of
 * those models, which model at another provider its bots move to.
 */
export const SwitchOffProviderInUse = meta.story({
	render: () => <ProviderSettings providerId={openai.id} />,
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("switch", { name: "Use OpenAI" }));
		const dialog = await screen.findByRole("dialog", { name: "Switch off OpenAI" });
		await expect(within(dialog).getByText("On-call")).toBeInTheDocument();
		await expect(
			within(dialog).getByRole("button", { name: "Move GPT-5 bots to: Claude Sonnet" }),
		).toBeInTheDocument();
		await expect(
			within(dialog).getByRole("button", { name: "Move bots and switch off" }),
		).toBeEnabled();
	},
});

/** A provider that resells hundreds of models: a search, which also finds them by who makes them. */
export const LargeCatalog = meta.story({
	render: () => <ProviderSettings providerId={openrouter.id} />,
	play: async ({ canvas, userEvent }) => {
		const search = await canvas.findByRole("searchbox", { name: "Search models" });
		await expect(search).toHaveAttribute("placeholder", "Search 32 models");
		await userEvent.type(search, "deepseek");
		await expect(canvas.getAllByRole("switch", { name: /^Bots can use / })).toHaveLength(4);
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

/** ChatGPT is signed in to rather than given a key, after a warning that a plan is one person's. */
export const ChatgptSignIn = meta.story({
	render: () => <ProviderSettings providerId={chatgpt.id} />,
	beforeEach({ msw }) {
		msw.use(
			http.post(`${API}/workspaces/:workspace/model-providers/:providerId/sign-in`, () =>
				HttpResponse.json({
					verificationUrl: "https://auth.openai.com/codex/device",
					userCode: "ABCD-1234",
					attempt: "sealed-attempt",
					pollIntervalMs: 60_000,
					expiresAt: "2026-09-01T00:15:00.000Z",
				}),
			),
		);
	},
	play: async ({ canvas, userEvent }) => {
		await expect(await canvas.findByText("Not signed in")).toBeInTheDocument();
		await userEvent.click(canvas.getByRole("button", { name: "Sign in with ChatGPT" }));
		const warning = await screen.findByRole("dialog", { name: "Single-user installs only" });
		await expect(within(warning).getByRole("link", { name: "OpenAI's terms" })).toHaveAttribute(
			"href",
			"https://openai.com/policies/terms-of-use/#registration-and-access",
		);
		await userEvent.click(within(warning).getByRole("button", { name: "Sign in" }));
		await expect(await canvas.findByText("ABCD-1234")).toBeVisible();
		await expect(canvas.getByRole("button", { name: "Copy code" })).toBeVisible();
		await expect(canvas.getByRole("link", { name: "Open sign-in page" })).toHaveAttribute(
			"href",
			"https://auth.openai.com/codex/device",
		);
	},
});

/** SuperGrok is signed in to at xAI, the same way, with xAI's terms in the warning. */
export const SupergrokSignIn = meta.story({
	parameters: { providers: [...providers, supergrok] },
	render: () => <ProviderSettings providerId={supergrok.id} />,
	beforeEach({ msw }) {
		msw.use(
			http.post(`${API}/workspaces/:workspace/model-providers/:providerId/sign-in`, () =>
				HttpResponse.json({
					verificationUrl: "https://accounts.x.ai/oauth2/device?user_code=GWJA-VZAE",
					userCode: "GWJA-VZAE",
					attempt: "sealed-attempt",
					pollIntervalMs: 60_000,
					expiresAt: "2026-09-01T00:30:00.000Z",
				}),
			),
		);
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Sign in with xAI" }));
		const warning = await screen.findByRole("dialog", { name: "Single-user installs only" });
		await expect(within(warning).getByText(/A SuperGrok plan is for one person/)).toBeVisible();
		await expect(within(warning).getByRole("link", { name: "xAI's terms" })).toHaveAttribute(
			"href",
			"https://x.ai/legal/terms-of-service",
		);
		await userEvent.click(within(warning).getByRole("button", { name: "Sign in" }));
		await expect(await canvas.findByText("GWJA-VZAE")).toBeVisible();
		await expect(canvas.getByText(/Open xAI's sign-in page/)).toBeVisible();
	},
});

/** A signed-in ChatGPT provider, with the plan's models. */
export const ChatgptSignedIn = meta.story({
	parameters: { providers: [chatgptSignedIn] },
	render: () => <ProviderSettings providerId={chatgptSignedIn.id} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("Signed in")).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
		await expect(canvas.queryByText("API key")).toBeNull();
	},
});

/** One model for every system bot, from the models that are switched on. */
export const SystemAgents = meta.story({
	render: () => <SystemModelSettings />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Summaries" })).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Claude Opus" })).toBeNull();
		await expect(canvas.getByRole("button", { name: "GPT-5" })).toBeInTheDocument();
	},
});

/** The model new bots start on, from the models that are switched on. */
export const NewBots = meta.story({
	render: () => <DefaultModelSettings />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Default for new bots" }),
		).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Claude Sonnet" })).toBeNull();
		await expect(canvas.getByRole("button", { name: "GPT-5" })).toBeInTheDocument();
	},
});

function AddProviderPreview({
	onAdded = async () => {},
}: {
	onAdded?: (provider: ModelProvider) => Promise<void>;
}) {
	return (
		<Dialog open>
			<AddProviderDialog providers={providers} done={() => {}} onAdded={onAdded} />
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

const chatgptAdded = fn(async (_provider: ModelProvider) => {});

/**
 * ChatGPT is in every workspace from the start, so choosing it goes on to its
 * page, where the person signs in, rather than switching it on without one.
 */
export const AddChatgpt = meta.story({
	render: () => <AddProviderPreview onAdded={chatgptAdded} />,
	beforeEach() {
		chatgptAdded.mockClear();
	},
	play: async ({ userEvent }) => {
		const dialog = await screen.findByRole("dialog", { name: "Add provider" });
		await userEvent.click(within(dialog).getByRole("button", { name: /^ChatGPT/ }));
		const step = await screen.findByRole("dialog", { name: "ChatGPT" });
		await expect(within(step).getByText("Sign in after you continue")).toBeVisible();
		await expect(within(step).queryByText("API key")).toBeNull();
		await userEvent.click(within(step).getByRole("button", { name: "Continue" }));
		await expect(chatgptAdded).toHaveBeenCalledWith(chatgpt);
		await expect(within(step).queryByRole("alert")).toBeNull();
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
