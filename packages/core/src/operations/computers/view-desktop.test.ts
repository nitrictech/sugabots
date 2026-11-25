import { randomUUID } from "node:crypto";
import { DesktopUnavailable } from "@sugabots/contracts/errors/computers";
import type { OutputOf } from "@sugabots/contracts/operations";
import { userText } from "@sugabots/errors";
import { eq } from "drizzle-orm";
import { Cause, Effect, Exit, Layer, Queue, Scope, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import {
	seedBot,
	seedComputer,
	seedMember,
	seedProject,
	seedProjectChat,
	seedWorkspace,
} from "../../authentication/seed.test-support.ts";
import { recordEnded } from "../../authentication/session.ts";
import { chatServicesForTests } from "../../chats/testing.ts";
import { DesktopViewer } from "../../chats/tools/browser/viewer.ts";
import { Computers } from "../../computers/computers.ts";
import { EventBus } from "../../database/events/bus.ts";
import { EventOutbox } from "../../database/events/outbox.ts";
import { EventStore } from "../../database/events/store.ts";
import { inMemoryEventStore } from "../../database/events/testing.ts";
import { bot, chatParticipant, session } from "../../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../../database/testing.ts";
import type { MemberSession } from "../../principal.ts";
import { authenticators, principals } from "../../proofs/world.test-support.ts";
import { Streams } from "../../streams/streams.ts";
import { type CallOperation, servedRegistry } from "../testing.ts";
import { viewDesktop } from "./view-desktop.ts";

type Opened = OutputOf<"computers.viewDesktop">;

/**
 * The desktop viewer operation against Postgres, over a stand-in for the
 * computer it shows: it proves what the member may do as it opens, then
 * proves again, naming its values afresh, each time who reaches what
 * changes, and ends once they may no longer see the desktop as it was opened
 * for them, or their session ends. It reads its session's row, and the stored
 * changes, within a second here, in case the bus missed one.
 */
describe.skipIf(!process.env.DATABASE_URL)("the desktop viewer, which proves again", () => {
	const bus = EventBus.inProcess({ store: inMemoryEventStore() });
	let call: CallOperation;
	let signedIn: ReturnType<typeof principals>;
	let streams: Streams.Interface;
	/** The computers the stand-in shows a desktop on, by the project they are in. */
	const computers = new Map<string, string>();
	/** Chats where the stand-in finds the bot gone after the desktop opened. */
	const leftAfterOpening = new Set<string>();

	const unexpectedComputerCall = () =>
		Effect.die(new Error("The desktop stand-in owns computer calls"));
	const desktopComputer = {
		id: Computers.ComputerId("desktop-test"),
		exec: unexpectedComputerCall,
		readFile: unexpectedComputerCall,
		writeFile: unexpectedComputerCall,
		downloadFile: unexpectedComputerCall,
		uploadFile: unexpectedComputerCall,
		endpoint: unexpectedComputerCall,
		setNetwork: unexpectedComputerCall,
	} satisfies Computers.Computer;

	/** Shows a desktop on the computer seeded for the chat's project, whoever may use it. */
	const standIn = DesktopViewer.Service.of({
		openComputer: (chat, bot) =>
			Effect.succeed({
				id: computers.get(chat.project.id) ?? "",
				computer: desktopComputer,
				holder: { kind: "viewer", id: randomUUID() },
				chat: chat.chat.value,
				bot: { id: bot.bot.value, color: "green" },
			}),
		show: (opened, canUse) =>
			Effect.succeed({
				endpoint: { url: `http://desktop.test/${opened.id}`, headers: {} },
				password: "password",
				control: canUse.control,
			}),
		stillShown: (chat, shown) =>
			Effect.gen(function* () {
				const unavailable = new DesktopUnavailable({
					reason: userText`The bot has no desktop here.`,
				});
				const [found] = yield* Effect.tryPromise({
					try: () =>
						onDatabase((db) =>
							db
								.select({ usesComputer: bot.usesComputer })
								.from(bot)
								.where(eq(bot.id, shown.bot.value)),
						),
					catch: () => unavailable,
				});
				if (leftAfterOpening.has(chat.chat.value) || !found?.usesComputer)
					return yield* unavailable;
				return computers.get(chat.project.id) ?? "";
			}),
	});

	beforeAll(async () => {
		const chats = await chatServicesForTests(bus);
		({ call } = await servedRegistry({ chats, bus: Layer.succeed(EventBus.Service, bus) }));
		signedIn = principals(await authenticators());
		streams = await runOnPostgres(
			Effect.provide(
				Streams.Service,
				Streams.layer.pipe(
					Layer.provide([
						Layer.succeed(EventBus.Service, bus),
						EventStore.layer,
						Layer.succeed(Streams.Timing, { catchUp: "1 second" }),
					]),
				),
			),
		);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	/** Opens the viewer for `principal`, as its entrypoint does: its desktop, and whether it has ended. */
	const view = async (principal: MemberSession, chatId: string, botId: string) => {
		const scope = await Effect.runPromise(Scope.make());
		onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)));
		const reproofs = await Effect.runPromise(Queue.unbounded<void, Cause.Done>());
		const observedStreams: Streams.Interface = {
			...streams,
			keep: (keeping) =>
				Effect.suspend(() => {
					let listening = false;
					return streams
						.keep({
							...keeping,
							prove: keeping.prove.pipe(
								Effect.tap(() => (listening ? Queue.offer(reproofs, undefined) : Effect.void)),
							),
						})
						.pipe(
							Effect.tap(() =>
								Effect.sync(() => {
									listening = true;
								}),
							),
						);
				}),
		};
		const viewing = await runOnPostgres(
			Scope.provide(scope)(
				viewDesktop
					.run(principal, { chatId, botId }, { kind: "request", request: randomUUID() })
					.pipe(
						Effect.provideService(DesktopViewer.Service, standIn),
						Effect.provideService(Streams.Service, observedStreams),
					),
			),
		);
		const yielded = await Effect.runPromise(Queue.unbounded<Opened, Cause.Done>());
		Effect.runFork(
			Stream.runForEach(viewing.stream, (opened) => Queue.offer(yielded, opened)).pipe(
				Effect.andThen(viewing.ended),
				Effect.ensuring(Queue.end(reproofs)),
				Effect.ensuring(Queue.end(yielded)),
				Effect.forkIn(scope),
			),
		);
		const desktop = await Effect.runPromise(Queue.take(yielded));
		return {
			desktop,
			/** Whether the viewer ends within a few seconds. */
			ends: () =>
				Effect.runPromise(
					Queue.take(yielded).pipe(
						Effect.as(false),
						Effect.catchIf(Cause.isDone, () => Effect.succeed(true)),
						Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.succeed(false) }),
					),
				),
			reproved: () =>
				Effect.runPromise(
					Queue.take(reproofs).pipe(
						Effect.as(true),
						Effect.catchIf(Cause.isDone, () => Effect.succeed(false)),
					),
				),
		};
	};

	/**
	 * A workspace whose project J, which Ed (an editor) and Vi (a viewer) are
	 * in, is led by Pub, which works on J's computer in a chat Ed started.
	 */
	const staffed = async () => {
		const workspace = await seedWorkspace();
		const admin = await seedMember(workspace, "admin");
		const ed = await seedMember(workspace, "editor");
		const vi = await seedMember(workspace, "viewer");
		const erin = await seedMember(workspace, "editor");
		const pub = await seedBot(workspace, { createdById: ed, usesComputer: true });
		const project = await seedProject(workspace, { leadBotId: pub.id, members: [ed, vi] });
		const chat = await seedProjectChat(workspace, project, ed);
		await onDatabase((db) => db.insert(chatParticipant).values({ chatId: chat, botId: pub.id }));
		computers.set(project, await seedComputer(workspace, project));
		return { workspace, admin, ed, vi, erin, pub, project, chat };
	};

	it("lets whoever reaches the chat watch, and take over where they may change things", async () => {
		const world = await staffed();

		const ed = await view(await signedIn.member(world.ed), world.chat, world.pub.id);
		const vi = await view(await signedIn.member(world.vi), world.chat, world.pub.id);

		expect(ed.desktop.control).toBe(true);
		expect(vi.desktop.control).toBe(false);
	});

	it("refuses to open for someone who doesn't reach the chat", async () => {
		const world = await staffed();

		await expect(
			view(await signedIn.member(world.erin), world.chat, world.pub.id),
		).rejects.toMatchObject({ _tag: "ResourceHidden" });
	});

	it("closes once its member stops reaching the chat, and stays open for those who still do", async () => {
		const world = await staffed();
		const ed = await view(await signedIn.member(world.ed), world.chat, world.pub.id);
		const vi = await view(await signedIn.member(world.vi), world.chat, world.pub.id);

		const admin = await signedIn.member(world.admin);
		await call(admin, "projects.removeMember", {
			projectId: world.project,
			memberId: world.ed,
		});

		expect(await ed.ends()).toBe(true);
		expect(await vi.reproved()).toBe(true);
		await call(admin, "projects.addMember", { projectId: world.project, memberId: world.erin });
		expect(await vi.reproved()).toBe(true);
	});

	it("closes when its member leaves while computer cleanup is pending", async () => {
		const world = await staffed();
		const assistant = await seedBot(world.workspace, {
			assistantOf: world.ed,
			visibility: "personal",
		});
		await seedComputer(world.workspace, assistant.defaultProject);
		const member = await signedIn.member(world.ed);
		const leaving = await view(member, world.chat, world.pub.id);
		const staying = await view(await signedIn.member(world.vi), world.chat, world.pub.id);

		await expect(call(member, "workspaces.leave", { workspace: world.workspace })).resolves.toEqual(
			{
				cleanupPending: true,
			},
		);

		expect(await leaving.ends()).toBe(true);
		expect(await staying.reproved()).toBe(true);
		const admin = await signedIn.member(world.admin);
		await call(admin, "projects.addMember", { projectId: world.project, memberId: world.erin });
		expect(await staying.reproved()).toBe(true);
	});

	it("closes a take-over once its member may no longer change things there, though they could still watch", async () => {
		const world = await staffed();
		const ed = await view(await signedIn.member(world.ed), world.chat, world.pub.id);
		const admin = await signedIn.member(world.admin);
		const memberships = await call(admin, "workspaces.memberships", { workspace: world.workspace });
		const edsMembership = memberships.find((membership) => membership.member.id === world.ed);

		await call(admin, "workspaces.changeRole", {
			workspace: world.workspace,
			membershipId: edsMembership?.id ?? "",
			role: "viewer",
		});

		expect(await ed.ends()).toBe(true);
	});

	it("closes when its session ends", async () => {
		const world = await staffed();
		const session = await signedIn.member(world.ed);
		const ed = await view(session, world.chat, world.pub.id);

		await runOnPostgres(
			recordEnded({ session: session.session, member: world.ed }).pipe(
				Effect.provide(EventOutbox.layer.pipe(Layer.provide(Layer.succeed(EventBus.Service, bus)))),
			),
		);

		expect(await ed.ends()).toBe(true);
	});

	it("closes once its bot stops using its computer", async () => {
		const world = await staffed();
		const ed = await view(await signedIn.member(world.ed), world.chat, world.pub.id);

		await call(await signedIn.member(world.ed), "bots.update", {
			botId: world.pub.id,
			changes: { usesComputer: false },
		});

		expect(await ed.ends()).toBe(true);
	});

	it("refuses to open, handing on no desktop, when its first proof after opening is refused", async () => {
		const world = await staffed();
		leftAfterOpening.add(world.chat);

		await expect(
			view(await signedIn.member(world.ed), world.chat, world.pub.id),
		).rejects.toMatchObject({ _tag: "DesktopUnavailable" });
	});

	it("closes when its session is deleted though no event says so", async () => {
		const world = await staffed();
		const signedOut = await signedIn.member(world.ed);
		const ed = await view(signedOut, world.chat, world.pub.id);

		await onDatabase((db) => db.delete(session).where(eq(session.id, signedOut.session)));

		expect(await ed.ends()).toBe(true);
	});
});
