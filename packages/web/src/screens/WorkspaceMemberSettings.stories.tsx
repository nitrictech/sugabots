import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { type ReactNode, useEffect, useState } from "react";
// A dialog is portalled to the body, so reaching it means `screen` rather
// than the story's own canvas.
import { expect, screen, within } from "storybook/test";
import preview from "#storybook/preview";
import {
	accountManager,
	engineering,
	growthDesk,
	leadResearcher,
	linearHandler,
	oncall,
	revenue,
} from "@/shell/story-fixtures.ts";
import { WorkspaceMemberSettings } from "./WorkspaceMemberSettings.tsx";

const workspace = {
	id: "0199a3a0-0000-7000-8000-000000000001",
	name: "Nitric",
	slug: "nitric",
	createdAt: "2026-09-01T00:00:00.000Z",
};

function member(n: number, name: string, email: string, role: string) {
	const memberId = `0199a3a0-0000-7000-8000-0000000000${String(n).padStart(2, "0")}`;
	return {
		id: `0199a3a0-0000-7000-8000-0000000000d${n}`,
		role,
		member: { id: memberId, name, email, image: null },
		joinedAt: `2026-09-0${n}T00:00:00.000Z`,
	};
}

const rowan = member(1, "Rowan Ellis", "rowan@example.com", "owner");
const jay = member(2, "Jay Young", "jay@nitric.io", "admin");
const mara = member(3, "Mara Kent", "mara@nitric.io", "editor");
const sam = member(4, "Sam Park", "sam@nitric.io", "viewer");

const inProject = (membership: typeof rowan) => ({
	memberId: membership.member.id,
	name: membership.member.name,
	email: membership.member.email,
	image: null,
	removable: membership.role !== "owner" && membership.role !== "admin",
});

const HOUR_MS = 60 * 60 * 1000;

/**
 * Somebody asked and not yet arrived, sent a day and a half ago. Expiring in
 * half a day, so the expiry copy reads the same whenever it runs.
 */
const alex = {
	id: "0199a3a0-0000-7000-8000-0000000000e1",
	email: "alex@nitric.io",
	role: "editor",
	sentAt: new Date(Date.now() - 36 * HOUR_MS).toISOString(),
	expiresAt: new Date(Date.now() + 12 * HOUR_MS).toISOString(),
};

const roster = `${import.meta.env.VITE_API_URL}/workspaces/:workspace`;

const refuses = (message: string) =>
	HttpResponse.json({ _tag: "BadRequest", message }, { status: 400 });

function SettingsPreview({ children }: { children: ReactNode }) {
	const [queryClient] = useState(() => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		// What a member's page reads besides the roster: the projects, their bots and who is in each.
		client.setQueryData(["workspaces"], [workspace]);
		client.setQueryData(
			["projects", workspace.id],
			[
				{ ...revenue, memberCount: 3 },
				{ ...engineering, memberCount: 2 },
			],
		);
		client.setQueryData(
			["bots", workspace.id],
			[growthDesk, accountManager, leadResearcher, linearHandler, oncall],
		);
		client.setQueryData(
			["project-members", revenue.id],
			[inProject(rowan), inProject(jay), inProject(mara)],
		);
		client.setQueryData(["project-members", engineering.id], [inProject(rowan), inProject(sam)]);
		return client;
	});
	useEffect(() => () => queryClient.clear(), [queryClient]);
	return (
		<QueryClientProvider client={queryClient}>
			<div className="flex min-h-screen flex-col bg-background">{children}</div>
		</QueryClientProvider>
	);
}

const meta = preview.meta({
	title: "Views/WorkspaceMemberSettings",
	component: WorkspaceMemberSettings,
	tags: ["ai-generated"],
	args: {
		workspaceId: workspace.id,
		canManage: true,
		canManageAdmins: true,
		canHandOverOwnership: true,
		currentUserId: rowan.member.id,
	},
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
			http.get(`${roster}/memberships`, () => HttpResponse.json([rowan, jay, mara, sam])),
			http.get(`${roster}/invitations`, () => HttpResponse.json([alex])),
			http.patch(`${roster}/memberships/:membershipId`, () =>
				refuses("This preview does not save role changes."),
			),
			http.delete(`${roster}/memberships/:membershipId`, () =>
				refuses("This preview does not remove anybody."),
			),
			http.put(`${roster}/owner`, () => refuses("This preview does not hand over ownership.")),
			http.post(`${roster}/invitations`, () => refuses("This preview does not send invitations.")),
		);
	},
});

/** Everybody with their role, you as You, and the invitation still out below them. */
export const Managing = meta.story({
	play: async ({ canvas }) => {
		const mara = await canvas.findByRole("link", { name: /Mara Kent/ });
		await expect(mara).toHaveTextContent("Editor");
		await expect(canvas.getByRole("link", { name: /Rowan Ellis/ })).toHaveTextContent("(you)");
		// Members and invitations are two requests, so the invitation is awaited.
		await expect(await canvas.findByText("alex@nitric.io")).toBeInTheDocument();
		await expect(canvas.getByText(/^Sent .+, expires in \d+ hours$/)).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Resend" })).toBeInTheDocument();
	},
});

/** Addresses in one field, and the role described as it is picked. */
export const Inviting = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Invite members" }));
		const dialog = await screen.findByRole("dialog", { name: "Invite members" });

		await expect(within(dialog).getByLabelText("Email addresses")).toBeInTheDocument();
		await expect(
			within(dialog).getByText("Makes bots and projects, and works with the public bots."),
		).toBeInTheDocument();
		await expect(within(dialog).getByRole("button", { name: "Send" })).toBeDisabled();
	},
});

/** Somebody else's page: their role, the projects they are in, when they joined, and removing them. */
export const Member = meta.story({
	args: { selectedMembershipId: mara.id },
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Mara Kent" })).toBeInTheDocument();
		await expect(canvas.getByRole("radio", { name: "Editor" })).toBeChecked();
		await expect(canvas.getByRole("switch", { name: "Mara Kent is in Revenue" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await expect(
			canvas.getByRole("switch", { name: "Mara Kent is in Engineering" }),
		).toHaveAttribute("aria-checked", "false");
		await expect(canvas.getByRole("button", { name: "Remove from workspace" })).toBeInTheDocument();
	},
});

/** The owner hands the workspace on from somebody else's page, after saying what it means. */
export const TransferringOwnership = meta.story({
	args: { selectedMembershipId: mara.id },
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Make Mara Kent the owner" }));

		const dialog = await screen.findByRole("dialog", { name: "Make Mara Kent the owner?" });
		await expect(dialog).toHaveTextContent("You stay on as an admin.");
		await userEvent.click(within(dialog).getByRole("button", { name: "Transfer" }));
		await expect(
			await within(dialog).findByText("This preview does not hand over ownership."),
		).toBeInTheDocument();
	},
});

/** The owner's own page: their role stated, and no way out until they hand the workspace on. */
export const You = meta.story({
	args: { selectedMembershipId: rowan.id },
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Rowan Ellis" })).toBeInTheDocument();
		await expect(canvas.getByText("Owner")).toBeInTheDocument();
		await expect(canvas.queryByRole("radio", { name: "Editor" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Leave workspace" })).toBeNull();
		await expect(
			canvas.getByText(/To leave, hand ownership over to somebody else first/),
		).toBeInTheDocument();
	},
});

/** An admin manages editors and viewers, but only the owner makes or unmakes an admin. */
export const AdminManaging = meta.story({
	args: {
		canManageAdmins: false,
		canHandOverOwnership: false,
		currentUserId: jay.member.id,
		selectedMembershipId: mara.id,
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("radio", { name: "Editor" })).toBeChecked();
		await expect(canvas.getByRole("radio", { name: "Viewer" })).toBeInTheDocument();
		await expect(canvas.queryByRole("radio", { name: "Admin" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: /the owner$/ })).toBeNull();
		await expect(canvas.getByRole("button", { name: "Remove from workspace" })).toBeInTheDocument();
	},
});

/** Nobody but the owner changes the owner: an admin reads their page and nothing more. */
export const AdminOnOwner = meta.story({
	args: {
		canManageAdmins: false,
		canHandOverOwnership: false,
		currentUserId: jay.member.id,
		selectedMembershipId: rowan.id,
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Rowan Ellis" })).toBeInTheDocument();
		await expect(canvas.getByText("Owner")).toBeInTheDocument();
		await expect(canvas.queryByRole("radio")).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Remove from workspace" })).toBeNull();
	},
});

/** Leaving says what it costs before it happens. */
export const Leaving = meta.story({
	args: {
		canManageAdmins: false,
		canHandOverOwnership: false,
		currentUserId: jay.member.id,
		selectedMembershipId: jay.id,
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Leave workspace" }));

		const dialog = await screen.findByRole("dialog");
		await expect(dialog).toHaveTextContent("somebody inviting you again");
	},
});

/** Reading is everybody else: the same pages, stated rather than editable. */
export const Reading = meta.story({
	args: { canManage: false, currentUserId: mara.member.id, selectedMembershipId: sam.id },
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Sam Park" })).toBeInTheDocument();
		await expect(canvas.getByText("Viewer")).toBeInTheDocument();
		await expect(canvas.queryByRole("radio", { name: "Viewer" })).toBeNull();
		await expect(canvas.getByRole("switch", { name: "Sam Park is in Engineering" })).toBeDisabled();
		await expect(canvas.queryByRole("button", { name: "Remove from workspace" })).toBeNull();
	},
});
