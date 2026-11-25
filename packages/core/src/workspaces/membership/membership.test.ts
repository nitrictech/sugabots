import type { Connector } from "@sugabots/contracts";
import type { InputOf, OutputOf, RequestOperationName } from "@sugabots/contracts/operations";
import { and, eq, isNotNull } from "drizzle-orm";
import { Effect, type Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Accounts } from "../../accounts/accounts.ts";
import { seedAutomation, seedBot, seedRoutine } from "../../authentication/seed.test-support.ts";
import { SystemWorkAuthentication } from "../../authentication/system-work.ts";
import { ComputerProviderStore } from "../../computers/computer-provider-store.ts";
import { Computers } from "../../computers/computers.ts";
import { localComputerEgress, recordingFirstComputer } from "../../computers/testing.ts";
import { query } from "../../database/database.ts";
import {
	automation,
	automationRun,
	automationTrigger,
	bot,
	computer,
	gitHubUninstall,
	invitation,
	member,
	membership,
	modelProvider,
	project,
	projectMember,
	providerModel,
	searchProvider,
	workspaceDefaultModel,
	workspace as workspaceTable,
} from "../../database/schema.ts";
import {
	closeDatabase,
	holdTransaction,
	onDatabase,
	runOnPostgres,
	servedOnPostgres,
	waitUntilWaitingOnLocks,
} from "../../database/testing.ts";
import type { Email } from "../../email/email.ts";
import { type CallOperation, servedOperations } from "../../operations/testing.ts";
import type { MemberSession } from "../../principal.ts";
import { authenticators, principals } from "../../proofs/world.test-support.ts";
import { connectorsIn } from "../../providers/connectors/connector-reads.ts";
import { ConnectorStore } from "../../providers/connectors/connector-store.ts";
import {
	egressToGitHub,
	gitHubSetupAt,
	installedConnector,
	standInGitHub,
	USER_INSTALLATION_ID,
} from "../../providers/connectors/github/github.test-support.ts";
import { providersIn } from "../../providers/model-providers/model-provider-reads.ts";
import { ModelProviderStore } from "../../providers/model-providers/model-provider-store.ts";
import type { Egress } from "../../providers/network/egress.ts";
import { Secrets } from "../../secrets/secrets.ts";
import { ServerSettings } from "../../server-settings/server-settings.ts";
import { unimplemented } from "../../testing.ts";
import { seedProject } from "../projects/seed.test-support.ts";

const WEB_APP_URL = "http://localhost:5173";
/** A computer provider's address nothing listens on. */
const UNREACHABLE_URL = "http://127.0.0.1:9";

/**
 * The workspace operations, called through the registry for members signed
 * in, over a migrated database, with the emails they send kept in `sent`.
 * Needs `DATABASE_URL`, and makes a fresh workspace per case so it can run
 * against a database with the dev seed in it.
 */
describe.skipIf(!process.env.DATABASE_URL)("Membership, against Postgres", () => {
	const sent: Email.Message[] = [];
	let signIn: (memberId: string) => Promise<MemberSession>;

	beforeAll(async () => {
		const signedIn = principals(await authenticators());
		const sessions = new Map<string, Promise<MemberSession>>();
		signIn = (memberId) => {
			const known = sessions.get(memberId);
			if (known) return known;
			const started = signedIn.member(memberId);
			sessions.set(memberId, started);
			return started;
		};
	});

	/**
	 * The workspace operations, by the names these cases use, on a server that
	 * requires members to verify their email when `requireEmailVerification`,
	 * as none does by default, and whose requests out reach `egress`, by
	 * default nothing.
	 */
	function membershipWith({
		requireEmailVerification = false,
		egress,
	}: {
		readonly requireEmailVerification?: boolean;
		readonly egress?: Layer.Layer<Egress.Service>;
	} = {}) {
		let served: Promise<CallOperation> | undefined;
		const callOperation = () => {
			served ??= servedOperations({
				accounts: unimplemented(Accounts.Service, { requireEmailVerification }),
				egress,
				serverSettings: ServerSettings.fromUrls({
					isProduction: false,
					publicUrl: "http://sugabots.test",
					webAppUrl: WEB_APP_URL,
				}),
				email: {
					send: (message) =>
						Effect.sync(() => {
							sent.push(message);
						}),
				},
			});
			return served;
		};
		const membershipAs = async (memberId: string): Promise<MembershipAs> => {
			const call = await callOperation();
			const principal = await signIn(memberId);
			const operation =
				<Name extends RequestOperationName>(name: Name) =>
				(input: InputOf<Name>) =>
					call(principal, name, input);
			return {
				get workspaces() {
					return call(principal, "workspaces.list", {});
				},
				create: ({ details }) => call(principal, "workspaces.create", details),
				update: ({ workspace, details }) =>
					call(principal, "workspaces.update", { workspace, ...details }),
				delete: operation("workspaces.delete"),
				access: operation("system.workspaceAccess"),
				memberships: operation("workspaces.memberships"),
				changeRole: operation("workspaces.changeRole"),
				remove: operation("workspaces.removeMembership"),
				leave: operation("workspaces.leave"),
				handOverOwnership: operation("workspaces.handOverOwnership"),
				invitations: operation("workspaces.invitations"),
				invite: ({ workspace, invitation }) =>
					call(principal, "workspaces.invite", { workspace, ...invitation }),
				cancelInvitation: operation("workspaces.cancelInvitation"),
				invitation: operation("workspaces.invitation"),
				accept: operation("workspaces.acceptInvitation"),
			};
		};
		return {
			/** What `operation` comes to when `memberId` asks for it: its value, or the tag it failed with. */
			run: <A>(memberId: string, operation: (membership: MembershipAs) => Promise<A>) =>
				membershipAs(memberId)
					.then(operation)
					.then(
						(value): A | { failed: string } => value,
						(failure: unknown) => ({ failed: refusalOf(failure)._tag }),
					),
			/** The error `operation` fails with when `memberId` asks for it. */
			failure: <A>(memberId: string, operation: (membership: MembershipAs) => Promise<A>) =>
				membershipAs(memberId)
					.then(operation)
					.then(
						() => {
							throw new Error("It succeeded");
						},
						(failure: unknown) => refusalOf(failure),
					),
		};
	}

	const { run, failure } = membershipWith();

	afterAll(async () => {
		await closeDatabase();
	});

	const unique = () => crypto.randomUUID().slice(0, 8);

	async function newMember(name: string, options?: { verified?: boolean }) {
		const [row] = await onDatabase((db) =>
			db
				.insert(member)
				.values({
					name,
					email: `${name.toLowerCase()}-${unique()}@example.com`,
					emailVerified: options?.verified ?? true,
				})
				.returning(),
		);
		if (!row) throw new Error("The member was not created");
		return row;
	}

	/** A workspace Ada owns. */
	async function workspaceOfAda() {
		const ada = await newMember("Ada");
		const created = await run(ada.id, (m) =>
			m.create({ details: { name: "Nitric", slug: `nitric-${unique()}` } }),
		);
		if ("failed" in created) throw new Error(created.failed);
		return { ada, workspace: created };
	}

	async function join(
		workspaceId: string,
		inviterId: string,
		invitee: { id: string; email: string },
		role: "admin" | "editor" | "viewer" = "editor",
	) {
		const invitation = await run(inviterId, (m) =>
			m.invite({
				workspace: workspaceId,
				invitation: { email: invitee.email, role },
			}),
		);
		if ("failed" in invitation) throw new Error(invitation.failed);
		await run(invitee.id, (m) => m.accept({ invitationId: invitation.id }));
		const memberships = await run(inviterId, (m) => m.memberships({ workspace: workspaceId }));
		if ("failed" in memberships) throw new Error(memberships.failed);
		const joined = memberships.find((one) => one.member.id === invitee.id);
		if (!joined) throw new Error("The invitee did not join");
		return joined;
	}

	it("makes the creator its owner, and provisions the workspace and their Personal Assistant", async () => {
		const { ada, workspace } = await workspaceOfAda();

		expect(await run(ada.id, (m) => m.memberships({ workspace: workspace.id }))).toEqual([
			expect.objectContaining({ role: "owner", member: expect.objectContaining({ id: ada.id }) }),
		]);
		expect(
			await onDatabase((db) =>
				db
					.select({ builtIn: searchProvider.builtIn, enabled: searchProvider.enabled })
					.from(searchProvider)
					.where(eq(searchProvider.workspaceId, workspace.id)),
			),
		).toEqual([{ builtIn: "exa", enabled: true }]);
		expect(
			await onDatabase((db) =>
				db
					.select({ id: bot.id })
					.from(bot)
					.where(and(eq(bot.workspaceId, workspace.id), isNotNull(bot.systemBotKey))),
			),
		).not.toEqual([]);
		expect(
			await onDatabase((db) =>
				db
					.select({ assistantOf: bot.assistantOf })
					.from(bot)
					.where(and(eq(bot.workspaceId, workspace.id), isNotNull(bot.assistantOf))),
			),
		).toEqual([{ assistantOf: ada.id }]);
		expect(await run(ada.id, (m) => m.workspaces)).toEqual([workspace]);
	});

	it("keeps the time zone a workspace is created in, and is in UTC when given none", async () => {
		const ada = await newMember("Ada");

		const inSydney = await run(ada.id, (m) =>
			m.create({
				details: { name: "Sydney", slug: `sydney-${unique()}`, timeZone: "Australia/Sydney" },
			}),
		);
		const inDefault = await run(ada.id, (m) =>
			m.create({ details: { name: "Nitric", slug: `nitric-${unique()}` } }),
		);

		expect(inSydney).toEqual(expect.objectContaining({ timeZone: "Australia/Sydney" }));
		expect(inDefault).toEqual(expect.objectContaining({ timeZone: "UTC" }));
		expect(await run(ada.id, (m) => m.workspaces)).toEqual([inSydney, inDefault]);
	});

	it("refuses a time zone Postgres does not have, and creates nothing", async () => {
		const ada = await newMember("Ada");

		expect(
			await run(ada.id, (m) =>
				m.create({
					details: { name: "Mars", slug: `mars-${unique()}`, timeZone: "Mars/Olympus" },
				}),
			),
		).toEqual({ failed: "TimeZoneUnknown" });
		expect(await run(ada.id, (m) => m.workspaces)).toEqual([]);
	});

	it("refuses a slug shaped like a UUID, or one another workspace has", async () => {
		const { ada, workspace } = await workspaceOfAda();

		expect(
			await run(ada.id, (m) =>
				m.create({ details: { name: "Nitric", slug: crypto.randomUUID() } }),
			),
		).toEqual({
			failed: "SlugShapedLikeUuid",
		});
		expect(
			await run(ada.id, (m) =>
				m.update({
					workspace: workspace.id,
					details: { name: "Nitric", slug: crypto.randomUUID() },
				}),
			),
		).toEqual({ failed: "SlugShapedLikeUuid" });
		expect(
			await run(ada.id, (m) => m.create({ details: { name: "Again", slug: workspace.slug } })),
		).toEqual({
			failed: "SlugTaken",
		});
	});

	it("emails an invitation whose id is a random UUID, and lets the invitee in", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await newMember("Bob");

		const invitation = await run(ada.id, (m) =>
			m.invite({
				workspace: workspace.id,
				invitation: { email: bob.email, role: "editor" },
			}),
		);
		if ("failed" in invitation) throw new Error(invitation.failed);

		expect(invitation.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
		expect(sent.at(-1)).toMatchObject({
			to: [{ email: bob.email }],
			replyTo: { email: ada.email, name: "Ada" },
		});
		expect(sent.at(-1)?.text).toContain(`${WEB_APP_URL}/invitations/${invitation.id}`);
		expect(await run(bob.id, (m) => m.invitation({ invitationId: invitation.id }))).toEqual({
			status: "pending",
			workspaceName: "Nitric",
			inviterName: "Ada",
			role: "editor",
		});
		expect(await run(bob.id, (m) => m.accept({ invitationId: invitation.id }))).toEqual({
			workspaceId: workspace.id,
		});
		expect(await run(bob.id, (m) => m.memberships({ workspace: workspace.id }))).toHaveLength(2);
		expect(
			await onDatabase((db) =>
				db
					.select({ id: bot.id })
					.from(bot)
					.where(and(eq(bot.workspaceId, workspace.id), eq(bot.assistantOf, bob.id))),
			),
		).toHaveLength(1);
	});

	it("leads an invitee back in from a link already accepted, until they leave", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await newMember("Bob");
		const invitation = await run(ada.id, (m) =>
			m.invite({ workspace: workspace.id, invitation: { email: bob.email, role: "editor" } }),
		);
		if ("failed" in invitation) throw new Error(invitation.failed);
		await run(bob.id, (m) => m.accept({ invitationId: invitation.id }));

		expect(await run(bob.id, (m) => m.invitation({ invitationId: invitation.id }))).toEqual({
			status: "accepted",
			workspaceId: workspace.id,
		});
		expect(await run(bob.id, (m) => m.accept({ invitationId: invitation.id }))).toEqual({
			workspaceId: workspace.id,
		});
		expect(await run(bob.id, (m) => m.memberships({ workspace: workspace.id }))).toHaveLength(2);

		await run(bob.id, (m) => m.leave({ workspace: workspace.id }));

		expect(await run(bob.id, (m) => m.invitation({ invitationId: invitation.id }))).toEqual({
			failed: "ResourceHidden",
		});
		expect(await run(bob.id, (m) => m.accept({ invitationId: invitation.id }))).toEqual({
			failed: "ResourceHidden",
		});
	});

	it("starts somebody joining on another model the workspace offers while it does not offer its default", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await newMember("Bob");
		const [provider] = await onDatabase((db) =>
			db
				.insert(modelProvider)
				.values({
					workspaceId: workspace.id,
					name: "Models",
					baseUrl: "https://models.example/v1",
					apiFormat: "openai",
					active: true,
				})
				.returning(),
		);
		if (!provider) throw new Error("could not create the model provider");
		await onDatabase((db) =>
			db.insert(providerModel).values(
				[
					{ modelId: "offered", enabled: true },
					{ modelId: "switched-off", enabled: false },
				].map((model) => ({
					...model,
					workspaceId: workspace.id,
					providerId: provider.id,
					source: "manual" as const,
				})),
			),
		);
		await onDatabase((db) =>
			db
				.insert(workspaceDefaultModel)
				.values({ workspaceId: workspace.id, modelId: "switched-off" }),
		);
		const invitation = await run(ada.id, (m) =>
			m.invite({ workspace: workspace.id, invitation: { email: bob.email, role: "editor" } }),
		);
		if ("failed" in invitation) throw new Error(invitation.failed);

		await run(bob.id, (m) => m.accept({ invitationId: invitation.id }));

		const [assistant] = await onDatabase((db) =>
			db
				.select({ model: bot.model })
				.from(bot)
				.where(and(eq(bot.workspaceId, workspace.id), eq(bot.assistantOf, bob.id))),
		);
		expect(assistant?.model).toBe("offered");
	});

	it("hides an invitation from anybody but the address it was sent to", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await newMember("Bob");
		const eve = await newMember("Eve");
		const invitation = await run(ada.id, (m) =>
			m.invite({
				workspace: workspace.id,
				invitation: { email: bob.email, role: "editor" },
			}),
		);
		if ("failed" in invitation) throw new Error(invitation.failed);

		expect(await run(eve.id, (m) => m.invitation({ invitationId: invitation.id }))).toEqual({
			failed: "ResourceHidden",
		});
		expect(await run(eve.id, (m) => m.accept({ invitationId: invitation.id }))).toEqual({
			failed: "ResourceHidden",
		});
	});

	it("on a server that requires verified emails, lets in only an address its account has proved, and tells that account to prove it", async () => {
		const verifying = membershipWith({ requireEmailVerification: true });
		const { ada, workspace } = await workspaceOfAda();
		const bob = await newMember("Bob", { verified: false });
		const eve = await newMember("Eve", { verified: false });
		const invitation = await run(ada.id, (m) =>
			m.invite({
				workspace: workspace.id,
				invitation: { email: bob.email, role: "editor" },
			}),
		);
		if ("failed" in invitation) throw new Error(invitation.failed);

		expect(
			await verifying.run(bob.id, (m) => m.invitation({ invitationId: invitation.id })),
		).toEqual({ failed: "EmailUnverified" });
		expect(await verifying.run(bob.id, (m) => m.accept({ invitationId: invitation.id }))).toEqual({
			failed: "EmailUnverified",
		});
		expect(await verifying.run(eve.id, (m) => m.accept({ invitationId: invitation.id }))).toEqual({
			failed: "ResourceHidden",
		});

		await onDatabase((db) =>
			db.update(member).set({ emailVerified: true }).where(eq(member.id, bob.id)),
		);
		expect(await verifying.run(bob.id, (m) => m.accept({ invitationId: invitation.id }))).toEqual({
			workspaceId: workspace.id,
		});
	});

	it("on a server that doesn't require verified emails, lets in the account an invitation is addressed to without proving it", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await newMember("Bob", { verified: false });
		const eve = await newMember("Eve", { verified: false });
		const invitation = await run(ada.id, (m) =>
			m.invite({
				workspace: workspace.id,
				invitation: { email: bob.email, role: "editor" },
			}),
		);
		if ("failed" in invitation) throw new Error(invitation.failed);

		expect(await run(bob.id, (m) => m.invitation({ invitationId: invitation.id }))).toMatchObject({
			status: "pending",
			role: "editor",
		});
		expect(await run(eve.id, (m) => m.accept({ invitationId: invitation.id }))).toEqual({
			failed: "ResourceHidden",
		});
		expect(await run(bob.id, (m) => m.accept({ invitationId: invitation.id }))).toEqual({
			workspaceId: workspace.id,
		});
	});

	it("refuses a second invitation to the same address unless it is a resend, and one to somebody already in the workspace", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await newMember("Bob");
		const first = await run(ada.id, (m) =>
			m.invite({
				workspace: workspace.id,
				invitation: { email: bob.email, role: "editor" },
			}),
		);
		if ("failed" in first) throw new Error(first.failed);

		expect(
			await run(ada.id, (m) =>
				m.invite({
					workspace: workspace.id,
					invitation: { email: bob.email, role: "editor" },
				}),
			),
		).toEqual({
			failed: "AlreadyInvited",
		});
		expect(
			await run(ada.id, (m) =>
				m.invite({
					workspace: workspace.id,
					invitation: { email: bob.email, role: "viewer", resend: true },
				}),
			),
		).toMatchObject({ id: first.id, role: "viewer" });
		expect(
			await run(ada.id, (m) =>
				m.invite({
					workspace: workspace.id,
					invitation: { email: ada.email, role: "editor" },
				}),
			),
		).toEqual({
			failed: "AlreadyInWorkspace",
		});
	});

	it("stops a cancelled invitation's link working", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await newMember("Bob");
		const invitation = await run(ada.id, (m) =>
			m.invite({
				workspace: workspace.id,
				invitation: { email: bob.email, role: "editor" },
			}),
		);
		if ("failed" in invitation) throw new Error(invitation.failed);

		await run(ada.id, (m) => m.cancelInvitation({ invitationId: invitation.id }));

		expect(await run(ada.id, (m) => m.invitations({ workspace: workspace.id }))).toEqual([]);
		expect(await run(bob.id, (m) => m.accept({ invitationId: invitation.id }))).toEqual({
			failed: "ResourceHidden",
		});
	});

	it("answers an invitation to another workspace as it answers one that does not exist", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const eve = await newMember("Eve");
		const invitation = await run(ada.id, (m) =>
			m.invite({ workspace: workspace.id, invitation: { email: eve.email, role: "editor" } }),
		);
		if ("failed" in invitation) throw new Error(invitation.failed);
		const cancelling = (invitationId: string) =>
			failure(eve.id, (m) => m.cancelInvitation({ invitationId }));

		const elsewhere = await cancelling(invitation.id);
		const nowhere = await cancelling(crypto.randomUUID());

		expect(elsewhere).toEqual(nowhere);
		expect(elsewhere).toMatchObject({ _tag: "ResourceHidden", resource: "invitation" });
		expect(await run(ada.id, (m) => m.invitations({ workspace: workspace.id }))).toHaveLength(1);
	});

	it("refuses to cancel an invitation for somebody who may not manage members", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await newMember("Bob");
		await join(workspace.id, ada.id, bob);
		const invitation = await run(ada.id, (m) =>
			m.invite({
				workspace: workspace.id,
				invitation: { email: "someone@example.com", role: "editor" },
			}),
		);
		if ("failed" in invitation) throw new Error(invitation.failed);

		expect(await run(bob.id, (m) => m.cancelInvitation({ invitationId: invitation.id }))).toEqual({
			failed: "ActionForbidden",
		});
		expect(await run(ada.id, (m) => m.invitations({ workspace: workspace.id }))).toHaveLength(1);
	});

	it("promotes and demotes, and lets a viewer read the roster and administer nobody", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await newMember("Bob");
		const kim = await newMember("Kim");
		const bobMembership = await join(workspace.id, ada.id, bob);
		await join(workspace.id, ada.id, kim, "viewer");

		await run(ada.id, (m) =>
			m.changeRole({
				workspace: workspace.id,
				membershipId: bobMembership.id,
				role: "admin",
			}),
		);
		expect(await run(ada.id, (m) => m.memberships({ workspace: workspace.id }))).toContainEqual(
			expect.objectContaining({ id: bobMembership.id, role: "admin" }),
		);
		await run(ada.id, (m) =>
			m.changeRole({
				workspace: workspace.id,
				membershipId: bobMembership.id,
				role: "editor",
			}),
		);

		expect(await run(kim.id, (m) => m.memberships({ workspace: workspace.id }))).toHaveLength(3);
		expect(
			await run(kim.id, (m) =>
				m.invite({
					workspace: workspace.id,
					invitation: { email: "nope@example.com", role: "editor" },
				}),
			),
		).toEqual({
			failed: "ActionForbidden",
		});
		expect(
			await run(kim.id, (m) =>
				m.remove({ workspace: workspace.id, membershipId: bobMembership.id }),
			),
		).toEqual({
			failed: "ActionForbidden",
		});
		expect(
			await run(kim.id, (m) =>
				m.changeRole({
					workspace: workspace.id,
					membershipId: bobMembership.id,
					role: "admin",
				}),
			),
		).toEqual({
			failed: "ActionForbidden",
		});
	});

	it("puts an administrator in every project members made, whether invited or promoted", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await newMember("Bob");
		const kim = await newMember("Kim");
		const shared = await onDatabase((db) =>
			seedProject(db, {
				workspaceId: workspace.id,
				name: "Launch",
				slug: `launch-${unique()}`,
			}),
		);
		if (!shared) throw new Error("The project was not created");
		const inShared = () =>
			onDatabase((db) =>
				db
					.select({ memberId: projectMember.memberId })
					.from(projectMember)
					.where(eq(projectMember.projectId, shared.id)),
			).then((rows) => rows.map((row) => row.memberId).toSorted());

		const bobMembership = await join(workspace.id, ada.id, bob);
		await join(workspace.id, ada.id, kim, "admin");
		expect(await inShared()).toEqual([ada.id, kim.id].toSorted());

		await run(ada.id, (m) =>
			m.changeRole({
				workspace: workspace.id,
				membershipId: bobMembership.id,
				role: "admin",
			}),
		);
		expect(await inShared()).toEqual([ada.id, bob.id, kim.id].toSorted());
	});

	/** The membership `memberId` holds in the workspace, as they see it on the roster. */
	async function membershipOf(workspaceId: string, memberId: string) {
		const memberships = await run(memberId, (m) => m.memberships({ workspace: workspaceId }));
		if ("failed" in memberships) throw new Error(memberships.failed);
		const own = memberships.find((one) => one.member.id === memberId);
		if (!own) throw new Error("They are not in the workspace");
		return own;
	}

	it("keeps the owner, whom nobody demotes or removes and who cannot leave", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await newMember("Bob");
		await join(workspace.id, ada.id, bob, "admin");
		const adaMembership = await membershipOf(workspace.id, ada.id);

		for (const actor of [ada.id, bob.id]) {
			expect(
				await run(actor, (m) =>
					m.remove({ workspace: workspace.id, membershipId: adaMembership.id }),
				),
			).toEqual({ failed: "ActionForbidden" });
			expect(
				await run(actor, (m) =>
					m.changeRole({ workspace: workspace.id, membershipId: adaMembership.id, role: "editor" }),
				),
			).toEqual({ failed: "ActionForbidden" });
		}
		expect(await run(ada.id, (m) => m.leave({ workspace: workspace.id }))).toEqual({
			failed: "OwnerStays",
		});
		expect(await membershipOf(workspace.id, ada.id)).toMatchObject({ role: "owner" });
	});

	it("leaves making, unmaking and removing administrators to the owner", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await newMember("Bob");
		const kim = await newMember("Kim");
		const lee = await newMember("Lee");
		await join(workspace.id, ada.id, bob, "admin");
		const kimMembership = await join(workspace.id, ada.id, kim, "admin");
		const leeMembership = await join(workspace.id, ada.id, lee);

		expect(
			await run(bob.id, (m) =>
				m.changeRole({ workspace: workspace.id, membershipId: leeMembership.id, role: "admin" }),
			),
		).toEqual({ failed: "ActionForbidden" });
		expect(
			await run(bob.id, (m) =>
				m.changeRole({ workspace: workspace.id, membershipId: kimMembership.id, role: "editor" }),
			),
		).toEqual({ failed: "ActionForbidden" });
		expect(
			await run(bob.id, (m) =>
				m.remove({ workspace: workspace.id, membershipId: kimMembership.id }),
			),
		).toEqual({ failed: "ActionForbidden" });
		expect(
			await run(bob.id, (m) =>
				m.invite({
					workspace: workspace.id,
					invitation: { email: `new-${unique()}@example.com`, role: "admin" },
				}),
			),
		).toEqual({ failed: "ActionForbidden" });

		// Everybody who is not an administrator is still an administrator's to manage.
		await run(bob.id, (m) =>
			m.changeRole({ workspace: workspace.id, membershipId: leeMembership.id, role: "viewer" }),
		);
		expect(await membershipOf(workspace.id, lee.id)).toMatchObject({ role: "viewer" });

		await run(ada.id, (m) =>
			m.changeRole({ workspace: workspace.id, membershipId: kimMembership.id, role: "editor" }),
		);
		expect(await membershipOf(workspace.id, kim.id)).toMatchObject({ role: "editor" });
		// An administrator may leave: the owner is still there to administer.
		expect(await run(bob.id, (m) => m.leave({ workspace: workspace.id }))).toEqual({
			cleanupPending: false,
		});
	});

	it("hands over ownership, putting the new owner in every project members made and making the old one an admin", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await newMember("Bob");
		const bobMembership = await join(workspace.id, ada.id, bob, "viewer");
		const shared = await onDatabase((db) =>
			seedProject(db, {
				workspaceId: workspace.id,
				name: "Launch",
				slug: `launch-${unique()}`,
			}),
		);
		if (!shared) throw new Error("The project was not created");

		expect(
			await run(ada.id, (m) =>
				m.handOverOwnership({ workspace: workspace.id, membershipId: bobMembership.id }),
			),
		).toBeUndefined();

		expect(await membershipOf(workspace.id, bob.id)).toMatchObject({ role: "owner" });
		expect(await membershipOf(workspace.id, ada.id)).toMatchObject({ role: "admin" });
		expect(
			await onDatabase((db) =>
				db
					.select({ memberId: projectMember.memberId })
					.from(projectMember)
					.where(eq(projectMember.projectId, shared.id)),
			).then((rows) => rows.map((row) => row.memberId).toSorted()),
		).toEqual([ada.id, bob.id].toSorted());
		// Ada holds nothing of the owner's now, and Bob can leave nothing behind.
		const adaMembership = await membershipOf(workspace.id, ada.id);
		expect(
			await run(ada.id, (m) =>
				m.handOverOwnership({ workspace: workspace.id, membershipId: adaMembership.id }),
			),
		).toEqual({ failed: "ActionForbidden" });
		expect(await run(bob.id, (m) => m.leave({ workspace: workspace.id }))).toEqual({
			failed: "OwnerStays",
		});
	});

	/**
	 * Holds the workspace's membership lock, as handing over ownership to
	 * `newOwnerId` in progress does, and hands it over once released.
	 */
	function holdHandingOverTo(workspaceId: string, newOwnerId: string) {
		return holdTransaction(
			query((db) =>
				db
					.select({ id: workspaceTable.id })
					.from(workspaceTable)
					.where(eq(workspaceTable.id, workspaceId))
					.for("no key update"),
			),
			query((db) =>
				Effect.gen(function* () {
					yield* db
						.update(membership)
						.set({ role: "admin" })
						.where(and(eq(membership.workspaceId, workspaceId), eq(membership.role, "owner")));
					yield* db
						.update(membership)
						.set({ role: "owner" })
						.where(
							and(eq(membership.workspaceId, workspaceId), eq(membership.memberId, newOwnerId)),
						);
				}),
			),
		);
	}

	it("refuses to hand over ownership for an owner who has already handed it on", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await newMember("Bob");
		const kim = await newMember("Kim");
		await join(workspace.id, ada.id, bob);
		const kimMembership = await join(workspace.id, ada.id, kim);
		const firstHandingOver = holdHandingOverTo(workspace.id, bob.id);
		await firstHandingOver.held;

		const secondHandingOver = run(ada.id, (m) =>
			m.handOverOwnership({ workspace: workspace.id, membershipId: kimMembership.id }),
		);
		await waitUntilWaitingOnLocks(1);
		await firstHandingOver.release();

		expect(await secondHandingOver).toEqual({ failed: "ActionForbidden" });
		expect(await membershipOf(workspace.id, bob.id)).toMatchObject({ role: "owner" });
		expect(await membershipOf(workspace.id, kim.id)).toMatchObject({ role: "editor" });
	});

	it("keeps a workspace whose owner hands it on while their deletion of it waits", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await newMember("Bob");
		await join(workspace.id, ada.id, bob);
		const transfer = holdHandingOverTo(workspace.id, bob.id);
		await transfer.held;

		const deleting = run(ada.id, (m) => m.delete({ workspace: workspace.id }));
		await waitUntilWaitingOnLocks(1);
		await transfer.release();

		expect(await deleting).toEqual({ failed: "ActionForbidden" });
		expect(await run(bob.id, (m) => m.workspaces)).toMatchObject([{ id: workspace.id }]);
	});

	it("lets only the owner delete a workspace, which takes it from everyone in it", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await newMember("Bob");
		await join(workspace.id, ada.id, bob, "admin");

		expect(await run(bob.id, (m) => m.delete({ workspace: workspace.id }))).toEqual({
			failed: "ActionForbidden",
		});
		expect(await run(ada.id, (m) => m.delete({ workspace: workspace.slug }))).toBeUndefined();

		expect(await run(ada.id, (m) => m.workspaces)).toEqual([]);
		expect(await run(bob.id, (m) => m.workspaces)).toEqual([]);
		expect(await run(ada.id, (m) => m.memberships({ workspace: workspace.id }))).toEqual({
			failed: "ResourceHidden",
		});
	});

	it("keeps a workspace while its computers' provider can't be reached to destroy them", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const provider = await runOnPostgres(
			Effect.flatMap(ComputerProviderStore.Service, (providers) =>
				providers.create(workspace.id, {
					createdById: ada.id,
					provider: {
						settings: { builtIn: "opensandbox", serverUrl: UNREACHABLE_URL, image: "debian" },
						enabled: true,
						apiKey: "key",
					},
				}),
			).pipe(Effect.provide(ComputerProviderStore.layer)),
		);
		const launch = await onDatabase((db) =>
			seedProject(db, { workspaceId: workspace.id, name: "Launch", slug: "launch" }),
		);
		if (!launch) throw new Error("The project was not created");
		await onDatabase((db) =>
			db.insert(computer).values({
				workspaceId: workspace.id,
				projectId: launch.id,
				computerProviderId: provider.id,
				providerComputerId: Computers.ComputerId("running"),
				image: "debian",
			}),
		);

		const withProvider = membershipWith({ egress: localComputerEgress });
		expect(await withProvider.run(ada.id, (m) => m.delete({ workspace: workspace.id }))).toEqual({
			failed: "ComputerUnavailable",
		});
		expect(
			await onDatabase((db) =>
				db.select({ id: computer.id }).from(computer).where(eq(computer.projectId, launch.id)),
			),
		).toHaveLength(1);
		expect(await run(ada.id, (m) => m.workspaces)).toMatchObject([{ id: workspace.id }]);
	});

	it("revokes membership and queues cleanup when the Personal Assistant’s first computer is recorded during removal", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await newMember("Bob");
		const bobMembership = await join(workspace.id, ada.id, bob);
		const provider = await runOnPostgres(
			Effect.flatMap(ComputerProviderStore.Service, (providers) =>
				providers.create(workspace.id, {
					createdById: ada.id,
					provider: {
						settings: { builtIn: "opensandbox", serverUrl: UNREACHABLE_URL, image: "debian" },
						enabled: true,
						apiKey: "key",
					},
				}),
			).pipe(Effect.provide(ComputerProviderStore.layer)),
		);
		const [assistantProject] = await onDatabase((db) =>
			db
				.select({ id: project.id })
				.from(project)
				.innerJoin(bot, eq(bot.id, project.defaultOfBotId))
				.where(and(eq(bot.workspaceId, workspace.id), eq(bot.assistantOf, bob.id))),
		);
		if (!assistantProject) throw new Error("Bob has no Personal Assistant");
		const recording = await recordingFirstComputer({
			workspaceId: workspace.id,
			projectId: assistantProject.id,
			computerProviderId: provider.id,
		});

		const removing = run(ada.id, (m) =>
			m.remove({ workspace: workspace.id, membershipId: bobMembership.id }),
		);
		await waitUntilWaitingOnLocks(1);
		await recording.release();

		expect(await removing).toEqual({ cleanupPending: true });
		expect(
			await onDatabase((db) =>
				db
					.select({ id: computer.id })
					.from(computer)
					.where(eq(computer.projectId, assistantProject.id)),
			),
		).toHaveLength(1);
	});

	it("lets a workspace have only one owner", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await newMember("Bob");
		const bobMembership = await join(workspace.id, ada.id, bob);

		await expect(
			onDatabase((db) =>
				db.update(membership).set({ role: "owner" }).where(eq(membership.id, bobMembership.id)),
			),
		).rejects.toThrow();
	});

	it("hides a workspace from somebody outside it", async () => {
		const { workspace } = await workspaceOfAda();
		const eve = await newMember("Eve");

		expect(await run(eve.id, (m) => m.memberships({ workspace: workspace.id }))).toEqual({
			failed: "ResourceHidden",
		});
	});

	it("takes a removed member out of their projects, does not put them back when they rejoin, and gives them one Personal Assistant", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await newMember("Bob");
		const bobMembership = await join(workspace.id, ada.id, bob);
		const shared = await onDatabase((db) =>
			seedProject(db, {
				workspaceId: workspace.id,
				name: "Private",
				slug: `private-${unique()}`,
			}),
		);
		if (!shared) throw new Error("The project was not created");
		await onDatabase((db) =>
			db
				.insert(projectMember)
				.values({ workspaceId: workspace.id, projectId: shared.id, memberId: bob.id }),
		);

		await run(ada.id, (m) => m.remove({ workspace: workspace.id, membershipId: bobMembership.id }));
		await join(workspace.id, ada.id, bob);

		expect(
			await onDatabase((db) =>
				db
					.select()
					.from(projectMember)
					.where(and(eq(projectMember.projectId, shared.id), eq(projectMember.memberId, bob.id))),
			),
		).toEqual([]);
		expect(
			await onDatabase((db) =>
				db
					.select({ id: bot.id })
					.from(bot)
					.where(and(eq(bot.workspaceId, workspace.id), eq(bot.assistantOf, bob.id))),
			),
		).toHaveLength(1);
	});

	it("lets the workspace's projects be made while a membership's removal waits", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await newMember("Bob");
		const bobMembership = await join(workspace.id, ada.id, bob);
		const [lead] = await onDatabase((db) =>
			db
				.insert(bot)
				.values({
					workspaceId: workspace.id,
					name: "Lead",
					handle: "lead",
					color: "sky",
					eyes: "pill",
				})
				.returning(),
		);
		if (!lead) throw new Error("The bot was not created");
		// Holds Bob's membership, so his removal waits there with the workspace locked,
		// before recording the departure.
		const hold = holdTransaction(
			query((db) =>
				db
					.select({ id: membership.id })
					.from(membership)
					.where(eq(membership.id, bobMembership.id))
					.for("update"),
			),
		);
		await hold.held;
		const removed = run(ada.id, (m) =>
			m.remove({ workspace: workspace.id, membershipId: bobMembership.id }),
		);
		await waitUntilWaitingOnLocks(1);

		const made = onDatabase((db) =>
			seedProject(db, {
				workspaceId: workspace.id,
				name: "Launch",
				slug: `launch-${unique()}`,
				leadBotId: lead.id,
			}),
		);
		expect(
			await Promise.race([
				made.then(() => "made"),
				waitUntilWaitingOnLocks(2).then(
					() => "held up",
					() => "never held up",
				),
			]),
		).toBe("made");

		await hold.release();
		await removed;
		expect(
			await onDatabase((db) =>
				db.select().from(membership).where(eq(membership.id, bobMembership.id)),
			),
		).toEqual([]);
	});

	it("lets somebody who created a project leave, and keeps the project", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await newMember("Bob");
		await join(workspace.id, ada.id, bob);
		const shared = await onDatabase((db) =>
			seedProject(db, {
				workspaceId: workspace.id,
				name: "Launch",
				slug: `launch-${unique()}`,
				createdById: bob.id,
			}),
		);
		if (!shared) throw new Error("The project was not created");

		expect(await run(bob.id, (m) => m.leave({ workspace: workspace.id }))).toEqual({
			cleanupPending: false,
		});
		expect(
			await onDatabase((db) => db.select().from(project).where(eq(project.id, shared.id))),
		).toHaveLength(1);
	});

	it("matches an invitation to an address whatever its case", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await newMember("Bob");
		const sent = await run(ada.id, (m) =>
			m.invite({
				workspace: workspace.id,
				invitation: { email: bob.email.toUpperCase(), role: "editor" },
			}),
		);
		if ("failed" in sent) throw new Error(sent.failed);

		expect(
			await onDatabase((db) =>
				db.select({ email: invitation.email }).from(invitation).where(eq(invitation.id, sent.id)),
			),
		).toEqual([{ email: bob.email }]);
		expect(await run(bob.id, (m) => m.accept({ invitationId: sent.id }))).toEqual({
			workspaceId: workspace.id,
		});
	});

	it("says what a member may do in the workspace, and hides it from anybody else", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await newMember("Bob");
		const eve = await newMember("Eve");
		await join(workspace.id, ada.id, bob, "viewer");

		expect(await run(ada.id, (m) => m.access({ workspace: workspace.slug }))).toMatchObject({
			role: "owner",
			permissions: {
				manageMembers: true,
				createProjects: true,
				manageAdmins: true,
				handOverOwnership: true,
			},
		});
		expect(await run(bob.id, (m) => m.access({ workspace: workspace.id }))).toMatchObject({
			role: "viewer",
			permissions: {
				manageMembers: false,
				createProjects: false,
				manageAdmins: false,
				handOverOwnership: false,
			},
		});
		expect(await run(eve.id, (m) => m.access({ workspace: workspace.id }))).toEqual({
			failed: "ResourceHidden",
		});
	});

	describe("what signs in as a member who goes", () => {
		let connectors: Awaited<ReturnType<typeof servedConnectors>>;
		let modelProviders: Awaited<ReturnType<typeof servedModelProviders>>;

		const servedConnectors = () => servedOnPostgres(ConnectorStore.Service, ConnectorStore.layer);
		const servedModelProviders = () =>
			servedOnPostgres(ModelProviderStore.Service, ModelProviderStore.layer);

		beforeAll(async () => {
			connectors = await servedConnectors();
			modelProviders = await servedModelProviders();
		});

		/** A subscription sign-in's tokens. */
		const SUBSCRIPTION = { access: "access", refresh: "refresh", expiresAt: 0, accountId: null };

		/** Ada's workspace, with Bob and Cy as admins, and a project they are in. */
		async function workspaceWithAdmins() {
			const { ada, workspace } = await workspaceOfAda();
			const bob = await newMember("Bob");
			const cy = await newMember("Cy");
			const bobMembership = await join(workspace.id, ada.id, bob, "admin");
			await join(workspace.id, ada.id, cy, "admin");
			const builders = await newProject(workspace.id, "Builders");
			return { ada, bob, cy, bobMembership, workspaceId: workspace.id, projectId: builders };
		}

		async function newProject(workspaceId: string, name: string) {
			const made = await onDatabase((db) =>
				seedProject(db, { workspaceId, name, slug: `${name.toLowerCase()}-${unique()}` }),
			);
			if (!made) throw new Error("The project was not created");
			return made.id;
		}

		const shownConnectors = (workspaceId: string, projectId: string) =>
			runOnPostgres(
				Effect.flatMap(Secrets.Service, (cipher) => connectorsIn(workspaceId, projectId, cipher)),
			);

		/**
		 * Membership whose requests out reach only `gitHub`, and the operations
		 * a project's GitHub app is made and installed through.
		 */
		async function reachingOnly(gitHub: typeof fetch) {
			const gitHubApps = await gitHubSetupAt(gitHub, "https://sugabots.example.com");
			return { ...membershipWith({ egress: egressToGitHub(gitHub) }), gitHubApps };
		}

		/** The ways a member goes from a workspace: the owner removes them, or they leave. */
		const departures: ReadonlyArray<readonly [string, (departing: Departing) => Departure]> = [
			[
				"is removed",
				(departing) => ({
					actorId: departing.ownerId,
					operation: (m) =>
						m.remove({ workspace: departing.workspaceId, membershipId: departing.membershipId }),
				}),
			],
			[
				"leaves",
				(departing) => ({
					actorId: departing.memberId,
					operation: (m) => m.leave({ workspace: departing.workspaceId }),
				}),
			],
		];

		/** The owner removing Bob from the workspace `workspaceWithAdmins` made. */
		const removingBob = (fixture: Awaited<ReturnType<typeof workspaceWithAdmins>>) =>
			run(fixture.ada.id, (m) =>
				m.remove({ workspace: fixture.workspaceId, membershipId: fixture.bobMembership.id }),
			);

		/** Bob going from the workspace `workspaceWithAdmins` made. */
		const bobGoing = ({
			ada,
			bob,
			bobMembership,
			workspaceId,
		}: Awaited<ReturnType<typeof workspaceWithAdmins>>): Departing => ({
			workspaceId,
			ownerId: ada.id,
			memberId: bob.id,
			membershipId: bobMembership.id,
		});

		it.each(departures)(
			"stops a personal bot’s due routine when its creator %s",
			async (_, depart) => {
				const departing = bobGoing(await workspaceWithAdmins());
				const personal = await seedBot(departing.workspaceId, {
					createdById: departing.memberId,
					visibility: "personal",
				});
				const publicBot = await seedBot(departing.workspaceId, { createdById: departing.memberId });
				const own = await seedAutomation(departing.workspaceId, personal.defaultProject);
				const shared = await seedAutomation(departing.workspaceId, publicBot.defaultProject);
				const pending = await seedAutomation(departing.workspaceId, personal.defaultProject);
				const ownRoutine = await seedRoutine(own, departing.workspaceId, -60);
				const sharedRoutine = await seedRoutine(shared, departing.workspaceId, -30);
				await onDatabase((db) =>
					db
						.update(automation)
						.set({ pauseAfterFailuresPendingAt: new Date() })
						.where(eq(automation.id, pending)),
				);
				const auth = await runOnPostgres(
					Effect.provide(SystemWorkAuthentication.Service, SystemWorkAuthentication.layer),
				);
				const alreadyDue = await runOnPostgres(auth.dueRoutine(ownRoutine));
				const { actorId, operation } = depart(departing);

				expect(await run(actorId, operation)).toEqual({ cleanupPending: false });

				const [paused] = await onDatabase((db) =>
					db.select().from(automation).where(eq(automation.id, own)),
				);
				expect(paused?.state).toBe("paused");
				const [routine] = await onDatabase((db) =>
					db.select().from(automationTrigger).where(eq(automationTrigger.id, ownRoutine)),
				);
				expect(routine?.nextScheduledAt).toBeNull();
				const [pausedFromPending] = await onDatabase((db) =>
					db.select().from(automation).where(eq(automation.id, pending)),
				);
				expect(pausedFromPending).toMatchObject({
					state: "paused",
					pauseAfterFailuresPendingAt: null,
					pausedAfterFailuresAt: null,
				});
				await expect(runOnPostgres(auth.dueRoutine(ownRoutine))).rejects.toMatchObject({
					_tag: "StoredWorkGone",
				});
				const call = await servedOperations();
				expect(
					await call(alreadyDue, "automations.runDueRoutine", { triggerId: ownRoutine }),
				).toBeUndefined();

				const sharedWork = await runOnPostgres(auth.dueRoutine(sharedRoutine));
				expect(
					await call(sharedWork, "automations.runDueRoutine", { triggerId: sharedRoutine }),
				).toMatchObject({
					runId: expect.any(String),
				});
				const started = await onDatabase((db) =>
					db
						.select({ automationId: automationRun.automationId })
						.from(automationRun)
						.where(eq(automationRun.workspaceId, departing.workspaceId)),
				);
				expect(started).toEqual([{ automationId: shared }]);
			},
		);

		const shownProviders = async (workspaceId: string) => {
			const providers = await runOnPostgres(providersIn(workspaceId));
			return (builtIn: string) => providers.find((one) => one.builtIn === builtIn);
		};

		const seededProviderId = async (workspaceId: string, builtIn: string) => {
			const found = (await shownProviders(workspaceId))(builtIn);
			if (!found) throw new Error(`No ${builtIn} provider`);
			return found.id;
		};

		const stillIn = async (workspaceId: string, memberId: string) => {
			const found = await onDatabase((db) =>
				db
					.select({ id: membership.id })
					.from(membership)
					.where(and(eq(membership.workspaceId, workspaceId), eq(membership.memberId, memberId))),
			);
			return found.length > 0;
		};

		/**
		 * Holds the workspace's membership lock with `memberId`'s membership
		 * deleted, as their removal in progress does, and commits once released.
		 */
		function holdRemovingUnderLock(workspaceId: string, memberId: string) {
			return holdTransaction(
				Effect.andThen(
					query((db) =>
						db
							.select({ id: workspaceTable.id })
							.from(workspaceTable)
							.where(eq(workspaceTable.id, workspaceId))
							.for("no key update"),
					),
					query((db) =>
						db
							.delete(membership)
							.where(
								and(eq(membership.workspaceId, workspaceId), eq(membership.memberId, memberId)),
							),
					),
				),
			);
		}

		it.each(departures)(
			"refuses while model providers sign in with the subscription of a member who %s, naming each, and changes nothing",
			async (_, depart) => {
				const fixture = await workspaceWithAdmins();
				const { bob, cy, workspaceId, projectId } = fixture;
				const chatgpt = await seededProviderId(workspaceId, "chatgpt");
				await modelProviders.saveOAuthTokens(workspaceId, chatgpt, {
					tokens: SUBSCRIPTION,
					signedInById: bob.id,
				});
				const supergrok = await modelProviders.create(workspaceId, {
					createdById: cy.id,
					provider: { builtIn: "supergrok" },
				});
				await modelProviders.saveOAuthTokens(workspaceId, supergrok.id, {
					tokens: SUBSCRIPTION,
					signedInById: bob.id,
				});
				const linear = await connectors.create(workspaceId, projectId, bob.id, {
					name: "Linear",
					url: "https://mcp.linear.app/mcp",
					auth: "oauth",
				});
				await connectors.saveOauthRecord(
					workspaceId,
					linear.id,
					{ tokens: { access_token: "bob's", token_type: "Bearer" } },
					{ kind: "signIn", signedInById: bob.id, version: null },
				);

				const { actorId, operation } = depart(bobGoing(fixture));
				const refused = await failure(actorId, operation);

				expect(refused).toMatchObject({
					_tag: "SubscriptionInUse",
					userMessage:
						"ChatGPT and SuperGrok sign in with Bob's subscription, so Bob stays until another member signs them in or they're switched to a key.",
				});
				expect(await stillIn(workspaceId, bob.id)).toBe(true);
				const shown = await shownProviders(workspaceId);
				expect(shown("chatgpt")).toMatchObject({ signedIn: true, signedInAs: { id: bob.id } });
				expect(shown("supergrok")).toMatchObject({ signedIn: true, signedInAs: { id: bob.id } });
				expect(await shownConnectors(workspaceId, projectId)).toMatchObject([
					{ name: "Linear", signedIn: true, signedInAs: { id: bob.id } },
				]);
			},
		);

		const waysOut = [
			[
				"another member signs it in",
				(workspaceId: string, providerId: string, by: { id: string }) =>
					modelProviders.saveOAuthTokens(workspaceId, providerId, {
						tokens: SUBSCRIPTION,
						signedInById: by.id,
					}),
			],
			[
				"it is given a key",
				(workspaceId: string, providerId: string, by: { id: string }) =>
					modelProviders.update(workspaceId, providerId, { apiKey: "xai-key" }, by.id),
			],
			[
				"it is signed out",
				(workspaceId: string, providerId: string) =>
					modelProviders.saveOAuthTokens(workspaceId, providerId, null),
			],
			[
				"it is deleted",
				(workspaceId: string, providerId: string) => modelProviders.remove(workspaceId, providerId),
			],
		] as const;

		it.each(waysOut)(
			"lets a member go once the provider signed in with their subscription no longer is: %s",
			async (_, wayOut) => {
				const fixture = await workspaceWithAdmins();
				const { bob, cy, workspaceId } = fixture;
				const supergrok = await modelProviders.create(workspaceId, {
					createdById: bob.id,
					provider: { builtIn: "supergrok" },
				});
				await modelProviders.saveOAuthTokens(workspaceId, supergrok.id, {
					tokens: SUBSCRIPTION,
					signedInById: bob.id,
				});
				expect(await removingBob(fixture)).toEqual({ failed: "SubscriptionInUse" });

				await wayOut(workspaceId, supergrok.id, cy);

				expect(await removingBob(fixture)).toEqual({ cleanupPending: false });
				expect(await stillIn(workspaceId, bob.id)).toBe(false);
			},
		);

		it("takes a subscription sign-in away once the provider is given a key, which it then runs on", async () => {
			const { bob, workspaceId } = await workspaceWithAdmins();
			const supergrok = await modelProviders.create(workspaceId, {
				createdById: bob.id,
				provider: { builtIn: "supergrok" },
			});
			await modelProviders.saveOAuthTokens(workspaceId, supergrok.id, {
				tokens: SUBSCRIPTION,
				signedInById: bob.id,
			});

			await modelProviders.update(workspaceId, supergrok.id, { apiKey: "xai-key" }, bob.id);

			expect((await shownProviders(workspaceId))("supergrok")).toMatchObject({
				signedIn: false,
				signedInAs: null,
				hasApiKey: true,
				status: "untested",
			});
			expect(await modelProviders.access(workspaceId, supergrok.id)).toMatchObject({
				apiKey: "xai-key",
				oauthTokens: undefined,
			});
		});

		it("refuses a subscription sign-in that finishes as its member is removed", async () => {
			const fixture = await workspaceWithAdmins();
			const { bob, workspaceId } = fixture;
			const chatgpt = await seededProviderId(workspaceId, "chatgpt");
			const removal = holdRemovingUnderLock(workspaceId, bob.id);
			await removal.held;

			const signingIn = modelProviders.saveOAuthTokens(workspaceId, chatgpt, {
				tokens: SUBSCRIPTION,
				signedInById: bob.id,
			});
			await waitUntilWaitingOnLocks(1);
			await removal.release();

			expect(await signingIn).toBe(false);
			expect((await shownProviders(workspaceId))("chatgpt")).toMatchObject({
				signedIn: false,
				signedInAs: null,
			});
		});

		it("refuses to remove a member whose subscription sign-in lands while the removal waits", async () => {
			const fixture = await workspaceWithAdmins();
			const { bob, workspaceId } = fixture;
			const chatgpt = await seededProviderId(workspaceId, "chatgpt");
			const signIn = holdTransaction(
				Effect.flatMap(ModelProviderStore.Service, (store) =>
					store.saveOAuthTokens(workspaceId, chatgpt, {
						tokens: SUBSCRIPTION,
						signedInById: bob.id,
					}),
				).pipe(Effect.provide(ModelProviderStore.layer)),
			);
			expect(await signIn.held).toBe(true);

			const removing = removingBob(fixture);
			await waitUntilWaitingOnLocks(1);
			await signIn.release();

			expect(await removing).toEqual({ failed: "SubscriptionInUse" });
			expect(await stillIn(workspaceId, bob.id)).toBe(true);
		});

		it.each(departures)(
			"signs out the connectors a member who %s signed in, and keeps others' sign-ins, every key and every model provider",
			async (_, depart) => {
				const fixture = await workspaceWithAdmins();
				const { bob, cy, workspaceId, projectId } = fixture;
				// Who signs a connector in, not who added it, is who it signs in as.
				const linear = await connectors.create(workspaceId, projectId, cy.id, {
					name: "Linear",
					url: "https://mcp.linear.app/mcp",
					auth: "oauth",
				});
				await connectors.saveOauthRecord(
					workspaceId,
					linear.id,
					{ tokens: { access_token: "bob's", token_type: "Bearer" } },
					{ kind: "signIn", signedInById: bob.id, version: null },
				);
				// A sign-in replaced by another's is the other's.
				const notion = await connectors.create(workspaceId, projectId, bob.id, {
					name: "Notion",
					url: "https://mcp.notion.com/mcp",
					auth: "oauth",
				});
				for (const signer of [bob, cy]) {
					await connectors.saveOauthRecord(
						workspaceId,
						notion.id,
						{ tokens: { access_token: `${signer.name}'s`, token_type: "Bearer" } },
						{
							kind: "signIn",
							signedInById: signer.id,
							version: (await connectors.readOauthRecord(workspaceId, notion.id))?.version ?? null,
						},
					);
				}
				await connectors.create(workspaceId, projectId, bob.id, {
					name: "Sentry",
					url: "https://mcp.sentry.dev/mcp",
					secretHeader: "Authorization",
					secret: "Bearer bob's key",
				});
				const chatgpt = await seededProviderId(workspaceId, "chatgpt");
				for (const signer of [bob, cy]) {
					await modelProviders.saveOAuthTokens(workspaceId, chatgpt, {
						tokens: SUBSCRIPTION,
						signedInById: signer.id,
					});
				}
				const anthropic = await seededProviderId(workspaceId, "anthropic");
				await modelProviders.update(workspaceId, anthropic, { apiKey: "sk-ant-bob" }, bob.id);
				const signedInAs = (connectors: ReadonlyArray<Connector>) =>
					connectors.map(({ name, signedIn, hasSecret, signedInAs }) => ({
						name,
						signedIn,
						hasSecret,
						signedInAs: signedInAs?.name ?? null,
					}));
				expect(signedInAs(await shownConnectors(workspaceId, projectId))).toEqual([
					{ name: "Linear", signedIn: true, hasSecret: false, signedInAs: "Bob" },
					{ name: "Notion", signedIn: true, hasSecret: false, signedInAs: "Cy" },
					{ name: "Sentry", signedIn: true, hasSecret: true, signedInAs: null },
				]);

				const { actorId, operation } = depart(bobGoing(fixture));
				expect(await run(actorId, operation)).toEqual({ cleanupPending: false });

				expect(signedInAs(await shownConnectors(workspaceId, projectId))).toEqual([
					{ name: "Linear", signedIn: false, hasSecret: false, signedInAs: null },
					{ name: "Notion", signedIn: true, hasSecret: false, signedInAs: "Cy" },
					{ name: "Sentry", signedIn: true, hasSecret: true, signedInAs: null },
				]);
				const shown = await shownProviders(workspaceId);
				expect(shown("chatgpt")).toMatchObject({ signedIn: true, signedInAs: { name: "Cy" } });
				expect(shown("anthropic")).toMatchObject({ hasApiKey: true, signedInAs: null });
			},
		);

		it("queues uninstall of a removed member’s personal GitHub app and keeps organization installations", async () => {
			const { ada, bob, bobMembership, workspaceId, projectId } = await workspaceWithAdmins();
			const research = await newProject(workspaceId, "Research");
			const gitHub = standInGitHub();
			const { run: runReaching, gitHubApps } = await reachingOnly(gitHub.fetch);
			await installedConnector(gitHubApps, { projectId, adminId: bob.id }, USER_INSTALLATION_ID);
			await installedConnector(gitHubApps, { projectId: research, adminId: bob.id });
			// An app on a member's own account signs in as them; one on an organization as nobody.
			expect(await shownConnectors(workspaceId, projectId)).toMatchObject([
				{ kind: "github", signedInAs: { id: bob.id } },
			]);
			expect(await shownConnectors(workspaceId, research)).toMatchObject([
				{ kind: "github", signedInAs: null },
			]);

			expect(
				await runReaching(ada.id, (m) =>
					m.remove({ workspace: workspaceId, membershipId: bobMembership.id }),
				),
			).toEqual({ cleanupPending: false });

			const queued = await onDatabase((db) =>
				db.select().from(gitHubUninstall).where(eq(gitHubUninstall.workspaceId, workspaceId)),
			);
			expect(queued).toMatchObject([{ installationId: USER_INSTALLATION_ID, attempts: 0 }]);
			expect(gitHub.asked.some(({ method }) => method === "DELETE")).toBe(false);
			expect(await shownConnectors(workspaceId, projectId)).toMatchObject([
				{ kind: "github", signedIn: false, url: "https://github.com/apps/acme-sugabots" },
			]);
			expect(await shownConnectors(workspaceId, research)).toMatchObject([
				{ kind: "github", signedIn: true, url: "https://github.com/acme" },
			]);
		});
	});
});

/** A member going from a workspace, which the owner removes them from or they leave. */
interface Departing {
	workspaceId: string;
	ownerId: string;
	memberId: string;
	membershipId: string;
}

/** Who asks for a member to go, and what they ask for. */
interface Departure {
	actorId: string;
	operation: (membership: MembershipAs) => Promise<OutputOf<"workspaces.leave">>;
}

/** The workspace operations for one member signed in, by the names these cases use. */
interface MembershipAs {
	readonly workspaces: Promise<OutputOf<"workspaces.list">>;
	create(input: { details: InputOf<"workspaces.create"> }): Promise<OutputOf<"workspaces.create">>;
	update(input: {
		workspace: string;
		details: Omit<InputOf<"workspaces.update">, "workspace">;
	}): Promise<OutputOf<"workspaces.update">>;
	delete(input: InputOf<"workspaces.delete">): Promise<void>;
	access(input: InputOf<"system.workspaceAccess">): Promise<OutputOf<"system.workspaceAccess">>;
	memberships(
		input: InputOf<"workspaces.memberships">,
	): Promise<OutputOf<"workspaces.memberships">>;
	changeRole(input: InputOf<"workspaces.changeRole">): Promise<void>;
	remove(
		input: InputOf<"workspaces.removeMembership">,
	): Promise<OutputOf<"workspaces.removeMembership">>;
	leave(input: InputOf<"workspaces.leave">): Promise<OutputOf<"workspaces.leave">>;
	handOverOwnership(input: InputOf<"workspaces.handOverOwnership">): Promise<void>;
	invitations(
		input: InputOf<"workspaces.invitations">,
	): Promise<OutputOf<"workspaces.invitations">>;
	invite(input: {
		workspace: string;
		invitation: Omit<InputOf<"workspaces.invite">, "workspace">;
	}): Promise<OutputOf<"workspaces.invite">>;
	cancelInvitation(input: InputOf<"workspaces.cancelInvitation">): Promise<void>;
	invitation(input: InputOf<"workspaces.invitation">): Promise<OutputOf<"workspaces.invitation">>;
	accept(
		input: InputOf<"workspaces.acceptInvitation">,
	): Promise<OutputOf<"workspaces.acceptInvitation">>;
}

/** An operation's error, which it rejects with; anything else is a defect, rethrown. */
function refusalOf(failure: unknown): { readonly _tag: string } & Record<string, unknown> {
	if (
		typeof failure === "object" &&
		failure !== null &&
		"userMessage" in failure &&
		"_tag" in failure
	) {
		return failure as { readonly _tag: string } & Record<string, unknown>;
	}
	throw failure;
}
