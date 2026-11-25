import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { useState } from "react";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { InterruptTurnButton } from "./InterruptTurnButton.tsx";

const meta = preview.meta({
	title: "Product/InterruptTurnButton",
	component: InterruptTurnButton,
	decorators: [
		function WithQueries(Story) {
			const [client] = useState(() => new QueryClient());
			return (
				<QueryClientProvider client={client}>
					<Story />
				</QueryClientProvider>
			);
		},
	],
	args: {
		botName: "Issue Triager",
		chatId: "0199a3a0-0000-7000-8000-00000000000a",
		turnId: "0199a3a0-0000-7000-8000-000000000321",
	},
});

/** Available gives the asker a way to interrupt the bot’s writing reply. */
export const Available = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.post(
				`${import.meta.env.VITE_API_URL}/chats/:chatId/turns/:turnId/interrupt`,
				() => new HttpResponse(null, { status: 202 }),
			),
		);
	},
	play: async ({ canvas, userEvent }) => {
		const button = canvas.getByRole("button", { name: "Interrupt Issue Triager’s reply" });
		await expect(button).toBeEnabled();
		await userEvent.click(button);
		await expect(await canvas.findByRole("status")).toHaveTextContent("Interrupting…");
		await expect(button).toBeDisabled();
	},
});
