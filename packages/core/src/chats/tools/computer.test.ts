import { createHash } from "node:crypto";
import { Effect, Exit, Layer, Scope, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	seedBot,
	seedMember,
	seedProjectChat,
	seedWorkspace,
} from "../../authentication/seed.test-support.ts";
import { ComputerProviderStore } from "../../computers/computer-provider-store.ts";
import { ComputerSignIn } from "../../computers/computer-sign-in.ts";
import { Computers } from "../../computers/computers.ts";
import { ProjectComputers } from "../../computers/project-computers.ts";
import { noComputers, recordingIds, removeWorkVolumes } from "../../computers/testing.ts";
import {
	allowedHost,
	bot as botTable,
	member,
	membership,
	message,
	workspace,
} from "../../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../../database/testing.ts";
import { ChatFileStore } from "../../files/chat-file-store.ts";
import { authenticators, principals } from "../../proofs/world.test-support.ts";
import { Egress } from "../../providers/network/egress.ts";
import { unimplemented } from "../../testing.ts";
import { defaultProjectOf } from "../../workspaces/projects/project-reads.ts";
import { seedChat } from "../seed.test-support.ts";
import { stepOnComputer } from "./computer/testing.ts";
import { TurnComputers } from "./computer/turn-computers.ts";

describe.skipIf(!process.env.DATABASE_URL)("computer tool step lifetimes", () => {
	afterAll(closeDatabase);

	it("keeps the later step registered when the earlier scope closes", async () => {
		const workspaceId = await seedWorkspace();
		const memberId = await seedMember(workspaceId, "editor");
		const bot = await seedBot(workspaceId, { usesComputer: true });
		const chatId = await seedProjectChat(workspaceId, bot.defaultProject, memberId);
		const as = principals(await authenticators());
		const principal = await as.botFor(memberId, bot.id, chatId);
		const computers = await runOnPostgres(
			Effect.provide(TurnComputers.Service, TurnComputers.layer).pipe(Effect.provide(noComputers)),
		);
		const turn: TurnComputers.Turn = {
			workspaceId,
			projectId: bot.defaultProject,
			turnId: principal.turn,
			chatId,
			botId: bot.id,
			color: "orange",
			naturalBrowsing: false,
			acceptsImages: false,
		};
		const earlier = Effect.runSync(Scope.make());
		const later = Effect.runSync(Scope.make());
		try {
			await stepOnComputer(computers, principal, turn, earlier);
			const { call } = await stepOnComputer(computers, principal, turn, later);
			await Effect.runPromise(Scope.close(earlier, Exit.void));

			await expect(
				call("computers.runCommand", { command: "pwd", timeout_seconds: 30 }),
			).rejects.toMatchObject({ _tag: "NoComputerProvider" });
		} finally {
			await Effect.runPromise(
				Effect.all([Scope.close(later, Exit.void), Scope.close(earlier, Exit.void)]),
			);
		}
	});
});

/**
 * Where the computer tools work, against Postgres and a real OpenSandbox
 * server (`docker compose --profile computers up -d`, with OPENSANDBOX_URL and
 * OPENSANDBOX_API_KEY set): each chat in its own folder, each bot in its
 * own home, both kept between turns.
 */
const env = process.env;
const configured = env.DATABASE_URL && env.OPENSANDBOX_URL && env.OPENSANDBOX_API_KEY;
const SLOW = 180_000;

describe.skipIf(!configured)("computer tools, against Postgres and OpenSandbox", () => {
	let turnComputers: TurnComputers.Interface;
	let signedIn: ReturnType<typeof principals>;
	let projectComputers: ProjectComputers.Interface;
	let workspaceId: string;
	let ownerId: string;
	const scope = Effect.runSync(Scope.make());
	let botId: string;
	const idsHandedOut = new Set<string>();

	beforeAll(async () => {
		signedIn = principals(await authenticators());
		[turnComputers, projectComputers] = await runOnPostgres(
			Effect.all([TurnComputers.Service, ProjectComputers.Service]).pipe(
				Effect.provide(Layer.merge(TurnComputers.layer, ProjectComputers.layer)),
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
				.values({ name: `Tools ${suffix}`, slug: `tools-${suffix}` })
				.returning(),
		);
		const [owner] = await onDatabase((db) =>
			db
				.insert(member)
				.values({ name: "Sam", email: `tools-${suffix}@example.com` })
				.returning(),
		);
		if (!space || !owner) throw new Error("fixture");
		ownerId = owner.id;
		await onDatabase((db) =>
			db.insert(membership).values({ workspaceId: space.id, memberId: owner.id }),
		);
		workspaceId = space.id;
		// A bot's computer is its default project's, which comes with the bot.
		const [bot] = await onDatabase((db) =>
			db
				.insert(botTable)
				.values({
					workspaceId: space.id,
					name: `Tools bot ${suffix}`,
					handle: `tools-bot-${suffix}`,
					color: "orange",
					eyes: "pill",
					usesComputer: true,
					createdById: owner.id,
				})
				.returning({ id: botTable.id }),
		);
		if (!bot) throw new Error("fixture");
		botId = bot.id;
		const providers = await runOnPostgres(
			Effect.provide(ComputerProviderStore.Service, ComputerProviderStore.layer),
		);
		await runOnPostgres(
			providers.create(space.id, {
				createdById: owner.id,
				provider: {
					settings: {
						builtIn: "opensandbox",
						serverUrl: env.OPENSANDBOX_URL,
						// The local build of the default image, for its browser:
						// `bun run build:computer` first.
						image: "sugabots-computer:dev",
						networkMode: "allowed-hosts-only",
					},
					enabled: true,
					apiKey: env.OPENSANDBOX_API_KEY,
				},
			}),
		);
	});

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

	/** A new chat with the bot `withBot`, in its default project, which Sam started. */
	const newChat = (title: string, withBot = botId) =>
		onDatabase((db) =>
			seedChat(db, {
				workspaceId,
				kind: "project_chat",
				botId: withBot,
				title,
				startedById: ownerId,
			}),
		).then((chat) => chat.id);

	/**
	 * A turn of `withBot`'s answering Sam in `chatId`, and its calls to the
	 * computers operations, in one step held open for the file.
	 */
	const turnIn = async (chatId: string, withBot = botId, attach?: TurnComputers.Turn["attach"]) => {
		const principal = await signedIn.botFor(ownerId, withBot, chatId);
		const { call } = await stepOnComputer(
			turnComputers,
			principal,
			{
				workspaceId,
				projectId: await runOnPostgres(defaultProjectOf(withBot)),
				turnId: principal.turn,
				chatId,
				botId: withBot,
				color: "orange",
				naturalBrowsing: false,
				acceptsImages: false,
				...(attach && { attach }),
			},
			scope,
		);
		return call;
	};

	type Calls = Awaited<ReturnType<typeof turnIn>>;

	const run = (call: Calls, command: string) =>
		call("computers.runCommand", { command, timeout_seconds: 30 }).then((result) =>
			String(result.stdout).trim(),
		);

	it(
		"starts commands in the chat's folder, with the bot's home as HOME",
		async () => {
			const chatId = await newChat("Folders");
			const call = await turnIn(chatId);

			expect(await run(call, "pwd")).toBe(`${Computers.WORK_DIRECTORY}/chats/${chatId}`);
			expect(await run(call, "echo $HOME")).toBe(`${Computers.WORK_DIRECTORY}/bots/${botId}`);
		},
		SLOW,
	);

	it(
		"keeps a chat's files for its next turn, and apart from other chats",
		async () => {
			const chatId = await newChat("Notes");
			const first = await turnIn(chatId);
			await first("computers.writeFile", { path: "notes.txt", content: "chat b" });

			const later = await turnIn(chatId);
			const elsewhere = await turnIn(await newChat("Elsewhere"));

			expect((await later("computers.readFile", { path: "notes.txt" })).content).toBe("chat b");
			expect((await elsewhere("computers.readFile", { path: "notes.txt" })).status).toBe("failed");
		},
		SLOW,
	);

	it(
		"copies a file in the chat into its folder when asked, under a safe name",
		async () => {
			const [host] = await onDatabase((db) =>
				db
					.insert(botTable)
					.values({
						workspaceId,
						name: "Editor",
						handle: `editor-${Date.now()}`,
						color: "green",
						eyes: "pill",
						usesComputer: true,
						createdById: ownerId,
					})
					.returning(),
			);
			if (!host) throw new Error("fixture");
			const where = await newChat("Pictures", host.id);
			const [sent] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						chatId: where,
						authorMemberId: ownerId,
						status: "complete",
						parts: [],
						content: "",
					})
					.returning(),
			);
			if (!sent) throw new Error("fixture");
			// Not text: a NUL and bytes that aren't UTF-8 must come through as they are.
			const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0a]);
			const files = await runOnPostgres(Effect.provide(ChatFileStore.Service, ChatFileStore.layer));
			const uploaded = await runOnPostgres(
				files.upload({
					chatId: where,
					uploaderId: ownerId,
					name: "../dot.png",
					maxSize: 1_000,
					maxUnsent: 20,
					content: { stream: Stream.succeed(bytes), contentType: "image/png" },
				}),
			);
			await runOnPostgres(
				files.attach({
					chatId: where,
					messageId: sent.id,
					uploaderId: ownerId,
					fileIds: [uploaded.id],
				}),
			);
			const call = await turnIn(where, host.id);
			const hash = createHash("sha256").update(bytes).digest("hex");

			const path = `attachments/${uploaded.id}/_dot.png`;
			const copy = () => call("computers.copyChatFile", { file: uploaded.id });

			expect(await copy()).toMatchObject({ path, alreadyCopied: false });
			expect(await run(call, `sha256sum ${path} | cut -d' ' -f1`)).toBe(hash);
			// Nothing half copied is left beside it.
			expect(await run(call, `ls -A attachments/${uploaded.id}`)).toBe("_dot.png");

			// Copying again keeps the changes made to the copy.
			await run(call, `echo inverted > ${path}`);
			expect(await copy()).toMatchObject({ path, alreadyCopied: true });
			expect(await run(call, `cat ${path}`)).toBe("inverted");

			await run(call, `rm ${path}`);
			expect(await copy()).toMatchObject({ path, alreadyCopied: false });
			expect(await run(call, `sha256sum ${path} | cut -d' ' -f1`)).toBe(hash);

			const elsewhere = await turnIn(await newChat("Other", host.id), host.id);
			expect(await elsewhere("computers.copyChatFile", { file: uploaded.id })).toMatchObject({
				status: "failed",
			});
		},
		SLOW,
	);

	it(
		"attaches a file from the computer to the reply, read as it is, and refuses one too large",
		async () => {
			const attached: { name: string; contentType: string; content: Uint8Array }[] = [];
			const call = await turnIn(await newChat("Sharing"), botId, (file) => {
				attached.push(file);
				return Effect.succeed({
					type: "file" as const,
					id: `file-${attached.length}`,
					name: file.name,
					contentType: file.contentType,
					size: file.content.byteLength,
				});
			});
			// A PNG's signature, then bytes that aren't text.
			await run(
				call,
				String.raw`mkdir -p out && printf '\x89PNG\r\n\x1a\n\x00\xff' > out/chart.png`,
			);
			await run(call, String.raw`printf 'region,total\nnorth,4\n' > report.csv`);
			await run(call, "truncate -s 11M big.bin");

			expect(await call("computers.shareFile", { path: "out/chart.png" })).toMatchObject({
				shared: "chart.png",
				file: "file-1",
			});
			expect(
				await call("computers.shareFile", { path: "report.csv", name: "../Q3 totals.csv" }),
			).toMatchObject({
				shared: "_Q3 totals.csv",
			});
			expect(attached.map(({ name, contentType }) => ({ name, contentType }))).toEqual([
				{ name: "chart.png", contentType: "image/png" },
				{ name: "_Q3 totals.csv", contentType: "text/csv; charset=utf-8" },
			]);
			expect([...(attached[0]?.content ?? [])]).toEqual([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff,
			]);

			expect(await call("computers.shareFile", { path: "big.bin" })).toMatchObject({
				status: "failed",
				error: expect.stringContaining("files up to 10 MB"),
			});
			expect(await call("computers.shareFile", { path: "nowhere.png" })).toMatchObject({
				status: "failed",
			});
			expect(attached).toHaveLength(2);
		},
		SLOW,
	);

	it(
		"keeps a bot's home across its chats",
		async () => {
			const one = await turnIn(await newChat("One"));
			await run(one, "echo remembered > ~/memo");
			const other = await turnIn(await newChat("Other"));

			expect(await run(other, "cat ~/memo")).toBe("remembered");
		},
		SLOW,
	);

	it(
		"reaches the trusted hosts, and a host the workspace adds at once",
		async () => {
			const call = await turnIn(await newChat("Hosts"));
			const reaches = async (host: string) =>
				(await run(
					call,
					`curl -s -o /dev/null --max-time 10 https://${host} && echo yes || echo no`,
				)) === "yes";
			expect([await reaches("github.com"), await reaches("example.com")]).toEqual([true, false]);

			await onDatabase((db) => db.insert(allowedHost).values({ workspaceId, host: "example.com" }));
			await runOnPostgres(projectComputers.applyNetwork({ workspaceId }));

			expect(await reaches("example.com")).toBe(true);
		},
		SLOW,
	);

	it(
		"drives a browser of the bot's own, and has no screenshots for a model that can't see them",
		async () => {
			const call = await turnIn(await newChat("Browsing"));

			const opened = await call("computers.useBrowser", {
				tool: "browser_navigate",
				arguments: {
					url: "data:text/html,<title>Sugabots</title><h1>Hello from the computer</h1>",
				},
			});
			const snapshot = await call("computers.useBrowser", {
				tool: "browser_snapshot",
				arguments: {},
			});
			const screenshot = await call("computers.useBrowser", {
				tool: "browser_take_screenshot",
				arguments: {},
			});

			expect(String(opened.text)).toContain("Your browser has just started");
			expect(String(snapshot.text)).toContain("Hello from the computer");
			expect(screenshot).toMatchObject({ status: "failed" });
		},
		SLOW,
	);
});
