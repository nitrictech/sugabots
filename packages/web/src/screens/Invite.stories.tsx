import { QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { type ReactNode, useState } from "react";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { createQueryClient } from "@/lib/query.ts";
import { Invite } from "./Invite.tsx";

/*
 * The other end of an invitation, once signed in: whose workspace it is and
 * Accept, or why it will not work. It first tries to finish an invitation
 * already accepted, which a fresh one refuses, then reads the invitation.
 */

const API = import.meta.env.VITE_API_URL;
const ID = "0199a3a0-0000-7000-8000-0000000000e1";

const notYetAccepted = http.post(`${API}/onboarding/complete-invite`, () =>
	HttpResponse.json({ _tag: "BadRequest", message: "No accepted invitation" }, { status: 400 }),
);

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
			notYetAccepted,
			http.get(`${API}/auth/organization/get-invitation`, () =>
				HttpResponse.json({
					id: ID,
					email: "ryan@nitric.io",
					role: "member",
					status: "pending",
					organizationId: "0199a3a0-0000-7000-8000-000000000001",
					organizationName: "Nitric",
					organizationSlug: "nitric",
					inviterEmail: "jay@nitric.io",
					inviterId: "0199a3a0-0000-7000-8000-00000000000a",
					expiresAt: "2026-09-28T00:00:00.000Z",
				}),
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
			notYetAccepted,
			http.get(`${API}/auth/organization/get-invitation`, () =>
				HttpResponse.json(
					{ code: "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION", message: "Not the recipient" },
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
