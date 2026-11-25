import { Effect, Exit, Layer, Scope, Stream } from "effect";
import { WebSocket } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ComputerProviderStore } from "../../../computers/computer-provider-store.ts";
import { ComputerSignIn } from "../../../computers/computer-sign-in.ts";
import { ProjectComputers } from "../../../computers/project-computers.ts";
import {
	localComputerEgress,
	recordingIds,
	removeWorkVolumes,
} from "../../../computers/testing.ts";
import { EventBus } from "../../../database/events/bus.ts";
import { EventStore } from "../../../database/events/store.ts";
import { inMemoryEventStore } from "../../../database/events/testing.ts";
import {
	bot as botTable,
	chatParticipant,
	member,
	membership,
	workspace,
} from "../../../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../../../database/testing.ts";
import { viewDesktop } from "../../../operations/computers/view-desktop.ts";
import { authenticators, principals } from "../../../proofs/world.test-support.ts";
import { Streams } from "../../../streams/streams.ts";
import { defaultProjectOf } from "../../../workspaces/projects/project-reads.ts";
import { seedChat } from "../../seed.test-support.ts";
import { stepOnComputer } from "../computer/testing.ts";
import { TurnComputers } from "../computer/turn-computers.ts";
import { DesktopViewer } from "./viewer.ts";
import { answerChallenge } from "./vnc-authentication.ts";

/**
 * Watching a bot's desktop, against Postgres and a real OpenSandbox server
 * running the local build of the default image (`docker compose --profile
 * computers up -d` and `bun run build:computer`, with OPENSANDBOX_URL and
 * OPENSANDBOX_API_KEY set).
 */
const env = process.env;
const configured = env.DATABASE_URL && env.OPENSANDBOX_URL && env.OPENSANDBOX_API_KEY;
const SLOW = 180_000;

describe.skipIf(!configured)("the desktop viewer, against Postgres and OpenSandbox", () => {
	let botCalls: Awaited<ReturnType<typeof stepOnComputer>>["call"];
	let viewer: DesktopViewer.Interface;
	let streams: Streams.Interface;
	let signedIn: ReturnType<typeof principals>;
	let projectComputers: ProjectComputers.Interface;
	let workspaceId: string;
	let ownerId: string;
	let outsiderId: string;
	let watcherId: string;
	let botId: string;
	let bystanderId: string;
	let computerlessId: string;
	let chatId: string;
	const scope = Effect.runSync(Scope.make());
	const idsHandedOut = new Set<string>();

	beforeAll(async () => {
		let turnComputers: TurnComputers.Interface;
		let providers: ComputerProviderStore.Interface;
		signedIn = principals(await authenticators());
		[turnComputers, viewer, projectComputers, providers, streams] = await runOnPostgres(
			Effect.all([
				TurnComputers.Service,
				DesktopViewer.Service,
				ProjectComputers.Service,
				ComputerProviderStore.Service,
				Streams.Service,
			]).pipe(
				Effect.provide(
					Layer.mergeAll(
						TurnComputers.layer,
						DesktopViewer.layer,
						ProjectComputers.layer,
						ComputerProviderStore.layer,
						Streams.layer.pipe(
							Layer.provide([
								Layer.sync(EventBus.Service, () =>
									EventBus.inProcess({ store: inMemoryEventStore() }),
								),
								EventStore.layer,
							]),
						),
					),
				),
				Effect.provide(ComputerSignIn.none),
				Effect.provide(recordingIds(idsHandedOut)),
				// Registries are asked what an image's tag names, as in production.
				Effect.provide(localComputerEgress),
			),
		);
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Viewer ${suffix}`, slug: `viewer-${suffix}` })
				.returning(),
		);
		const members = await onDatabase((db) =>
			db
				.insert(member)
				.values([
					{ name: "Sam", email: `viewer-sam-${suffix}@example.com` },
					{ name: "Kim", email: `viewer-kim-${suffix}@example.com` },
					{ name: "Lee", email: `viewer-lee-${suffix}@example.com` },
				])
				.returning(),
		);
		const [owner, outsider, watcher] = members;
		if (!space || !owner || !outsider || !watcher) throw new Error("fixture");
		workspaceId = space.id;
		ownerId = owner.id;
		outsiderId = outsider.id;
		watcherId = watcher.id;
		await onDatabase((db) =>
			db.insert(membership).values([
				// The outsider is in no workspace.
				{ workspaceId, memberId: ownerId, role: "admin" },
				{ workspaceId, memberId: watcherId, role: "viewer" },
			]),
		);
		const botIn = (name: string, usesComputer: boolean): typeof botTable.$inferInsert => ({
			workspaceId,
			name,
			handle: `${name.toLowerCase().replaceAll(" ", "-")}-${suffix}`,
			color: "green",
			eyes: "pill",
			model: "no-such-model",
			usesComputer,
			createdById: ownerId,
		});
		const [bot, bystander, computerless] = await onDatabase((db) =>
			db
				.insert(botTable)
				.values([
					botIn("Browser Bot", true),
					botIn("Bystander Bot", true),
					botIn("Computerless Bot", false),
				])
				.returning(),
		);
		if (!bot || !bystander || !computerless) throw new Error("fixture");
		botId = bot.id;
		bystanderId = bystander.id;
		computerlessId = computerless.id;
		const chat = await onDatabase((db) =>
			seedChat(db, {
				workspaceId,
				kind: "project_chat",
				botId,
				title: "Look something up",
				startedById: ownerId,
			}),
		);
		chatId = chat.id;
		await onDatabase((db) => db.insert(chatParticipant).values({ chatId, botId: computerlessId }));
		await runOnPostgres(
			providers.create(workspaceId, {
				createdById: ownerId,
				provider: {
					settings: {
						builtIn: "opensandbox",
						serverUrl: env.OPENSANDBOX_URL,
						image: "sugabots-computer:dev",
					},
					enabled: true,
					apiKey: env.OPENSANDBOX_API_KEY,
				},
			}),
		);
		const botTurn = await signedIn.botFor(ownerId, botId, chatId);
		({ call: botCalls } = await stepOnComputer(
			turnComputers,
			botTurn,
			{
				workspaceId,
				projectId: await runOnPostgres(defaultProjectOf(botId)),
				naturalBrowsing: false,
				turnId: botTurn.turn,
				chatId,
				botId,
				color: "orange",
				acceptsImages: false,
			},
			scope,
		));
	}, SLOW);

	afterAll(async () => {
		await Effect.runPromise(Scope.close(scope, Exit.void));
		const providers = await runOnPostgres(
			Effect.provide(ComputerProviderStore.Service, ComputerProviderStore.layer),
		);
		const provider = await runOnPostgres(providers.enabled(workspaceId));
		if (provider) await runOnPostgres(projectComputers.destroyAllMadeBy(workspaceId, provider));
		await closeDatabase();
		removeWorkVolumes(idsHandedOut);
	}, SLOW);

	/** Opens the desktop viewer for `memberId`, as its entrypoint does, held open for the file. */
	const openAs = async (memberId: string, of = botId) => {
		const principal = await signedIn.member(memberId);
		return runOnPostgres(
			Effect.exit(
				Scope.provide(scope)(
					viewDesktop
						.run(principal, { chatId, botId: of }, { kind: "request", request: memberId })
						.pipe(
							Effect.flatMap(({ stream }) => Stream.runHead(stream)),
							Effect.flatMap((first) =>
								first._tag === "Some"
									? Effect.succeed(first.value)
									: Effect.die(new Error("The viewer ended before it opened")),
							),
							Effect.provideService(DesktopViewer.Service, viewer),
							Effect.provideService(Streams.Service, streams),
						),
				),
			),
		);
	};

	let openedFirst: string | undefined;

	it(
		"starts the desktop for someone who opens it before the bot has used its browser",
		async () => {
			const exit = await openAs(ownerId);
			if (!Exit.isSuccess(exit)) throw new Error(exit.toString());
			openedFirst = exit.value.endpoint.url;

			expect(await signsIn(exit.value)).toBe(true);
		},
		SLOW,
	);

	it(
		"gives the bot's browser the desktop a member opened, and shows it to them",
		async () => {
			await botCalls("computers.useBrowser", {
				tool: "browser_navigate",
				arguments: { url: "data:text/html,<h1>Watched</h1>" },
			});

			const exit = await openAs(ownerId);
			if (!Exit.isSuccess(exit)) throw new Error(exit.toString());

			expect(exit.value.endpoint.url).toBe(openedFirst);
			expect(await signsIn(exit.value)).toBe(true);
		},
		SLOW,
	);

	it(
		"shows the desktop to a viewer to watch only, from another server",
		async () => {
			const exit = await openAs(watcherId);
			if (!Exit.isSuccess(exit)) throw new Error(exit.toString());

			expect(exit.value.endpoint.url).not.toBe(openedFirst);
			expect(await signsIn(exit.value)).toBe(true);
		},
		SLOW,
	);

	it(
		"keeps the desktop from anything in the computer without its password",
		async () => {
			const exit = await openAs(ownerId);
			if (!Exit.isSuccess(exit)) throw new Error(exit.toString());

			expect(await signsIn({ ...exit.value, password: "guessed!" })).toBe(false);
		},
		SLOW,
	);

	it(
		"hides it from someone who can't reach the chat",
		async () => {
			const exit = await openAs(outsiderId);

			expect(Exit.isFailure(exit) && exit.toString()).toContain("ResourceHidden");
		},
		SLOW,
	);

	it("refuses a bot that isn't in the chat", async () => {
		const exit = await openAs(ownerId, bystanderId);

		expect(Exit.isFailure(exit) && exit.toString()).toContain("DesktopUnavailable");
	});

	it("refuses a bot in the chat that doesn't use the computer", async () => {
		const exit = await openAs(ownerId, computerlessId);

		expect(Exit.isFailure(exit) && exit.toString()).toContain("DesktopUnavailable");
	});
});

/**
 * Whether a viewer with the desktop's password gets in: RFB 3.8's start
 * (RFC 6143, 7.1), as the relay goes through it.
 */
async function signsIn({ endpoint, password }: DesktopViewer.OpenDesktop): Promise<boolean> {
	const socket = new WebSocket(endpoint.url.replace(/^http/, "ws"), {
		protocols: ["binary"],
		headers: endpoint.headers,
	});
	socket.binaryType = "arraybuffer";
	let buffered = new Uint8Array(0);
	let closed = false;
	const waiting: Array<() => void> = [];
	const wakeAll = () => {
		for (const wake of waiting.splice(0)) wake();
	};
	socket.onmessage = (event) => {
		buffered = Uint8Array.from([...buffered, ...new Uint8Array(event.data as ArrayBuffer)]);
		wakeAll();
	};
	socket.onclose = () => {
		closed = true;
		wakeAll();
	};
	const take = async (count: number) => {
		while (buffered.length < count) {
			if (closed) throw new SocketClosed();
			await new Promise<void>((wake) => waiting.push(wake));
		}
		const taken = buffered.slice(0, count);
		buffered = buffered.slice(count);
		return taken;
	};
	await new Promise((opened, failed) => {
		socket.onopen = opened;
		socket.onerror = () => failed(new Error("The viewer's socket failed"));
	});
	try {
		socket.send(await take(12));
		const [offered = 0] = await take(1);
		if (!(await take(offered)).includes(2)) return false;
		socket.send(Uint8Array.of(2));
		socket.send(answerChallenge(password, await take(16)));
		return (await take(4)).every((byte) => byte === 0);
	} catch (cause) {
		if (cause instanceof SocketClosed) return false;
		throw cause;
	} finally {
		socket.close();
	}
}

/** The desktop closed the socket before saying all it would. */
class SocketClosed extends Error {}
