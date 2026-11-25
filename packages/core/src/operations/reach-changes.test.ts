import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import {
	seedBot,
	seedComputer,
	seedConnector,
	seedInvitation,
	seedMember,
	seedProject,
	seedWorkspace,
} from "../authentication/seed.test-support.ts";
import { type Database, query, transaction } from "../database/database.ts";
import {
	bot,
	computer,
	computerProvider,
	connector,
	event,
	member,
	membership,
	project,
	workspace,
} from "../database/schema.ts";
import {
	closeDatabase,
	holdTransaction,
	onDatabase,
	runOnPostgres,
	servedOnPostgres,
	waitUntilWaitingOnLocks,
} from "../database/testing.ts";
import type { Principal } from "../principal.ts";
import { underWorkspaceLock } from "../proofs/workspace-lock.ts";
import { authenticators, principals } from "../proofs/world.test-support.ts";
import { ConnectorStore, type OAuthVersion } from "../providers/connectors/connector-store.ts";
import { SignInRequired, storedOAuthProvider } from "../providers/connectors/oauth.ts";
import { Secrets } from "../secrets/secrets.ts";
import { type CallOperation, servedOperations } from "./testing.ts";

/**
 * The operations that change who reaches what, against Postgres: each checks
 * and writes under its workspace's lock, in one `READ COMMITTED` transaction,
 * with every id it acts on named afresh inside it, so what it proves is what
 * the change before it committed. A connector sign-in that lands during a
 * removal of its member is seen by the removal or refused.
 *
 * A change in progress is stood in for by a transaction held open with the
 * workspace's row locked as `underWorkspaceLock` locks it, so a case can start
 * an operation against it and choose when it commits.
 */
describe.skipIf(!process.env.DATABASE_URL)(
	"changes to who reaches what, under the workspace's lock",
	() => {
		let call: CallOperation;
		let signedIn: ReturnType<typeof principals>;

		beforeAll(async () => {
			call = await servedOperations();
			signedIn = principals(await authenticators());
		});

		afterAll(async () => {
			await closeDatabase();
		});

		/** What `called` came to: "ok", or its refusal's tag. */
		const outcome = (called: Promise<unknown>) =>
			called.then(
				() => "ok",
				(failure: { readonly _tag: string }) => failure._tag,
			);

		/** Locks the workspace's row as `underWorkspaceLock` does, then does `then`, in the held transaction. */
		const holdingLock = (
			workspaceId: string,
			then: Effect.Effect<unknown, never, Database> = Effect.void,
		) =>
			holdTransaction(
				Effect.gen(function* () {
					yield* query((db) =>
						db
							.select({ id: workspace.id })
							.from(workspace)
							.where(eq(workspace.id, workspaceId))
							.for("no key update"),
					);
					return yield* then;
				}),
			);

		/** Sets `memberId`'s role in the workspace, as a change of role does. */
		const setRole = (workspaceId: string, memberId: string, role: "admin" | "editor" | "viewer") =>
			query((db) =>
				db
					.update(membership)
					.set({ role })
					.where(and(eq(membership.workspaceId, workspaceId), eq(membership.memberId, memberId))),
			).pipe(Effect.asVoid);

		/** Takes `memberId` out of the workspace, as a removal does. */
		const takeOut = (workspaceId: string, memberId: string) =>
			query((db) =>
				db
					.delete(membership)
					.where(and(eq(membership.workspaceId, workspaceId), eq(membership.memberId, memberId))),
			).pipe(Effect.asVoid);

		/** The id of `memberId`'s membership of the workspace. */
		const membershipOf = async (workspaceId: string, memberId: string) => {
			const [row] = await onDatabase((db) =>
				db
					.select({ id: membership.id })
					.from(membership)
					.where(and(eq(membership.workspaceId, workspaceId), eq(membership.memberId, memberId))),
			);
			if (!row) throw new Error("No such membership");
			return row.id;
		};

		/** A workspace with an owner, two admins, two editors and a public bot leading a project. */
		const staffed = async () => {
			const workspaceId = await seedWorkspace();
			const owner = await seedMember(workspaceId, "owner");
			const admin = await seedMember(workspaceId, "admin");
			const otherAdmin = await seedMember(workspaceId, "admin");
			const ed = await seedMember(workspaceId, "editor");
			const erin = await seedMember(workspaceId, "editor");
			const pub = await seedBot(workspaceId, { createdById: ed });
			const project = await seedProject(workspaceId, { leadBotId: pub.id, members: [ed] });
			return { workspaceId, owner, admin, otherAdmin, ed, erin, pub, project };
		};

		describe("two admins acting at once", () => {
			it("refuses an admin's change of a role once the owner, whose change came first, made them an editor", async () => {
				const staff = await staffed();
				const demoting = holdingLock(
					staff.workspaceId,
					setRole(staff.workspaceId, staff.admin, "editor"),
				);
				await demoting.held;

				const changing = outcome(
					call(await signedIn.member(staff.admin), "workspaces.changeRole", {
						workspace: staff.workspaceId,
						membershipId: await membershipOf(staff.workspaceId, staff.ed),
						role: "viewer",
					}),
				);
				await waitUntilWaitingOnLocks(1);
				await demoting.release();

				expect(await changing).toBe("ActionForbidden");
				const [ed] = await onDatabase((db) =>
					db
						.select({ role: membership.role })
						.from(membership)
						.where(eq(membership.memberId, staff.ed)),
				);
				expect(ed?.role).toBe("editor");
			});

			it("hides a membership from an admin changing its role once another admin, who came first, removed it", async () => {
				const staff = await staffed();
				const membershipId = await membershipOf(staff.workspaceId, staff.ed);
				const removing = holdingLock(staff.workspaceId, takeOut(staff.workspaceId, staff.ed));
				await removing.held;

				const changing = outcome(
					call(await signedIn.member(staff.otherAdmin), "workspaces.changeRole", {
						workspace: staff.workspaceId,
						membershipId,
						role: "viewer",
					}),
				);
				await waitUntilWaitingOnLocks(1);
				await removing.release();

				expect(await changing).toBe("ResourceHidden");
			});

			it("lets the second of two admins changing the same role at once act on what the first left", async () => {
				const staff = await staffed();
				const membershipId = await membershipOf(staff.workspaceId, staff.ed);
				const [first, second] = await Promise.all([
					outcome(
						call(await signedIn.member(staff.admin), "workspaces.changeRole", {
							workspace: staff.workspaceId,
							membershipId,
							role: "viewer",
						}),
					),
					outcome(
						call(await signedIn.member(staff.otherAdmin), "workspaces.removeMembership", {
							workspace: staff.workspaceId,
							membershipId,
						}),
					),
				]);
				const [left] = await onDatabase((db) =>
					db.select().from(membership).where(eq(membership.id, membershipId)),
				);

				// Whichever went first, the other proved what it left: a role changed then a
				// removal, or a removal and then nothing to change.
				expect(left).toBeUndefined();
				expect(second).toBe("ok");
				expect(["ok", "ResourceHidden"]).toContain(first);
			});
		});

		describe("deleting, and the computers that go first", () => {
			/** Whether the project, and its computer, are still there. */
			const stillThere = async (projectId: string) => {
				const [kept] = await onDatabase((db) =>
					db.select({ id: project.id }).from(project).where(eq(project.id, projectId)),
				);
				const [machine] = await onDatabase((db) =>
					db.select({ id: computer.id }).from(computer).where(eq(computer.projectId, projectId)),
				);
				return { project: kept !== undefined, computer: machine !== undefined };
			};

			it("refuses a project's deletion, and keeps its computer, once the owner, who came first, made its admin an editor", async () => {
				const staff = await staffed();
				await seedComputer(staff.workspaceId, staff.project);
				const demoting = holdingLock(
					staff.workspaceId,
					setRole(staff.workspaceId, staff.admin, "editor"),
				);
				await demoting.held;

				const deleting = outcome(
					call(await signedIn.member(staff.admin), "projects.remove", {
						projectId: staff.project,
					}),
				);
				await waitUntilWaitingOnLocks(1);
				await demoting.release();

				expect(await deleting).toBe("ActionForbidden");
				expect(await stillThere(staff.project)).toEqual({ project: true, computer: true });
			});

			it.each(["project", "workspace", "bot"] as const)(
				"fences a deleting %s and frees the database pool before destroying its computer",
				async (kind) => {
					const staff = await staffed();
					const removingBot =
						kind === "bot"
							? await seedBot(staff.workspaceId, { createdById: staff.admin })
							: undefined;
					const projectId = removingBot?.defaultProject ?? staff.project;
					await seedComputer(staff.workspaceId, projectId);
					const destroying = Promise.withResolvers<void>();
					const destroyed = Promise.withResolvers<void>();
					// The computer provider, which takes its time destroying the computer, then finds it gone.
					const provider = createServer((_request, response) => {
						destroying.resolve();
						void destroyed.promise.then(() =>
							response
								.writeHead(404, { "content-type": "application/json" })
								.end(JSON.stringify({ code: "NOT_FOUND", message: "No such computer" })),
						);
					});
					await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
					onTestFinished(() => void provider.close());
					const { port } = provider.address() as AddressInfo;
					const apiKey = await runOnPostgres(
						Effect.map(Secrets.Service, (secrets) => secrets.encrypt("api-key")),
					);
					await onDatabase((db) =>
						db
							.update(computerProvider)
							.set({
								apiKeyEncrypted: apiKey,
								settings: {
									builtIn: "opensandbox",
									serverUrl: `http://127.0.0.1:${port}`,
									image: "debian",
								},
							})
							.where(eq(computerProvider.workspaceId, staff.workspaceId)),
					);
					const owner = await signedIn.member(staff.owner);
					const adminMembership = await membershipOf(staff.workspaceId, staff.admin);
					const admin = await signedIn.member(staff.admin);

					const start = () => {
						switch (kind) {
							case "workspace":
								return call(owner, "workspaces.delete", { workspace: staff.workspaceId });
							case "project":
								return call(admin, "projects.remove", { projectId });
							case "bot":
								if (!removingBot) throw new Error("Expected a bot to remove");
								return call(admin, "bots.remove", { botId: removingBot.id });
						}
					};
					const deleting = outcome(start());
					onTestFinished(() => {
						destroyed.resolve();
					});
					await destroying.promise;
					try {
						const [pool] = await onDatabase((db) =>
							db.execute<{ held: number }>(
								sql`
						select count(*)::int as held from pg_stat_activity
						where datname = current_database() and state = 'idle in transaction'
					`,
								"objects",
							),
						);
						expect(pool?.held).toBe(0);
						if (kind === "workspace") {
							expect(
								await outcome(
									call(owner, "workspaces.handOverOwnership", {
										workspace: staff.workspaceId,
										membershipId: adminMembership,
									}),
								),
							).toBe("ResourceHidden");
						}
						expect(
							await outcome(
								call(owner, "projects.update", {
									projectId,
									changes: { name: "Too late" },
								}),
							),
						).toBe("ResourceHidden");
						expect(
							await outcome(
								call(owner, "chats.startProjectChat", {
									projectId,
									retryKey: randomUUID(),
									message: "Too late",
								}),
							),
						).toBe("ResourceHidden");
						if (kind === "bot" && removingBot) {
							expect(
								await outcome(
									call(owner, "projects.update", {
										projectId: staff.project,
										changes: { leadBotId: removingBot.id },
									}),
								),
							).toBe("ResourceHidden");
						}
						if (kind === "project") {
							await call(owner, "workspaces.changeRole", {
								workspace: staff.workspaceId,
								membershipId: adminMembership,
								role: "editor",
							});
						}
					} finally {
						destroyed.resolve();
					}
					expect(await deleting).toBe("ok");
					expect(await stillThere(projectId)).toEqual({ project: false, computer: false });
					if (removingBot) {
						expect(
							await onDatabase((db) => db.select().from(bot).where(eq(bot.id, removingBot.id))),
						).toEqual([]);
					}
				},
			);

			it("refuses a workspace's deletion, and destroys none of its computers, once its owner, who came first, handed it on", async () => {
				const staff = await staffed();
				await seedComputer(staff.workspaceId, staff.project);
				const handingOver = holdingLock(
					staff.workspaceId,
					Effect.andThen(
						setRole(staff.workspaceId, staff.owner, "admin"),
						query((db) =>
							db
								.update(membership)
								.set({ role: "owner" })
								.where(
									and(
										eq(membership.workspaceId, staff.workspaceId),
										eq(membership.memberId, staff.admin),
									),
								),
						),
					),
				);
				await handingOver.held;

				const deleting = outcome(
					call(await signedIn.member(staff.owner), "workspaces.delete", {
						workspace: staff.workspaceId,
					}),
				);
				await waitUntilWaitingOnLocks(1);
				await handingOver.release();

				expect(await deleting).toBe("ActionForbidden");
				expect(await stillThere(staff.project)).toEqual({ project: true, computer: true });
			});
		});

		describe("each waits for the workspace's lock", () => {
			/** Whether `start`, run while the workspace's lock is held, waits for it, and then comes to "ok". */
			const waitsForLock = async (workspaceId: string, start: () => Promise<unknown>) => {
				const holding = holdingLock(workspaceId);
				await holding.held;
				const started = outcome(start());
				await waitUntilWaitingOnLocks(1);
				await holding.release();
				return started;
			};

			it.each([
				"workspaces.changeRole",
				"workspaces.removeMembership",
				"workspaces.handOverOwnership",
			] as const)("%s", async (name) => {
				const staff = await staffed();
				const membershipId = await membershipOf(staff.workspaceId, staff.ed);
				const owner = await signedIn.member(staff.owner);
				const input =
					name === "workspaces.changeRole"
						? { workspace: staff.workspaceId, membershipId, role: "viewer" as const }
						: { workspace: staff.workspaceId, membershipId };
				expect(
					await waitsForLock(staff.workspaceId, () =>
						call(owner, name, input as { workspace: string; membershipId: string; role: "viewer" }),
					),
				).toBe("ok");
			});

			it("workspaces.leave", async () => {
				const staff = await staffed();
				expect(
					await waitsForLock(staff.workspaceId, async () =>
						call(await signedIn.member(staff.erin), "workspaces.leave", {
							workspace: staff.workspaceId,
						}),
					),
				).toBe("ok");
			});

			it("workspaces.invite, workspaces.cancelInvitation and workspaces.acceptInvitation", async () => {
				const staff = await staffed();
				const admin = await signedIn.member(staff.admin);
				expect(
					await waitsForLock(staff.workspaceId, () =>
						call(admin, "workspaces.invite", {
							workspace: staff.workspaceId,
							email: `invited-${randomUUID()}@example.com`,
							role: "editor",
						}),
					),
				).toBe("ok");

				const cancelled = await seedInvitation(staff.workspaceId, staff.admin, {
					email: `cancelled-${randomUUID()}@example.com`,
				});
				expect(
					await waitsForLock(staff.workspaceId, () =>
						call(admin, "workspaces.cancelInvitation", { invitationId: cancelled }),
					),
				).toBe("ok");

				const newcomer = await seedMember(await seedWorkspace(), "editor");
				const [{ email } = { email: "" }] = await onDatabase((db) =>
					db.select({ email: member.email }).from(member).where(eq(member.id, newcomer)),
				);
				const accepted = await seedInvitation(staff.workspaceId, staff.admin, { email });
				expect(
					await waitsForLock(staff.workspaceId, async () =>
						call(await signedIn.member(newcomer), "workspaces.acceptInvitation", {
							invitationId: accepted,
						}),
					),
				).toBe("ok");
			});

			it("a project's members and bots: added, removed, joined and left", async () => {
				const staff = await staffed();
				const ed = await signedIn.member(staff.ed);
				const helper = await seedBot(staff.workspaceId, { createdById: staff.ed });
				const open = await seedProject(staff.workspaceId, {
					leadBotId: staff.pub.id,
					visibility: "public",
				});
				const changes: Array<() => Promise<unknown>> = [
					() => call(ed, "projects.addMember", { projectId: staff.project, memberId: staff.erin }),
					() =>
						call(ed, "projects.removeMember", { projectId: staff.project, memberId: staff.erin }),
					() => call(ed, "projects.addBot", { projectId: staff.project, botId: helper.id }),
					() => call(ed, "projects.removeBot", { projectId: staff.project, botId: helper.id }),
					async () => call(await signedIn.member(staff.erin), "projects.join", { projectId: open }),
					async () =>
						call(await signedIn.member(staff.erin), "projects.leave", { projectId: open }),
				];
				for (const change of changes) {
					expect(await waitsForLock(staff.workspaceId, change)).toBe("ok");
				}
			});

			it("a project made, and a project's lead changed, each recording the change", async () => {
				const staff = await staffed();
				const admin = await signedIn.member(staff.admin);
				const spare = await seedBot(staff.workspaceId, { createdById: staff.ed });
				let made: { id: string } | undefined;
				expect(
					await waitsForLock(staff.workspaceId, async () => {
						made = await call(admin, "projects.create", {
							workspace: staff.workspaceId,
							name: `Made ${randomUUID().slice(0, 8)}`,
							leadBotId: staff.pub.id,
						});
					}),
				).toBe("ok");
				expect(
					await waitsForLock(staff.workspaceId, () =>
						call(admin, "projects.update", {
							projectId: staff.project,
							changes: { leadBotId: spare.id },
						}),
					),
				).toBe("ok");

				const recorded = await onDatabase((db) =>
					db
						.select({ payload: event.payload })
						.from(event)
						.where(
							and(
								eq(event.stream, `workspace:${staff.workspaceId}`),
								eq(event.type, "reach.changed"),
							),
						)
						.orderBy(event.seq),
				);
				expect(recorded.map(({ payload }) => payload.about)).toEqual([
					{ kind: "project", projectId: made?.id },
					{ kind: "project", projectId: staff.project },
				]);
			});

			it("a bot made personal, and a bot deleted", async () => {
				const staff = await staffed();
				const ed = await signedIn.member(staff.ed);
				const spare = await seedBot(staff.workspaceId, { createdById: staff.ed });

				expect(
					await waitsForLock(staff.workspaceId, () =>
						call(ed, "bots.update", { botId: spare.id, changes: { visibility: "personal" } }),
					),
				).toBe("ok");
				expect(
					await waitsForLock(staff.workspaceId, () => call(ed, "bots.remove", { botId: spare.id })),
				).toBe("ok");
			});

			it("but not a change to a bot that leaves who reaches it as it was", async () => {
				const staff = await staffed();
				const holding = holdingLock(staff.workspaceId);
				await holding.held;

				expect(
					await outcome(
						call(await signedIn.member(staff.ed), "bots.update", {
							botId: staff.pub.id,
							changes: { description: "Answers questions." },
						}),
					),
				).toBe("ok");
				await holding.release();
			});
		});

		it("begins its own transaction, inside no other", async () => {
			const staff = await staffed();
			const owner: Principal = await signedIn.member(staff.owner);

			await expect(
				runOnPostgres(transaction(underWorkspaceLock(owner, staff.workspaceId, () => Effect.void))),
			).rejects.toThrow("inside no other");
		});

		describe("a connector sign-in during a removal", () => {
			const tokens = { tokens: { access_token: "token", token_type: "bearer" } };

			/** The connector's sign-in as stored: who signed it in, and whether it holds a record. */
			const signInOf = async (connectorId: string) => {
				const [row] = await onDatabase((db) =>
					db
						.select({ signedInById: connector.signedInById, sealed: connector.oauthEncrypted })
						.from(connector)
						.where(eq(connector.id, connectorId)),
				);
				return { signedInById: row?.signedInById ?? null, signedIn: row?.sealed != null };
			};

			it("is refused when it finishes while the removal holds the lock, as is a GitHub app installed on their account", async () => {
				const staff = await staffed();
				const store = await servedOnPostgres(ConnectorStore.Service, ConnectorStore.layer);
				const oauth = await seedConnector(staff.workspaceId, staff.project);
				const github = await seedConnector(staff.workspaceId, staff.project, {
					github: { appCredentialEncrypted: "sealed" },
				});
				const removing = holdingLock(staff.workspaceId, takeOut(staff.workspaceId, staff.ed));
				await removing.held;

				const signingIn = store.saveOauthRecord(staff.workspaceId, oauth, tokens, {
					kind: "signIn",
					version: null,
					signedInById: staff.ed,
				});
				const installing = store.installed(staff.workspaceId, github, {
					installationId: 1,
					account: "ed",
					installedById: staff.ed,
				});
				await waitUntilWaitingOnLocks(2);
				await removing.release();

				expect(await signingIn).toBeUndefined();
				expect(await installing).toBe(false);
				expect(await signInOf(oauth)).toEqual({ signedInById: null, signedIn: false });
			});

			it("refuses every refresh callback after a metadata save conflicts with removal and a new sign-in", async () => {
				const staff = await staffed();
				const store = await servedOnPostgres(ConnectorStore.Service, ConnectorStore.layer);
				const oauth = await seedConnector(staff.workspaceId, staff.project);
				await store.saveOauthRecord(staff.workspaceId, oauth, tokens, {
					kind: "signIn",
					version: null,
					signedInById: staff.ed,
				});
				let version: OAuthVersion = null;
				const refreshing = storedOAuthProvider(
					{
						load: async () => {
							const current = await store.readOauthRecord(staff.workspaceId, oauth);
							version = current?.version ?? null;
							return current?.record;
						},
						save: async (record) => {
							const saved = await store.saveOauthRecord(staff.workspaceId, oauth, record, {
								kind: "since",
								version,
							});
							if (saved === undefined) return false;
							version = saved;
							return true;
						},
						now: async () => new Date(),
					},
					{ redirectUrl: "https://sugabots.test/callback", clientName: "Sugabots" },
				);
				expect(await refreshing.tokens()).toMatchObject({ access_token: "token" });

				await call(await signedIn.member(staff.admin), "workspaces.removeMembership", {
					workspace: staff.workspaceId,
					membershipId: await membershipOf(staff.workspaceId, staff.ed),
				});

				await store.saveOauthRecord(
					staff.workspaceId,
					oauth,
					{
						tokens: { access_token: "replacement", token_type: "bearer" },
					},
					{ kind: "signIn", signedInById: staff.admin, version: null },
				);

				await expect(
					refreshing.saveClientInformation?.({
						client_id: "old-client",
						issuer: "https://auth.example.com",
					}),
				).rejects.toBeInstanceOf(SignInRequired);
				await expect(
					refreshing.saveTokens({ access_token: "refreshed", token_type: "bearer" }),
				).rejects.toBeInstanceOf(SignInRequired);
				expect(await store.oauthRecord(staff.workspaceId, oauth)).toMatchObject({
					tokens: { access_token: "replacement" },
				});
				expect(await signInOf(oauth)).toEqual({ signedInById: staff.admin, signedIn: true });
			});

			it("is seen by the removal, which signs it out, when it finished first", async () => {
				const staff = await staffed();
				const oauth = await seedConnector(staff.workspaceId, staff.project);
				const signingIn = holdTransaction(
					Effect.flatMap(ConnectorStore.Service, (store) =>
						store.saveOauthRecord(staff.workspaceId, oauth, tokens, {
							kind: "signIn",
							version: null,
							signedInById: staff.ed,
						}),
					).pipe(Effect.provide(ConnectorStore.layer)),
				);
				expect(await signingIn.held).toBeTypeOf("string");

				const removing = outcome(
					call(await signedIn.member(staff.admin), "workspaces.removeMembership", {
						workspace: staff.workspaceId,
						membershipId: await membershipOf(staff.workspaceId, staff.ed),
					}),
				);
				await waitUntilWaitingOnLocks(1);
				await signingIn.release();

				expect(await removing).toBe("ok");
				expect(await signInOf(oauth)).toEqual({ signedInById: null, signedIn: false });
			});
		});
	},
);
