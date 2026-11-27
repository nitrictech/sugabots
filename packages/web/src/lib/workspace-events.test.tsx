import { type Bot, type BotMember, type Project, streamEvent } from "@sugabots/contracts";
import { NotFound, Unauthorized } from "@sugabots/contracts/http";
import { userText } from "@sugabots/errors";
import { screen, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiAnswers,
	bots,
	controlledEventStream,
	linear,
	mount,
	projects,
	sam,
	workspace,
} from "@/api.test-support.tsx";
import { client } from "@/client.test-support.ts";

vi.mock("@/api.ts", () => import("@/client.test-support.ts"));

/**
 * What the workspace's and the member's own streams keep fresh, as the
 * member sees it: each event is scripted onto a stream the app follows.
 */

beforeEach(() => {
	apiAnswers();
});

/** From now on the API says the member is a viewer, who may make nothing. */
function demotedToViewer() {
	client.api.workspaceAccess.mockReturnValue(
		Effect.succeed({
			role: "viewer",
			permissions: {
				createProjects: false,
				createBots: false,
				updateWorkspace: false,
				manageProviders: false,
				manageMembers: false,
				chooseSystemModel: false,
				manageUsage: false,
				manageAdmins: false,
				handOverOwnership: false,
				deleteWorkspace: false,
			},
		}),
	);
}

describe("the workspace's stream", () => {
	it("takes away what a member may no longer do once their role changes", async () => {
		const updates = controlledEventStream();
		client.events.workspace.mockReturnValue(updates.stream);
		mount("/suga/projects");
		await screen.findByRole("button", { name: "New project" });

		demotedToViewer();
		updates.emit(streamEvent("reach.changed", { about: { kind: "membership", memberId: sam.id } }));

		await waitFor(() => expect(screen.queryByRole("button", { name: "New project" })).toBeNull());
	});

	it.each(["ready", "reset"] as const)(
		"fetches the projects and what the member may do again on %s",
		async (restart) => {
			const updates = controlledEventStream();
			client.events.workspace.mockReturnValue(updates.stream);
			mount("/suga/projects");
			await screen.findByRole("button", { name: "New project" });

			const [listed] = projects;
			if (!listed) throw new Error("The fixtures have no project");
			const missed: Project = {
				...listed,
				id: "0199a3a0-0000-7000-8000-0000000000a9",
				workspaceId: workspace.id,
				name: "Made while away",
				slug: "made-while-away",
			};
			client.api.projects.list.mockReturnValue(Effect.succeed([...projects, missed]));
			demotedToViewer();
			updates.emit(streamEvent(restart));

			await waitFor(() => expect(screen.getAllByText("Made while away").length).toBeGreaterThan(0));
			await waitFor(() => expect(screen.queryByRole("button", { name: "New project" })).toBeNull());
		},
	);
	/** The workspace's stream, which the server ends for good with `refuse`. */
	function refusableWorkspaceStream() {
		const { promise: refusal, reject: refuse } = Promise.withResolvers<never>();
		client.events.workspace.mockReturnValue({
			// biome-ignore lint/correctness/useYield: a stream the server refuses yields nothing.
			async *[Symbol.asyncIterator]() {
				await refusal;
			},
			close: vi.fn(),
		});
		return refuse;
	}

	it("shows a private bot's members as they are once who reaches what changes", async () => {
		const updates = controlledEventStream();
		client.events.workspace.mockReturnValue(updates.stream);
		const diary: Bot = { ...linear, visibility: "private" };
		client.api.bots.list.mockReturnValue(
			Effect.succeed(bots.map((bot) => (bot.id === diary.id ? diary : bot))),
		);
		const robin: BotMember = {
			memberId: "0199a3a0-0000-7000-8000-0000000000c9",
			name: "Robin",
			email: "robin@example.com",
			image: null,
			removable: true,
		};
		client.api.bots.listMembers.mockReturnValue(Effect.succeed([robin]));
		mount(`/suga/bots/${diary.handle}/settings`);
		await screen.findByText("Robin");

		client.api.bots.listMembers.mockReturnValue(Effect.succeed([]));
		updates.emit(streamEvent("reach.changed", { about: { kind: "workspace" } }));

		await waitFor(() => expect(screen.queryByText("Robin")).toBeNull());
	});

	it("asks again which workspaces and projects the member reaches once it says they reach it no more", async () => {
		const refuse = refusableWorkspaceStream();
		mount("/suga/projects");
		await screen.findByRole("button", { name: "New project" });
		const asked = {
			workspaces: client.api.workspaces.list.mock.calls.length,
			projects: client.api.projects.list.mock.calls.length,
			standing: client.api.workspaceAccess.mock.calls.length,
		};

		refuse(new NotFound({ message: userText`No such workspace` }));

		await waitFor(() => {
			expect(client.api.workspaces.list.mock.calls.length).toBeGreaterThan(asked.workspaces);
			expect(client.api.projects.list.mock.calls.length).toBeGreaterThan(asked.projects);
			expect(client.api.workspaceAccess.mock.calls.length).toBeGreaterThan(asked.standing);
		});
	});

	it("asks about the member's session again once it ends with it", async () => {
		const refuse = refusableWorkspaceStream();
		const refresh = vi.fn(async () => {});
		mount("/suga/projects", { refresh });
		await screen.findByRole("button", { name: "New project" });

		refuse(new Unauthorized({ message: userText`Invalid or expired session` }));

		await waitFor(() => expect(refresh).toHaveBeenCalled());
	});
});

describe("the member's own stream", () => {
	it.each(["ready", "reset"] as const)(
		"asks for what waits on the member again on %s",
		async (restart) => {
			const own = controlledEventStream();
			client.events.me.mockReturnValue(own.stream);
			mount("/suga/projects");
			await waitFor(() => expect(client.api.chats.attention).toHaveBeenCalled());
			const asked = client.api.chats.attention.mock.calls.length;

			own.emit(streamEvent(restart));

			await waitFor(() =>
				expect(client.api.chats.attention.mock.calls.length).toBeGreaterThan(asked),
			);
		},
	);
});
