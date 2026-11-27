import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeFileSystem } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import { WorkflowEngines } from "@sugabots/workflow/engine";
import { sql } from "drizzle-orm";
import { makeWithDefaults } from "drizzle-orm/effect-postgres";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import {
	ConfigProvider,
	Duration,
	Effect,
	Layer,
	ManagedRuntime,
	Option,
	Redacted,
	Schedule,
	Schema,
	Stream,
} from "effect";
import { DurableDeferred, Workflow } from "effect/unstable/workflow";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebhookAuthentication, WebhookRefused } from "../authentication/webhook.ts";
import { reachesBotFor, reachesChatFor, reachesProjectFor } from "../authorization/access.ts";
import { BlobStore } from "../blob-store/blob-store.ts";
import { BlobDeletions } from "../blob-store/deletions.ts";
import { fromFileSystem } from "../blob-store/implementations/filesystem.ts";
import { Compaction, CompactionRequest } from "../chats/compaction/compaction.workflow.ts";
import { TurnRequests } from "../chats/turns/turns.ts";
import { ChatFileStore } from "../files/chat-file-store.ts";
import { Files } from "../files/files.ts";
import { Ids } from "../ids/ids.ts";
import { Secrets } from "../secrets/secrets.ts";
import { type Database, layer as databaseLayer, query, transaction } from "./database.ts";
import { applyMigrations } from "./migrations.ts";
import {
	bytesQueuedForDeletion,
	LAST_MAIN_MIGRATION,
	type LegacyFile,
	legacy,
	legacyBytes,
	legacyFiles,
	legacyKeyOf,
	legacyRows,
	legacySummaryRequest,
} from "./upgrade.test-support.ts";

/**
 * Upgrading an installation `main` left before bots and projects: its
 * database migrated to the last migration it had, holding rows of each kind,
 * with their bytes in the blob store, then every later migration run at once,
 * as `db:migrate` runs them, and the server started on it.
 *
 * Each blob store is upgraded in a database of its own, since the folders a
 * migration moved are moved by whichever store the server starts with.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * How long migrating a database from nothing, twice over, may take, and how
 * long dropping it may take while the rest of the suite loads the server.
 */
const UPGRADE_TIMEOUT_MS = 120_000;

type Store = "postgres" | "filesystem";

describe.skipIf(!process.env.DATABASE_URL).for<Store>(["postgres", "filesystem"])(
	"upgrading from main, with blobs on %s",
	(store) => {
		const url = upgradeDatabaseUrl(process.env.DATABASE_URL ?? "", store);
		let root: string;
		let upgraded: Upgraded;
		let submitted: SubmittedToMainsEngine;
		/** The folders queued for deletion as the upgrade left them, before any case works the queue. */
		let queuedByTheUpgrade: string[];

		beforeAll(async () => {
			root = await mkdtemp(join(tmpdir(), "upgrade-blobs-"));
			await recreateDatabase(url);
			await migrateTo(url, LAST_MAIN_MIGRATION);
			await withClient(url, async (client) => {
				await client.query(legacyRows);
				await client.query(legacySummaryRequest);
			});
			await storeLegacyBytes(url, store, root);
			submitted = await submitToMainsEngine(url);
			await Effect.runPromise(applyMigrations.pipe(Effect.provide(poolAt(url))));
			upgraded = startServer(url, store, root);
			queuedByTheUpgrade = (
				await upgraded.rows<{ prefix: string }>(`select prefix from blob_deletion order by prefix`)
			).map(({ prefix }) => prefix);
		}, UPGRADE_TIMEOUT_MS);

		afterAll(async () => {
			await upgraded?.dispose();
			await dropDatabase(url);
			await rm(root, { recursive: true, force: true });
		}, UPGRADE_TIMEOUT_MS);

		it("keeps every computer at its provider, with its work, where its pod's work went", async () => {
			const computers = await upgraded.rows<{
				id: string;
				provider_computer_id: string;
				project_id: string;
				default_of_bot_id: string | null;
			}>(
				`select computer.id, computer.provider_computer_id, computer.project_id, project.default_of_bot_id
				 from computer join project on project.id = computer.project_id order by computer.id`,
			);

			expect(computers).toEqual([
				// A shared pod's stays with the project it became, bots or none.
				{
					id: legacy.computers.family.id,
					provider_computer_id: legacy.computers.family.providerId,
					project_id: legacy.pods.family,
					default_of_bot_id: null,
				},
				{
					id: legacy.computers.notes.id,
					provider_computer_id: legacy.computers.notes.providerId,
					project_id: legacy.pods.notes,
					default_of_bot_id: null,
				},
				// A personal pod's goes to its bot other than the Personal Assistant.
				{
					id: legacy.computers.pat.id,
					provider_computer_id: legacy.computers.pat.providerId,
					project_id: expect.any(String),
					default_of_bot_id: legacy.bots.helper,
				},
			]);
		});

		it("queues the computer of a personal pod with no bots to be destroyed at its provider", async () => {
			expect(
				await upgraded.rows(
					`select workspace_id, computer_provider_id, provider_computer_id from computer_destruction`,
				),
			).toEqual([
				{
					workspace_id: legacy.workspace,
					computer_provider_id: legacy.provider,
					provider_computer_id: legacy.computers.ana.providerId,
				},
			]);
		});

		it("gives every project a lead among its bots, and one with no bots a lead that answers nobody", async () => {
			const projects = await upgraded.rows<{
				id: string;
				lead: string;
				name: string;
				model: string | null;
				in_project: boolean;
			}>(
				`select project.id, bot.id as lead, bot.name, bot.model,
					exists (select 1 from project_bot where project_bot.project_id = project.id and project_bot.bot_id = bot.id) as in_project
				 from project join bot on bot.id = project.lead_bot_id
				 where project.default_of_bot_id is null order by project.id`,
			);

			expect(projects).toEqual([
				{
					id: legacy.pods.family,
					lead: legacy.bots.planner,
					name: "Planner",
					model: "m",
					in_project: true,
				},
				{
					id: legacy.pods.notes,
					lead: expect.any(String),
					name: "Lead",
					model: null,
					in_project: true,
				},
			]);
		});

		it("keeps a shared pod's bots, chats, files, connectors and computer to its members", async () => {
			const { family } = legacy.pods;
			const { planner, budget } = legacy.bots;
			/** Everything that was the Family pod's, with whether `memberId` reaches each. */
			const reachedBy = (memberId: string) =>
				upgraded.run(
					query((db) =>
						db.execute<{ kind: string; id: string; reached: boolean }>(
							sql`
							with pod_project as (
								select id from project
								where id = ${family}::uuid or default_of_bot_id in (${planner}::uuid, ${budget}::uuid)
							)
							select 'bot' as kind, b.id::text as id, ${reachesBotFor(sql`b.id`, memberId)} as reached
								from bot b where b.id in (${planner}::uuid, ${budget}::uuid)
							union all
							select 'project', p.id::text, ${reachesProjectFor(sql`p.id`, memberId)}
								from project p where p.id in (select id from pod_project)
							union all
							select 'chat', c.id::text, ${reachesChatFor({ projectId: sql`c.project_id` }, memberId)}
								from placed_chat c where c.project_id in (select id from pod_project)
							union all
							select 'file', f.id::text, ${reachesChatFor({ projectId: sql`fc.project_id` }, memberId)}
								from file f join placed_chat fc on fc.id = f.chat_id
								where fc.project_id in (select id from pod_project)
							union all
							select 'connector', k.id::text, ${reachesProjectFor(sql`k.project_id`, memberId)}
								from connector k where k.project_id in (select id from pod_project)
							union all
							select 'computer', m.id::text, ${reachesProjectFor(sql`m.project_id`, memberId)}
								from computer m where m.project_id in (select id from pod_project)
							order by 1, 2
						`,
							"objects",
						),
					),
				);
			const reachedByAna = await reachedBy(legacy.members.ana);
			const kinds = new Set(reachedByAna.map(({ kind }) => kind));

			expect([...kinds].sort()).toEqual(
				["bot", "chat", "computer", "connector", "file", "project"].sort(),
			);
			expect(reachedByAna.filter(({ reached }) => reached)).toEqual([]);
			for (const podMember of [legacy.members.sam, legacy.members.pat]) {
				expect((await reachedBy(podMember)).filter(({ reached }) => !reached)).toEqual([]);
			}
		});

		it("keeps a shared pod's connectors in the project it became, bots or none", async () => {
			expect(
				await upgraded.rows(`select project_id from connector where id = $1`, [
					legacy.notesConnection,
				]),
			).toEqual([{ project_id: legacy.pods.notes }]);
		});

		it("keeps the files of a personal pod with no bots for its owner alone", async () => {
			const [diary] = await upgraded.rows<{
				chat_id: string;
				visibility: string;
				assistant_of: string;
			}>(
				`select file.chat_id, bot.visibility, bot.assistant_of
				 from file join placed_chat on placed_chat.id = file.chat_id
				 join project on project.id = placed_chat.project_id
				 join bot on bot.id = project.default_of_bot_id
				 where file.id = $1`,
				[legacy.diary],
			);
			expect(diary).toEqual({
				chat_id: expect.any(String),
				visibility: "personal",
				assistant_of: legacy.members.ana,
			});
			const reachedBy = async (memberId: string) => {
				const [row] = await upgraded.run(
					query((db) =>
						db.execute<{ reached: boolean }>(
							sql`select ${reachesChatFor({ projectId: sql`c.project_id` }, memberId)} as reached
								from placed_chat c where c.id = ${diary?.chat_id}::uuid`,
							"objects",
						),
					),
				);
				return row?.reached;
			};
			expect(await reachedBy(legacy.members.ana)).toBe(true);
			expect(await reachedBy(legacy.members.sam)).toBe(false);
			expect(await reachedBy(legacy.members.pat)).toBe(false);
		});

		it("makes a shared pod a private project, and its bots private, with its members as theirs", async () => {
			expect(
				await upgraded.rows(`select visibility from project where id = $1`, [legacy.pods.family]),
			).toEqual([{ visibility: "private" }]);
			const botMembers = await upgraded.rows<{
				bot_id: string;
				visibility: string;
				members: string[];
			}>(
				`select bot.id as bot_id, bot.visibility,
					array(select member_id::text from bot_member where bot_id = bot.id order by member_id) as members
				 from bot where bot.id in ($1, $2) order by bot.id`,
				[legacy.bots.planner, legacy.bots.budget],
			);
			const podMembers = [legacy.members.sam, legacy.members.pat].sort();
			expect(botMembers).toEqual([
				{ bot_id: legacy.bots.planner, visibility: "private", members: podMembers },
				{ bot_id: legacy.bots.budget, visibility: "private", members: podMembers },
			]);
		});

		it("keeps a shared pod's bots' own connectors on in the private project it became", async () => {
			const own = await upgraded.rows<{ bot_id: string; on: boolean }>(
				`select project.default_of_bot_id as bot_id,
					exists (
						select 1 from project_bot_connector turned_on
						where turned_on.project_id = $1 and turned_on.connector_id = connector.id
							and turned_on.bot_id = project.default_of_bot_id
							and turned_on.address = connector.url
					) as on
				 from connector
				 join project on project.id = connector.project_id
				 where project.default_of_bot_id in ($2, $3)
				 order by 1`,
				[legacy.pods.family, legacy.bots.planner, legacy.bots.budget],
			);
			expect(new Set(own.map(({ bot_id }) => bot_id))).toEqual(
				new Set([legacy.bots.planner, legacy.bots.budget]),
			);
			expect(own.filter(({ on }) => !on)).toEqual([]);
		});

		it("records who started a chat nobody started as its project's creator", async () => {
			expect(
				await upgraded.rows(`select started_by_id from project_chat where chat_id = $1`, [
					legacy.threads.general,
				]),
			).toEqual([{ started_by_id: legacy.members.sam }]);
		});

		it("carries the turns and compactions in lanes over, and a message to a held turn's bot finds it", async () => {
			const lanes = await upgraded.rows<{ workflow: string; payload: unknown }>(
				`select workflow, payload from (
					select workflow, payload from lane where payload is not null
					union all select workflow, payload from lane_request
				) as held order by workflow, payload->>'triggerMessageId'`,
			);
			const decode = {
				compaction: Schema.decodeUnknownSync(Schema.toCodecJson(CompactionRequest)),
				turn: Schema.decodeUnknownSync(Schema.toCodecJson(TurnRequests.TurnRequest)),
			};
			const held = await upgraded.run(
				transaction(
					TurnRequests.holdOpening({ chatId: legacy.threads.trip, botId: legacy.bots.planner }),
				),
			);

			expect(
				lanes.map(({ workflow, payload }) =>
					workflow === "turn" || workflow === "compaction" ? decode[workflow](payload) : workflow,
				),
			).toEqual([
				expect.objectContaining({ chatId: legacy.threads.trip, botId: legacy.bots.planner }),
				expect.objectContaining({ reason: "mention", triggerMessageId: legacy.tripMessages.asked }),
				// A turn a routine asked for, waiting behind it, as an automation's.
				expect.objectContaining({
					reason: "automation",
					triggerMessageId: legacy.tripMessages.answered,
				}),
			]);
			expect(held).toEqual({
				running: expect.objectContaining({
					chatId: legacy.threads.trip,
					botId: legacy.bots.planner,
				}),
				opened: true,
			});
		});

		it("resumes the work main's engine held by its requests' new names, and forgets a workflow gone", async () => {
			const resumed = Promise.withResolvers<CompactionRequest>();
			const engine = ManagedRuntime.make(
				Compaction.toLayer((request) =>
					DurableDeferred.await(Paused).pipe(
						Effect.andThen(Effect.sync(() => resumed.resolve(request))),
					),
				).pipe(Layer.provideMerge(engineAt(url))),
			);
			try {
				await engine.runPromise(
					DurableDeferred.succeed(Paused, {
						token: DurableDeferred.tokenFromExecutionId(Paused, {
							workflow: Compaction,
							executionId: submitted.compaction,
						}),
						value: undefined,
					}),
				);
				expect(await resumed.promise).toEqual({
					chatId: legacy.threads.trip,
					botId: legacy.bots.planner,
					sourceMessageId: legacy.tripMessages.answered,
					readKeptFrom: null,
				});
			} finally {
				await engine.dispose();
			}
			const requests = await upgraded.rows<{ entity_type: string; payload: string }>(
				`select entity_type, payload from cluster_messages
				 where tag = 'run' and entity_type <> 'Workflow/compaction' order by entity_type`,
			);
			expect(requests.map(({ entity_type }) => entity_type)).toEqual(["Workflow/turn"]);
			expect(
				Schema.decodeUnknownSync(Schema.toCodecJson(TurnRequests.TurnRequest))(
					JSON.parse(requests[0]?.payload ?? "null"),
				),
			).toEqual({
				chatId: legacy.threads.trip,
				botId: legacy.bots.planner,
				triggerMessageId: legacy.tripMessages.asked,
				reason: "automation",
			});
		});

		it("records the runs main's routine workflow held as failed, and keeps no lane of a workflow gone", async () => {
			const workflows = await upgraded.rows<{ workflow: string }>(
				`select workflow from lane where workflow is not null
				 union select workflow from lane_request order by 1`,
			);
			const runs = await upgraded.rows(
				`select id, state, error from run where id = any($1) order by id`,
				[[legacy.routineRuns.running, legacy.routineRuns.waiting]],
			);

			expect(workflows.map(({ workflow }) => workflow)).toEqual(["compaction", "turn"]);
			expect(runs).toEqual(
				[legacy.routineRuns.running, legacy.routineRuns.waiting].map((id) => ({
					id,
					state: "failed",
					error: "Stopped when Sugabots was upgraded. Run it again.",
				})),
			);
		});

		it("pauses a webhook trigger's automation that kept only its secret's digest, and refuses every delivery to it", async () => {
			const { trigger } = legacy.digestOnlyWebhook;
			const secrets = Secrets.fromKey(Buffer.alloc(32, 7).toString("base64"));
			const delivered = (authorization: string | undefined) =>
				upgraded.run(
					Effect.gen(function* () {
						const webhooks = yield* WebhookAuthentication.Service;
						return yield* Effect.flip(
							webhooks.trigger(trigger, {
								headers: { authorization },
								body: new TextEncoder().encode("{}"),
								payload: {},
							}),
						);
					}).pipe(
						Effect.provide(WebhookAuthentication.layer),
						Effect.provideService(Secrets.Service, secrets),
					),
				);

			const refusals = [await delivered(undefined), await delivered("Bearer guessed")];
			const [stored] = await upgraded.rows<{ state: string; secret: string }>(
				`select automation.state, automation_trigger.secret_encrypted as secret
				 from automation join automation_trigger on automation_trigger.automation_id = automation.id
				 where automation_trigger.id = $1`,
				[trigger],
			);

			for (const refused of refusals) expect(refused).toBeInstanceOf(WebhookRefused);
			expect(stored?.state).toBe("paused");
			// A secret nobody knows, sealed under the server's key once it started.
			expect(() => secrets.decrypt(stored?.secret ?? "")).not.toThrow();
		});

		it("deletes direct messages, with what was in them, and queues their folders for deletion", async () => {
			const directMessages = Object.values(legacy.directMessages);

			expect(
				await upgraded.rows(
					`select id from chat where id = any($1)
					 union all select chat_id from message where chat_id = any($1)
					 union all select chat_id from file where chat_id = any($1)
					 union all select chat_id from read_cursor where chat_id = any($1)`,
					[directMessages],
				),
			).toEqual([]);
			expect(queuedByTheUpgrade).toEqual(
				expect.arrayContaining(directMessages.map((id) => `chats/${id}`)),
			);
		});

		it("keeps what summaries cost, as system bots' work on their chats", async () => {
			expect(
				await upgraded.rows(
					`select purpose, bot_id, chat_id, cost_usd::float8 as usd from model_request where id = $1`,
					[legacy.summaryRequest],
				),
			).toEqual([{ purpose: "compaction", bot_id: null, chat_id: legacy.threads.trip, usd: 0.25 }]);
		});

		it("serves every file's bytes from where the file is read now", async () => {
			const files = await upgraded.rows<{ id: string; chat_id: string }>(
				`select id, chat_id from file`,
			);
			const chatOf = new Map(files.map(({ id, chat_id }) => [id, chat_id]));

			for (const file of legacyFiles) {
				expect(await upgraded.read(keyNow(file, chatOf)), legacyKeyOf(file)).toBe(file.text);
			}
		});

		it("deletes the bytes whose deletion was queued, wherever they moved, and keeps the rest", async () => {
			await upgraded.deleteQueuedBlobs();

			for (const { legacyKey, upgradedKey } of bytesQueuedForDeletion) {
				await expect(upgraded.read(BlobStore.key(...segments(upgradedKey)))).rejects.toBeInstanceOf(
					BlobStore.NotFound,
				);
				await expect(upgraded.read(BlobStore.key(...segments(legacyKey)))).rejects.toBeInstanceOf(
					BlobStore.NotFound,
				);
			}
			expect(await upgraded.read(keyNow(legacyFiles[0] as LegacyFile, new Map()))).toBe("plan");
		});
	},
);

/** Pauses work main's engine was carrying out, until the test resumes it. */
const Paused = DurableDeferred.make("upgrade/paused");

/** Main's workflows, as their requests encoded, to submit work through main's engine. */
const MainCompaction = Workflow.make("compaction", {
	payload: {
		threadId: Schema.String,
		agentId: Schema.String,
		sourceMessageId: Schema.String,
		readKeptFrom: Schema.NullOr(Schema.String),
	},
	idempotencyKey: (request) => `${request.threadId}/${request.sourceMessageId}`,
});
const MainTurn = Workflow.make("turn", {
	payload: {
		threadId: Schema.String,
		agentId: Schema.String,
		triggerMessageId: Schema.String,
		reason: Schema.String,
	},
	idempotencyKey: (request) => `${request.threadId}/${request.agentId}/${request.triggerMessageId}`,
});
const MainRoutine = Workflow.make("routine", {
	payload: { routineId: Schema.String, executionId: Schema.String },
	idempotencyKey: (run) => run.executionId,
});

interface SubmittedToMainsEngine {
	/** The compaction's execution, the one id main's and today's workflow agree on. */
	compaction: string;
}

/**
 * Work main's engine was carrying out when the upgrade stopped it, each
 * execution waiting to resume: a compaction, a turn a routine asked for, and
 * a routine's run.
 */
async function submitToMainsEngine(url: string): Promise<SubmittedToMainsEngine> {
	const waiting = () => DurableDeferred.await(Paused);
	const engine = ManagedRuntime.make(
		Layer.mergeAll(
			MainCompaction.toLayer(waiting),
			MainTurn.toLayer(waiting),
			MainRoutine.toLayer(waiting),
		).pipe(Layer.provideMerge(engineAt(url))),
	);
	try {
		const compaction = await engine.runPromise(
			MainCompaction.execute(
				{
					threadId: legacy.threads.trip,
					agentId: legacy.bots.planner,
					sourceMessageId: legacy.tripMessages.answered,
					readKeptFrom: null,
				},
				{ discard: true },
			).pipe(Effect.tap((id) => untilSuspended(MainCompaction.poll(id)))),
		);
		await engine.runPromise(
			MainTurn.execute(
				{
					threadId: legacy.threads.trip,
					agentId: legacy.bots.planner,
					triggerMessageId: legacy.tripMessages.asked,
					reason: "routine",
				},
				{ discard: true },
			).pipe(Effect.tap((id) => untilSuspended(MainTurn.poll(id)))),
		);
		await engine.runPromise(
			MainRoutine.execute(
				{ routineId: legacy.routine, executionId: legacy.routineRuns.running },
				{ discard: true },
			).pipe(Effect.tap((id) => untilSuspended(MainRoutine.poll(id)))),
		);
		return { compaction };
	} finally {
		await engine.dispose();
	}
}

/** Waits for the engine to record an execution suspended, as a stopped process leaves it. */
const untilSuspended = <R>(
	polled: Effect.Effect<Option.Option<Workflow.Result<unknown, unknown>>, never, R>,
) =>
	polled.pipe(
		Effect.flatMap((result) =>
			Option.isSome(result) && result.value._tag === "Suspended"
				? Effect.void
				: Effect.fail("not suspended yet"),
		),
		Effect.retry({ times: 400, schedule: Schedule.spaced(Duration.millis(25)) }),
		Effect.orDie,
	);

/** The server's workflow engine, on the database at `url`. */
function engineAt(url: string) {
	return WorkflowEngines.singleRunnerWith({ hostLockWait: Duration.seconds(30) }).pipe(
		Layer.provideMerge(poolAt(url)),
	);
}

/** Where a legacy file is read from now: its chat's folder, which kept the thread's id, or its file's. */
function keyNow(file: LegacyFile, chatOf: ReadonlyMap<string, string>): BlobStore.Key {
	return file.kind === "thread"
		? ChatFileStore.fileKey(chatOf.get(file.fileId) ?? file.threadId, file.fileId)
		: Files.versionKey(file.fileId, file.versionId);
}

function segments(key: string): [string, ...string[]] {
	const [first, ...rest] = key.split("/");
	return [first ?? "", ...rest];
}

/** Bytes as `main` stored them, at their legacy keys, before the upgrade. */
async function storeLegacyBytes(url: string, store: Store, root: string) {
	if (store === "postgres") {
		await withClient(url, async (client) => {
			for (const { key, text } of legacyBytes) {
				await client.query(
					`insert into blob (key, bytes, content_type, size) values ($1, $2, 'text/plain', $3)`,
					[key, Buffer.from(text), Buffer.byteLength(text)],
				);
			}
		});
		return;
	}
	await Effect.runPromise(
		Effect.gen(function* () {
			const onDisk = yield* fromFileSystem(root);
			for (const { key, text } of legacyBytes) {
				yield* onDisk.put(BlobStore.key(...segments(key)), {
					stream: Stream.succeed(new TextEncoder().encode(text)),
					contentType: "text/plain",
				});
			}
		}).pipe(Effect.provide([NodeFileSystem.layer, Ids.layer])),
	);
}

interface Upgraded {
	rows: <Row = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<Row[]>;
	/** The text stored under `key`, failing with `BlobStore.NotFound` if nothing is. */
	read: (key: BlobStore.Key) => Promise<string>;
	deleteQueuedBlobs: () => Promise<void>;
	/** Runs `effect` against the upgraded database, as the server's code would. */
	run: <A, E>(effect: Effect.Effect<A, E, Database>) => Promise<A>;
	dispose: () => Promise<void>;
}

/** The server's database and blob store on the upgraded database, started as the server starts them. */
function startServer(url: string, store: Store, root: string): Upgraded {
	const env = { DATABASE_URL: url, BLOB_STORE_PROVIDER: store, BLOB_STORE_FILESYSTEM_ROOT: root };
	const runtime = ManagedRuntime.make(
		BlobStore.layer.pipe(
			Layer.provideMerge(Layer.mergeAll(databaseLayer, Ids.layer)),
			Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
		),
	);
	return {
		rows: (sql, params = []) =>
			withClient(url, async (client) => (await client.query(sql, params)).rows),
		read: (key) =>
			runtime.runPromise(
				Effect.gen(function* () {
					const { stream } = yield* (yield* BlobStore.Service).get(key);
					const chunks = yield* Stream.runCollect(stream);
					return Buffer.concat(chunks).toString("utf8");
				}),
			),
		deleteQueuedBlobs: () => runtime.runPromise(BlobDeletions.deleteQueued),
		run: (effect) => runtime.runPromise(effect),
		dispose: () => runtime.dispose(),
	};
}

/** Migrates the database at `url` through `last`, as an installation of `main` was. */
async function migrateTo(url: string, last: string) {
	const folder = await mkdtemp(join(tmpdir(), "migrations-"));
	try {
		const names = (await readdir(MIGRATIONS)).filter((name) => name <= last);
		for (const name of names) await symlink(join(MIGRATIONS, name), join(folder, name));
		await Effect.runPromise(
			Effect.gen(function* () {
				const db = yield* makeWithDefaults();
				yield* migrate(db, { migrationsFolder: folder, migrationsTable: "__drizzle_migrations" });
			}).pipe(Effect.provide(poolAt(url))),
		);
	} finally {
		await rm(folder, { recursive: true, force: true });
	}
}

/** This worker's database with `_upgrade_<store>` on the end of its name, so workers never share one. */
function upgradeDatabaseUrl(workerUrl: string, store: Store): string {
	if (!workerUrl) return "";
	const parsed = new URL(workerUrl);
	parsed.pathname = `${parsed.pathname}_upgrade_${store}`;
	return parsed.toString();
}

async function recreateDatabase(url: string) {
	await dropDatabase(url);
	await withServer(url, (client, name) => client.query(`create database ${quoted(name)}`));
}

async function dropDatabase(url: string) {
	await withServer(url, (client, name) =>
		client.query(`drop database if exists ${quoted(name)} with (force)`),
	);
}

/** Runs `use` connected to the server's default database, with the name of the database at `url`. */
async function withServer<A>(url: string, use: (client: pg.Client, name: string) => Promise<A>) {
	const server = new URL(url);
	const name = server.pathname.replace(/^\//, "");
	server.pathname = "/postgres";
	return withClient(server.toString(), (client) => use(client, name));
}

async function withClient<A>(url: string, use: (client: pg.Client) => Promise<A>): Promise<A> {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		return await use(client);
	} finally {
		await client.end();
	}
}

function quoted(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

function poolAt(url: string) {
	return PgClient.layer({ url: Redacted.make(url) }).pipe(Layer.orDie);
}
