import type { Bot, Project, ProjectComputerNetwork } from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { type ReactNode, useEffect, useState } from "react";
import { expect, waitFor } from "storybook/test";
import preview from "#storybook/preview";
import { storyBots } from "@/shell/story-fixtures.ts";
import { SettingsPage } from "@/ui/settings-page.tsx";
import { storyProjects } from "../story-app.tsx";
import { ProjectComputerNetworkSettings } from "./ProjectComputerNetworkSettings.tsx";

const project = storyProjects[0] as Project;
const bot = storyBots[0] as Bot;
/** The project, to someone who may not change its computer. */
const projectReadOnly: Project = {
	...project,
	permissions: {
		...project.permissions,
		resources: { ...project.permissions.resources, manageComputer: false },
	},
};
/** The bot, to someone who may not change its computer. */
const botReadOnly: Bot = {
	...bot,
	permissions: {
		...bot.permissions,
		resources: { ...bot.permissions.resources, manageComputer: false },
	},
};
const networkUrl = (projectId: string) =>
	`${import.meta.env.VITE_API_URL}/projects/${projectId}/computer/network`;

const network: ProjectComputerNetwork = {
	mode: "allowed-hosts-only",
	blocking: true,
	workspaceHosts: [
		{ host: "github.com", blockedBy: null },
		{ host: "registry.npmjs.org", blockedBy: null },
		{ host: "api.example.com", blockedBy: "api.example.com" },
	],
	addedHosts: [
		{
			host: "api.stripe.com",
			addedByName: "Sam Rivera",
			blockedBy: null,
		},
		{
			host: "*.pastebin.com",
			addedByName: "Kim Park",
			blockedBy: "*.pastebin.com",
		},
	],
};

function Preview({ children }: { children: ReactNode }) {
	const [queryClient] = useState(
		() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }),
	);
	useEffect(() => () => queryClient.clear(), [queryClient]);
	return (
		<QueryClientProvider client={queryClient}>
			<div className="flex min-h-screen flex-col bg-background">
				<SettingsPage title={project.name}>{children}</SettingsPage>
			</div>
		</QueryClientProvider>
	);
}

/** The network answers with `shown`, for the project and for the bot's default project. */
const answers = (shown: ProjectComputerNetwork) => [
	http.get(networkUrl(project.id), () => HttpResponse.json(shown)),
	http.get(networkUrl(bot.defaultProjectId), () => HttpResponse.json(shown)),
];

/** The hosts the stories' Add and Remove sent, newest last. */
const sent: string[] = [];

const meta = preview.meta({
	title: "Views/ProjectComputerNetworkSettings",
	component: ProjectComputerNetworkSettings,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: { owner: { project } },
	decorators: [
		(Story, context) => (
			<Preview key={context.id}>
				<Story />
			</Preview>
		),
	],
	beforeEach({ msw }) {
		sent.length = 0;
		msw.use(
			...answers(network),
			http.post(`${networkUrl(project.id)}/hosts`, async ({ request }) => {
				const { host } = (await request.json()) as { host: string };
				sent.push(`add ${host}`);
				return HttpResponse.json(network);
			}),
			http.delete(`${networkUrl(project.id)}/hosts/:host`, ({ params }) => {
				sent.push(`remove ${String(params.host)}`);
				return HttpResponse.json(network);
			}),
		);
	},
});

/**
 * The project's own hosts, one of them kept out by the workspace's block, to
 * someone who may change them.
 */
export const ProjectHosts = meta.story({
	play: async ({ canvas, userEvent }) => {
		await expect(await canvas.findByText(/Added by Sam Rivera/)).toBeVisible();
		await expect(canvas.getByText(/Blocked for the workspace by \*\.pastebin\.com/)).toBeVisible();

		await userEvent.type(canvas.getByLabelText("Add host"), "Docs.Example.com");
		await userEvent.click(canvas.getByRole("button", { name: "Add" }));
		await waitFor(() => expect(sent).toContain("add docs.example.com"));

		await userEvent.click(canvas.getByRole("button", { name: "Remove api.stripe.com" }));
		await waitFor(() => expect(sent).toContain("remove api.stripe.com"));
	},
});

/** The workspace's hosts every computer reaches, less the blocked, listed once asked for. */
export const FromTheWorkspace = meta.story({
	play: async ({ canvas, userEvent }) => {
		await expect(await canvas.findByText(/2 hosts every computer reaches/)).toBeVisible();
		await userEvent.click(canvas.getByText("From the workspace"));
		await expect(canvas.getByText("github.com, registry.npmjs.org")).toBeVisible();
	},
});

/** Someone who may not change the project's hosts sees them, without adding or removing. */
export const ReadOnly = meta.story({
	args: { owner: { project: projectReadOnly } },
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("api.stripe.com")).toBeVisible();
		await expect(canvas.queryByLabelText("Add host")).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Remove api.stripe.com" })).toBeNull();
		await expect(canvas.getByText(/someone who manages the project decides/)).toBeVisible();
	},
});

/** A bot's computer, its default project's, is worded as the bot's. */
export const ABotsComputer = meta.story({
	args: { owner: { bot: botReadOnly } },
	play: async ({ canvas }) => {
		await expect(await canvas.findByText(/This bot's computer connects/)).toBeVisible();
		await expect(canvas.getByText(/someone who manages the bot decides/)).toBeVisible();
	},
});

/** The workspace's computers are open: the project has no hosts of its own to add. */
export const Open = meta.story({
	beforeEach({ msw }) {
		msw.use(...answers({ ...network, mode: "open" }));
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByText(/Any host the workspace hasn't blocked/)).toBeVisible();
		await expect(canvas.queryByLabelText("Add host")).toBeNull();
		await expect(canvas.queryByText("api.stripe.com")).toBeNull();
	},
});

/** Open at a provider that can't block hosts: every host. */
export const OpenWithoutBlocking = meta.story({
	beforeEach({ msw }) {
		msw.use(...answers({ ...network, mode: "open", blocking: false }));
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("Any host")).toBeVisible();
	},
});
