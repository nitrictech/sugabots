import type { ToolSet } from "ai";
import { Effect, Exit, Layer, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CurrentActor } from "../../../authorization/current-actor.ts";
import {
	agent,
	pod,
	podMember,
	thread,
	threadParticipant,
	user,
	workspace,
	workspaceMember,
} from "../../../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../../../database/testing.ts";
import { Installation } from "../../../installation/installation.ts";
import { Egress } from "../../../providers/network/egress.ts";
import { PodSandboxes } from "../../../sandboxes/pod-sandboxes.ts";
import { SandboxProviderRepository } from "../../../sandboxes/sandbox-provider-repository.ts";
import { SandboxTools } from "../sandbox.ts";
import { DesktopViewer } from "./viewer.ts";
import { answerChallenge } from "./vnc-authentication.ts";

/** The installation and its egress, which the git tools reach GitHub through. */
const installationLayer = Egress.layer.pipe(
	Layer.provideMerge(
		Layer.succeed(
			Installation.Service,
			Installation.fromUrls({ isProduction: false, publicUrl: "http://localhost:3000" }),
		),
	),
);

/**
 * Watching an agent's desktop, against Postgres and a real OpenSandbox server
 * running the default image (`docker compose --profile sandboxes up -d` and
 * `bun run build:sandbox`, with OPENSANDBOX_URL and OPENSANDBOX_API_KEY set).
 */
const env = process.env;
const configured = env.DATABASE_URL && env.OPENSANDBOX_URL && env.OPENSANDBOX_API_KEY;
const SLOW = 180_000;

describe.skipIf(!configured)("the desktop viewer, against Postgres and OpenSandbox", () => {
	let tools: ToolSet;
	let viewer: DesktopViewer.Interface;
	let podSandboxes: PodSandboxes.Interface;
	let workspaceId: string;
	let ownerId: string;
	let outsiderId: string;
	let watcherId: string;
	let agentId: string;
	let bystanderId: string;
	let sandboxlessId: string;
	let threadId: string;
	const scope = Effect.runSync(Scope.make());

	beforeAll(async () => {
		let sandboxTools: SandboxTools.Interface;
		let providers: SandboxProviderRepository.Interface;
		[sandboxTools, viewer, podSandboxes, providers] = await runOnPostgres(
			Effect.all([
				SandboxTools.Service,
				DesktopViewer.Service,
				PodSandboxes.Service,
				SandboxProviderRepository.Service,
			]).pipe(
				Effect.provide(
					Layer.mergeAll(
						SandboxTools.layer.pipe(Layer.provide(installationLayer)),
						DesktopViewer.layer,
						PodSandboxes.layer,
						SandboxProviderRepository.layer,
					),
				),
			),
		);
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Viewer ${suffix}`, slug: `viewer-${suffix}` })
				.returning(),
		);
		const people = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Sam", email: `viewer-sam-${suffix}@example.com` },
					{ name: "Kim", email: `viewer-kim-${suffix}@example.com` },
					{ name: "Lee", email: `viewer-lee-${suffix}@example.com` },
				])
				.returning(),
		);
		const [owner, outsider, watcher] = people;
		if (!space || !owner || !outsider || !watcher) throw new Error("fixture");
		workspaceId = space.id;
		ownerId = owner.id;
		outsiderId = outsider.id;
		watcherId = watcher.id;
		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				// An administrator is put in every shared pod.
				{ workspaceId, userId: ownerId, role: "admin" },
				{ workspaceId, userId: outsiderId },
				{ workspaceId, userId: watcherId, role: "viewer" },
			]),
		);
		const [shared] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId,
					ownerId,
					kind: "shared",
					name: "Builders",
					slug: "builders",
					createdById: ownerId,
				})
				.returning(),
		);
		if (!shared) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(podMember).values({ workspaceId, podId: shared.id, userId: watcherId }),
		);
		const agentIn = (name: string, usesSandbox: boolean): typeof agent.$inferInsert => ({
			workspaceId,
			podId: shared.id,
			name,
			handle: `${name.toLowerCase().replaceAll(" ", "-")}-${suffix}`,
			color: "green",
			face: "pill",
			model: "no-such-model",
			usesSandbox,
			createdById: ownerId,
		});
		const [bot, bystander, sandboxless] = await onDatabase((db) =>
			db
				.insert(agent)
				.values([
					agentIn("Browser Bot", true),
					agentIn("Bystander Bot", true),
					agentIn("Sandboxless Bot", false),
				])
				.returning(),
		);
		if (!bot || !bystander || !sandboxless) throw new Error("fixture");
		agentId = bot.id;
		bystanderId = bystander.id;
		sandboxlessId = sandboxless.id;
		const [conversation] = await onDatabase((db) =>
			db
				.insert(thread)
				.values({
					workspaceId,
					podId: shared.id,
					hostAgentId: agentId,
					type: "chat",
					title: "Look something up",
				})
				.returning(),
		);
		if (!conversation) throw new Error("fixture");
		threadId = conversation.id;
		await onDatabase((db) =>
			db.insert(threadParticipant).values({ threadId, agentId: sandboxlessId }),
		);
		await runOnPostgres(
			providers.create(workspaceId, {
				createdById: ownerId,
				provider: {
					settings: { preset: "opensandbox", serverUrl: env.OPENSANDBOX_URL },
					enabled: true,
					apiKey: env.OPENSANDBOX_API_KEY,
				},
			}),
		);
		tools = await runOnPostgres(
			Scope.provide(scope)(
				sandboxTools.forTurn({
					pod: { workspaceId, podId: shared.id },
					usesSandbox: true,
					turnId: "turn-1",
					threadId,
					agentId,
					model: "no-such-model",
				}),
			),
		).then((offered) => offered.tools);
	}, SLOW);

	afterAll(async () => {
		await Effect.runPromise(Scope.close(scope, Exit.void));
		const providers = await runOnPostgres(
			Effect.provide(SandboxProviderRepository.Service, SandboxProviderRepository.layer),
		);
		const provider = await runOnPostgres(providers.enabled(workspaceId));
		if (provider) await runOnPostgres(podSandboxes.destroyAllMadeBy(workspaceId, provider));
		await closeDatabase();
	}, SLOW);

	const openAs = (userId: string, of = agentId) =>
		runOnPostgres(
			Effect.exit(
				Scope.provide(scope)(viewer.open({ threadId, agentId: of })).pipe(
					CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(userId)),
				),
			),
		);

	let openedFirst: string | undefined;

	it(
		"starts the desktop for someone who opens it before the agent has used its browser",
		async () => {
			const exit = await openAs(ownerId);
			if (!Exit.isSuccess(exit)) throw new Error(exit.toString());
			openedFirst = exit.value.endpoint.url;

			expect(await logsIn(exit.value)).toBe(true);
		},
		SLOW,
	);

	it(
		"gives the agent's browser the desktop a person opened, and shows it to them",
		async () => {
			const navigate = tools.browser_navigate?.execute as (
				input: object,
				options: object,
			) => Promise<unknown>;
			await navigate({ url: "data:text/html,<h1>Watched</h1>" }, { toolCallId: "1", messages: [] });

			const exit = await openAs(ownerId);
			if (!Exit.isSuccess(exit)) throw new Error(exit.toString());

			expect(exit.value.endpoint.url).toBe(openedFirst);
			expect(await logsIn(exit.value)).toBe(true);
		},
		SLOW,
	);

	it(
		"shows the desktop to a pod's viewer to watch only, from another server",
		async () => {
			const exit = await openAs(watcherId);
			if (!Exit.isSuccess(exit)) throw new Error(exit.toString());

			expect(exit.value.endpoint.url).not.toBe(openedFirst);
			expect(await logsIn(exit.value)).toBe(true);
		},
		SLOW,
	);

	it(
		"keeps the desktop from anything in the sandbox without its password",
		async () => {
			const exit = await openAs(ownerId);
			if (!Exit.isSuccess(exit)) throw new Error(exit.toString());

			expect(await logsIn({ ...exit.value, password: "guessed!" })).toBe(false);
		},
		SLOW,
	);

	it(
		"hides it from someone who can't reach the thread's pod",
		async () => {
			const exit = await openAs(outsiderId);

			expect(Exit.isFailure(exit) && exit.toString()).toContain("ResourceHidden");
		},
		SLOW,
	);

	it("refuses an agent of the pod that isn't in the thread", async () => {
		const exit = await openAs(ownerId, bystanderId);

		expect(Exit.isFailure(exit) && exit.toString()).toContain("DesktopUnavailable");
	});

	it("refuses an agent in the thread that doesn't use the sandbox", async () => {
		const exit = await openAs(ownerId, sandboxlessId);

		expect(Exit.isFailure(exit) && exit.toString()).toContain("DesktopUnavailable");
	});
});

/**
 * Whether a viewer with the desktop's password gets in: RFB 3.8's start
 * (RFC 6143, 7.1), as the relay goes through it. x11vnc wants an Origin, as
 * a browser sends, before it takes a WebSocket.
 */
async function logsIn({ endpoint, password }: DesktopViewer.OpenDesktop): Promise<boolean> {
	const socket = new WebSocket(endpoint.url.replace(/^http/, "ws"), {
		protocols: ["binary"],
		headers: { ...endpoint.headers, origin: "http://localhost" },
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
