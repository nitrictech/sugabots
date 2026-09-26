import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
// The dialog is portalled to the body, so reaching it means `screen`.
import { expect, fn, screen, within } from "storybook/test";
import preview from "#storybook/preview";
import { Dialog } from "@/ui/dialog.tsx";
import { NewPodDialog } from "./NewPod.tsx";

function Preview({ children }: { children: React.ReactNode }) {
	const [queryClient] = useState(
		() => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
	);
	useEffect(() => () => queryClient.clear(), [queryClient]);
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const meta = preview.meta({
	title: "Product/NewPodDialog",
	component: NewPodDialog,
	tags: ["ai-generated"],
	args: { onCreated: fn(async () => {}) },
	render: (args) => (
		<Preview>
			<Dialog open>
				<NewPodDialog {...args} />
			</Dialog>
		</Preview>
	),
});

/** Opened: the empty tile a pod starts as, and Create waiting for a name. */
export const Empty = meta.story({
	play: async () => {
		const dialog = await screen.findByRole("dialog", { name: "New pod" });
		await expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();
		await expect(
			within(dialog).getByText(/You'll add bots, people and connections next/),
		).toBeInTheDocument();
	},
});

/** Named, and ready to make. */
export const Named = meta.story({
	play: async ({ userEvent }) => {
		const dialog = await screen.findByRole("dialog", { name: "New pod" });
		await userEvent.type(within(dialog).getByLabelText("Name"), "Support");
		await expect(within(dialog).getByRole("button", { name: "Create" })).toBeEnabled();
	},
});
