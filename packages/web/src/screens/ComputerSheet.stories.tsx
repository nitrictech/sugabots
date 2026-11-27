import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { expect, screen, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk } from "@/shell/story-fixtures.test-support.ts";
import { storyChatFor } from "@/story-app.test-support.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import { ComputerSheet } from "./ComputerSheet.tsx";

const meta = preview.meta({
	title: "Product/Computer Sheet",
	component: ComputerSheet,
	args: {
		bot: { ...growthDesk, usesComputer: false },
		chatId: storyChatFor(growthDesk).id,
		onDismiss: () => {},
		onOpenFull: () => {},
	},
	decorators: [
		function OpenSheet(Story) {
			const [client] = useState(() => {
				const queries = new QueryClient();
				queries.setQueryData(["computer-providers", undefined, "access"], { enabled: true });
				return queries;
			});
			return (
				<QueryClientProvider client={client}>
					<Dialog open>
						<Story />
					</Dialog>
				</QueryClientProvider>
			);
		},
	],
});

/** ComputerTurnedOff shows how someone who manages the computer can turn it on for the bot. */
export const ComputerTurnedOff = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	play: async () => {
		const sheet = within(await screen.findByRole("dialog", { name: "Growth Desk's computer" }));
		await waitFor(() =>
			expect(sheet.getByText("Growth Desk doesn't have a computer")).toBeVisible(),
		);
		await expect(sheet.getByRole("button", { name: "Turn on computer" })).toBeEnabled();
	},
});
