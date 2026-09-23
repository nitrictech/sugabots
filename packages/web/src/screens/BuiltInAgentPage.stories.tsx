import type { SystemAgent } from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { type ReactNode, useEffect, useState } from "react";
// A combobox's listbox is portalled to the body, so reaching an option means
// `screen` rather than the story's own canvas.
import { expect, screen } from "storybook/test";
import preview from "#storybook/preview";
import { BuiltInAgentPage } from "./BuiltInAgentsSettings.tsx";

/*
 * The Facilitator's own page, in the states that matter: before a model has
 * been chosen, after, and for somebody who may not choose one.
 *
 * `BuiltInAgentPage` is deliberately router-free — its back control is a
 * callback, not a Link — which is what lets it be driven here without router
 * scaffolding. The section around it (`BuiltInAgentsSettings`) owns the links,
 * and is covered by the shell tests instead.
 */

const workspace = {
	id: "0199a3a0-0000-7000-8000-000000000001",
	name: "Suga Workspace",
	slug: "suga",
	createdAt: "2026-09-01T00:00:00.000Z",
};

const facilitator: SystemAgent = {
	key: "facilitate",
	name: "Facilitator",
	description: "Decides who speaks next when nobody was addressed.",
	hue: 205,
	face: "bar",
	model: "claude-sonnet-4-20250514",
};

const notSetUp: SystemAgent = { ...facilitator, model: null };

const modelsUrl = `${import.meta.env.VITE_API_URL}/workspaces/${workspace.id}/model-providers/models`;
const systemAgentsUrl = `${import.meta.env.VITE_API_URL}/workspaces/${workspace.id}/system-agents`;

const models = {
	models: [
		{
			modelId: "claude-sonnet-4-20250514",
			providerId: "0199a3a0-0000-7000-8000-000000000002",
			providerName: "Anthropic",
			providerPreset: "anthropic" as const,
		},
		{
			modelId: "claude-3-5-haiku-20241022",
			providerId: "0199a3a0-0000-7000-8000-000000000002",
			providerName: "Anthropic",
			providerPreset: "anthropic" as const,
		},
	],
};

function SettingsPreview({ children }: { children: ReactNode }) {
	const [queryClient] = useState(
		() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }),
	);
	useEffect(() => () => queryClient.clear(), [queryClient]);
	return (
		<QueryClientProvider client={queryClient}>
			<div className="flex h-screen flex-col bg-card">{children}</div>
		</QueryClientProvider>
	);
}

const meta = preview.meta({
	title: "Views/BuiltInAgentPage",
	component: BuiltInAgentPage,
	tags: ["ai-generated"],
	args: { agent: facilitator, canEdit: true, onBack: () => {} },
	parameters: {
		layout: "fullscreen",
		// Inline docs examples share MSW handlers; separate frames keep their responses independent.
		docs: { story: { inline: false, height: "620px" } },
	},
	decorators: [
		(Story, context) => (
			<SettingsPreview key={context.id}>
				<Story />
			</SettingsPreview>
		),
	],
	beforeEach({ msw }) {
		msw.use(
			http.get(`${import.meta.env.VITE_API_URL}/auth/organization/list`, () =>
				HttpResponse.json([workspace]),
			),
			http.get(modelsUrl, () => HttpResponse.json(models)),
			http.get(systemAgentsUrl, () => HttpResponse.json([notSetUp, facilitator])),
			http.patch(`${systemAgentsUrl}/*`, () =>
				HttpResponse.json(
					{ error: { code: "internal", message: "This preview does not save the model." } },
					{ status: 503 },
				),
			),
		);
	},
});

/**
 * NotSetUp is the state this screen exists for: a fresh workspace, where the
 * agent has no model and therefore is not running. It names the consequence
 * rather than only reporting that something is unconfigured.
 */
export const NotSetUp = meta.story({
	args: { agent: notSetUp },
	play: async ({ canvas }) => {
		await expect(await canvas.findByText(/no pod can hand it the floor/)).toBeVisible();
		await expect(canvas.queryByRole("button", { name: "Run the check" })).toBeNull();
		// Nothing to clear when nothing is chosen.
		await expect(canvas.queryByRole("button", { name: "Clear the model" })).toBeNull();
	},
});

/** Configured shows the agent running, with the model check available beside the picker. */
export const Configured = meta.story({
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("combobox", { name: "Model" })).toHaveValue(
			"claude-sonnet-4-20250514",
		);
		await expect(await canvas.findByRole("button", { name: "Run the check" })).toBeVisible();
	},
});

/**
 * ClearingTheModel is the way back to NotSetUp: taking the model away is how a
 * built-in agent is switched off, so the control sits in the picker rather than
 * being a separate switch that would mean the same thing twice.
 */
export const ClearingTheModel = meta.story({
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("button", { name: "Clear the model" })).toBeVisible();
	},
});

/** ChoosingAModel opens the picker against the workspace's enabled models. */
export const ChoosingAModel = meta.story({
	args: { agent: notSetUp },
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Choose a model" }));
		await expect(
			await screen.findByRole("option", { name: "claude-3-5-haiku-20241022" }),
		).toBeVisible();
	},
});

/**
 * ReadOnly is what somebody who may not configure the workspace sees: the model
 * stated, no picker, no check, and a line saying who chooses it.
 */
export const ReadOnly = meta.story({
	args: { agent: notSetUp, canEdit: false },
	play: async ({ canvas }) => {
		await expect(await canvas.findByText(/A workspace administrator chooses/)).toBeVisible();
		await expect(canvas.getByText("No model chosen yet")).toBeVisible();
		await expect(canvas.queryByRole("combobox", { name: "Model" })).toBeNull();
	},
});

/** Narrow checks the page holds together at phone width, where the rail is hidden. */
export const Narrow = meta.story({
	args: { agent: notSetUp },
	globals: { viewport: { value: "mobile1" } },
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Facilitator" })).toBeVisible();
		await expect(canvas.getByRole("button", { name: "Back to built-in agents" })).toBeVisible();
	},
});
