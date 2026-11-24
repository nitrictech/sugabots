import type { ToolSet } from "ai";
import { Effect, Exit, Layer, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CurrentActor } from "../../../authorization/current-actor.ts";
import { ComputerProviderStore } from "../../../computers/computer-provider-store.ts";
import { ComputerSignIn } from "../../../computers/computer-sign-in.ts";
import { ProjectComputers } from "../../../computers/project-computers.ts";
import { recordingIds, removeWorkVolumes } from "../../../computers/testing.ts";
import {
	bot as botTable,
	chatParticipant,
	member,
	membership,
	workspace,
} from "../../../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../../../database/testing.ts";
import { Egress } from "../../../providers/network/egress.ts";
import { unimplemented } from "../../../testing.ts";
import { defaultProjectOf } from "../../../workspaces/projects/project-reads.ts";
import { seedChat } from "../../seed.test-support.ts";
import { ComputerTools } from "../computer.ts";
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
	let tools: ToolSet;
	let viewer: DesktopViewer.Interface;
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
		let computerTools: ComputerTools.Interface;
		let providers: ComputerProviderStore.Interface;
		[computerTools, viewer, projectComputers, providers] = await runOnPostgres(
			Effect.all([
				ComputerTools.Service,
				DesktopViewer.Service,
				ProjectComputers.Service,
				ComputerProviderStore.Service,
			]).pipe(
				Effect.provide(
					Layer.mergeAll(
						ComputerTools.layer,
						DesktopViewer.layer,
						ProjectComputers.layer,
						ComputerProviderStore.layer,
					),
				),
				Effect.provide(ComputerSignIn.none),
				Effect.provide(recordingIds(idsHandedOut)),
				// Registries are asked what an image's tag names, as in production.
				Effect.provide(unimplemented(Egress.Service, { providers: { for: () => fetch } })),
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
		tools = await runOnPostgres(
			Scope.provide(scope)(
				computerTools.forTurn({
					workspaceId,
					projectId: await runOnPostgres(defaultProjectOf(botId)),
					usesComputer: true,
					naturalBrowsing: false,
					turnId: "turn-1",
					chatId,
					botId,
					color: "orange",
					acceptsImages: false,
				}),
			),
		).then((offered) => offered.tools);
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

	const openAs = (memberId: string, of = botId) =>
		runOnPostgres(
			Effect.exit(
				Scope.provide(scope)(viewer.open({ chatId, botId: of })).pipe(
					CurrentActor.provide(CurrentActor.AuthenticatedMemberId.vouchedFor(memberId)),
				),
			),
		);

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
			const navigate = tools.browser_navigate?.execute as (
				input: object,
				options: object,
			) => Promise<unknown>;
			await navigate({ url: "data:text/html,<h1>Watched</h1>" }, { toolCallId: "1", messages: [] });

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
	} as unknown as string[]);
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
