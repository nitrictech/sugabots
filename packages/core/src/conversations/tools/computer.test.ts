import { createHash } from "node:crypto";
import type { ToolSet } from "ai";
import { Effect, Exit, Layer, Scope, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ComputerCredentials } from "../../computers/computer-credentials.ts";
import { ComputerProviderRepository } from "../../computers/computer-provider-repository.ts";
import { Computers } from "../../computers/computers.ts";
import { ProjectComputers } from "../../computers/project-computers.ts";
import { recordingIds, removeWorkVolumes } from "../../computers/testing.ts";
import {
	allowedHost,
	bot as botTable,
	message,
	user,
	workspace,
	workspaceMember,
} from "../../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../../database/testing.ts";
import { ConversationFiles } from "../../files/conversation-files.ts";
import { Egress } from "../../providers/network/egress.ts";
import { unimplemented } from "../../testing.ts";
import { defaultProjectOf } from "../../workspaces/projects/project-reads.ts";
import { seedConversation } from "../seed.test-support.ts";
import { ComputerTools } from "./computer.ts";

/**
 * Where the computer tools work, against Postgres and a real OpenSandbox
 * server (`docker compose --profile computers up -d`, with OPENSANDBOX_URL and
 * OPENSANDBOX_API_KEY set): each conversation in its own folder, each bot in its
 * own home, both kept between turns.
 */
const env = process.env;
const configured = env.DATABASE_URL && env.OPENSANDBOX_URL && env.OPENSANDBOX_API_KEY;
const SLOW = 180_000;

describe.skipIf(!configured)("computer tools, against Postgres and OpenSandbox", () => {
	let computerTools: ComputerTools.Interface;
	let projectComputers: ProjectComputers.Interface;
	let workspaceId: string;
	let ownerId: string;
	const scope = Effect.runSync(Scope.make());
	let botId: string;
	/** The bot's default project, whose computer the turns use. */
	let projectId: string;
	const idsHandedOut = new Set<string>();

	beforeAll(async () => {
		[computerTools, projectComputers] = await runOnPostgres(
			Effect.all([ComputerTools.Service, ProjectComputers.Service]).pipe(
				Effect.provide(Layer.merge(ComputerTools.layer, ProjectComputers.layer)),
				Effect.provide(ComputerCredentials.none),
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
				.insert(user)
				.values({ name: "Sam", email: `tools-${suffix}@example.com` })
				.returning(),
		);
		if (!space || !owner) throw new Error("fixture");
		ownerId = owner.id;
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId: space.id, userId: owner.id }),
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
					face: "pill",
					createdById: owner.id,
				})
				.returning({ id: botTable.id }),
		);
		if (!bot) throw new Error("fixture");
		botId = bot.id;
		projectId = await runOnPostgres(defaultProjectOf(bot.id));
		const providers = await runOnPostgres(
			Effect.provide(ComputerProviderRepository.Service, ComputerProviderRepository.layer),
		);
		await runOnPostgres(
			providers.create(space.id, {
				createdById: owner.id,
				provider: {
					settings: {
						preset: "opensandbox",
						serverUrl: env.OPENSANDBOX_URL,
						// The local build of the default image, for its browser:
						// `bun run build:computer` first.
						image: "sugabots-sandbox:dev",
						networkMode: "allowlist",
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
			Effect.provide(ComputerProviderRepository.Service, ComputerProviderRepository.layer),
		);
		const provider = await runOnPostgres(providers.enabled(workspaceId));
		if (provider) await runOnPostgres(projectComputers.destroyAllMadeBy(workspaceId, provider));
		await closeDatabase();
		removeWorkVolumes(idsHandedOut);
	}, SLOW);

	const toolsFor = (
		turnId: string,
		conversationId: string,
		botId: string,
		attach?: ComputerTools.Turn["attach"],
	) =>
		runOnPostgres(
			Scope.provide(scope)(
				computerTools.forTurn({
					workspaceId,
					projectId,
					usesComputer: true,
					turnId,
					conversationId,
					botId,
					color: "orange",
					naturalBrowsing: false,
					acceptsImages: false,
					...(attach && { attach }),
				}),
			),
		).then((offered) => offered.tools);

	const call = async (tools: ToolSet, name: string, input: object) => {
		const execute = tools[name]?.execute;
		if (!execute) throw new Error(`no ${name} tool`);
		// The SDK types each tool's input; these calls give each tool its own shape.
		const untyped = execute as (input: object, options: object) => Promise<unknown>;
		return (await untyped(input, { toolCallId: name, messages: [] })) as Record<string, unknown>;
	};

	const run = (tools: ToolSet, command: string) =>
		call(tools, "run_command", { command, timeout_seconds: 30 }).then((result) =>
			String(result.stdout).trim(),
		);

	it(
		"starts commands in the conversation's folder, with the bot's home as HOME",
		async () => {
			const tools = await toolsFor("turn-1", "conversation-a", botId);

			expect(await run(tools, "pwd")).toBe(`${Computers.WORKSPACE_DIRECTORY}/threads/thread-a`);
			expect(await run(tools, "echo $HOME")).toBe(`${Computers.WORKSPACE_DIRECTORY}/bots/bot-1`);
		},
		SLOW,
	);

	it(
		"keeps a conversation's files for its next turn, and apart from other conversations",
		async () => {
			const first = await toolsFor("turn-2", "conversation-b", botId);
			await call(first, "write_file", { path: "notes.txt", content: "conversation b" });

			const later = await toolsFor("turn-3", "conversation-b", botId);
			const elsewhere = await toolsFor("turn-4", "conversation-c", botId);

			expect((await call(later, "read_file", { path: "notes.txt" })).content).toBe(
				"conversation b",
			);
			expect((await call(elsewhere, "read_file", { path: "notes.txt" })).status).toBe("failed");
		},
		SLOW,
	);

	it(
		"copies a file in the conversation into its folder when asked, under a safe name",
		async () => {
			const [host] = await onDatabase((db) =>
				db
					.insert(botTable)
					.values({
						workspaceId,
						name: "Editor",
						handle: `editor-${Date.now()}`,
						color: "green",
						face: "pill",
					})
					.returning(),
			);
			if (!host) throw new Error("fixture");
			const newThread = (title: string) =>
				onDatabase((db) =>
					seedConversation(db, {
						workspaceId,
						kind: "project_thread",
						botId: host.id,
						title,
						startedById: ownerId,
					}),
				);
			const where = await newThread("Pictures");
			const [sent] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						conversationId: where.id,
						authorUserId: ownerId,
						kind: "text",
						status: "complete",
						parts: [],
						content: "",
					})
					.returning(),
			);
			if (!sent) throw new Error("fixture");
			// Not text: a NUL and bytes that aren't UTF-8 must come through as they are.
			const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0a]);
			const files = await runOnPostgres(
				Effect.provide(ConversationFiles.Service, ConversationFiles.layer),
			);
			const uploaded = await runOnPostgres(
				files.upload({
					conversationId: where.id,
					uploaderId: ownerId,
					name: "../dot.png",
					maxSize: 1_000,
					maxUnsent: 20,
					content: { stream: Stream.succeed(bytes), contentType: "image/png" },
				}),
			);
			await runOnPostgres(
				files.attach({
					conversationId: where.id,
					messageId: sent.id,
					uploaderId: ownerId,
					fileIds: [uploaded.id],
				}),
			);
			const tools = await toolsFor("turn-9", where.id, host.id);
			const hash = createHash("sha256").update(bytes).digest("hex");

			const path = `attachments/${uploaded.id}/_dot.png`;
			const copy = () => call(tools, "copy_file_to_computer", { file: uploaded.id });

			expect(await copy()).toMatchObject({ path, alreadyCopied: false });
			expect(await run(tools, `sha256sum ${path} | cut -d' ' -f1`)).toBe(hash);
			// Nothing half copied is left beside it.
			expect(await run(tools, `ls -A attachments/${uploaded.id}`)).toBe("_dot.png");

			// Copying again keeps the changes made to the copy.
			await run(tools, `echo inverted > ${path}`);
			expect(await copy()).toMatchObject({ path, alreadyCopied: true });
			expect(await run(tools, `cat ${path}`)).toBe("inverted");

			await run(tools, `rm ${path}`);
			expect(await copy()).toMatchObject({ path, alreadyCopied: false });
			expect(await run(tools, `sha256sum ${path} | cut -d' ' -f1`)).toBe(hash);

			const elsewhere = await toolsFor("turn-10", (await newThread("Other")).id, host.id);
			expect(await call(elsewhere, "copy_file_to_computer", { file: uploaded.id })).toMatchObject({
				status: "failed",
			});
		},
		SLOW,
	);

	it(
		"attaches a file from the computer to the reply, read as it is, and refuses one too large",
		async () => {
			const attached: { name: string; contentType: string; content: Uint8Array }[] = [];
			const tools = await toolsFor("turn-12", "conversation-h", botId, (file) => {
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
				tools,
				String.raw`mkdir -p out && printf '\x89PNG\r\n\x1a\n\x00\xff' > out/chart.png`,
			);
			await run(tools, String.raw`printf 'region,total\nnorth,4\n' > report.csv`);
			await run(tools, "truncate -s 11M big.bin");

			expect(await call(tools, "share_file", { path: "out/chart.png" })).toMatchObject({
				shared: "chart.png",
				file: "file-1",
			});
			expect(
				await call(tools, "share_file", { path: "report.csv", name: "../Q3 totals.csv" }),
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

			expect(await call(tools, "share_file", { path: "big.bin" })).toMatchObject({
				status: "failed",
				error: expect.stringContaining("files up to 10 MB"),
			});
			expect(await call(tools, "share_file", { path: "nowhere.png" })).toMatchObject({
				status: "failed",
			});
			expect(attached).toHaveLength(2);
		},
		SLOW,
	);

	it(
		"keeps a bot's home across its conversations",
		async () => {
			const one = await toolsFor("turn-5", "conversation-d", botId);
			await run(one, "echo remembered > ~/memo");
			const other = await toolsFor("turn-6", "conversation-e", botId);

			expect(await run(other, "cat ~/memo")).toBe("remembered");
		},
		SLOW,
	);

	it(
		"reaches the trusted hosts, and a host the workspace adds at once",
		async () => {
			const tools = await toolsFor("turn-8", "conversation-g", botId);
			const reaches = async (host: string) =>
				(await run(
					tools,
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
		"drives a browser of the bot's own, and leaves out screenshots for a model that can't see them",
		async () => {
			const tools = await toolsFor("turn-7", "conversation-f", botId);

			const opened = await call(tools, "browser_navigate", {
				url: "data:text/html,<title>Sugabots</title><h1>Hello from the computer</h1>",
			});
			const snapshot = await call(tools, "browser_snapshot", {});

			expect(String(opened.text)).toContain("Your browser has just started");
			expect(String(snapshot.text)).toContain("Hello from the computer");
			expect(tools.browser_take_screenshot).toBeUndefined();
		},
		SLOW,
	);
});
