import type { SessionUser } from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { type ReactNode, useEffect, useState } from "react";
import { expect, fn, type within } from "storybook/test";
import preview from "#storybook/preview";
import type { Session } from "@/lib/session.ts";
import { personal } from "@/shell/story-fixtures.ts";
import { Login } from "./Login.tsx";
import { Onboarding } from "./Onboarding.tsx";

const WORKSPACE = "0199a3a0-0000-7000-8000-000000000001";
const workspace = {
	id: WORKSPACE,
	name: "Nitric",
	slug: "nitric",
	createdAt: "2026-09-01T00:00:00.000Z",
};
const user = {
	id: "0199a3a0-0000-7000-8000-000000000009",
	name: "Ryan Eyes",
	email: "ryan@nitric.io",
};
const session: Session = {
	user: user as SessionUser,
	error: undefined,
	refresh: async () => {},
};
const ownPersonal = { ...personal, ownerId: user.id };
const placeholder = {
	id: "0199a3a0-0000-7000-8000-0000000001ff",
	workspaceId: WORKSPACE,
	podId: ownPersonal.id,
	name: "Personal Assistant",
	handle: "personal-assistant",
	systemAgentKey: null,
	description: "Your private assistant.",
	color: "sky",
	face: "pill",
	model: "claude-sonnet",
	prompt: "",
	disabledTools: [],
	usesSandbox: false,
	createdAt: "2026-09-01T00:00:00.000Z",
};
const enabledModel = {
	providerId: "0199a3a0-0000-7000-8000-000000000201",
	providerName: "Anthropic",
	providerPreset: "anthropic",
	providerActive: true,
	modelId: "claude-sonnet",
	displayName: "Claude Sonnet",
};

const API = import.meta.env.VITE_API_URL;

/** Where the workspace has got to: none yet, one with no model, or one with a model on. */
type Stage = "new" | "no-model" | "model";

function Preview({
	stage,
	providers = [],
	children,
}: {
	stage: Stage;
	providers?: readonly unknown[];
	children: ReactNode;
}) {
	const [queryClient] = useState(() => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		client.setQueryData(["workspaces"], stage === "new" ? [] : [workspace]);
		client.setQueryData(["pods", WORKSPACE], [ownPersonal]);
		client.setQueryData(["agents", WORKSPACE], [placeholder]);
		client.setQueryData(["models", WORKSPACE], {
			models: stage === "model" ? [enabledModel] : [],
		});
		client.setQueryData(["model-providers", WORKSPACE], providers);
		return client;
	});
	useEffect(() => () => queryClient.clear(), [queryClient]);
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const meta = preview.meta({
	title: "Views/Onboarding",
	component: Onboarding,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: { session },
});

/** The welcome, before signing in: a bot of every colour, and the way in. */
export const Welcome = meta.story({
	render: () => (
		<div className="h-screen">
			<Login onSignedIn={async () => {}} />
		</div>
	),
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Welcome to Sugabots" }),
		).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Continue with email" })).toBeInTheDocument();
	},
});

/** Naming the workspace, which Continue waits on. */
export const Workspace = meta.story({
	render: (args) => (
		<Preview stage="new">
			<div className="h-screen">
				<Onboarding {...args} />
			</div>
		</Preview>
	),
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Name your workspace" }),
		).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Continue" })).toBeDisabled();
		await expect(canvas.getByLabelText("Workspace name")).toHaveAttribute(
			"placeholder",
			"e.g. Ryan's bots",
		);
	},
});

/** Naming another workspace, from a workspace already set up, which Cancel returns to. */
export const AnotherWorkspace = meta.story({
	args: { newWorkspace: { made: undefined, onMade: fn(), onCancel: fn() } },
	render: (args) => (
		<Preview stage="model">
			<div className="h-screen">
				<Onboarding {...args} />
			</div>
		</Preview>
	),
	play: async ({ args, canvas, userEvent }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Name your workspace" }),
		).toBeInTheDocument();
		await expect(canvas.getByLabelText("Workspace name")).toHaveValue("");
		await expect(canvas.queryByRole("button", { name: "Back" })).toBeNull();
		await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
		await expect(args.newWorkspace?.onCancel).toHaveBeenCalled();
	},
});

/** Connecting a first provider, from the same picker as the Models settings. It cannot be skipped. */
export const Model = meta.story({
	render: (args) => (
		<Preview stage="no-model">
			<div className="h-screen">
				<Onboarding {...args} />
			</div>
		</Preview>
	),
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Connect a provider" }),
		).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Choose a provider" })).toBeEnabled();
		await expect(canvas.queryByRole("button", { name: "Skip for now" })).toBeNull();
	},
});

/** Anthropic as it is once its key is in, with its model list fetched and nothing switched on. */
const anthropic = {
	id: "0199a3a0-0000-7000-8000-000000000201",
	workspaceId: WORKSPACE,
	preset: "anthropic",
	name: "Anthropic",
	baseUrl: "https://api.anthropic.com",
	apiFormat: "anthropic",
	active: true,
	status: "connected",
	hasApiKey: true,
	signedIn: false,
	customHeaders: [],
	modelCount: 3,
	enabledModelCount: 0,
	lastTestedAt: null,
	lastTestError: null,
	models: [
		["claude-3-5-haiku-20241022", "Claude 3.5 Haiku"],
		["claude-opus-4", "Claude Opus 4.1"],
		["claude-sonnet-4-20250514", "Claude Sonnet 4"],
	].map(([modelId, displayName], index) => ({
		id: `0199a3a0-0000-7000-8000-00000000030${index}`,
		modelId,
		displayName,
		capabilities: ["tools", "vision"],
		disabledCapabilities: [],
		contextLength: 200_000,
		enabled: false,
		source: "fetched",
	})),
};

/** Coming back part way: a provider already connected, and its models once it is picked, with nothing chosen for you. */
export const ChooseModel = meta.story({
	render: (args) => (
		<Preview stage="no-model" providers={[anthropic]}>
			<div className="h-screen">
				<Onboarding {...args} />
			</div>
		</Preview>
	),
	beforeEach: ({ msw }) => {
		const root = `${API}/workspaces/:workspace/model-providers`;
		msw.use(
			http.get(`${root}/models`, () => HttpResponse.json({ models: [], defaultModel: null })),
		);
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: /^Anthropic/ }));
		await expect(
			await canvas.findByRole("heading", { name: "Choose a model" }),
		).toBeInTheDocument();
		const choices = canvas
			.getAllByRole("radio")
			.map((radio) => radio.closest("label")?.textContent);
		await expect(choices).toEqual(["Claude 3.5 Haiku", "Claude Opus 4.1", "Claude Sonnet 4"]);
		await expect(canvas.getByRole("button", { name: "Continue" })).toBeDisabled();
		await userEvent.click(canvas.getByRole("radio", { name: "Claude Sonnet 4" }));
		await expect(canvas.getByRole("button", { name: "Continue" })).toBeEnabled();
	},
});

/** The first bot: its face as it is chosen, and a name. */
export const FirstBot = meta.story({
	render: (args) => (
		<Preview stage="model">
			<div className="h-screen">
				<Onboarding {...args} />
			</div>
		</Preview>
	),
	play: async ({ canvas, userEvent }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Make your first bot" }),
		).toBeInTheDocument();
		await userEvent.type(canvas.getByLabelText("Name"), "Chief");
		await expect(canvas.getByRole("button", { name: "Create bot" })).toBeEnabled();
	},
});

/** The placeholder once it has been made the first bot, as the API gives it back. */
const chief = {
	...placeholder,
	name: "Chief",
	handle: "chief",
	color: "purple",
	face: "arc",
};

/** Saving the first bot, and the roster after it. */
function firstBotSaved({
	msw,
}: {
	msw: { use: (...handlers: ReturnType<typeof http.get>[]) => void };
}) {
	msw.use(
		http.patch(`${API}/agents/:agentId`, () => HttpResponse.json(chief)),
		http.get(`${API}/workspaces/:workspace/agents`, () => HttpResponse.json([chief])),
	);
}

/** Makes the first bot: a name, a colour and eyes, then Create bot. */
async function makeChief(
	canvas: ReturnType<typeof within>,
	userEvent: {
		click: (element: Element) => Promise<void>;
		type: (element: Element, text: string) => Promise<void>;
	},
) {
	await canvas.findByRole("heading", { name: "Make your first bot" });
	await userEvent.type(canvas.getByLabelText("Name"), "Chief");
	await userEvent.click(canvas.getByRole("radio", { name: "purple" }));
	await userEvent.click(canvas.getByRole("radio", { name: "arc" }));
	await userEvent.click(canvas.getByRole("button", { name: "Create bot" }));
}

/** Inviting people: addresses turn into chips, and the button counts them. */
export const Invites = meta.story({
	render: (args) => (
		<Preview stage="model">
			<div className="h-screen">
				<Onboarding {...args} />
			</div>
		</Preview>
	),
	beforeEach: firstBotSaved,
	play: async ({ canvas, userEvent }) => {
		await makeChief(canvas, userEvent);
		const emails = await canvas.findByLabelText("Email addresses");
		await userEvent.type(emails, "jay@nitric.io{enter}mara@nitric.io,");
		await expect(canvas.getByRole("button", { name: "Remove jay@nitric.io" })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Remove mara@nitric.io" })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Send 2 invites" })).toBeEnabled();
	},
});

/** The first bot's hello, in its own colour, and the way into its chat. */
export const Ready = meta.story({
	render: (args) => (
		<Preview stage="model">
			<div className="h-screen">
				<Onboarding {...args} />
			</div>
		</Preview>
	),
	beforeEach: firstBotSaved,
	play: async ({ canvas, userEvent }) => {
		await makeChief(canvas, userEvent);
		await userEvent.click(await canvas.findByRole("button", { name: "Skip for now" }));
		await expect(
			await canvas.findByRole("heading", { name: "Chief is ready" }),
		).toBeInTheDocument();
		await expect(canvas.getByText(/help me work out what I'm for/i)).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Start chatting" })).toBeEnabled();
	},
});

/** On a phone: the first bot's pickers stack each label above its row. */
export const FirstBotOnAPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	render: (args) => (
		<Preview stage="model">
			<div className="h-screen">
				<Onboarding {...args} />
			</div>
		</Preview>
	),
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Make your first bot" }),
		).toBeInTheDocument();
		await expect(canvas.getByRole("group", { name: "Eyes" })).toBeInTheDocument();
	},
});
