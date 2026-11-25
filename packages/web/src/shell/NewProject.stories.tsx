import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
// The dialog is portalled to the body, so reaching it means `screen`.
import { expect, fn, screen, within } from "storybook/test";
import preview from "#storybook/preview";
import { Dialog } from "@/ui/dialog.tsx";
import { NewProjectDialog } from "./NewProject.tsx";
import { growthDesk, projectsWithBots, revenue } from "./story-fixtures.test-support.ts";

const WORKSPACE = revenue.workspaceId;

function Preview({ children }: { children: React.ReactNode }) {
	const [queryClient] = useState(() => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		// The roster the lead bot is chosen from.
		client.setQueryData(["workspaces"], [{ id: WORKSPACE, name: "Nitric", slug: "nitric" }]);
		client.setQueryData(
			["bots", WORKSPACE],
			projectsWithBots.flatMap(({ bots }) => bots),
		);
		return client;
	});
	useEffect(() => () => queryClient.clear(), [queryClient]);
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const meta = preview.meta({
	title: "Product/NewProjectDialog",
	component: NewProjectDialog,
	tags: ["ai-generated"],
	args: { onCreated: fn(async () => {}) },
	render: (args) => (
		<Preview>
			<Dialog open>
				<NewProjectDialog {...args} />
			</Dialog>
		</Preview>
	),
});

/** Opened: the empty tile a project starts as, and Create waiting for a name and a lead bot. */
export const Empty = meta.story({
	play: async () => {
		const dialog = await screen.findByRole("dialog", { name: "New project" });
		await expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();
		await expect(within(dialog).getByText(/You can add members and bots next/)).toBeInTheDocument();
	},
});

/** Named and given a lead bot, and ready to make. */
export const Named = meta.story({
	play: async ({ userEvent }) => {
		const dialog = await screen.findByRole("dialog", { name: "New project" });
		await userEvent.type(within(dialog).getByLabelText("Name"), "Support");
		await expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();
		await userEvent.click(within(dialog).getByRole("button", { name: "Choose a lead bot" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: growthDesk.name }));
		await expect(
			within(dialog).getByRole("button", { name: `Lead bot: ${growthDesk.name}` }),
		).toBeInTheDocument();
		await expect(within(dialog).getByRole("button", { name: "Create" })).toBeEnabled();
	},
});

/** Opens on the first colour a new project takes, and another can be picked for the tile. */
export const Recoloured = meta.story({
	play: async ({ userEvent }) => {
		const dialog = await screen.findByRole("dialog", { name: "New project" });
		await expect(within(dialog).getByRole("radio", { name: "green" })).toBeChecked();
		await userEvent.click(within(dialog).getByRole("radio", { name: "plum" }));
		await expect(within(dialog).getByRole("radio", { name: "plum" })).toBeChecked();
	},
});
