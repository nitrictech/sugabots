import { mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeFileSystem } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { WorkflowEngines } from "@sugabots/workflow/engine";
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
import { SessionAuthentication } from "../authentication/session.ts";
import { TurnAuthentication } from "../authentication/turn.ts";
import { askerColumns } from "../authentication/turn-facts.ts";
import { WebhookAuthentication, WebhookRefused } from "../authentication/webhook.ts";
import { BlobStore } from "../blob-store/blob-store.ts";
import { BlobDeletions } from "../blob-store/deletions.ts";
import { fromFileSystem } from "../blob-store/implementations/filesystem.ts";
import { Compaction, CompactionRequest } from "../chats/compaction/compaction.workflow.ts";
import { DesktopViewer } from "../chats/tools/browser/viewer.ts";
import { TurnRequests } from "../chats/turns/turns.ts";
import { ComputerSignIn } from "../computers/computer-sign-in.ts";
import { ChatFileStore } from "../files/chat-file-store.ts";
import { Files } from "../files/files.ts";
import { Ids } from "../ids/ids.ts";
import { viewDesktop } from "../operations/computers/view-desktop.ts";
import { servedOperations } from "../operations/testing.ts";
import type { Principal } from "../principal.ts";
import { proveCanReachConnector } from "../proofs/can-use-connector.ts";
import { proveCanRunAutomations } from "../proofs/project-permissions.ts";
import { named } from "../proofs/proof.ts";
import { proveReachesProject } from "../proofs/reaches-project.ts";
import { Egress } from "../providers/network/egress.ts";
import { Secrets } from "../secrets/secrets.ts";
import { Streams } from "../streams/streams.ts";
import { unimplemented } from "../testing.ts";
import { effectRunner, query, type RunEffect, transaction } from "./database.ts";
import { EventBus } from "./events/bus.ts";
import { EventStore } from "./events/store.ts";
import { applyMigrations } from "./migrations.ts";
import { message, turn } from "./schema.ts";
import { type TestInfrastructure, testInfrastructure } from "./testing.ts";
import {
	bytesQueuedForDeletion,
	LAST_MAIN_MIGRATION,
	type LegacyFile,
	legacy,
	legacyBytes,
	legacyCyclicCollaboration,
	legacyFiles,
	legacyKeyOf,
	legacyMigrationScaleRows,
	legacyRows,
	legacySessions,
	legacySessionToken,
	legacySummaryRequest,
	migrationScale,
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
		/** What each member reached on main, before the upgrade. */
		let reachedOnMain: Reached[];
		let legacyConnectors: { id: string; pod_id: string; handle: string }[];
		let legacyBots: { id: string; pod_id: string }[];

		beforeAll(async () => {
			root = await mkdtemp(join(tmpdir(), "upgrade-blobs-"));
			await recreateDatabase(url);
			await migrateTo(url, LAST_MAIN_MIGRATION);
			await withClient(url, async (client) => {
				await client.query(legacyRows);
				await client.query(legacyMigrationScaleRows);
				await client.query(legacySummaryRequest);
				await client.query(legacySessions);
				reachedOnMain = (await client.query<Reached>(REACHED_ON_MAIN)).rows;
				legacyConnectors = (await client.query("select id, pod_id, handle from connection")).rows;
				legacyBots = (await client.query("select id, pod_id from agent")).rows;
				const cipher = Secrets.fromKey(Buffer.alloc(32).toString("base64"));
				await client.query(
					"update sandbox_provider set api_key_encrypted = $1, settings = settings || $3::jsonb where id = $2",
					[
						cipher.encrypt("desktop-test-key"),
						legacy.provider,
						{ serverUrl: "https://computers.example.com" },
					],
				);
				await client.query("update agent set uses_sandbox = true where id in ($1, $2)", [
					legacy.bots.helper,
					legacy.bots.planner,
				]);
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

		it("adds the indexes for stream control events and computer leases", async () => {
			const indexes = await upgraded.rows<{ indexname: string }>(`
				select indexname from pg_indexes
				where indexname in ('event_control_stream_seq_idx', 'computer_lease_holder_idx')
				order by indexname
			`);
			expect(indexes.map(({ indexname }) => indexname)).toEqual([
				"computer_lease_holder_idx",
				"event_control_stream_seq_idx",
			]);
		});

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
				// Hoe was made first, though Rake's id comes first.
				{
					id: legacy.pods.garden,
					lead: legacy.bots.hoe,
					name: "Hoe",
					model: "m",
					in_project: true,
				},
				{
					id: migrationScale.memberlessPod,
					lead: expect.any(String),
					name: "Lead",
					model: null,
					in_project: true,
				},
			]);
		});

		it("lets a viewer manage a bot of their own from their personal pod, as its owner could on main", async () => {
			const call = await servedOperations({ runOn: upgraded.run });
			const lee = await upgraded.signIn(legacy.members.lee);

			expect(
				await call(lee, "bots.update", {
					botId: legacy.bots.sketch,
					changes: { name: "Sketchbook" },
				}),
			).toMatchObject({ id: legacy.bots.sketch, name: "Sketchbook", visibility: "personal" });
		});

		it("keeps a shared pod's connectors in the project it became, bots or none", async () => {
			expect(
				await upgraded.rows(`select project_id from connector where id = $1`, [
					legacy.notesConnection,
				]),
			).toEqual([{ project_id: legacy.pods.notes }]);
		});

		it("lets only the member who owns the personal file read it", async () => {
			const call = await servedOperations({ runOn: upgraded.run });
			const input = { fileId: legacy.diary };
			const { ana, sam, pat } = legacy.members;
			await expect(call(await upgraded.signIn(ana), "files.get", input)).resolves.toMatchObject({
				content: "Dear.",
			});
			for (const outsider of [sam, pat]) {
				await expect(
					call(await upgraded.signIn(outsider), "files.get", input),
				).rejects.toBeInstanceOf(ResourceHidden);
			}
		});

		it.each([
			{
				place: "personal bot",
				computer: legacy.computers.pat,
				chatId: legacy.threads.report,
				botId: legacy.bots.helper,
				members: [legacy.members.pat],
				outsiders: [legacy.members.sam, legacy.members.ana],
			},
			{
				place: "private project",
				computer: legacy.computers.family,
				chatId: legacy.threads.trip,
				botId: legacy.bots.planner,
				members: [legacy.members.sam, legacy.members.pat],
				outsiders: [legacy.members.ana, legacy.members.lee],
			},
		])(
			"opens the preserved computer's desktop only for members of the $place",
			async ({ computer, chatId, botId, members, outsiders }) => {
				const openedMachines: string[] = [];
				const fetchComputer: typeof fetch = async (request) => {
					const url = new URL(request instanceof Request ? request.url : request.toString());
					if (url.pathname.endsWith(`/sandboxes/${computer.providerId}`)) {
						openedMachines.push(computer.providerId);
						return Response.json({
							id: computer.providerId,
							status: { state: "Running" },
							createdAt: "2026-10-01T00:00:00Z",
						});
					}
					if (url.pathname.includes(`/sandboxes/${computer.providerId}/endpoints/`))
						return Response.json({ endpoint: "desktop.example.com", headers: {} });
					if (url.pathname === "/ping") return new Response("ok");
					if (url.pathname === "/policy")
						return Response.json({ policy: { defaultAction: "deny", egress: [] } });
					if (url.pathname === "/credential-vault")
						return Response.json({ code: "NOT_FOUND", message: "Missing" }, { status: 404 });
					if (url.pathname.endsWith(`/sandboxes/${computer.providerId}/networkpolicy`))
						return new Response(null, { status: 204 });
					throw new Error(`Unexpected computer request to ${url.pathname}`);
				};
				const store = await upgraded.run(EventStore.make);
				const bus = EventBus.inProcess({ store });
				const viewer = await upgraded.run(
					DesktopViewer.Service.pipe(
						Effect.provide(
							DesktopViewer.layer.pipe(
								Layer.provide([
									ComputerSignIn.none,
									unimplemented(Egress.Service, { providers: { for: () => fetchComputer } }),
								]),
							),
						),
					),
				);
				const streams = await upgraded.run(
					Streams.Service.pipe(
						Effect.provide(
							Streams.layer.pipe(
								Layer.provide([EventStore.layer, Layer.succeed(EventBus.Service, bus)]),
							),
						),
					),
				);
				const view = async (member: string) => {
					const principal = await upgraded.signIn(member);
					return upgraded.run(
						Effect.scoped(
							viewDesktop.run(principal, { chatId, botId }, { kind: "request" }).pipe(
								Effect.flatMap(({ stream }) => Stream.runCollect(stream)),
								Effect.provideService(DesktopViewer.Service, {
									...viewer,
									show: (opened, canUse) =>
										Effect.succeed({
											endpoint: {
												url: `https://desktop.example.com/${opened.computer.id}`,
												headers: {},
											},
											password: "desktop-test",
											control: canUse.control,
										}),
								}),
								Effect.provideService(Streams.Service, streams),
							),
						),
					);
				};
				try {
					for (const outsider of outsiders) {
						await expect(view(outsider)).rejects.toBeInstanceOf(ResourceHidden);
					}
					expect(openedMachines).toEqual([]);
					for (const member of members) {
						expect(await view(member)).toEqual([
							{
								endpoint: {
									url: `https://desktop.example.com/${computer.providerId}`,
									headers: {},
								},
								password: "desktop-test",
								control: true,
							},
						]);
					}
					expect(openedMachines).toContain(computer.providerId);
				} finally {
					await bus.close();
				}
			},
		);

		it("lets a bot-less shared pod's members read a file written there whose chat is gone, and nobody else", async () => {
			const call = await servedOperations({ runOn: upgraded.run });
			const read = async (member: string) => {
				const principal = await upgraded.signIn(member);
				return call(principal, "files.get", { fileId: legacy.groceries }).then(
					(file) => file.content,
					(refusal: unknown) => refusal,
				);
			};

			expect(await read(legacy.members.sam)).toBe("Eggs");
			expect(await read(legacy.members.pat)).toBe("Eggs");
			expect(await read(legacy.members.ana)).toBeInstanceOf(ResourceHidden);
		});

		it("leaves each member reaching, through the operations, what they reached on main, but for admins seeing personal bots", async () => {
			const call = await servedOperations({ runOn: upgraded.run });
			const chats = [
				...new Set(reachedOnMain.filter(({ kind }) => kind === "chat").map(({ id }) => id)),
			];
			const projects = await upgraded.rows<{
				id: string;
				default_of_bot_id: string | null;
				assistant_of: string | null;
			}>(
				`select project.id, project.default_of_bot_id, bot.assistant_of
				from project left join bot on bot.id = project.default_of_bot_id`,
			);
			const connectors = await upgraded.rows<{ id: string; project_id: string; handle: string }>(
				"select id, project_id, handle from connector",
			);
			const originalConnector = new Map(
				connectors.map(({ id, project_id, handle }) => {
					const defaultBot = projects.find(
						(project) => project.id === project_id,
					)?.default_of_bot_id;
					const legacyPod = legacyBots.find((bot) => bot.id === defaultBot)?.pod_id;
					const original =
						legacyConnectors.find((connector) => connector.id === id) ??
						legacyConnectors.find(
							(connector) => connector.pod_id === legacyPod && connector.handle === handle,
						);
					if (!original) throw new Error(`Connector ${id} has no connection on main`);
					return [id, original.id] as const;
				}),
			);
			const [anasAssistant] = projects.filter(
				({ assistant_of }) => assistant_of === legacy.members.ana,
			);
			if (!anasAssistant?.default_of_bot_id)
				throw new Error("Ana has no Personal Assistant for her file");
			const [notesLead] = await upgraded.rows<{ id: string }>(
				"select lead_bot_id as id from project where id = $1",
				[legacy.pods.notes],
			);
			if (!notesLead) throw new Error("Notes has no lead bot");
			const expected: Reached[] = [
				...Object.values(legacy.members).map((member) => ({
					member,
					kind: "bot" as const,
					id: notesLead.id,
				})),
				...reachedOnMain.filter(
					({ id }) =>
						id !== migrationScale.orphanedCollaboration &&
						id !== migrationScale.hostlessPersonalChat,
				),
				{ member: legacy.members.ana, kind: "bot", id: anasAssistant.default_of_bot_id },
				{ member: legacy.members.sam, kind: "bot", id: anasAssistant.default_of_bot_id },
				{ member: legacy.members.sam, kind: "bot", id: legacy.bots.patsAssistant },
				{ member: legacy.members.sam, kind: "bot", id: legacy.bots.helper },
				{ member: legacy.members.sam, kind: "bot", id: legacy.bots.sketch },
			];
			const reachedNow: Reached[] = [];
			for (const member of Object.values(legacy.members)) {
				const principal = await upgraded.signIn(member);
				const workspace = legacy.workspace;
				const reached = (kind: Reached["kind"], id: string) =>
					expected.some((row) => row.member === member && row.kind === kind && row.id === id);
				const list = async <A>(request: Promise<readonly A[]>, expectHidden: boolean) => {
					try {
						return await request;
					} catch (error) {
						if (expectHidden && error instanceof ResourceHidden) return [];
						throw error;
					}
				};
				for (const bot of await call(principal, "bots.list", { workspace })) {
					reachedNow.push({ member, kind: "bot", id: bot.id });
				}
				for (const project of await call(principal, "projects.list", { workspace })) {
					reachedNow.push({ member, kind: "project", id: project.id });
				}
				for (const { id: projectId, default_of_bot_id: botId } of projects) {
					const reachesProject = botId
						? botId === notesLead.id ||
							reachedOnMain.some(
								(row) => row.member === member && row.kind === "bot" && row.id === botId,
							) ||
							(botId === anasAssistant.default_of_bot_id && member === legacy.members.ana)
						: reached("project", projectId);
					const automations = await list(
						call(principal, "automations.list", { projectId }),
						!reachesProject,
					);
					for (const automation of automations) {
						reachedNow.push({ member, kind: "automation", id: automation.id });
					}
					const files = await list(
						call(principal, "files.listInProject", { projectId }),
						!reachesProject,
					);
					for (const file of files) reachedNow.push({ member, kind: "file", id: file.id });
					const listed = await list(
						call(principal, "connectors.list", { projectId }),
						!reachesProject,
					);
					expect(listed.map(({ id }) => id).sort()).toEqual(
						connectors
							.filter(({ id, project_id }) => {
								const original = originalConnector.get(id);
								return (
									reachesProject &&
									project_id === projectId &&
									original &&
									reached("connector", original)
								);
							})
							.map(({ id }) => id)
							.sort(),
					);
					for (const connector of listed) {
						const original = originalConnector.get(connector.id);
						if (!original) throw new Error(`Connector ${connector.id} has no connection on main`);
						reachedNow.push({ member, kind: "connector", id: original });
					}
				}
				for (const chatId of chats) {
					try {
						await call(principal, "chats.get", { chatId, limit: 1 });
						reachedNow.push({ member, kind: "chat", id: chatId });
					} catch (error) {
						if (reached("chat", chatId) || !(error instanceof ResourceHidden)) throw error;
					}
				}
			}
			expect([...new Set(sortedReach(reachedNow))]).toEqual(sortedReach(expected));
		});

		it("lets a shared pod's members start its bots' automations by hand, which on main only owners and admins could", async () => {
			// Pods' members are editors now, and an editor who reaches a bot runs its automations.
			const [plannersOwn] = await upgraded.rows<{ id: string }>(
				`select id from project where default_of_bot_id = $1`,
				[legacy.bots.planner],
			);
			const startsRuns = async (member: string) => {
				const principal = await upgraded.signIn(member);
				return upgraded.run(
					named(principal, plannersOwn?.id ?? "", (acting, project) =>
						proveReachesProject(acting, project).pipe(
							Effect.flatMap(proveCanRunAutomations),
							Effect.as("allowed"),
							Effect.catchTag("ActionForbidden", () => Effect.succeed("forbidden")),
							Effect.catchTag("ResourceHidden", () => Effect.succeed("hidden")),
						),
					),
				);
			};

			expect(await startsRuns(legacy.members.pat)).toBe("allowed");
			expect(await startsRuns(legacy.members.ana)).toBe("hidden");
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

		it("keeps legacy turns without admission and drops connector approval metadata", async () => {
			const columns = await upgraded.rows<{ table_name: string; column_name: string }>(
				`select table_name, column_name from information_schema.columns
				 where table_schema = 'public'
				   and ((table_name = 'turn' and column_name = 'admission')
				     or (table_name = 'project_bot_connector' and column_name = 'turned_on_by_id'))`,
			);
			expect(columns).toEqual([{ table_name: "turn", column_name: "admission" }]);
			expect(await upgraded.rows("select id from turn where admission is not null")).toEqual([]);
		});

		it("keeps a shared pod's bots' own connectors on in the private project it became", async () => {
			const own = await upgraded.rows<{ bot_id: string; on: boolean }>(
				`select project.default_of_bot_id as bot_id,
					exists (
						select 1 from project_bot_connector turned_on
						where turned_on.project_id = $1 and turned_on.connector_id = connector.id
							and turned_on.bot_id = project.default_of_bot_id
							and turned_on.address_revision = connector.address_revision
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

		it("lets a shared pod's bot use its own connector in a turn in the private project the pod became", async () => {
			const { planner } = legacy.bots;
			const [own] = await upgraded.rows<{ id: string }>(
				`select connector.id from connector
				 join project on project.id = connector.project_id
				 where project.default_of_bot_id = $1 and connector.kind <> 'github'
				 order by connector.id limit 1`,
				[planner],
			);
			if (!own) throw new Error("Planner kept none of the pod's connectors");
			const asked = await upgraded.run(
				query((db) =>
					db
						.insert(message)
						.values({
							chatId: legacy.threads.trip,
							authorMemberId: legacy.members.sam,
							status: "complete",
							parts: [],
							content: "Check the calendar",
						})
						.returning({ id: message.id }),
				),
			);
			const answering = {
				chatId: legacy.threads.trip,
				botId: planner,
				triggerMessageId: asked[0]?.id ?? "",
			};
			const [turnRow] = await upgraded.run(
				query((db) =>
					db
						.insert(turn)
						.values({
							...answering,
							...askerColumns(answering),
							status: "running",
							model: "m",
							reason: "mention",
							startedAt: new Date(),
						})
						.returning({ id: turn.id }),
				),
			);

			const reached = await upgraded.run(
				Effect.gen(function* () {
					const authenticator = yield* TurnAuthentication.make;
					const principal = yield* authenticator.authenticate(turnRow?.id ?? "");
					return yield* named(principal, own.id, (acting, connector) =>
						Effect.map(proveCanReachConnector(acting, connector), (reach) => reach.connector.value),
					);
				}),
			);

			expect(reached).toBe(own.id);
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

		it("records every unfinished run as failed, and keeps no lane of a workflow gone", async () => {
			const workflows = await upgraded.rows<{ workflow: string }>(
				`select workflow from lane where workflow is not null
				 union select workflow from lane_request order by 1`,
			);
			const runs = await upgraded.rows(
				`select id, state, error from run where id = any($1) order by id`,
				[[legacy.routineRuns.running, legacy.routineRuns.waiting, migrationScale.unclaimedRun]],
			);

			expect(workflows.map(({ workflow }) => workflow)).toEqual(["compaction", "turn"]);
			expect(runs).toEqual(
				[legacy.routineRuns.running, legacy.routineRuns.waiting, migrationScale.unclaimedRun].map(
					(id) => ({
						id,
						state: "failed",
						error: "Stopped when Sugabots was upgraded. Run it again.",
					}),
				),
			);
		});

		it("keeps both copies of an automation result and links the run from its feed", async () => {
			expect(
				await upgraded.rows(
					`select id, chat_id, run_id, content from message where id = any($1) order by id`,
					[[migrationScale.feedResult, migrationScale.chatResult]],
				),
			).toEqual([
				{
					id: migrationScale.feedResult,
					chat_id: migrationScale.feed,
					run_id: migrationScale.resultRun,
					content: "Digest ready.",
				},
				{
					id: migrationScale.chatResult,
					chat_id: legacy.threads.trip,
					run_id: null,
					content: "Digest ready.",
				},
			]);
		});

		it("leaves the opener unknown when a workspace has no members", async () => {
			expect(
				await upgraded.rows(`select started_by_id from project_chat where chat_id = $1`, [
					migrationScale.memberlessGeneral,
				]),
			).toEqual([{ started_by_id: null }]);
		});

		it("retains the cost of a turn whose bot is unknown", async () => {
			expect(
				await upgraded.rows(
					`select purpose, bot_id, cost_usd::float8 as usd from model_request where id = $1`,
					[migrationScale.unattributedRequest],
				),
			).toEqual([{ purpose: "bot-turn", bot_id: null, usd: 0.5 }]);
		});

		it("gives ordinary bots handles they can keep", async () => {
			const [bot] = await upgraded.rows<{ handle: string }>(
				`select handle from bot where id = $1`,
				[migrationScale.reservedBot],
			);
			expect(bot?.handle).toBeDefined();
			expect(bot?.handle).not.toMatch(/^(here|channel|personal-assistant(-\d+)?)$/);
		});

		it("keeps written files from removed chats within their original audience", async () => {
			const { collaboration, personal } = migrationScale.files;
			expect(
				await upgraded.rows(`select id, chat_id from file where id = any($1) order by id`, [
					[collaboration.fileId, personal.fileId],
				]),
			).toEqual([
				{ id: collaboration.fileId, chat_id: legacy.threads.general },
				{ id: personal.fileId, chat_id: legacy.threads.report },
			]);
			for (const file of [collaboration, personal]) {
				expect(queuedByTheUpgrade).not.toContain(`files/${file.fileId}`);
			}
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

			for (const file of [...legacyFiles, ...Object.values(migrationScale.files)]) {
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

it.skipIf(!process.env.DATABASE_URL)(
	"reports the ids in a collaboration cycle and rolls back",
	async () => {
		const url = upgradeDatabaseUrl(process.env.DATABASE_URL ?? "", "cycle");
		const migration = await readFile(
			join(MIGRATIONS, "20261125093952_bots_projects_and_chats/migration.sql"),
			"utf8",
		);
		await recreateDatabase(url);
		try {
			await migrateTo(url, LAST_MAIN_MIGRATION);
			await withClient(url, async (client) => {
				await client.query(legacyRows);
				await client.query(legacyCyclicCollaboration);
				await client.query("begin");
				try {
					await client.query("set local statement_timeout = '2s'");
					await expect(client.query(migration)).rejects.toThrow(
						`Collaboration chat ancestry has a cycle: ${migrationScale.cyclicChat}`,
					);
				} finally {
					await client.query("rollback");
				}
				const { rows } = await client.query("select id from thread where id = $1", [
					migrationScale.cyclicChat,
				]);
				expect(rows).toEqual([{ id: migrationScale.cyclicChat }]);
			});
		} finally {
			await dropDatabase(url);
		}
	},
	UPGRADE_TIMEOUT_MS,
);

/**
 * Something a member reaches: a bot, a project (on main, a `shared` `pod`), a
 * chat, an automation, a file or a connector.
 */
interface Reached {
	member: string;
	kind: "bot" | "project" | "chat" | "automation" | "file" | "connector";
	id: string;
}

/**
 * What each member reached on main, read from main's own tables: the bots,
 * threads, routines, files, connections and `shared` `pod`s of each `pod`
 * they were in or owned,
 * as main's access rules read them. Direct messages, which the upgrade deletes, are in
 * no `pod`.
 */
const REACHED_ON_MAIN = `
	with reach as (
		select pod_id, user_id from pod_member
		union select id, owner_id from pod where owner_id is not null
	)
	select reach.user_id::text as member, 'bot' as kind, agent.id::text as id
		from agent join reach on reach.pod_id = agent.pod_id
	union all
	select reach.user_id::text, 'project', pod.id::text
		from pod join reach on reach.pod_id = pod.id where pod.kind = 'shared'
	union all
	select reach.user_id::text, 'chat', thread.id::text
		from thread join reach on reach.pod_id = thread.pod_id
	union all
	select reach.user_id::text, 'automation', routine.id::text
		from routine join agent on agent.id = routine.agent_id
		join reach on reach.pod_id = agent.pod_id
		where routine.deleted_at is null
	union all
	-- A tool's result is read with its call, in a chat, not listed among files.
	select reach.user_id::text, 'file', thread_file.id::text
		from thread_file join thread on thread.id = thread_file.thread_id
		join reach on reach.pod_id = thread.pod_id
		where thread_file.kind <> 'tool_result'
	union all
	select reach.user_id::text, 'file', artifact.id::text
		from artifact join reach on reach.pod_id = artifact.pod_id
	union all
	select reach.user_id::text, 'connector', connection.id::text
		from connection join reach on reach.pod_id = connection.pod_id`;

function sortedReach(reached: readonly Reached[]): string[] {
	return reached.map(({ member, kind, id }) => `${member} ${kind} ${id}`).sort();
}

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
	const bytes = [
		...legacyBytes,
		...Object.values(migrationScale.files).map((file) => ({
			key: legacyKeyOf(file),
			text: file.text,
		})),
	];
	if (store === "postgres") {
		await withClient(url, async (client) => {
			for (const { key, text } of bytes) {
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
			for (const { key, text } of bytes) {
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
	run: RunEffect<TestInfrastructure>;
	/** `memberId`, signed in with the session main gave them in {@link legacySessions}. */
	signIn: (memberId: string) => Promise<Principal>;
	dispose: () => Promise<void>;
}

/** The server's database and blob store on the upgraded database, started as the server starts them. */
function startServer(url: string, store: Store, root: string): Upgraded {
	const env = { DATABASE_URL: url, BLOB_STORE_PROVIDER: store, BLOB_STORE_FILESYSTEM_ROOT: root };
	const runtime = ManagedRuntime.make(
		testInfrastructure.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))),
	);
	const run = effectRunner(runtime);
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
		run,
		signIn: (memberId) =>
			run(
				Effect.gen(function* () {
					const sessions = yield* SessionAuthentication.Service;
					return yield* sessions
						.authenticate(new Headers({ authorization: `Bearer ${legacySessionToken(memberId)}` }))
						.pipe(
							Effect.provideService(SessionAuthentication.Cookies, {
								read: () => Effect.succeed(undefined),
							}),
						);
				}).pipe(Effect.provide(SessionAuthentication.layer)),
			),
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
function upgradeDatabaseUrl(workerUrl: string, store: Store | "cycle"): string {
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
