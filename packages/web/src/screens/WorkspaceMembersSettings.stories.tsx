import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { type ReactNode, useEffect, useState } from "react";
// A dialog and a select's listbox are portalled to the body, so reaching them
// means `screen` rather than the story's own canvas.
import { expect, screen, within } from "storybook/test";
import preview from "#storybook/preview";
import { WorkspaceMembersSettings } from "./WorkspaceMembersSettings.tsx";

const workspace = {
	id: "0199a3a0-0000-7000-8000-000000000001",
	name: "Suga Workspace",
	slug: "suga",
	createdAt: "2026-09-01T00:00:00.000Z",
};

const ada = {
	id: "0199a3a0-0000-7000-8000-0000000000d1",
	organizationId: workspace.id,
	userId: "0199a3a0-0000-7000-8000-000000000009",
	role: "admin",
	createdAt: "2026-09-01T00:00:00.000Z",
	user: { id: "0199a3a0-0000-7000-8000-000000000009", name: "Ada", email: "ada@example.com" },
};

const jye = {
	id: "0199a3a0-0000-7000-8000-0000000000d2",
	organizationId: workspace.id,
	userId: "0199a3a0-0000-7000-8000-00000000000a",
	role: "member",
	createdAt: "2026-09-02T00:00:00.000Z",
	user: { id: "0199a3a0-0000-7000-8000-00000000000a", name: "Jye", email: "jye@example.com" },
};

const kim = {
	id: "0199a3a0-0000-7000-8000-0000000000d3",
	organizationId: workspace.id,
	userId: "0199a3a0-0000-7000-8000-00000000000b",
	role: "viewer",
	createdAt: "2026-09-03T00:00:00.000Z",
	user: { id: "0199a3a0-0000-7000-8000-00000000000b", name: "Kim", email: "kim@example.com" },
};

/** Somebody asked and not yet arrived: a row in the same list as the people. */
const dana = {
	id: "0199a3a0-0000-7000-8000-0000000000e1",
	email: "dana@studioform.co",
	role: "viewer",
	status: "pending",
	organizationId: workspace.id,
	inviterId: ada.userId,
	expiresAt: "2026-09-24T00:00:00.000Z",
};

const auth = `${import.meta.env.VITE_API_URL}/auth/organization`;

/** better-auth's refusal shape, which the SDK turns into this product's words. */
const refuses = (code: string, message: string) =>
	HttpResponse.json({ code, message }, { status: 400 });

function SettingsPreview({ children }: { children: ReactNode }) {
	const [queryClient] = useState(
		() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }),
	);
	useEffect(() => () => queryClient.clear(), [queryClient]);
	return (
		<QueryClientProvider client={queryClient}>
			<div className="flex h-screen flex-col bg-card p-6">{children}</div>
		</QueryClientProvider>
	);
}

const meta = preview.meta({
	title: "Views/WorkspaceMembersSettings",
	component: WorkspaceMembersSettings,
	tags: ["ai-generated"],
	args: { workspaceId: workspace.id, canManage: true, currentUserId: ada.userId },
	parameters: {
		layout: "fullscreen",
		// Inline docs examples share MSW handlers; separate frames keep their responses independent.
		docs: { story: { inline: false, height: "720px" } },
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
			http.get(`${auth}/list-members`, () =>
				HttpResponse.json({ members: [ada, jye, kim], total: 3 }),
			),
			http.get(`${auth}/list-invitations`, () => HttpResponse.json([dana])),
			http.post(`${auth}/update-member-role`, () =>
				refuses("PREVIEW", "This preview does not save access changes."),
			),
			http.post(`${auth}/remove-member`, () =>
				refuses("PREVIEW", "This preview does not remove anybody."),
			),
			http.post(`${auth}/invite-member`, () =>
				refuses("PREVIEW", "This preview does not send invitations."),
			),
		);
	},
});

/**
 * Managing is what an administrator sees: people and the invitation nobody has
 * accepted in one list, everybody else's access editable, and their own row
 * stated rather than editable. Demoting yourself would take away the control
 * needed to undo it, and the API only stops the very last administrator.
 */
export const Managing = meta.story({
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("combobox", { name: "Access for Jye" })).toBeVisible();
		// People and invitations are two requests, so the invitation is awaited.
		await expect(await canvas.findByText("dana@studioform.co")).toBeVisible();
		await expect(canvas.getByText("Invited, not yet accepted")).toBeVisible();

		await expect(canvas.getByText("you")).toBeVisible();
		await expect(canvas.queryByRole("combobox", { name: "Access for Ada" })).toBeNull();
	},
});

/** The invite panel, where the role is described at the moment it is picked. */
export const Inviting = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Invite people" }));
		const panel = await screen.findByRole("dialog");

		await expect(within(panel).getByLabelText("Email address")).toBeVisible();
		await expect(
			within(panel).getByText("Builds agents in the pods they are added to."),
		).toBeVisible();
		await expect(
			within(panel).getByText("Reads and takes part in the pods they are added to."),
		).toBeVisible();
	},
});

/**
 * ChoosingARole leaves the role menu open, because that is the state worth
 * looking at: each option carries a sentence, so the menu is sized to the
 * sentences rather than to the trigger it hangs from.
 */
export const ChoosingARole = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("combobox", { name: "Access for Jye" }));

		const options = await screen.findAllByRole("option");
		await expect(options).toHaveLength(3);
		await expect(
			within(options[1] as HTMLElement).getByText("Builds agents in the pods they are added to."),
		).toBeVisible();

		// Wide enough that a description is one or two lines, not a column of
		// single words: the whole point of putting it here.
		const menu = options[0]?.closest("[data-slot=select-content]");
		await expect((menu as HTMLElement).getBoundingClientRect().width).toBeGreaterThan(280);
	},
});

/** An invitation's own menu: copy the link, send it again, or withdraw it. */
export const PendingInvitation = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: "Invitation for dana@studioform.co options" }),
		);

		await expect(
			await screen.findByRole("menuitem", { name: "Copy invitation link" }),
		).toBeVisible();
		await expect(screen.getByRole("menuitem", { name: "Send it again" })).toBeVisible();
		await expect(screen.getByRole("menuitem", { name: "Revoke invitation" })).toBeVisible();
	},
});

/** Leaving is the one thing your own row offers, and it says what it costs. */
export const Leaving = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Ada options" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: "Leave workspace" }));

		const dialog = await screen.findByRole("dialog");
		await expect(dialog).toHaveTextContent("somebody inviting you again");
	},
});

/** Reading is everybody else: the same roster, stated rather than editable. */
export const Reading = meta.story({
	args: { canManage: false, currentUserId: jye.userId },
	play: async ({ canvas }) => {
		// Kim holds Viewer and the outstanding invitation is for one too, so the
		// roles are read from their own rows rather than from the page.
		const kimRow = (await canvas.findByText("kim@example.com")).closest("li");
		await expect(within(kimRow as HTMLElement).getByText("Viewer")).toBeVisible();
		await expect(await canvas.findByText("Administrator")).toBeVisible();
		await expect(canvas.queryByRole("combobox", { name: "Access for Jye" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Invite people" })).toBeNull();
	},
});

/**
 * Removing asks first, and says what goes with the person — their Personal pod
 * is deleted with their membership, which is not obvious from "remove".
 */
export const Removing = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Jye options" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: "Remove from workspace" }));

		const dialog = await screen.findByRole("dialog");
		await expect(dialog).toHaveTextContent("their Personal pod and its conversations are deleted");
	},
});

/**
 * LastAdministrator shows better-auth's refusal in this product's words: it
 * says organization and owner, and people here read workspace and
 * administrator.
 */
export const LastAdministrator = meta.story({
	// Looking as Jye, so the administrator being demoted is somebody else's row.
	args: { currentUserId: jye.userId },
	beforeEach({ msw }) {
		msw.use(
			http.get(`${auth}/list-members`, () => HttpResponse.json({ members: [ada, jye], total: 2 })),
			http.get(`${auth}/list-invitations`, () => HttpResponse.json([])),
			http.post(`${auth}/update-member-role`, () =>
				refuses(
					"YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER",
					"You cannot leave the organization as the only owner",
				),
			),
		);
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("combobox", { name: "Access for Ada" }));
		await userEvent.click(await screen.findByRole("option", { name: /Member/ }));

		await expect(
			await canvas.findByText("A workspace needs at least one administrator"),
		).toBeVisible();
	},
});

/** Loading holds the roster request open so the loading state can be reviewed. */
export const Loading = meta.story({
	beforeEach({ msw }) {
		msw.use(http.get(`${auth}/list-members`, () => new Promise(() => {})));
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("Loading members…")).toBeVisible();
	},
});
