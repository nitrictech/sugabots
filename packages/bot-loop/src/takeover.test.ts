import { toolCallPartSchema } from "@sugabots/contracts/messages";
import { WEB_FETCH_TOOL } from "@sugabots/contracts/operations/web";
import type { ConnectorCatalog } from "@sugabots/core/chats/tools/connector-catalog";
import { CALL_TOOL } from "@sugabots/core/chats/tools/tool-search/tool";
import {
	aChatWithConnectorAwaitingReply,
	type TurnCheckpoint,
} from "@sugabots/core/chats/turns/testing";
import type { Turns } from "@sugabots/core/chats/turns/turns";
import type { CommittedEvent } from "@sugabots/core/database/events/outbox";
import { membership, turn } from "@sugabots/core/database/schema";
import { closeDatabase, onDatabase, runOnPostgres } from "@sugabots/core/database/testing";
import { asMember } from "@sugabots/core/operations/chats/testing";
import { Models } from "@sugabots/core/providers/models/models";
import { streamed } from "@sugabots/core/providers/models/testing";
import { Egress } from "@sugabots/core/providers/network/egress";
import { unimplemented } from "@sugabots/core/testing";
import { DisplayName, userText } from "@sugabots/errors";
import { eq, sql } from "drizzle-orm";
import { Duration, Effect, Option, Schema } from "effect";
import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as Steps from "./steps.ts";
import {
	botLoopOnPostgres,
	callsOf,
	controlledClock,
	enableWebSearch,
	examplePage,
	failedCall,
	openTurnInChat,
	scriptedSteps,
	storedReply,
	storedTurn,
	toolResultFor,
	wikiWipe,
} from "./testing.ts";

/**
 * A turn taken over by a newer execution of its workflow, as after a
 * restart, through the bot loop on Postgres: the older one stops and records
 * nothing more, and a step taken again makes no request or call twice.
 */
describe.skipIf(!process.env.DATABASE_URL)(
	"a turn taken over by a newer execution, against Postgres",
	async () => {
		const delivered: CommittedEvent[] = [];
		let afterCommit: ((events: readonly CommittedEvent[]) => Promise<void>) | undefined;
		const loop = await botLoopOnPostgres(delivered, async (events) => afterCommit?.(events));
		const chatsAs = (memberId: string) => asMember(loop.call, memberId);
		const testProvider = {
			provider: DisplayName.fromRecord("Test provider"),
			model: DisplayName.fromRecord("test-model"),
		};
		let chatId: string;
		let workspaceId: string;
		let connectorId: string;
		let adminId: string;

		afterAll(async () => {
			await closeDatabase();
		});

		beforeEach(async () => {
			({ chatId, workspaceId, connectorId, adminId } =
				await aChatWithConnectorAwaitingReply(chatsAs));
			delivered.length = 0;
			afterCommit = undefined;
		});

		/** What a step waits for on its clock, in milliseconds: its next read of where the turn stands, and its deadline. */
		const stepTimers = [Steps.timing.checkEvery, Steps.timing.stepTimeout].map(Duration.toMillis);

		/** The tool call a `tool_call.completed` event says completed, if `event` is one. */
		const completedCall = (event: CommittedEvent["event"]) => {
			if (event.type !== "tool_call.completed") return undefined;
			return Option.getOrUndefined(Schema.decodeUnknownOption(toolCallPartSchema)(event.toolCall));
		};

		/** The connector tool `wiki__wipe` of the connector `installedId`, with `access`, running `execute`. */
		const wiki = (
			access: "allow" | "ask" | "off",
			execute: Parameters<typeof wikiWipe>[2],
			installedId = connectorId,
		) => wikiWipe(installedId, access, execute);

		it("runs a failed run again, as late as the provider asked, though the step that failed it is taken again after a restart", async () => {
			const { model, requests } = scriptedSteps(
				new Models.ProviderRateLimited({
					...testProvider,
					retryAfter: Duration.seconds(30),
					cause: new Error("429"),
				}),
			);
			const { steps, authentication } = await loop.loopOver({ model });
			const { run, opened } = await openTurnInChat(chatId, steps);
			const at = { turnId: opened.turnId, attempt: 0, step: 0 };
			const first = await authentication.authenticate(opened.turnId);
			expect(await steps.step(run.request, first, at)).toEqual({
				_tag: "Retry",
				after: Duration.seconds(30),
			});

			// The process stops before the workflow kept that outcome: it resumes the
			// turn and takes the step again.
			const resumed = await authentication.authenticate(opened.turnId);
			const again = await steps.step(run.request, resumed, at);

			expect(again).toMatchObject({ _tag: "Retry", after: expect.anything() });
			if (again._tag !== "Retry" || again.after === undefined) throw new Error("no retry");
			expect(Duration.toMillis(again.after)).toBeGreaterThan(0);
			expect(Duration.toMillis(again.after)).toBeLessThanOrEqual(30_000);
			expect(requests).toHaveLength(1);
			expect(await storedTurn(opened.turnId)).toMatchObject({
				status: "failed",
				retrying: true,
				retryAt: expect.any(Date),
			});
		});

		it("supersedes an older step while a newer execution waits to retry", async () => {
			const started = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<void>();
			const slow = Models.fromStream(() =>
				Effect.succeed(
					streamed(
						(async function* () {
							started.resolve();
							await finish.promise;
							yield "Old reply.";
						})(),
					),
				),
			);
			const retryAfter = Duration.seconds(30);
			const { steps, authentication } = await loop.loopOver({
				model: scriptedSteps(
					new Models.ProviderRateLimited({
						...testProvider,
						retryAfter,
						cause: new Error("429"),
					}),
				).model,
			});
			const older = await loop.loopOver({ model: slow });
			const { run, opened } = await openTurnInChat(chatId, steps);
			const at = { turnId: opened.turnId, attempt: 0, step: 0 };
			const first = await authentication.authenticate(opened.turnId);
			const stale = older.steps.step(run.request, first, at);

			try {
				await started.promise;
				const second = await authentication.authenticate(opened.turnId);
				expect(await steps.step(run.request, second, at)).toEqual({
					_tag: "Retry",
					after: retryAfter,
				});
			} finally {
				finish.resolve();
			}

			expect(await stale).toEqual({ _tag: "Superseded" });
			expect(await storedTurn(opened.turnId)).toMatchObject({
				status: "failed",
				retrying: true,
				retryAt: expect.any(Date),
			});
		});

		it.each([false, true])(
			"discards partial thinking and reply text on takeover (older checkpoint %s)",
			async (olderCheckpoint) => {
				const oldWritingSaved = Promise.withResolvers<void>();
				const finishOld = Promise.withResolvers<void>();
				const resumedRequestOpened = Promise.withResolvers<void>();
				const finishResumed = Promise.withResolvers<void>();
				// Enough characters for the stream to save immediately before reading its next delta.
				const staleThinking = "Old thinking. ".repeat(100);
				const staleText = "Old reply. ".repeat(100);
				const oldModel = Models.fromStream(() =>
					Effect.succeed({
						deltas: (async function* (): AsyncGenerator<Models.Delta> {
							yield { kind: "thinking", text: staleThinking };
							yield { kind: "text", text: staleText };
							oldWritingSaved.resolve();
							await finishOld.promise;
						})(),
						finished: Effect.never,
					}),
				);
				const scripted = scriptedSteps({ thinking: ["New thinking."], text: ["New reply."] });
				const resumedModel = Models.fromStream((request) =>
					Effect.callback<void>((resume) => {
						resumedRequestOpened.resolve();
						void finishResumed.promise.then(() => resume(Effect.void));
					}).pipe(Effect.andThen(scripted.model.stream(request))),
				);
				// The older execution's model never finishes, so it ends only at its
				// next read of where the turn stands, on a clock the case moves.
				const time = await controlledClock();
				const older = await loop.loopOver({ model: oldModel }, { clock: time.clock });
				const newer = await loop.loopOver({ model: resumedModel });
				const { run, opened } = await openTurnInChat(chatId, older.steps);
				const at = { turnId: opened.turnId, attempt: 0, step: 0 };
				const first = await older.authentication.authenticate(opened.turnId);
				const stale = older.steps.step(run.request, first, at);
				const readReply = async () =>
					(await chatsAs(adminId).get(chatId)).messages.find(({ author }) => author.kind === "bot");
				try {
					await oldWritingSaved.promise;
					// Its deadline, its next read of where the turn stands, and its next save.
					expect(await time.waiting(3)).toEqual(expect.arrayContaining(stepTimers));
					expect(await readReply()).toMatchObject({
						content: staleText,
						thinking: [{ step: 0, text: staleThinking }],
					});
					if (olderCheckpoint) {
						const draft = JSON.stringify({
							content: staleText,
							toolCalls: [],
							thinking: [{ step: 0, text: staleThinking }],
						});
						await onDatabase((db) =>
							db
								.update(turn)
								.set({ checkpoint: sql`jsonb_set(${turn.checkpoint}, '{reply}', ${draft}::jsonb)` })
								.where(eq(turn.id, opened.turnId)),
						);
					}
					const second = await newer.authentication.authenticate(opened.turnId);
					await time.adjust(Steps.timing.checkEvery);
					expect(await stale).toEqual({ _tag: "Superseded" });
					const resumed = newer.steps.step(run.request, second, at);
					await resumedRequestOpened.promise;
					expect(await readReply()).toMatchObject({ content: "" });
					expect((await readReply())?.thinking ?? []).toEqual([]);
					finishResumed.resolve();
					expect(await resumed).toEqual({ _tag: "Finished" });
					expect(scripted.requests).toHaveLength(1);
					expect(scripted.requests[0]?.continuationMessages).toEqual([]);
					expect(await readReply()).toMatchObject({
						content: "New reply.",
						thinking: [{ step: 0, text: "New thinking." }],
					});
				} finally {
					finishOld.resolve();
					finishResumed.resolve();
				}
			},
		);

		it("takes no step for an execution a newer one took over, and records nothing", async () => {
			const { model, requests } = scriptedSteps({ text: ["Hello."] });
			const { steps, authentication } = await loop.loopOver({ model });
			const { run, opened } = await openTurnInChat(chatId, steps);
			const stale = await authentication.authenticate(opened.turnId);
			// The turn resumes elsewhere before this execution's first step.
			await authentication.authenticate(opened.turnId);

			const outcome = await steps.step(run.request, stale, {
				turnId: opened.turnId,
				attempt: 0,
				step: 0,
			});

			expect(outcome).toEqual({ _tag: "Superseded" });
			expect(requests).toEqual([]);
			expect(await storedTurn(opened.turnId)).toMatchObject({ status: "running" });
			expect(await storedReply(opened.turnId)).toMatchObject({ status: "writing", content: "" });
		});

		it("stops recording a step a newer execution took over mid-request", async () => {
			let resumed = false;
			const model = Models.fromStream((request) =>
				Effect.sync(() =>
					streamed(
						(async function* () {
							yield "Half";
							// The turn resumes in another process while this request streams.
							const turnId = request.purpose.name === "bot-turn" ? request.purpose.turnId : "";
							const { authentication } = await loop.loopOver({ model: scriptedSteps().model });
							await authentication.authenticate(turnId);
							resumed = true;
							yield " and the rest.";
						})(),
					),
				),
			);

			const ran = await loop.runTurn(chatId, { model });

			expect(resumed).toBe(true);
			expect(ran.outcomes).toEqual([{ _tag: "Superseded" }]);
			// Nothing of the request was recorded for the turn, which the newer execution carries on.
			expect(await storedTurn(ran.turnId)).toMatchObject({ status: "running" });
			expect(await storedReply(ran.turnId)).toMatchObject({ status: "writing", content: "" });
		});

		it("marks a write/delete call a stopped execution sent as interrupted when the turn resumes, rather than send it again", async () => {
			const started = Promise.withResolvers<void>();
			const cutShort = Promise.withResolvers<void>();
			onTestFinished(() => cutShort.resolve());
			const execute = vi.fn(async () => {
				started.resolve();
				await cutShort.promise;
				return { removed: true };
			});
			const { model, requests } = scriptedSteps(
				{
					text: ["Wiping. "],
					calls: [
						{
							toolCallId: "sdk-1",
							toolName: CALL_TOOL,
							input: { tool: "wiki__wipe", arguments: {} },
						},
					],
				},
				{ text: ["Check the wiki."] },
			);
			const time = await controlledClock();
			const { steps, authentication, runningTurn } = await loop.loopOver(
				{ model, connectorTools: wiki("allow", execute) },
				{ clock: time.clock },
			);
			const { run, opened } = await openTurnInChat(chatId, steps);
			const at = (step: number) => ({ turnId: opened.turnId, attempt: 0, step });
			// The first execution sends the call, which doesn't come back: its process stops.
			const first = await authentication.authenticate(opened.turnId);
			const stopped = steps.step(run.request, first, at(0));
			await started.promise;
			// Its deadline, and its next read of where the turn stands.
			expect(await time.waiting(2)).toEqual(stepTimers);

			// The workflow resumes the turn in another process, which takes the step
			// again. The stopped execution, should it still be running, gives up its
			// step at its next read of where the turn stands, without waiting for the call.
			const second = await authentication.authenticate(opened.turnId);
			await time.adjust(Steps.timing.checkEvery);
			expect(await stopped).toEqual({ _tag: "Superseded" });
			// Should its call come back late, whatever the stopped execution would
			// record of it is refused, as it no longer runs the turn.
			const lateResult: Turns.ToolResultOutput = { type: "json" };
			await expect(
				runOnPostgres(
					runningTurn.recordToolResults(first, [{ toolCallId: "sdk-1", output: lateResult }]),
				),
			).rejects.toMatchObject({ _tag: "TurnExecutionSuperseded" });
			expect(await steps.step(run.request, second, at(0))).toEqual({ _tag: "Continue" });
			expect(await steps.step(run.request, second, at(1))).toEqual({ _tag: "Finished" });

			expect(execute).toHaveBeenCalledOnce();
			expect(requests).toHaveLength(2);
			const interrupted = {
				tool: "wiki__wipe",
				status: "failed",
				error: expect.stringContaining("Check what it did"),
			};
			expect(await callsOf(opened.turnId)).toMatchObject([interrupted]);
			const [recorded] = await callsOf(opened.turnId);
			expect(toolResultFor(requests[1], "sdk-1")).toEqual(failedCall(recorded?.error));

			expect(await storedReply(opened.turnId)).toMatchObject({
				status: "complete",
				content: "Wiping. Check the wiki.",
			});
		});

		it("stops a step a newer execution took over while its call runs, aborting the call", async () => {
			const aborted = vi.fn();
			const started = Promise.withResolvers<void>();
			await enableWebSearch(workspaceId, adminId);
			const webFetch: Egress.Interface["webFetch"] = async (_url, options) => {
				started.resolve();
				return new Promise<Response>((_resolve, reject) =>
					options?.signal?.addEventListener("abort", () => {
						aborted();
						reject(options.signal?.reason);
					}),
				);
			};
			const { model, requests } = scriptedSteps({
				calls: [{ toolCallId: "sdk-1", toolName: WEB_FETCH_TOOL, input: { url: examplePage.url } }],
			});
			const time = await controlledClock();
			const { steps, authentication } = await loop.loopOver(
				{ model, egress: unimplemented(Egress.Service, { webFetch }) },
				{ clock: time.clock },
			);
			const { run, opened } = await openTurnInChat(chatId, steps);
			const first = await authentication.authenticate(opened.turnId);
			const stale = steps.step(run.request, first, { turnId: opened.turnId, attempt: 0, step: 0 });
			await started.promise;
			// Its deadline, and its next read of where the turn stands.
			expect(await time.waiting(2)).toEqual(stepTimers);

			// The turn resumes in another process while the call runs; the step finds
			// out at its next read of where the turn stands.
			await authentication.authenticate(opened.turnId);
			await time.adjust(Steps.timing.checkEvery);

			expect(await stale).toEqual({ _tag: "Superseded" });
			expect(aborted).toHaveBeenCalledOnce();
			expect(requests).toHaveLength(1);
			expect(await storedTurn(opened.turnId)).toMatchObject({ status: "running" });
			expect(await callsOf(opened.turnId)).toMatchObject([
				{ tool: WEB_FETCH_TOOL, status: "running" },
			]);
		});

		it.each([
			{ initialAccess: "ask", resumedAccess: "allow", sent: false },
			{ initialAccess: "allow", resumedAccess: "ask", sent: true },
			{ initialAccess: "allow", resumedAccess: "off", sent: true },
		] as const)(
			"replays a step when tool access changes from $initialAccess to $resumedAccess",
			async ({ initialAccess, resumedAccess, sent }) => {
				const fetching = Promise.withResolvers<void>();
				let comeBack = () => {};
				const cutShort = new Promise<void>((resolve) => {
					comeBack = resolve;
				});
				let fetches = 0;
				await enableWebSearch(workspaceId, adminId);
				const webFetch = async () => {
					fetches++;
					if (fetches === 1) {
						fetching.resolve();
						await cutShort;
					}
					return examplePage.response();
				};
				const wipe = vi.fn(async () => ({ removed: true }));
				let access: "allow" | "ask" | "off" = initialAccess;
				// Read as each step builds its tools, so a change shows in the next step.
				const liveWiki: ConnectorCatalog.Interface = {
					forTurn: (...args) => wiki(access, wipe).forTurn(...args),
				};
				const { model, requests } = scriptedSteps(
					{
						calls: [
							{
								toolCallId: "sdk-fetch",
								toolName: WEB_FETCH_TOOL,
								input: { url: examplePage.url },
							},
							{
								toolCallId: "sdk-wipe",
								toolName: CALL_TOOL,
								input: { tool: "wiki__wipe", arguments: {} },
							},
						],
					},
					{ text: ["Done."] },
				);
				const outside = {
					model,
					egress: unimplemented(Egress.Service, { webFetch }),
					connectorTools: liveWiki,
				};
				const { steps, authentication } = await loop.loopOver(outside);
				const { run, opened } = await openTurnInChat(chatId, steps);
				const at = { turnId: opened.turnId, attempt: 0, step: 0 };
				const wipeRecorded = Promise.withResolvers<void>();
				afterCommit = async (events) => {
					if (events.some(({ event }) => completedCall(event)?.tool === "wiki__wipe")) {
						wipeRecorded.resolve();
					}
				};
				const first = await authentication.authenticate(opened.turnId);
				const stopped = steps.step(run.request, first, at);
				await fetching.promise;
				// The allowed wipe is made and recorded while the fetch hangs.
				if (sent) await wipeRecorded.promise;

				access = resumedAccess;
				const second = await authentication.authenticate(opened.turnId);
				const resumed = await steps.step(run.request, second, at);
				comeBack();
				expect(await stopped).toEqual({ _tag: "Superseded" });
				const calls = await callsOf(opened.turnId);

				if (sent) {
					expect(resumed).toEqual({ _tag: "Continue" });
					expect(await steps.step(run.request, second, { ...at, step: 1 })).toEqual({
						_tag: "Finished",
					});
					expect(calls).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								tool: "wiki__wipe",
								status: "completed",
								approvalId: null,
							}),
							expect.objectContaining({ tool: WEB_FETCH_TOOL, status: "completed" }),
						]),
					);
					expect(calls).toHaveLength(2);
					expect(wipe).toHaveBeenCalledOnce();
					expect(fetches).toBe(2);
					expect(JSON.stringify(requests[1]?.continuationMessages)).toContain('"removed":true');
					expect(loop.deliveredEvents()).toContainEqual(
						expect.objectContaining({
							type: "message.execution_started",
							messageId: (await storedReply(opened.turnId))?.id,
							execution: second.executionNumber,
						}),
					);
					return;
				}

				expect(resumed).toEqual({ _tag: "Waiting", approvals: [expect.any(String)], taken: true });
				expect(wipe).not.toHaveBeenCalled();
				expect(calls).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ tool: "wiki__wipe", approvalStatus: "pending" }),
						expect.objectContaining({ tool: WEB_FETCH_TOOL, status: "completed" }),
					]),
				);
			},
			15_000,
		);

		it("never makes the calls of the turn's last step, nor asks again when that step is taken again after a restart", async () => {
			await enableWebSearch(workspaceId, adminId);
			const webFetch = vi.fn(async () => examplePage.response());
			const { model, requests } = scriptedSteps({
				text: ["Here is what I found."],
				calls: [{ toolCallId: "sdk-1", toolName: WEB_FETCH_TOOL, input: { url: examplePage.url } }],
			});
			// The first execution is held once its answer is recorded, before it ends the turn.
			const ending = Promise.withResolvers<void>();
			const endHeld = Promise.withResolvers<void>();
			let ends = 0;
			const { steps, authentication } = await loop.loopOver(
				{ model, egress: unimplemented(Egress.Service, { webFetch }) },
				{
					beforeRecord: async (method) => {
						if (method !== "end" || ends++ > 0) return;
						ending.resolve();
						await endHeld.promise;
					},
				},
			);
			const { run, opened } = await openTurnInChat(chatId, steps);
			const last = { turnId: opened.turnId, attempt: 0, step: Steps.TURN_STEPS - 1 };
			// The turn has taken every step but its last.
			const everyStepButTheLast: TurnCheckpoint = {
				messages: [],
				reply: { content: "", toolCalls: [] },
				steps: last.step,
				calls: [],
				approvals: [],
			};
			await onDatabase((db) =>
				db.update(turn).set({ checkpoint: everyStepButTheLast }).where(eq(turn.id, opened.turnId)),
			);
			const first = await authentication.authenticate(opened.turnId);
			const firstTaking = steps.step(run.request, first, last);
			await ending.promise;
			expect(requests.map(({ lastRequest }) => lastRequest)).toEqual([true]);
			expect(await storedTurn(opened.turnId)).toMatchObject({ status: "running" });

			// The process restarts before the turn ended: a new execution takes the
			// step again, from the answer the first recorded.
			const resumed = await authentication.authenticate(opened.turnId);
			try {
				await expect(steps.step(run.request, resumed, last)).resolves.toEqual({
					_tag: "Finished",
				});
			} finally {
				endHeld.resolve();
			}
			// Let go, the first execution finds the turn over and ends nothing.
			expect(await firstTaking).toEqual({ _tag: "Finished" });

			expect(requests).toHaveLength(1);
			expect(webFetch).not.toHaveBeenCalled();
			expect(await storedTurn(opened.turnId)).toMatchObject({ status: "done" });
			expect(await storedReply(opened.turnId)).toMatchObject({
				status: "complete",
				content: "Here is what I found.",
			});
		});

		it("makes no request for a step past the turn's last", async () => {
			const { model, requests } = scriptedSteps();
			const { steps, authentication } = await loop.loopOver({ model });
			const { run, opened } = await openTurnInChat(chatId, steps);
			const past = { turnId: opened.turnId, attempt: 0, step: Steps.TURN_STEPS };
			const principal = await authentication.authenticate(opened.turnId);

			expect(await steps.step(run.request, principal, past)).toEqual({ _tag: "Finished" });
			expect(requests).toEqual([]);
		});

		it("leaves a turn whose asker left to the newer execution, when an older one finds out first", async () => {
			const { model, requests } = scriptedSteps({ text: ["Hello."] });
			const { steps, authentication } = await loop.loopOver({ model });
			const { run, opened } = await openTurnInChat(chatId, steps);
			const at = { turnId: opened.turnId, attempt: 0, step: 0 };
			const first = await authentication.authenticate(opened.turnId);
			const second = await authentication.authenticate(opened.turnId);
			await onDatabase((db) => db.delete(membership).where(eq(membership.memberId, adminId)));

			const stale = await steps.step(run.request, first, at);

			expect(stale).toEqual({ _tag: "Superseded" });
			expect(await storedTurn(opened.turnId)).toMatchObject({ status: "running" });

			// The newer execution, which still runs the turn, ends it.
			expect(await steps.step(run.request, second, at)).toEqual({ _tag: "Finished" });
			expect(await storedTurn(opened.turnId)).toMatchObject({
				status: "failed",
				error: userText`This bot can no longer reach this chat, so it stopped.`,
			});
			expect(requests).toEqual([]);
		});
	},
);
