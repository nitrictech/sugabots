import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { type ReactNode, useEffect, useState } from "react";
// The dialog is portalled to the body, so reaching it means `screen`.
import { expect, fn, screen, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { Dialog } from "@/ui/dialog.tsx";
import { NewBotDialog } from "./NewBot.tsx";
import { growthDesk, projectsWithBots, revenue } from "./story-fixtures.test-support.ts";

const WORKSPACE = revenue.workspaceId;
const API = import.meta.env.VITE_API_URL;

/** The bodies of the create requests a story sends, to check what the bot was made with. */
let created: Record<string, unknown>[] = [];
const createBot = http.post(`${API}/workspaces/:workspace/bots`, async ({ request }) => {
	const body = (await request.json()) as Record<string, unknown>;
	created.push(body);
	return HttpResponse.json({ ...growthDesk, ...body }, { status: 201 });
});
/** The roster, which creating a bot fetches again. */
const listBots = http.get(`${API}/workspaces/:workspace/bots`, () =>
	HttpResponse.json(projectsWithBots.flatMap(({ bots }) => bots)),
);

function Preview({ models, children }: { models: boolean; children: ReactNode }) {
	const [queryClient] = useState(() => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		client.setQueryData(["workspaces"], [{ id: WORKSPACE, name: "Nitric", slug: "nitric" }]);
		client.setQueryData(
			["bots", WORKSPACE],
			projectsWithBots.flatMap(({ bots }) => bots),
		);
		client.setQueryData(["models", WORKSPACE], {
			models: models
				? [
						{
							providerId: "0199a3a0-0000-7000-8000-000000000201",
							providerName: "Anthropic",
							providerBuiltIn: "anthropic",
							modelId: "claude-sonnet",
							displayName: "Claude Sonnet",
							capabilities: ["tools", "vision", "thinking"],
						},
						{
							providerId: "0199a3a0-0000-7000-8000-000000000202",
							providerName: "OpenAI",
							providerBuiltIn: "openai",
							modelId: "gpt-5",
							displayName: "GPT-5",
							capabilities: ["tools", "vision", "thinking"],
						},
						{
							providerId: "0199a3a0-0000-7000-8000-000000000201",
							providerName: "Anthropic",
							providerBuiltIn: "anthropic",
							modelId: "claude-haiku",
							displayName: "Claude Haiku",
							capabilities: ["tools", "vision"],
						},
						{
							providerId: "0199a3a0-0000-7000-8000-000000000202",
							providerName: "OpenAI",
							providerBuiltIn: "openai",
							modelId: "gpt-5-mini",
							displayName: "GPT-5 mini",
							capabilities: ["tools"],
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
	title: "Product/NewBotDialog",
	component: NewBotDialog,
	tags: ["ai-generated"],
	args: { onCreated: fn(async () => {}) },
	render: (args) => (
		<Preview models>
			<Dialog open>
				<NewBotDialog {...args} />
			</Dialog>
		</Preview>
	),
});

/**
 * Opened from a project: a row of avatars drawn at random and a model, beside the
 * bot as it will be, named over it.
 */
export const InAProject = meta.story({
	play: async ({ userEvent }) => {
		const dialog = await screen.findByRole("dialog", { name: "New bot" });
		await expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();
		const avatars = within(within(dialog).getByRole("group", { name: "Avatars" })).getAllByRole(
			"radio",
		);
		await expect(avatars).toHaveLength(7);
		await expect(avatars[0]).toBeChecked();
		await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "Support Desk");
		await expect(within(dialog).getByRole("button", { name: /^Claude Sonnet/ })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await expect(within(dialog).getByRole("button", { name: "Create" })).toBeEnabled();
	},
});

/** Before any model is connected, it says where to connect one, and cannot make the bot yet. */
export const NoModelYet = meta.story({
	render: (args) => (
		<Preview models={false}>
			<Dialog open>
				<NewBotDialog {...args} />
			</Dialog>
		</Preview>
	),
	play: async ({ userEvent }) => {
		const dialog = await screen.findByRole("dialog", { name: "New bot" });
		await userEvent.type(within(dialog).getByLabelText("Name"), "Support Desk");
		await expect(within(dialog).getByText(/No models are switched on yet/)).toBeInTheDocument();
		await expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();
	},
});

/**
 * The + opens the chosen look's colour, head and eyes; the bot is made as it
 * is shown, without instructions, so it starts by asking what it's for.
 */
export const MadeAsShown = meta.story({
	beforeEach({ msw }) {
		created = [];
		msw.use(createBot, listBots);
	},
	play: async ({ args, userEvent }) => {
		const dialog = await screen.findByRole("dialog", { name: "New bot" });
		await userEvent.click(within(dialog).getByRole("button", { name: "Colour, shape and eyes" }));
		await userEvent.click(within(dialog).getByRole("radio", { name: "teal" }));
		await userEvent.click(within(dialog).getByRole("radio", { name: "star" }));
		await userEvent.click(within(dialog).getByRole("tab", { name: "Eyes" }));
		await userEvent.click(within(dialog).getByRole("radio", { name: "wink" }));
		await userEvent.click(within(dialog).getByRole("button", { name: "Back" }));
		await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "Support Desk");
		await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
		await waitFor(() => expect(args.onCreated).toHaveBeenCalled());
		await expect(created).toEqual([
			expect.objectContaining({
				name: "Support Desk",
				color: "teal",
				shape: "star",
				eyes: "wink",
				model: "claude-sonnet",
			}),
		]);
		await expect(created).toEqual([
			expect.not.objectContaining({ instructions: expect.anything() }),
		]);
	},
});

/**
 * Who can see the new bot, chosen beside its name: Public, Private or
 * Personal, with a line saying what the choice means. A private bot is made
 * with its creator and the admins as its members.
 */
export const MadePrivate = meta.story({
	beforeEach({ msw }) {
		created = [];
		msw.use(createBot, listBots);
	},
	play: async ({ args, userEvent }) => {
		const dialog = await screen.findByRole("dialog", { name: "New bot" });
		const choice = within(dialog).getByRole("group", { name: "Who can see it" });
		await expect(within(choice).getByRole("radio", { name: "Public" })).toBeChecked();
		await expect(
			within(dialog).getByText("Everyone in the workspace can see it and talk to it."),
		).toBeInTheDocument();
		await userEvent.click(within(choice).getByRole("radio", { name: "Private" }));
		await expect(
			within(dialog).getByText("Only you, admins and the members you invite can see it."),
		).toBeInTheDocument();
		await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "Payroll");
		await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
		await waitFor(() => expect(args.onCreated).toHaveBeenCalled());
		await expect(created).toEqual([expect.objectContaining({ visibility: "private" })]);
	},
});

/** The × discards a bot that has a name and a model, rather than making it. */
export const ClosedWithoutMaking = meta.story({
	beforeEach({ msw }) {
		created = [];
		msw.use(createBot, listBots);
	},
	play: async ({ args, userEvent }) => {
		const dialog = await screen.findByRole("dialog", { name: "New bot" });
		await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "Support Desk");
		const close = within(dialog).getByRole("button", { name: "Close" });
		await userEvent.click(close);
		await expect(args.onCreated).not.toHaveBeenCalled();
		await expect(created).toEqual([]);
	},
});

/**
 * The models fill the right: Suggested first, with the default, then each
 * provider's, with what each can do; a search narrows a long list.
 */
export const ChoosingAModel = meta.story({
	play: async ({ userEvent }) => {
		const dialog = await screen.findByRole("dialog", { name: "New bot" });
		const models = within(dialog).getByRole("region", { name: "Model" });
		const suggested = within(models).getByRole("region", { name: "Suggested" });
		const sonnet = within(suggested).getByRole("button", { name: /^Claude Sonnet/ });
		await expect(sonnet).toHaveAttribute("aria-pressed", "true");
		await expect(sonnet).toHaveTextContent("Default");
		await expect(sonnet).toHaveTextContent("reads images");
		await expect(within(models).getByRole("region", { name: "OpenAI" })).toBeInTheDocument();
		await userEvent.type(within(models).getByRole("searchbox", { name: "Search models" }), "gpt");
		await expect(within(models).queryByRole("region", { name: "Anthropic" })).toBeNull();
		const gpt = within(models).getByRole("button", { name: /^GPT-5 uses tools/ });
		await userEvent.click(gpt);
		await expect(gpt).toHaveAttribute("aria-pressed", "true");
	},
});
