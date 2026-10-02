import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { type ReactNode, useEffect, useState } from "react";
// The dialog is portalled to the body, so reaching it means `screen`.
import { expect, fn, screen, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { Dialog } from "@/ui/dialog.tsx";
import { NewAgentDialog } from "./NewAgent.tsx";
import { engineering, growthDesk, personal, podsWithBots, revenue } from "./story-fixtures.ts";

const WORKSPACE = revenue.workspaceId;
const API = import.meta.env.VITE_API_URL;

/** The bodies of the create requests a story sends, to check what the bot was made with. */
let created: Record<string, unknown>[] = [];
const createAgent = http.post(`${API}/pods/:podId/agents`, async ({ request }) => {
	const body = (await request.json()) as Record<string, unknown>;
	created.push(body);
	return HttpResponse.json({ ...growthDesk, ...body }, { status: 201 });
});
/** The roster, which creating a bot fetches again. */
const listAgents = http.get(`${API}/workspaces/:workspace/agents`, () =>
	HttpResponse.json(podsWithBots.flatMap(({ bots }) => bots)),
);

function Preview({ models, children }: { models: boolean; children: ReactNode }) {
	const [queryClient] = useState(() => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		client.setQueryData(["workspaces"], [{ id: WORKSPACE, name: "Nitric", slug: "nitric" }]);
		client.setQueryData(
			["agents", WORKSPACE],
			podsWithBots.flatMap(({ bots }) => bots),
		);
		client.setQueryData(["models", WORKSPACE], {
			models: models
				? [
						{
							providerId: "0199a3a0-0000-7000-8000-000000000201",
							providerName: "Anthropic",
							providerPreset: "anthropic",
							providerActive: true,
							modelId: "claude-sonnet",
							displayName: "Claude Sonnet",
						},
					]
				: [],
			defaultModel: models ? "claude-sonnet" : null,
		});
		return client;
	});
	useEffect(() => () => queryClient.clear(), [queryClient]);
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const meta = preview.meta({
	title: "Product/NewAgentDialog",
	component: NewAgentDialog,
	tags: ["ai-generated"],
	args: { onCreated: fn(async () => {}) },
	render: (args) => (
		<Preview models>
			<Dialog open>
				<NewAgentDialog {...args} />
			</Dialog>
		</Preview>
	),
});

/** Opened from a pod: the face as it is chosen, a name, and the pod stated. */
export const InAPod = meta.story({
	args: { podId: revenue.id, pods: [revenue] },
	play: async ({ userEvent }) => {
		const dialog = await screen.findByRole("dialog", { name: "New bot" });
		await expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();
		await userEvent.click(within(dialog).getByRole("radio", { name: "purple" }));
		await userEvent.click(within(dialog).getByRole("radio", { name: "arc" }));
		await userEvent.type(within(dialog).getByLabelText("Name"), "Support Desk");
		await expect(within(dialog).getByText("Revenue")).toBeInTheDocument();
		await expect(within(dialog).getByRole("button", { name: "Create" })).toBeEnabled();
	},
});

/** Opened from Bots: the pod is chosen from those the viewer may add to. */
export const ChoosingAPod = meta.story({
	args: { pods: [revenue, engineering, personal] },
	play: async ({ userEvent }) => {
		const dialog = await screen.findByRole("dialog", { name: "New bot" });
		await userEvent.click(within(dialog).getByRole("button", { name: "Pod: Revenue" }));
		await expect(within(dialog).getByRole("list", { name: "Pods" })).toBeInTheDocument();
		await userEvent.click(within(dialog).getByRole("button", { name: /Engineering/ }));
		await expect(
			within(dialog).getByRole("button", { name: "Pod: Engineering" }),
		).toBeInTheDocument();
	},
});

/** Before any model is connected, it says where to connect one, and cannot make the bot yet. */
export const NoModelYet = meta.story({
	args: { podId: revenue.id, pods: [revenue] },
	render: (args) => (
		<Preview models={false}>
			<Dialog open>
				<NewAgentDialog {...args} />
			</Dialog>
		</Preview>
	),
	play: async ({ userEvent }) => {
		const dialog = await screen.findByRole("dialog", { name: "New bot" });
		await userEvent.type(within(dialog).getByLabelText("Name"), "Support Desk");
		await expect(within(dialog).getByText(/Connect a model first/)).toBeInTheDocument();
		await expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();
	},
});

/** By default the bot interviews its creator, so it is created without a prompt. */
export const InterviewByDefault = meta.story({
	args: { podId: revenue.id, pods: [revenue] },
	beforeEach({ msw }) {
		created = [];
		msw.use(createAgent, listAgents);
	},
	play: async ({ args, userEvent }) => {
		const dialog = await screen.findByRole("dialog", { name: "New bot" });
		await userEvent.type(within(dialog).getByLabelText("Name"), "Support Desk");
		await expect(within(dialog).getByRole("radio", { name: "Interview me" })).toBeChecked();
		await expect(
			within(dialog).getByText(/Support Desk will ask what it's for/),
		).toBeInTheDocument();
		await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
		await waitFor(() => expect(args.onCreated).toHaveBeenCalled());
		await expect(created).toEqual([expect.not.objectContaining({ prompt: expect.anything() })]);
	},
});

/** Writing its instructions instead: they are created with the bot, and may be left blank. */
export const WritingItsInstructions = meta.story({
	args: { podId: revenue.id, pods: [revenue] },
	beforeEach({ msw }) {
		created = [];
		msw.use(createAgent, listAgents);
	},
	play: async ({ args, userEvent }) => {
		const dialog = await screen.findByRole("dialog", { name: "New bot" });
		await userEvent.type(within(dialog).getByLabelText("Name"), "Support Desk");
		await userEvent.click(within(dialog).getByRole("radio", { name: "Write my own" }));
		await userEvent.type(
			within(dialog).getByRole("textbox", { name: "Instructions" }),
			"You answer support tickets.",
		);
		await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
		await waitFor(() => expect(args.onCreated).toHaveBeenCalled());
		await expect(created).toEqual([
			expect.objectContaining({ prompt: "You answer support tickets." }),
		]);
	},
});
