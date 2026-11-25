import { START_CHAT_TOOL } from "@sugabots/contracts";
import { toolCallPartSchema } from "@sugabots/contracts/messages";
import {
	seedBot,
	seedMember,
	seedMessage,
	seedProject,
	seedProjectChat,
	seedWorkspace,
} from "@sugabots/core/authentication/seed.test-support";
import { startBotChat } from "@sugabots/core/chats/chats/testing";
import { runningTurns } from "@sugabots/core/chats/turns/testing";
import { Turns } from "@sugabots/core/chats/turns/turns";
import { query } from "@sugabots/core/database/database";
import type { CommittedEvent } from "@sugabots/core/database/events/outbox";
import { bot, membership, turn } from "@sugabots/core/database/schema";
import {
	closeDatabase,
	holdTransaction,
	onDatabase,
	runOnPostgres,
	waitUntilWaitingOnLocks,
} from "@sugabots/core/database/testing";
import { asMember } from "@sugabots/core/operations/chats/testing";
import { authenticators, principals } from "@sugabots/core/proofs/world.test-support";
import { and, eq } from "drizzle-orm";
import { Context, Option, Schema } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { botLoopOnPostgres, calling, callsOf, parkedCallOf, storedTurn } from "./testing.ts";

/**
 * A parked call's approval withdrawn, through the real turn workflow on
 * Postgres: when the turn loses its chat or the approval expires, the call
 * is denied and the workflow wakes to end the turn.
 */
describe.skipIf(!process.env.DATABASE_URL)(
	"withdrawing a parked call's approval, against Postgres",
	async () => {
		const delivered: CommittedEvent[] = [];
		let afterCommit: ((events: readonly CommittedEvent[]) => Promise<void>) | undefined;
		const loop = await botLoopOnPostgres(delivered, async (events) => afterCommit?.(events));
		const chatsAs = (memberId: string) => asMember(loop.call, memberId);
		let workspaceId: string;
		let botId: string;
		let adminId: string;

		afterAll(async () => {
			await closeDatabase();
		});

		beforeEach(async () => {
			workspaceId = await seedWorkspace();
			adminId = await seedMember(workspaceId, "admin");
			botId = (await seedBot(workspaceId, { createdById: adminId })).id;
			await onDatabase((db) => db.update(bot).set({ model: "m" }).where(eq(bot.id, botId)));
			delivered.length = 0;
			afterCommit = undefined;
		});

		/** A real turn workflow in `chatId`, once it has parked a brief for approval and given up its lane. */
		const pendingBrief = async (chatId: string) => {
			const { model, requests } = calling(START_CHAT_TOOL, { title: "Report", brief: "Draft it." });
			const workflow = await loop.runWorkflow(chatId, { model });
			await workflow.suspended();
			const { turnId, parked } = await parkedCallOf(workflow.executionId);
			expect(parked.approvalStatus).toBe("pending");
			expect(await runOnPostgres(runningTurns(chatId))).toHaveLength(0);
			return { workflow, turnId, parked, requests };
		};

		/** The tool call a `tool_call.completed` event says was denied, if `event` is one. */
		const deniedCall = (event: CommittedEvent["event"]) => {
			if (event.type !== "tool_call.completed") return undefined;
			const call = Schema.decodeUnknownOption(toolCallPartSchema)(event.toolCall);
			return Option.isSome(call) && call.value.approval?.status === "denied"
				? call.value.id
				: undefined;
		};

		/**
		 * How the asker's late decision on a withdrawn call is refused, by why it
		 * was withdrawn: the approval is gone, or so is the asker's sight of it.
		 */
		const lateDecisionRefusedWith = {
			"project member removal": "ToolApprovalNotFound",
			"project departure": "ToolApprovalNotFound",
			"workspace departure": "ResourceHidden",
			"workspace member removal": "ResourceHidden",
			"bot visibility": "ToolApprovalNotFound",
			"bot removal": "ResourceHidden",
			"project bot removal": "ToolApprovalNotFound",
			"project deletion": "ResourceHidden",
			"workspace deletion": "ResourceHidden",
			expiry: "ToolApprovalNotFound",
		} as const;

		it.each(Object.keys(lateDecisionRefusedWith) as Array<keyof typeof lateDecisionRefusedWith>)(
			"withdraws a parked call after %s and wakes its workflow to end the turn",
			async (reason) => {
				const asker = await seedMember(workspaceId, "editor");
				const signedIn = principals(await authenticators());
				const askerSession = await signedIn.member(asker);
				const adminSession = await signedIn.member(adminId);
				const projectId = await seedProject(workspaceId, {
					leadBotId:
						reason === "project bot removal" ||
						reason === "bot removal" ||
						reason === "bot visibility"
							? (await seedBot(workspaceId)).id
							: botId,
					members: [asker],
					bots: [botId],
				});
				const inProject = await seedProjectChat(workspaceId, projectId, asker);
				const triggerMessageId = await seedMessage(inProject, { member: asker });
				await runOnPostgres(
					Context.get(loop.services, Turns.Service).ask({
						chatId: inProject,
						botId,
						triggerMessageId,
						reason: "mention",
					}),
				);
				const waitingChat =
					reason === "bot visibility"
						? (
								await startBotChat(chatsAs(asker), {
									botId,
									messageId: crypto.randomUUID(),
									content: "Draft the report.",
								})
							).chat.id
						: inProject;
				const { workflow, turnId, parked, requests } = await pendingBrief(waitingChat);
				const error =
					reason === "expiry"
						? "This approval expired before anyone decided it."
						: "This approval was withdrawn because the turn lost access to its chat.";
				// Deletion can erase the entire turn. Check what the withdrawal did as
				// its denial commits, while the request is held before its cleanup.
				let checked: Promise<void> | undefined;
				afterCommit = async (events) => {
					if (!events.some(({ event }) => deniedCall(event) === parked.id)) return;
					checked = (async () => {
						expect(await callsOf(turnId)).toMatchObject([
							{ status: "failed", approvalStatus: "denied", error },
						]);
						await workflow.completed();
						expect(await storedTurn(turnId)).toMatchObject({ status: "cancelled" });
					})();
					await checked.catch(() => {});
				};
				switch (reason) {
					case "project member removal":
						await loop.call(adminSession, "projects.removeMember", { projectId, memberId: asker });
						break;
					case "project departure":
						await loop.call(askerSession, "projects.leave", { projectId });
						break;
					case "workspace departure":
						await loop.call(askerSession, "workspaces.leave", { workspace: workspaceId });
						break;
					case "workspace member removal": {
						const [record] = await onDatabase((db) =>
							db
								.select({ id: membership.id })
								.from(membership)
								.where(
									and(eq(membership.workspaceId, workspaceId), eq(membership.memberId, asker)),
								),
						);
						if (!record) throw new Error("No membership");
						await loop.call(adminSession, "workspaces.removeMembership", {
							workspace: workspaceId,
							membershipId: record.id,
						});
						break;
					}
					case "bot visibility":
						await loop.call(adminSession, "bots.update", {
							botId,
							changes: { visibility: "personal" },
						});
						break;
					case "bot removal":
						await loop.call(adminSession, "bots.remove", { botId });
						break;
					case "project bot removal":
						await loop.call(adminSession, "projects.removeBot", { projectId, botId });
						break;
					case "project deletion":
						await loop.call(adminSession, "projects.remove", { projectId });
						break;
					case "workspace deletion": {
						const owner = await signedIn.member(await seedMember(workspaceId, "owner"));
						await loop.call(owner, "workspaces.delete", { workspace: workspaceId });
						break;
					}
					case "expiry":
						await (await loop.expiryOf(parked))();
						break;
				}
				if (!checked) throw new Error(`The ${reason} committed no denial of the parked call`);
				await checked;
				await expect(
					chatsAs(asker).decide({ toolCallId: parked.id, decision: "allow_once" }),
				).rejects.toMatchObject({ _tag: lateDecisionRefusedWith[reason] });
				expect(requests).toHaveLength(1);
			},
			15_000,
		);

		it.each(["reach withdrawal", "expiry"] as const)(
			"serializes a decision racing %s and refuses it when the withdrawal wins",
			async (reason) => {
				const asker = await seedMember(workspaceId, "editor");
				const projectId = await seedProject(workspaceId, { leadBotId: botId, members: [asker] });
				const started = await chatsAs(asker).startProjectChat({
					projectId,
					retryKey: crypto.randomUUID(),
					message: "Draft the report.",
				});
				const { workflow, turnId, parked, requests } = await pendingBrief(started.chat.id);
				const signedIn = principals(await authenticators());
				const admin = await signedIn.member(adminId);
				const withdraw =
					reason === "expiry"
						? await loop.expiryOf(parked)
						: () => loop.call(admin, "projects.removeMember", { projectId, memberId: asker });
				const lock = holdTransaction(
					query((db) =>
						db.select({ id: turn.id }).from(turn).where(eq(turn.id, turnId)).for("update"),
					),
				);
				await lock.held;
				const withdrawing = withdraw();
				void withdrawing.catch(() => {});
				await waitUntilWaitingOnLocks(1);
				const decision = expect(
					chatsAs(asker).decide({ toolCallId: parked.id, decision: "allow_once" }),
				).rejects.toMatchObject({ _tag: "ToolApprovalNotFound" });
				void decision.catch(() => {});
				await waitUntilWaitingOnLocks(2);
				await lock.release();
				await Promise.all([withdrawing, decision]);
				await workflow.completed();
				expect(await storedTurn(turnId)).toMatchObject({ status: "cancelled" });
				expect(await callsOf(turnId)).toMatchObject([
					{ approvalStatus: "denied", decidedById: null },
				]);
				expect(requests).toHaveLength(1);
			},
			15_000,
		);
	},
);
