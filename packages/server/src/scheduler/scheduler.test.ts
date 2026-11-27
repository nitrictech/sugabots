import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { botLoopOnPostgres, scriptedSteps } from "@sugabots/bot-loop/testing";
import {
	addMembership,
	seedAutomation,
	seedBot,
	seedComputer,
	seedMember,
	seedProject,
	seedRoutine,
	seedWorkspace,
} from "@sugabots/core/authentication/seed.test-support";
import { expiryOf } from "@sugabots/core/authentication/session";
import { SystemWorkAuthentication } from "@sugabots/core/authentication/system-work";
import { AutomationRunner } from "@sugabots/core/chats/automations/automation-runner";
import { AutomationRuns } from "@sugabots/core/chats/automations/runs";
import { AutomationSettlement } from "@sugabots/core/chats/automations/settlement";
import { chatServicesForTests } from "@sugabots/core/chats/testing";
import { aChatAwaitingReply } from "@sugabots/core/chats/turns/testing";
import { localComputerEgress } from "@sugabots/core/computers/testing";
import { Database, query } from "@sugabots/core/database/database";
import {
	automation,
	automationRun,
	automationTrigger,
	computer,
	computerProvider,
	gitHubUninstall,
	membership,
	project,
	toolCall,
	turn,
	workspace,
} from "@sugabots/core/database/schema";
import {
	closeDatabase,
	holdTransaction,
	onDatabase,
	runOnPostgres,
	servedOnPostgres,
	type TestInfrastructure,
} from "@sugabots/core/database/testing";
import { Ids } from "@sugabots/core/ids/ids";
import { asMember } from "@sugabots/core/operations/chats/testing";
import { Operations } from "@sugabots/core/operations/registry";
import { operationsForTests } from "@sugabots/core/operations/testing";
import { authenticators, principals } from "@sugabots/core/proofs/world.test-support";
import { ConnectorStore } from "@sugabots/core/providers/connectors/connector-store";
import {
	egressToGitHub,
	gitHubSetupAt,
	INSTALLATION_ID,
	installedConnector,
	json,
	madeConnector,
	standInGitHub,
	USER_INSTALLATION_ID,
	uninstalls,
} from "@sugabots/core/providers/connectors/github/github.test-support";
import { Secrets } from "@sugabots/core/secrets/secrets";
import { unimplemented } from "@sugabots/core/testing";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Clock, Context, Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { layer, layerNoDeps, make } from "./scheduler.ts";
import { emptyDatabase } from "./testing.ts";

const request = () => ({ kind: "request" as const, request: crypto.randomUUID() });

const authenticator = () =>
	runOnPostgres(Effect.provide(SystemWorkAuthentication.Service, SystemWorkAuthentication.layer));

const makeScheduler = (operations: Operations.Interface) =>
	runOnPostgres(
		make.pipe(
			Effect.provideService(Operations.Service, operations),
			Effect.provide(SystemWorkAuthentication.layer),
		),
	);

const clockAt =
	(now: Date) =>
	<A, E>(effect: Effect.Effect<A, E, TestInfrastructure>, signal?: AbortSignal) =>
		runOnPostgres(
			TestClock.setTime(now.getTime()).pipe(
				Effect.andThen(effect),
				Effect.provide(TestClock.layer()),
			),
			{ signal },
		);

async function operationsWithRoutineQueue(
	queue: (run: Parameters<AutomationRuns.Interface["queue"]>[0]) => Effect.Effect<void> | undefined,
) {
	const chats = await chatServicesForTests({ publishCommitted: async () => {} });
	const runs = Context.get(chats, AutomationRuns.Service);
	const runner = await runOnPostgres(
		AutomationRunner.Service.pipe(
			Effect.provide(AutomationRunner.layer),
			Effect.provideContext(
				Context.add(chats, AutomationRuns.Service, {
					...runs,
					queue: (run) => queue(run) ?? runs.queue(run),
				}),
			),
		),
	);
	return operationsForTests({ chats: Context.add(chats, AutomationRunner.Service, runner) });
}

async function runSchedulerUntilRoutine(
	operations: Operations.Interface,
	now: Date,
	triggerId: string,
) {
	const accepted = Promise.withResolvers<void>();
	const controller = new AbortController();
	const scheduler = layer.pipe(
		Layer.provide(
			Layer.succeed(Operations.Service, {
				...operations,
				"automations.runDueRoutine": (...input) =>
					operations["automations.runDueRoutine"](...input).pipe(
						Effect.tap((result) =>
							Effect.sync(() => {
								if (input[1].triggerId === triggerId && typeof result === "object") {
									accepted.resolve();
								}
							}),
						),
					),
			}),
		),
	);
	const running = clockAt(now)(
		Effect.scoped(
			Layer.build(scheduler).pipe(Effect.andThen(Effect.promise(() => accepted.promise))),
		),
		controller.signal,
	);
	// The scheduler's loops stop with its scope; the next case waits for them to
	// have stopped, so none of them reads its database.
	onTestFinished(async () => {
		controller.abort();
		await running.catch(() => undefined);
	});
	await running;
}

async function projectWithAdmin(adminEmail?: string) {
	const workspaceId = await seedWorkspace();
	const ownerId = await seedMember(workspaceId, "owner");
	const adminId = await seedMember(workspaceId, "admin", { email: adminEmail });
	const { id: leadBotId } = await seedBot(workspaceId);
	const projectId = await seedProject(workspaceId, { leadBotId, members: [adminId] });
	return { workspaceId, projectId, adminId, ownerId };
}

describe("the scheduler, against Postgres", () => {
	beforeEach(emptyDatabase);
	afterAll(closeDatabase);

	it("closes its scope promptly while waiting for the next routine poll", async () => {
		const polling = Promise.withResolvers<void>();
		let pollingLoops = 0;
		const scheduler = layerNoDeps.pipe(
			Layer.provide([
				Ids.layer,
				unimplemented(Operations.Service, {}),
				unimplemented(SystemWorkAuthentication.Service, {
					nextDueRoutineId: () => Effect.succeed(undefined),
					idleComputerIds: Effect.succeed([]),
					pendingPauseIds: Effect.succeed([]),
					pendingDeletions: Effect.succeed([]),
					dueGitHubUninstallIds: Effect.succeed([]),
				}),
			]),
		);
		await Effect.runPromise(
			Clock.clockWith((clock) =>
				Effect.scoped(
					Effect.gen(function* () {
						yield* Layer.build(scheduler);
						yield* Effect.promise(() => polling.promise);
					}),
				).pipe(
					Effect.provideService(Clock.Clock, {
						...clock,
						sleep: (duration) =>
							Effect.suspend(() => {
								if (Duration.toSeconds(duration) === 15 && ++pollingLoops === 2) {
									polling.resolve();
								}
								return clock.sleep(duration);
							}),
					}),
				),
			),
		);
	});

	it("withdraws a parked approval once its seven days are up, and not before", async () => {
		const loop = await botLoopOnPostgres([]);
		const chatsAs = (id: string) => asMember(loop.call, id);
		const { chatId, adminId } = await aChatAwaitingReply(chatsAs);
		const { model, requests } = scriptedSteps({
			calls: [
				{
					toolCallId: "brief",
					toolName: "start_chat",
					input: { title: "Report", brief: "Draft it." },
				},
			],
		});
		const ran = await loop.runTurn(chatId, { model });
		const [parked] = await onDatabase((db) =>
			db.select().from(toolCall).where(eq(toolCall.turnId, ran.turnId)),
		);
		if (!parked?.approvalAskedAt) throw new Error("No approval parked");
		const scheduler = await makeScheduler(await operationsForTests({ chats: loop.services }));
		const expiresAt = parked.approvalAskedAt.getTime() + Duration.toMillis(Duration.days(7));
		await clockAt(new Date(expiresAt - 1))(scheduler.expireApprovals);
		const call = () =>
			onDatabase((db) => db.select().from(toolCall).where(eq(toolCall.id, parked.id)));
		expect(await call()).toMatchObject([{ approvalStatus: "pending" }]);

		await clockAt(new Date(expiresAt))(scheduler.expireApprovals);

		expect(await call()).toMatchObject([
			{
				status: "failed",
				approvalStatus: "denied",
				error: "This approval expired before anyone decided it.",
			},
		]);
		await expect(
			chatsAs(adminId).decide({ toolCallId: parked.id, decision: "allow_once" }),
		).rejects.toMatchObject({ _tag: "ToolApprovalNotFound" });
		expect(
			await onDatabase((db) => db.select().from(turn).where(eq(turn.id, ran.turnId))),
		).toMatchObject([{ endRequested: "approval_expired" }]);
		expect(requests).toHaveLength(1);
	});

	it("finishes a workspace deletion left committed before the caller could destroy its computers", async () => {
		const workspaceId = await seedWorkspace();
		const activeId = await seedWorkspace();
		await onDatabase((db) =>
			db.update(workspace).set({ deleting: true }).where(eq(workspace.id, workspaceId)),
		);
		const auth = await authenticator();
		await expect(
			runOnPostgres(auth.deletion({ kind: "workspace", id: activeId })),
		).rejects.toMatchObject({ _tag: "StoredWorkGone" });
		const operations = await operationsForTests();
		const work = await runOnPostgres(auth.deletion({ kind: "workspace", id: workspaceId }));
		await expect(
			runOnPostgres(operations["deletions.finish"](work, { id: activeId }, request())),
		).rejects.toMatchObject({ _tag: "ResourceHidden" });
		const scheduler = await makeScheduler(operations);
		await runOnPostgres(scheduler.finishDeletions);
		await runOnPostgres(scheduler.finishDeletions);
		expect(
			await onDatabase((db) => db.select().from(workspace).where(eq(workspace.id, workspaceId))),
		).toEqual([]);
		expect(
			await onDatabase((db) => db.select().from(workspace).where(eq(workspace.id, activeId))),
		).toHaveLength(1);
	});

	it("retries a recorded project deletion after a computer provider outage", async () => {
		const { workspaceId, projectId, adminId } = await projectWithAdmin();
		const computerId = await seedComputer(workspaceId, projectId);
		let available = false;
		const provider = createServer((_request, response) => {
			response
				.writeHead(available ? 404 : 503, { "content-type": "application/json" })
				.end(
					JSON.stringify(
						available
							? { code: "NOT_FOUND", message: "No such computer" }
							: { message: "Unavailable" },
					),
				);
		});
		await new Promise<void>((listen) => provider.listen(0, "127.0.0.1", listen));
		onTestFinished(() => void provider.close());
		const { port } = provider.address() as AddressInfo;
		const apiKeyEncrypted = await runOnPostgres(
			Effect.map(Secrets.Service, (secrets) => secrets.encrypt("api-key")),
		);
		await onDatabase((db) =>
			db
				.update(computerProvider)
				.set({
					apiKeyEncrypted,
					settings: {
						builtIn: "opensandbox",
						serverUrl: `http://127.0.0.1:${port}`,
						image: "debian",
					},
				})
				.where(eq(computerProvider.workspaceId, workspaceId)),
		);
		const admin = await principals(await authenticators()).member(adminId);
		const operations = await operationsForTests({ egress: localComputerEgress });
		await expect(
			runOnPostgres(operations["projects.remove"](admin, { projectId }, request())),
		).rejects.toMatchObject({ _tag: "ComputerUnavailable" });
		const scheduler = await makeScheduler(operations);
		const now = Date.now();
		await clockAt(new Date(now))(scheduler.finishDeletions);
		expect(
			await onDatabase((db) => db.select().from(project).where(eq(project.id, projectId))),
		).toMatchObject([{ deleting: true }]);
		expect(
			await onDatabase((db) => db.select().from(computer).where(eq(computer.id, computerId))),
		).toHaveLength(1);
		available = true;
		await clockAt(new Date(now + 5 * 60 * 1000))(scheduler.finishDeletions);
		expect(
			await onDatabase((db) => db.select().from(project).where(eq(project.id, projectId))),
		).toEqual([]);
		expect(
			await onDatabase((db) => db.select().from(computer).where(eq(computer.id, computerId))),
		).toEqual([]);
	});

	it("finishes a member's removal only once every one of their Personal Assistants' computers is gone", async () => {
		const { workspaceId, ownerId, adminId } = await projectWithAdmin();
		const [adminMembership] = await onDatabase((db) =>
			db
				.select()
				.from(membership)
				.where(and(eq(membership.workspaceId, workspaceId), eq(membership.memberId, adminId))),
		);
		if (!adminMembership) throw new Error("Expected the administrator’s membership");
		const first = await seedBot(workspaceId, { assistantOf: adminId, visibility: "personal" });
		const second = await seedBot(workspaceId, { assistantOf: adminId, visibility: "personal" });
		const firstComputer = await seedComputer(workspaceId, first.defaultProject);
		const secondComputer = await seedComputer(workspaceId, second.defaultProject);
		// The first assistant's computer is already gone at the provider; the second's
		// provider can't be reached until it can.
		let secondReachable = false;
		const provider = createServer((incoming, response) => {
			const gone = incoming.url?.includes(first.defaultProject) || secondReachable;
			response
				.writeHead(gone ? 404 : 503, { "content-type": "application/json" })
				.end(
					JSON.stringify(
						gone ? { code: "NOT_FOUND", message: "No such computer" } : { message: "Unavailable" },
					),
				);
		});
		await new Promise<void>((listen) => provider.listen(0, "127.0.0.1", listen));
		onTestFinished(() => void provider.close());
		const { port } = provider.address() as AddressInfo;
		const apiKeyEncrypted = await runOnPostgres(
			Effect.map(Secrets.Service, (secrets) => secrets.encrypt("api-key")),
		);
		await onDatabase((db) =>
			db
				.update(computerProvider)
				.set({
					apiKeyEncrypted,
					settings: {
						builtIn: "opensandbox",
						serverUrl: `http://127.0.0.1:${port}`,
						image: "debian",
					},
				})
				.where(eq(computerProvider.workspaceId, workspaceId)),
		);
		const operations = await operationsForTests({ egress: localComputerEgress });
		const owner = await principals(await authenticators()).member(ownerId);
		const removing = operations["workspaces.removeMembership"](
			owner,
			{ workspace: workspaceId, membershipId: adminMembership.id },
			request(),
		);
		expect(await runOnPostgres(removing)).toEqual({ cleanupPending: true });
		const computersLeft = () =>
			onDatabase((db) =>
				db
					.select({ id: computer.id })
					.from(computer)
					.where(inArray(computer.id, [firstComputer, secondComputer])),
			).then((rows) => rows.map(({ id }) => id));
		const membershipLeft = () =>
			onDatabase((db) => db.select().from(membership).where(eq(membership.id, adminMembership.id)));

		const scheduler = await makeScheduler(operations);
		const now = Date.now();
		await clockAt(new Date(now))(scheduler.finishDeletions);
		expect(await computersLeft()).toEqual([secondComputer]);
		expect(await membershipLeft()).toMatchObject([{ leaving: true }]);

		secondReachable = true;
		await clockAt(new Date(now + 60 * 60 * 1000))(scheduler.finishDeletions);
		expect(await computersLeft()).toEqual([]);
		expect(await membershipLeft()).toEqual([]);
	});

	it.each(["is removed", "leaves"] as const)(
		"revokes access while a member %s during a computer provider outage",
		async (departure) => {
			const adminEmail = `departing-${crypto.randomUUID()}@example.com`;
			const { workspaceId, projectId, ownerId, adminId } = await projectWithAdmin(adminEmail);
			const otherWorkspace = await seedWorkspace();
			await addMembership(otherWorkspace, adminId, "editor");
			const [adminMembership] = await onDatabase((db) =>
				db
					.select()
					.from(membership)
					.where(and(eq(membership.workspaceId, workspaceId), eq(membership.memberId, adminId))),
			);
			if (!adminMembership) throw new Error("Expected the administrator’s membership");
			// Two Personal Assistants, the newer with a computer: the departure
			// waits for every one of them, not just the first.
			await seedBot(workspaceId, { assistantOf: adminId, visibility: "personal" });
			const assistant = await seedBot(workspaceId, {
				assistantOf: adminId,
				visibility: "personal",
			});
			const personal = await seedBot(workspaceId, { createdById: adminId, visibility: "personal" });
			const automationId = await seedAutomation(workspaceId, personal.defaultProject);
			const computerId = await seedComputer(workspaceId, assistant.defaultProject);

			let available = false;
			const providerCalls: string[] = [];
			const provider = createServer((request, response) => {
				providerCalls.push(request.method ?? "");
				response
					.writeHead(available ? 404 : 503, { "content-type": "application/json" })
					.end(
						JSON.stringify(
							available
								? { code: "NOT_FOUND", message: "No such computer" }
								: { message: "Unavailable" },
						),
					);
			});
			await new Promise<void>((listen) => provider.listen(0, "127.0.0.1", listen));
			onTestFinished(() => void provider.close());
			const { port } = provider.address() as AddressInfo;
			const apiKeyEncrypted = await runOnPostgres(
				Effect.map(Secrets.Service, (secrets) => secrets.encrypt("api-key")),
			);
			await onDatabase((db) =>
				db
					.update(computerProvider)
					.set({
						apiKeyEncrypted,
						settings: {
							builtIn: "opensandbox",
							serverUrl: `http://127.0.0.1:${port}`,
							image: "debian",
						},
					})
					.where(eq(computerProvider.workspaceId, workspaceId)),
			);
			const connect = await servedOnPostgres(ConnectorStore.Service, ConnectorStore.layer);
			const connector = await connect.create(workspaceId, projectId, adminId, {
				name: "Example",
				url: "https://example.com/mcp",
				auth: "oauth",
			});
			await connect.saveOauthRecord(
				workspaceId,
				connector.id,
				{ tokens: { access_token: "old-token", token_type: "Bearer" } },
				{ kind: "signIn", signedInById: adminId, version: null },
			);
			const signIn = principals(await authenticators());
			const [owner, admin, otherSession] = await Promise.all([
				signIn.member(ownerId),
				signIn.member(adminId),
				signIn.member(adminId),
			]);
			const operations = await operationsForTests({ egress: localComputerEgress });
			const gone =
				departure === "is removed"
					? operations["workspaces.removeMembership"](
							owner,
							{ workspace: workspaceId, membershipId: adminMembership.id },
							request(),
						)
					: operations["workspaces.leave"](admin, { workspace: workspaceId }, request());
			expect(await runOnPostgres(gone)).toEqual({ cleanupPending: true });
			expect(providerCalls).toEqual([]);
			await expect(
				runOnPostgres(
					operations["workspaces.invite"](
						admin,
						{ workspace: workspaceId, email: "invite@example.com", role: "editor" },
						request(),
					),
				),
			).rejects.toMatchObject({ _tag: "ResourceHidden" });
			await expect(
				runOnPostgres(operations["projects.list"](admin, { workspace: workspaceId }, request())),
			).rejects.toMatchObject({ _tag: "ResourceHidden" });
			expect(
				await runOnPostgres(
					operations["workspaces.memberships"](owner, { workspace: workspaceId }, request()),
				),
			).toEqual([expect.objectContaining({ role: "owner" })]);
			expect(await connect.oauthRecord(workspaceId, connector.id)).toBeUndefined();
			expect(
				await onDatabase((db) =>
					db.select().from(automation).where(eq(automation.id, automationId)),
				),
			).toMatchObject([{ state: "paused" }]);
			expect(await runOnPostgres(expiryOf(admin))).toBeInstanceOf(Date);
			expect(await runOnPostgres(expiryOf(otherSession))).toBeInstanceOf(Date);
			await expect(
				runOnPostgres(
					operations["projects.list"](otherSession, { workspace: otherWorkspace }, request()),
				),
			).resolves.toEqual([]);
			const inviteAgain = operations["workspaces.invite"](
				owner,
				{ workspace: workspaceId, email: adminEmail, role: "editor" },
				request(),
			);
			await expect(runOnPostgres(inviteAgain)).rejects.toMatchObject({
				_tag: "MembershipRemovalPending",
			});

			const scheduler = await makeScheduler(operations);
			const now = Date.now();
			await clockAt(new Date(now))(scheduler.finishDeletions);
			expect(providerCalls).toContain("DELETE");
			expect(
				await onDatabase((db) =>
					db.select().from(membership).where(eq(membership.id, adminMembership.id)),
				),
			).toMatchObject([{ leaving: true }]);
			expect(
				await onDatabase((db) => db.select().from(computer).where(eq(computer.id, computerId))),
			).toHaveLength(1);

			available = true;
			await clockAt(new Date(now + 60 * 60 * 1000))(scheduler.finishDeletions);
			expect(
				await onDatabase((db) =>
					db.select().from(membership).where(eq(membership.id, adminMembership.id)),
				),
			).toEqual([]);
			expect(
				await onDatabase((db) => db.select().from(computer).where(eq(computer.id, computerId))),
			).toEqual([]);
			await expect(runOnPostgres(inviteAgain)).resolves.toMatchObject({ email: adminEmail });
		},
	);

	it("finishes other deletions while a stuck deletion times out and backs off", async () => {
		const stalled = await seedWorkspace();
		const ready = await seedWorkspace();
		for (const id of [stalled, ready]) {
			await onDatabase((db) =>
				db.update(workspace).set({ deleting: true }).where(eq(workspace.id, id)),
			);
		}
		const started = Promise.withResolvers<void>();
		const cancelled = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		let attempts = 0;
		let stalledProviderRecovered = false;
		const auth = await authenticator();
		const operations = await operationsForTests();
		const scheduler = await runOnPostgres(
			make.pipe(
				Effect.provideService(SystemWorkAuthentication.Service, {
					...auth,
					pendingDeletions: Effect.succeed([
						{ kind: "workspace", id: stalled },
						{ kind: "workspace", id: ready },
					] as const),
				}),
				Effect.provideService(Operations.Service, {
					...operations,
					"deletions.finish": (principal, input, call) =>
						Effect.suspend(() => {
							const finish = operations["deletions.finish"](principal, input, call);
							if (input.id === ready)
								return finish.pipe(Effect.tap(() => Effect.sync(completed.resolve)));
							attempts += 1;
							if (stalledProviderRecovered) return finish;
							started.resolve();
							return Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(cancelled.resolve)));
						}),
				}),
			),
		);

		await clockAt(new Date())(
			Effect.gen(function* () {
				const sweep = yield* Effect.forkChild(scheduler.finishDeletions);
				yield* Effect.promise(() => started.promise);
				yield* Effect.promise(() => completed.promise);
				yield* TestClock.adjust("1 minute");
				yield* Fiber.join(sweep);
				yield* Effect.promise(() => cancelled.promise);
				yield* scheduler.finishDeletions;
				expect(attempts).toBe(1);

				stalledProviderRecovered = true;
				yield* TestClock.adjust("3 minutes");
				yield* scheduler.finishDeletions;
				expect(attempts).toBe(2);
			}),
		);
		expect(
			await onDatabase((db) => db.select().from(workspace).where(eq(workspace.id, stalled))),
		).toEqual([]);
	});

	it("accepts the latest missed occurrence once and keeps the next routine time", async () => {
		const { workspaceId, projectId } = await projectWithAdmin();
		const automationId = await seedAutomation(workspaceId, projectId);
		const triggerId = await seedRoutine(automationId, workspaceId, 0);
		const otherTrigger = await seedRoutine(automationId, workspaceId, 0);
		const now = new Date("2026-09-18T12:37:40Z");
		await onDatabase((db) =>
			db
				.update(automationTrigger)
				.set({ nextScheduledAt: new Date("2026-09-17T09:00:00Z") })
				.where(eq(automationTrigger.id, triggerId)),
		);
		await onDatabase((db) =>
			db
				.update(automationTrigger)
				.set({ nextScheduledAt: new Date("2026-09-18T09:00:00Z") })
				.where(eq(automationTrigger.id, otherTrigger)),
		);

		const operations = await operationsForTests();
		const auth = await authenticator();
		const run = clockAt(now);
		const work = await run(auth.dueRoutine(triggerId));
		await expect(
			run(operations["automations.runDueRoutine"](work, { triggerId: otherTrigger }, request())),
		).rejects.toMatchObject({ _tag: "ResourceHidden" });
		await expect(
			run(operations["automations.pauseAfterFailures"](work, { automationId }, request())),
		).rejects.toMatchObject({ _tag: "ResourceHidden" });
		await expect(
			run(operations["automations.list"](work, { projectId }, request())),
		).rejects.toMatchObject({ _tag: "ResourceHidden" });

		const scheduler = await makeScheduler(operations);
		const accepted = await run(scheduler.runNextRoutine);
		expect(accepted).toMatchObject({ duplicate: false });
		if (typeof accepted !== "object") throw new Error("Routine did not run");
		expect(
			await run(operations["automations.runDueRoutine"](work, { triggerId }, request())),
		).toBeUndefined();
		const [stored] = await onDatabase((db) =>
			db.select().from(automationRun).where(eq(automationRun.automationId, automationId)),
		);
		expect(stored).toMatchObject({
			id: accepted.runId,
			triggerId,
			trigger: { scheduledAt: "2026-09-18T09:00:00.000Z" },
		});
		const [routine] = await onDatabase((db) =>
			db.select().from(automationTrigger).where(eq(automationTrigger.id, triggerId)),
		);
		expect(routine?.nextScheduledAt?.toISOString()).toBe("2026-09-19T09:00:00.000Z");
	});

	it("clears an invalid routine's due time and immediately runs the next routine", async () => {
		const { workspaceId, projectId } = await projectWithAdmin();
		const automationId = await seedAutomation(workspaceId, projectId);
		const invalidTrigger = await seedRoutine(automationId, workspaceId, 0);
		const validTrigger = await seedRoutine(automationId, workspaceId, 0);
		await onDatabase((db) =>
			db
				.update(automationTrigger)
				.set({
					settings: {
						kind: "routine",
						schedule: { repeat: "cron", expression: "0 9 * * *" },
						timezone: "Invalid/Timezone",
					},
					nextScheduledAt: new Date("2026-09-15T09:00:00Z"),
				})
				.where(eq(automationTrigger.id, invalidTrigger)),
		);
		await onDatabase((db) =>
			db
				.update(automationTrigger)
				.set({ nextScheduledAt: new Date("2026-09-16T09:00:00Z") })
				.where(eq(automationTrigger.id, validTrigger)),
		);

		await runSchedulerUntilRoutine(
			await operationsForTests(),
			new Date("2026-09-16T10:00:00Z"),
			validTrigger,
		);

		const [invalid] = await onDatabase((db) =>
			db.select().from(automationTrigger).where(eq(automationTrigger.id, invalidTrigger)),
		);
		expect(invalid?.nextScheduledAt).toBeNull();
		const accepted = await onDatabase((db) =>
			db
				.select({ triggerId: automationRun.triggerId })
				.from(automationRun)
				.where(eq(automationRun.automationId, automationId)),
		);
		expect(accepted).toEqual([{ triggerId: validTrigger }]);
	});

	it.each(["declined", "defective"] as const)(
		"backs off a %s routine and runs the next one in the same poll",
		async (outcome) => {
			const { workspaceId, projectId } = await projectWithAdmin();
			const automationId = await seedAutomation(workspaceId, projectId);
			const deferredTrigger = await seedRoutine(automationId, workspaceId, -60);
			const healthyTrigger = await seedRoutine(automationId, workspaceId, -60);
			const now = new Date("2026-09-09T11:00:00Z");
			await onDatabase((db) =>
				db
					.update(automationTrigger)
					.set({ nextScheduledAt: new Date("2026-09-08T09:00:00Z") })
					.where(eq(automationTrigger.id, deferredTrigger)),
			);
			await onDatabase((db) =>
				db
					.update(automationTrigger)
					.set({ nextScheduledAt: new Date("2026-09-09T09:00:00Z") })
					.where(eq(automationTrigger.id, healthyTrigger)),
			);
			const operations = await operationsForTests();
			const scheduler = await makeScheduler({
				...operations,
				"automations.runDueRoutine": (principal, input, call) => {
					if (input.triggerId !== deferredTrigger) {
						return operations["automations.runDueRoutine"](principal, input, call);
					}
					return outcome === "declined"
						? Effect.succeed(undefined)
						: Effect.die(new Error("Routine failed outside acceptance"));
				},
			});
			const run = clockAt(now);
			expect(await run(scheduler.runNextRoutine)).toBe("retry");
			expect(await run(scheduler.runNextRoutine)).toMatchObject({ duplicate: false });
			expect(await run(scheduler.runNextRoutine)).toBeUndefined();
			const nextPoll = clockAt(new Date(now.getTime() + 15_000));
			expect(await nextPoll(scheduler.runNextRoutine)).toBe("retry");
		},
	);

	it("retries routine acceptance defects and advances after three for the same occurrence", async () => {
		const { workspaceId, projectId } = await projectWithAdmin();
		const defectiveAutomation = await seedAutomation(workspaceId, projectId);
		const healthyAutomation = await seedAutomation(workspaceId, projectId);
		const defectiveTrigger = await seedRoutine(defectiveAutomation, workspaceId, 0);
		const healthyTrigger = await seedRoutine(healthyAutomation, workspaceId, 0);
		await onDatabase((db) =>
			db
				.update(automationTrigger)
				.set({ nextScheduledAt: new Date("2026-09-13T09:00:00Z") })
				.where(eq(automationTrigger.id, defectiveTrigger)),
		);
		await onDatabase((db) =>
			db
				.update(automationTrigger)
				.set({ nextScheduledAt: new Date("2026-09-14T09:00:00Z") })
				.where(eq(automationTrigger.id, healthyTrigger)),
		);
		const operations = await operationsWithRoutineQueue((run) =>
			run.automationId === defectiveAutomation
				? Effect.die(new Error("Routine could not be queued"))
				: undefined,
		);
		const now = new Date("2026-09-14T10:00:00Z");
		const scheduler = await makeScheduler(operations);
		for (let attempt = 0; attempt < 2; attempt++) {
			expect(
				await clockAt(new Date(now.getTime() + attempt * 15_000))(scheduler.runNextRoutine),
			).toBe("retry");
			const [stillDue] = await onDatabase((db) =>
				db.select().from(automationTrigger).where(eq(automationTrigger.id, defectiveTrigger)),
			);
			expect(stillDue?.nextScheduledAt).toEqual(new Date("2026-09-13T09:00:00Z"));
		}
		await runSchedulerUntilRoutine(operations, now, healthyTrigger);

		const [advanced] = await onDatabase((db) =>
			db.select().from(automationTrigger).where(eq(automationTrigger.id, defectiveTrigger)),
		);
		expect(advanced?.nextScheduledAt).toEqual(new Date("2026-09-15T09:00:00Z"));
		const accepted = await onDatabase((db) =>
			db
				.select({ triggerId: automationRun.triggerId })
				.from(automationRun)
				.where(inArray(automationRun.automationId, [defectiveAutomation, healthyAutomation])),
		);
		expect(accepted).toEqual([{ triggerId: healthyTrigger }]);
	});

	it("keeps a routine due after a transient Postgres error and accepts the same occurrence on retry", async () => {
		const { workspaceId, projectId } = await projectWithAdmin();
		const automationId = await seedAutomation(workspaceId, projectId);
		const triggerId = await seedRoutine(automationId, workspaceId, 0);
		const due = new Date("2026-09-12T09:00:00Z");
		const now = new Date("2026-09-12T10:00:00Z");
		await onDatabase((db) =>
			db
				.update(automationTrigger)
				.set({ nextScheduledAt: due })
				.where(eq(automationTrigger.id, triggerId)),
		);
		const database = await runOnPostgres(Database);
		// A deadlock; the other errors Postgres says may be retried are classified alike.
		const sqlStates = ["40P01"];
		const failureCount = sqlStates.length;
		const operations = await operationsWithRoutineQueue((run) => {
			if (run.automationId !== automationId) return undefined;
			const code = sqlStates.shift();
			if (!code) return undefined;
			return query((db) =>
				db.execute(sql.raw(`do $$ begin raise exception using errcode = '${code}'; end $$`)),
			).pipe(Effect.provideService(Database, database), Effect.asVoid);
		});
		const scheduler = await makeScheduler(operations);
		const storedRuns = () =>
			onDatabase((db) =>
				db.select().from(automationRun).where(eq(automationRun.triggerId, triggerId)),
			);
		for (let attempt = 0; attempt < failureCount; attempt++) {
			expect(
				await clockAt(new Date(now.getTime() + attempt * 15_000))(scheduler.runNextRoutine),
			).toBe("retry");
			const [trigger] = await onDatabase((db) =>
				db.select().from(automationTrigger).where(eq(automationTrigger.id, triggerId)),
			);
			expect(trigger?.nextScheduledAt).toEqual(due);
			expect(await storedRuns()).toHaveLength(0);
		}

		await runSchedulerUntilRoutine(operations, now, triggerId);
		expect(await storedRuns()).toMatchObject([
			{ trigger: { kind: "routine", scheduledAt: due.toISOString() } },
		]);
	});

	it("keeps retrying a blocked routine while healthy routines run", async () => {
		const failing = await projectWithAdmin();
		const healthy = await projectWithAdmin();
		const failingAutomation = await seedAutomation(failing.workspaceId, failing.projectId);
		const healthyAutomation = await seedAutomation(healthy.workspaceId, healthy.projectId);
		const failingTrigger = await seedRoutine(failingAutomation, failing.workspaceId, 0);
		const healthyTrigger = await seedRoutine(healthyAutomation, healthy.workspaceId, 0);
		await onDatabase((db) =>
			db
				.update(automationTrigger)
				.set({ nextScheduledAt: new Date("2026-09-10T09:00:00Z") })
				.where(eq(automationTrigger.id, failingTrigger)),
		);
		await onDatabase((db) =>
			db
				.update(automationTrigger)
				.set({ nextScheduledAt: new Date("2026-09-11T09:00:00Z") })
				.where(eq(automationTrigger.id, healthyTrigger)),
		);
		const database = await runOnPostgres(Database);
		const lockTimeout = query((db) =>
			db.execute(sql`do $$ begin raise exception using errcode = '55P03'; end $$`),
		).pipe(Effect.provideService(Database, database), Effect.asVoid);
		let attempts = 0;
		let blocked = true;
		const operations = await operationsWithRoutineQueue(({ automationId }) =>
			automationId === failingAutomation && blocked
				? Effect.sync(() => {
						attempts++;
					}).pipe(Effect.andThen(lockTimeout))
				: undefined,
		);
		const now = new Date("2026-09-11T10:00:00Z");
		await runSchedulerUntilRoutine(operations, now, healthyTrigger);
		expect(attempts).toBe(1);

		const scheduler = await makeScheduler(operations);
		for (let retry = 1; retry <= 4; retry++) {
			expect(
				await clockAt(new Date(now.getTime() + retry * 15_000))(scheduler.runNextRoutine),
			).toBe("retry");
		}
		expect(attempts).toBe(5);
		const [stillDue] = await onDatabase((db) =>
			db.select().from(automationTrigger).where(eq(automationTrigger.id, failingTrigger)),
		);
		expect(stillDue?.nextScheduledAt).toEqual(new Date("2026-09-10T09:00:00Z"));

		blocked = false;
		await runSchedulerUntilRoutine(operations, new Date(now.getTime() + 75_000), failingTrigger);
		const accepted = await onDatabase((db) =>
			db.select().from(automationRun).where(eq(automationRun.triggerId, failingTrigger)),
		);
		expect(accepted).toMatchObject([
			{ trigger: { kind: "routine", scheduledAt: "2026-09-11T09:00:00.000Z" } },
		]);
	});

	it("applies the pending pause after two failures and leaves a manually retried automation enabled", async () => {
		const { workspaceId, projectId, adminId } = await projectWithAdmin();
		const admin = await principals(await authenticators()).member(adminId);
		const chats = await chatServicesForTests({ publishCommitted: async () => {} });
		const operations = await operationsForTests({ chats });
		const scheduler = await makeScheduler(operations);
		const automationId = await seedAutomation(workspaceId, projectId);
		const otherAutomationId = await seedAutomation(workspaceId, projectId);
		const triggerId = await seedRoutine(automationId, workspaceId, -60);
		const prepareRun = () =>
			runOnPostgres(
				operations["automations.run"](
					admin,
					{ projectId, automationId, requestId: crypto.randomUUID() },
					request(),
				),
			);
		const failRun = async () => {
			const { runId } = await prepareRun();
			const settlement = Context.get(chats, AutomationSettlement.Service);
			await runOnPostgres(settlement.failRun({ automationId, runId }));
		};
		const readAutomation = async () => {
			const [row] = await onDatabase((db) =>
				db.select().from(automation).where(eq(automation.id, automationId)),
			);
			return row;
		};

		await failRun();

		await runOnPostgres(scheduler.pauseFailingAutomations);
		expect(await readAutomation()).toMatchObject({
			state: "enabled",
			pauseAfterFailuresPendingAt: null,
		});
		await failRun();
		const auth = await authenticator();
		const work = await runOnPostgres(auth.pauseAfterFailures(automationId));
		await expect(
			runOnPostgres(
				operations["automations.pauseAfterFailures"](
					work,
					{ automationId: otherAutomationId },
					request(),
				),
			),
		).rejects.toMatchObject({ _tag: "ResourceHidden" });
		await expect(runOnPostgres(auth.dueRoutine(triggerId))).rejects.toMatchObject({
			_tag: "StoredWorkGone",
		});
		const listed = await runOnPostgres(
			operations["automations.list"](admin, { projectId }, request()),
		);
		expect(listed.find(({ id }) => id === automationId)).toMatchObject({
			state: "paused",
			pausedAfterFailures: true,
			triggers: [{ id: triggerId, nextScheduledAt: null }],
		});
		const { automations } = await runOnPostgres(
			operations["chats.projectChats"](admin, { projectId }, request()),
		);
		const entry = automations.find(({ automation }) => automation.id === automationId);
		const paused = { state: "paused", pausedAfterFailures: true };
		expect(entry?.automation).toMatchObject(paused);
		if (!entry?.chat) throw new Error("Missing automation feed");
		const chatId = entry.chat.id;
		const details = await runOnPostgres(
			operations["chats.get"](admin, { chatId, limit: 20 }, request()),
		);
		expect(details.automation).toMatchObject(paused);
		const feed = () =>
			runOnPostgres(operations["chats.messages"](admin, { chatId, limit: 20 }, request()));
		const pendingMarker = (await feed()).items.find(({ kind }) => kind === "automation_paused");
		expect(pendingMarker).toMatchObject({ id: automationId, createdAt: expect.any(String) });

		await runOnPostgres(
			operations["automations.update"](
				admin,
				{ projectId, automationId, changes: { name: "Renamed while pausing" } },
				request(),
			),
		);
		expect((await feed()).items.find(({ kind }) => kind === "automation_paused")).toEqual(
			pendingMarker,
		);

		await runOnPostgres(scheduler.pauseFailingAutomations);
		expect((await feed()).items.find(({ kind }) => kind === "automation_paused")).toEqual(
			pendingMarker,
		);
		expect(await readAutomation()).toMatchObject({
			state: "paused",
			pausedAfterFailuresAt: expect.any(Date),
		});
		const [pausedRoutine] = await onDatabase((db) =>
			db.select().from(automationTrigger).where(eq(automationTrigger.id, triggerId)),
		);
		expect(pausedRoutine?.nextScheduledAt).toBeNull();

		await prepareRun();
		await runOnPostgres(scheduler.pauseFailingAutomations);
		expect((await feed()).items.some(({ kind }) => kind === "automation_paused")).toBe(false);
		expect(await readAutomation()).toMatchObject({
			state: "enabled",
			pauseAfterFailuresPendingAt: null,
		});
	});

	it("backs off a failing pause without delaying another automation's pause", async () => {
		const { workspaceId, projectId } = await projectWithAdmin();
		const failing = await seedAutomation(workspaceId, projectId);
		const healthy = await seedAutomation(workspaceId, projectId);
		await onDatabase((db) =>
			db
				.update(automation)
				.set({ pauseAfterFailuresPendingAt: new Date() })
				.where(inArray(automation.id, [failing, healthy])),
		);
		const attempts = new Map<string, number>();
		const operations = await operationsForTests();
		const scheduler = await makeScheduler({
			...operations,
			"automations.pauseAfterFailures": (_, { automationId }) =>
				Effect.sync(() => attempts.set(automationId, (attempts.get(automationId) ?? 0) + 1)).pipe(
					Effect.andThen(
						automationId === failing ? Effect.die(new Error("Pause failed")) : Effect.void,
					),
				),
		});
		await clockAt(new Date("2026-09-18T12:00:00Z"))(scheduler.pauseFailingAutomations);
		expect(attempts.get(failing)).toBe(1);
		expect(attempts.get(healthy)).toBe(1);
		await clockAt(new Date("2026-09-18T12:00:15Z"))(scheduler.pauseFailingAutomations);
		expect(attempts.get(failing)).toBe(1);
		expect(attempts.get(healthy)).toBe(2);
		await clockAt(new Date("2026-09-18T12:05:00Z"))(scheduler.pauseFailingAutomations);
		expect(attempts.get(failing)).toBe(2);
	});

	it("uninstalls the app of a GitHub connector removed while it was installed", async () => {
		const { projectId, adminId } = await projectWithAdmin();
		const attempted: number[] = [];
		const gitHub = standInGitHub(
			uninstalls(async (installationId) => {
				attempted.push(installationId);
				return new Response(null, { status: 204 });
			}),
		);
		const setup = await gitHubSetupAt(gitHub.fetch, "https://sugabots.example.com");
		const connectorId = await installedConnector(setup, { projectId, adminId });

		await setup.call(await setup.member(adminId), "connectors.remove", { projectId, connectorId });
		const [work] = await onDatabase((db) =>
			db.select().from(gitHubUninstall).where(eq(gitHubUninstall.connectorId, connectorId)),
		);
		if (!work) throw new Error("Nothing queued to uninstall the app");
		const scheduler = await makeScheduler(
			await operationsForTests({ egress: egressToGitHub(gitHub.fetch) }),
		);
		await clockAt(new Date(work.nextAttemptAt.getTime() + 100))(scheduler.uninstallGitHubApps);

		expect(attempted).toEqual([work.installationId]);
	});

	it("uninstalls an app installed on a member's account who left before it was recorded", async () => {
		const { workspaceId, projectId, adminId } = await projectWithAdmin();
		let leaving: (() => Promise<unknown>) | undefined;
		const gitHub = standInGitHub();
		// The member leaves while Sugabots asks GitHub about the installation.
		const leavesWhileAsked: typeof fetch = async (input, init) => {
			const path = new URL(String(input)).pathname;
			if (leaving && path === `/app/installations/${USER_INSTALLATION_ID}`) {
				const leave = leaving;
				leaving = undefined;
				await leave();
			}
			return gitHub.fetch(input, init);
		};
		const setup = await gitHubSetupAt(leavesWhileAsked, "https://sugabots.example.com");
		const { connectorId, installState } = await madeConnector(setup, { projectId, adminId });
		const admin = await setup.member(adminId);
		leaving = () => setup.call(admin, "workspaces.leave", { workspace: workspaceId });

		const outcome = await setup.call(admin, "gitHubConnectors.gitHubAppInstalled", {
			installationId: USER_INSTALLATION_ID,
			state: installState,
		});

		expect(outcome).toMatchObject({ kind: "failed", failure: "expired" });
		expect(
			await onDatabase((db) =>
				db
					.select({ installationId: gitHubUninstall.installationId })
					.from(gitHubUninstall)
					.where(eq(gitHubUninstall.connectorId, connectorId)),
			),
		).toEqual([{ installationId: USER_INSTALLATION_ID }]);
	});

	it("uninstalls an app installed by a member who left before GitHub sent them back", async () => {
		const { workspaceId, projectId, adminId } = await projectWithAdmin();
		const attempted: number[] = [];
		const gitHub = standInGitHub(
			uninstalls(async (installationId) => {
				attempted.push(installationId);
				return new Response(null, { status: 204 });
			}),
		);
		const setup = await gitHubSetupAt(gitHub.fetch, "https://sugabots.example.com");
		const { connectorId, installState } = await madeConnector(setup, { projectId, adminId });
		const admin = await setup.member(adminId);
		await setup.call(admin, "workspaces.leave", { workspace: workspaceId });

		const outcome = await setup.call(admin, "gitHubConnectors.gitHubAppInstalled", {
			installationId: INSTALLATION_ID,
			state: installState,
		});
		const [work] = await onDatabase((db) =>
			db.select().from(gitHubUninstall).where(eq(gitHubUninstall.connectorId, connectorId)),
		);
		if (!work) throw new Error("Nothing queued to uninstall the app");
		const scheduler = await makeScheduler(
			await operationsForTests({ egress: egressToGitHub(gitHub.fetch) }),
		);
		await clockAt(new Date(work.nextAttemptAt.getTime() + 100))(scheduler.uninstallGitHubApps);

		expect(outcome).toMatchObject({ kind: "failed", failure: "expired" });
		expect(attempted).toEqual([INSTALLATION_ID]);
	});

	it("cannot abandon another member's GitHub installation with their callback state", async () => {
		const { projectId, adminId } = await projectWithAdmin();
		const outsider = await seedMember(await seedWorkspace(), "admin");
		const uninstalled: number[] = [];
		const gitHub = standInGitHub(
			uninstalls(async (installationId) => {
				uninstalled.push(installationId);
				return new Response(null, { status: 204 });
			}),
		);
		const setup = await gitHubSetupAt(gitHub.fetch, "https://sugabots.example.com");
		const { installState } = await madeConnector(setup, { projectId, adminId });
		const callback = { state: installState, installationId: INSTALLATION_ID };

		const refused = await setup.call(
			await setup.member(outsider),
			"gitHubConnectors.gitHubAppInstalled",
			callback,
		);
		const installed = await setup.call(
			await setup.member(adminId),
			"gitHubConnectors.gitHubAppInstalled",
			callback,
		);
		const scheduler = await makeScheduler(
			await operationsForTests({ egress: egressToGitHub(gitHub.fetch) }),
		);
		await clockAt(new Date(Date.now() + 60_000))(scheduler.uninstallGitHubApps);

		expect(refused).toMatchObject({ kind: "failed", failure: "expired" });
		expect(installed).toMatchObject({ kind: "done" });
		expect(uninstalled).toEqual([]);
	});

	it("uninstalls what a GitHub connector's app had installed when the connector goes before its installation is recorded", async () => {
		const { projectId, adminId } = await projectWithAdmin();
		const attempted: number[] = [];
		const gitHub = standInGitHub(
			// The member installed the app, but GitHub hasn't sent them back yet.
			({ method, path, search }) =>
				method === "GET" && path === "/app/installations" && search.includes("page=1")
					? json([{ id: INSTALLATION_ID, account: { login: "acme", type: "Organization" } }])
					: undefined,
			uninstalls(async (installationId) => {
				attempted.push(installationId);
				return new Response(null, { status: 204 });
			}),
		);
		const setup = await gitHubSetupAt(gitHub.fetch, "https://sugabots.example.com");
		const { connectorId } = await madeConnector(setup, { projectId, adminId });

		await setup.call(await setup.member(adminId), "connectors.remove", { projectId, connectorId });
		const [work] = await onDatabase((db) =>
			db.select().from(gitHubUninstall).where(eq(gitHubUninstall.connectorId, connectorId)),
		);
		if (!work) throw new Error("Nothing queued to uninstall the app");
		const scheduler = await makeScheduler(
			await operationsForTests({ egress: egressToGitHub(gitHub.fetch) }),
		);
		await clockAt(new Date(work.nextAttemptAt.getTime() + 100))(scheduler.uninstallGitHubApps);

		expect(attempted).toEqual([INSTALLATION_ID]);
		expect(
			await onDatabase((db) =>
				db.select().from(gitHubUninstall).where(eq(gitHubUninstall.connectorId, connectorId)),
			),
		).toEqual([]);
	});

	it("asks GitHub to uninstall a member's app with its queued uninstall unlocked", async () => {
		const { workspaceId, projectId, adminId } = await projectWithAdmin();
		const asked = Promise.withResolvers<void>();
		const answered = Promise.withResolvers<void>();
		const gitHub = standInGitHub(
			uninstalls(async () => {
				asked.resolve();
				await answered.promise;
				return json({ message: "Not Found" }, 404);
			}),
		);
		const setup = await gitHubSetupAt(gitHub.fetch, "https://sugabots.example.com");
		const connectorId = await installedConnector(
			setup,
			{ projectId, adminId },
			USER_INSTALLATION_ID,
		);
		await setup.call(await setup.member(adminId), "workspaces.leave", { workspace: workspaceId });
		const queued = () =>
			onDatabase((db) =>
				db.select().from(gitHubUninstall).where(eq(gitHubUninstall.connectorId, connectorId)),
			);
		const [work] = await queued();
		if (!work) throw new Error("Missing queued uninstall");
		const scheduler = await makeScheduler(
			await operationsForTests({ egress: egressToGitHub(gitHub.fetch) }),
		);

		const uninstalling = clockAt(new Date(work.nextAttemptAt.getTime() + 100))(
			scheduler.uninstallGitHubApps,
		);
		await asked.promise;
		const lockingTheRow = holdTransaction(
			query((db) =>
				db
					.select({ id: gitHubUninstall.id })
					.from(gitHubUninstall)
					.where(eq(gitHubUninstall.id, work.id))
					.for("update", { noWait: true }),
			),
		);
		const rowFree = await lockingTheRow.held.then(
			() => true,
			() => false,
		);
		await lockingTheRow.release().catch(() => undefined);
		answered.resolve();
		await uninstalling;

		expect(rowFree).toBe(true);
		expect(await queued()).toEqual([]);
	});

	it("retries a member removal's GitHub uninstall after rebuilding the scheduler", async () => {
		const { workspaceId, projectId, adminId } = await projectWithAdmin();
		const attempted: number[] = [];
		const gitHub = standInGitHub(
			uninstalls(async (installationId) => {
				attempted.push(installationId);
				return attempted.length === 1
					? json({ message: "Unavailable" }, 502)
					: json({ message: "Not Found" }, 404);
			}),
		);
		const setup = await gitHubSetupAt(gitHub.fetch, "https://sugabots.example.com");
		const connectorId = await installedConnector(
			setup,
			{ projectId, adminId },
			USER_INSTALLATION_ID,
		);
		const admin = await setup.member(adminId);
		await setup.call(admin, "workspaces.leave", { workspace: workspaceId });
		const queued = () =>
			onDatabase((db) =>
				db.select().from(gitHubUninstall).where(eq(gitHubUninstall.connectorId, connectorId)),
			);
		const [work] = await queued();
		expect(work).toMatchObject({ attempts: 0, installationId: USER_INSTALLATION_ID });
		if (!work) throw new Error("Missing queued uninstall");
		expect(attempted).toEqual([]);

		const buildOperations = () => operationsForTests({ egress: egressToGitHub(gitHub.fetch) });
		const operations = await buildOperations();
		const auth = await authenticator();
		const principal = await runOnPostgres(auth.gitHubUninstall(work.id));
		await expect(
			runOnPostgres(
				operations["gitHubConnectors.uninstall"](
					principal,
					{ uninstallId: crypto.randomUUID() },
					request(),
				),
			),
		).rejects.toMatchObject({ _tag: "ResourceHidden" });

		const firstScheduler = await makeScheduler(operations);
		const firstAttemptAt = new Date(work.nextAttemptAt.getTime() + 100);
		await clockAt(firstAttemptAt)(
			Effect.all([firstScheduler.uninstallGitHubApps, firstScheduler.uninstallGitHubApps], {
				concurrency: 2,
			}),
		);
		expect(attempted).toEqual([USER_INSTALLATION_ID]);
		const [retry] = await queued();
		expect(retry).toMatchObject({
			attempts: 1,
			nextAttemptAt: new Date(firstAttemptAt.getTime() + 1000),
		});

		const restarted = await makeScheduler(await buildOperations());
		await clockAt(firstAttemptAt)(restarted.uninstallGitHubApps);
		expect(attempted).toHaveLength(1);
		await clockAt(new Date(firstAttemptAt.getTime() + 1000))(restarted.uninstallGitHubApps);
		expect(attempted).toEqual([USER_INSTALLATION_ID, USER_INSTALLATION_ID]);
		expect(await queued()).toEqual([]);
	});
});
