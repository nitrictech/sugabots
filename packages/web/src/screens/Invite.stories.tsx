import { QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { type ReactNode, useState } from "react";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { createQueryClient } from "@/lib/query.ts";
import { Invite } from "./Invite.tsx";

/*
 * The other end of an invitation, once signed in: whose workspace it is and
 * Accept, or why it will not work.
 */

const API = import.meta.env.VITE_API_URL;
const ID = "0199a3a0-0000-7000-8000-0000000000e1";

function Cache({ children }: { children: ReactNode }) {
	const [client] = useState(() => createQueryClient());
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const meta = preview.meta({
	title: "Views/Invite",
	component: Invite,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: { id: ID, onDone: fn(async () => {}) },
	render: (args) => (
		<Cache>
			<div style={{ height: "100vh" }}>
				<Invite {...args} />
			</div>
		</Cache>
	),
});

/** Whose workspace it is, and Accept. */
export const Invited = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/invitations/:invitationId`, () =>
				HttpResponse.json({ status: "pending", workspaceName: "Nitric", inviterName: "Jay Young" }),
			),
		);
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "You have been invited to Nitric." }),
		).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Accept invite" })).toBeEnabled();
	},
});

/** Signed in as somebody else: says so, and offers carrying on without it. */
export const WrongAccount = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/invitations/:invitationId`, () =>
				HttpResponse.json(
					{ _tag: "Forbidden", message: "This invitation was sent to a different address" },
					{ status: 403 },
				),
			),
		);
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "This invitation did not work" }),
		).toBeInTheDocument();
		await expect(canvas.getByRole("alert")).toHaveTextContent(/different address/);
		await expect(canvas.getByRole("button", { name: "Carry on without it" })).toBeInTheDocument();
	},
});
