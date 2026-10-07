import type { AvailableRepositories, PodRepositories } from "@sugabots/contracts";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { SettingsPage } from "@/ui/settings-page.tsx";
import { RepositoriesGroup } from "./PodRepositories.tsx";

const GIT_HOST_ID = "0199b0f2-6a4e-7c1d-9a52-3c5e1f2d4b6a";

const repositories: PodRepositories = {
	repositories: [
		{
			gitHostId: GIT_HOST_ID,
			repository: "acme/web",
			addedByName: "Sam Rivera",
			addedAt: "2026-10-05T09:30:00.000Z",
		},
		{
			gitHostId: GIT_HOST_ID,
			repository: "acme/infra",
			addedByName: null,
			addedAt: "2026-10-06T01:10:00.000Z",
		},
	],
};

const available: AvailableRepositories = [
	{ gitHostId: GIT_HOST_ID, repository: "acme/web", private: true },
	{ gitHostId: GIT_HOST_ID, repository: "acme/infra", private: true },
	{ gitHostId: GIT_HOST_ID, repository: "acme/docs", private: false },
];

const meta = preview.meta({
	title: "Views/PodRepositories",
	component: RepositoriesGroup,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: {
		repositories,
		available,
		pending: false,
		onAdd: fn(async () => undefined),
		onRemove: fn(),
	},
	decorators: [
		(Story) => (
			<div className="flex min-h-screen flex-col bg-background">
				<SettingsPage title="Builders">
					<Story />
				</SettingsPage>
			</div>
		),
	],
});

/** The pod's repositories, to someone who may add one the workspace's app reaches, or remove one. */
export const Repositories = meta.story({
	play: async ({ canvas, args, userEvent }) => {
		await expect(canvas.getByText("Added by Sam Rivera")).toBeVisible();
		await userEvent.click(canvas.getByRole("button", { name: "Remove acme/infra" }));
		await expect(args.onRemove).toHaveBeenCalledWith({
			gitHostId: GIT_HOST_ID,
			repository: "acme/infra",
		});
		await userEvent.type(canvas.getByLabelText("Add"), "acme/docs");
		await userEvent.click(canvas.getByRole("button", { name: "Add" }));
		await expect(args.onAdd).toHaveBeenCalledWith({
			gitHostId: GIT_HOST_ID,
			repository: "acme/docs",
		});
	},
});

/** A name no app reaches can't be added. */
export const Unreachable = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.type(canvas.getByLabelText("Add"), "someone/else");
		await expect(canvas.getByRole("button", { name: "Add" })).toBeDisabled();
	},
});

/** Someone who may not change the pod's sandbox sees its repositories without changing them. */
export const ReadOnly = meta.story({
	args: { available: undefined },
	play: async ({ canvas }) => {
		await expect(canvas.getByText("acme/web")).toBeVisible();
		await expect(canvas.queryByRole("button", { name: "Remove acme/web" })).toBeNull();
		await expect(canvas.queryByLabelText("Add")).toBeNull();
	},
});

/** No repositories, and no installed app to add one from. */
export const NoApp = meta.story({
	args: { repositories: { repositories: [] }, available: [] },
	play: async ({ canvas }) => {
		await expect(canvas.getByText("None yet")).toBeVisible();
		await expect(canvas.getByText(/Install a GitHub App/)).toBeVisible();
	},
});
