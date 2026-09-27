import { and, eq, isNotNull } from "drizzle-orm";
import { ConfigProvider, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { Accounts } from "../../accounts/accounts.ts";
import { layer as databaseLayer } from "../../database/database.ts";
import {
	agent,
	pod,
	podMember,
	searchProvider,
	user,
	workspaceInvite,
} from "../../database/schema.ts";
import { closeDatabase, onDatabase } from "../../database/testing.ts";
import { Email } from "../../email/email.ts";
import { Installation } from "../../installation/installation.ts";
import { Membership } from "./membership.ts";

const WEB_APP_URL = "http://localhost:5173";

/**
 * The real service over a migrated database, with the emails it sends kept in
 * `sent`. Needs `DATABASE_URL`, and makes a fresh workspace per case so it can
 * run against a database with the dev seed in it.
 */
describe.skipIf(!process.env.DATABASE_URL)("Membership, against Postgres", () => {
	const sent: Email.Message[] = [];
	const runtimes: Array<ManagedRuntime.ManagedRuntime<Membership.Service, unknown>> = [];

	function membershipWith(requireEmailVerification: boolean) {
		const runtime = ManagedRuntime.make(
			Membership.layerNoDeps.pipe(
				Layer.provide([
					databaseLayer,
					Installation.layer,
					Layer.succeed(
						Accounts.Service,
						Accounts.Service.of({ admit: () => Effect.void, requireEmailVerification }),
					),
					Layer.succeed(
						Email.Service,
						Email.Service.of({
							send: (message) =>
								Effect.sync(() => {
									sent.push(message);
								}),
						}),
					),
				]),
				Layer.provide(
					ConfigProvider.layer(
						ConfigProvider.fromEnv({
							env: { DATABASE_URL: process.env.DATABASE_URL ?? "", WEB_APP_URL },
						}),
					),
				),
			),
		);
		runtimes.push(runtime);
		return {
			/** The operation's value, or the tag it failed with. */
			run: <A, E extends { _tag: string }>(
				operation: (membership: Membership.Interface) => Effect.Effect<A, E>,
			) =>
				runtime.runPromiseExit(Effect.flatMap(Membership.Service, operation)).then((exit) => {
					if (Exit.isSuccess(exit)) return exit.value;
					const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
					if (!failure) throw new Error(`Unexpected defect: ${String(exit.cause)}`);
					return { failed: (failure.error as E)._tag };
				}),
		};
	}

	const membership = membershipWith(false);
	const run = membership.run;

	afterAll(async () => {
		await Promise.all(runtimes.map((runtime) => runtime.dispose()));
		await closeDatabase();
	});

	const unique = () => crypto.randomUUID().slice(0, 8);

	async function person(name: string, options?: { verified?: boolean }) {
		const [row] = await onDatabase((db) =>
			db
				.insert(user)
				.values({
					name,
					email: `${name.toLowerCase()}-${unique()}@example.com`,
					emailVerified: options?.verified ?? true,
				})
				.returning(),
		);
		if (!row) throw new Error("The person was not created");
		return row;
	}

	/** A workspace Ada administers. */
	async function workspaceOfAda() {
		const ada = await person("Ada");
		const created = await run((m) =>
			m.create({ userId: ada.id, details: { name: "Nitric", slug: `nitric-${unique()}` } }),
		);
		if ("failed" in created) throw new Error(created.failed);
		return { ada, workspace: created };
	}

	async function join(
		workspaceId: string,
		inviterId: string,
		invitee: { id: string; email: string },
		role: "admin" | "member" | "viewer" = "member",
	) {
		const invitation = await run((m) =>
			m.invite({
				userId: inviterId,
				workspace: workspaceId,
				invitation: { email: invitee.email, role },
			}),
		);
		if ("failed" in invitation) throw new Error(invitation.failed);
		await run((m) => m.accept({ userId: invitee.id, invitationId: invitation.id }));
		const members = await run((m) => m.members({ userId: inviterId, workspace: workspaceId }));
		if ("failed" in members) throw new Error(members.failed);
		const member = members.find((one) => one.user.id === invitee.id);
		if (!member) throw new Error("The invitee did not join");
		return member;
	}

	it("makes the creator its administrator, and provisions the workspace and their Personal pod", async () => {
		const { ada, workspace } = await workspaceOfAda();

		expect(await run((m) => m.members({ userId: ada.id, workspace: workspace.id }))).toEqual([
			expect.objectContaining({ role: "admin", user: expect.objectContaining({ id: ada.id }) }),
		]);
		expect(
			await onDatabase((db) =>
				db
					.select({ preset: searchProvider.preset, enabled: searchProvider.enabled })
					.from(searchProvider)
					.where(eq(searchProvider.workspaceId, workspace.id)),
			),
		).toEqual([{ preset: "exa", enabled: true }]);
		expect(
			await onDatabase((db) =>
				db
					.select({ id: agent.id })
					.from(agent)
					.where(and(eq(agent.workspaceId, workspace.id), isNotNull(agent.systemAgentKey))),
			),
		).not.toEqual([]);
		expect(
			await onDatabase((db) =>
				db
					.select({ ownerId: pod.ownerId })
					.from(pod)
					.where(and(eq(pod.workspaceId, workspace.id), eq(pod.kind, "personal"))),
			),
		).toEqual([{ ownerId: ada.id }]);
		expect(await run((m) => m.workspaces({ userId: ada.id }))).toEqual([workspace]);
	});

	it("refuses a slug shaped like a UUID, or one another workspace has", async () => {
		const { ada, workspace } = await workspaceOfAda();

		expect(
			await run((m) =>
				m.create({ userId: ada.id, details: { name: "Nitric", slug: crypto.randomUUID() } }),
			),
		).toEqual({
			failed: "SlugShapedLikeUuid",
		});
		expect(
			await run((m) =>
				m.update({
					userId: ada.id,
					workspace: workspace.id,
					details: { name: "Nitric", slug: crypto.randomUUID() },
				}),
			),
		).toEqual({ failed: "SlugShapedLikeUuid" });
		expect(
			await run((m) =>
				m.create({ userId: ada.id, details: { name: "Again", slug: workspace.slug } }),
			),
		).toEqual({
			failed: "SlugTaken",
		});
	});

	it("emails an invitation whose id is a random UUID, and lets the invitee in", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await person("Bob");

		const invitation = await run((m) =>
			m.invite({
				userId: ada.id,
				workspace: workspace.id,
				invitation: { email: bob.email, role: "member" },
			}),
		);
		if ("failed" in invitation) throw new Error(invitation.failed);

		expect(invitation.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
		expect(sent.at(-1)).toMatchObject({
			to: [{ email: bob.email }],
			replyTo: { email: ada.email, name: "Ada" },
		});
		expect(sent.at(-1)?.text).toContain(`${WEB_APP_URL}/invite/${invitation.id}`);
		expect(await run((m) => m.invitation({ userId: bob.id, invitationId: invitation.id }))).toEqual(
			{
				workspaceName: "Nitric",
				inviterName: "Ada",
			},
		);
		expect(await run((m) => m.accept({ userId: bob.id, invitationId: invitation.id }))).toEqual({
			workspaceId: workspace.id,
		});
		expect(await run((m) => m.members({ userId: bob.id, workspace: workspace.id }))).toHaveLength(
			2,
		);
		expect(
			await onDatabase((db) =>
				db
					.select({ id: pod.id })
					.from(pod)
					.where(and(eq(pod.workspaceId, workspace.id), eq(pod.ownerId, bob.id))),
			),
		).toHaveLength(1);
	});

	it("refuses an invitation to anybody but the address it was sent to", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await person("Bob");
		const eve = await person("Eve");
		const invitation = await run((m) =>
			m.invite({
				userId: ada.id,
				workspace: workspace.id,
				invitation: { email: bob.email, role: "member" },
			}),
		);
		if ("failed" in invitation) throw new Error(invitation.failed);

		expect(await run((m) => m.invitation({ userId: eve.id, invitationId: invitation.id }))).toEqual(
			{
				failed: "NotTheInvitee",
			},
		);
		expect(await run((m) => m.accept({ userId: eve.id, invitationId: invitation.id }))).toEqual({
			failed: "NotTheInvitee",
		});
	});

	it("requires a proven address to accept only where the installation requires one", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await person("Bob", { verified: false });
		const invitation = await run((m) =>
			m.invite({
				userId: ada.id,
				workspace: workspace.id,
				invitation: { email: bob.email, role: "member" },
			}),
		);
		if ("failed" in invitation) throw new Error(invitation.failed);

		expect(
			await membershipWith(true).run((m) =>
				m.accept({ userId: bob.id, invitationId: invitation.id }),
			),
		).toEqual({
			failed: "EmailUnverified",
		});
		expect(await run((m) => m.accept({ userId: bob.id, invitationId: invitation.id }))).toEqual({
			workspaceId: workspace.id,
		});
	});

	it("refuses a second invitation to the same address unless it is a resend, and one to a member", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await person("Bob");
		const first = await run((m) =>
			m.invite({
				userId: ada.id,
				workspace: workspace.id,
				invitation: { email: bob.email, role: "member" },
			}),
		);
		if ("failed" in first) throw new Error(first.failed);

		expect(
			await run((m) =>
				m.invite({
					userId: ada.id,
					workspace: workspace.id,
					invitation: { email: bob.email, role: "member" },
				}),
			),
		).toEqual({
			failed: "AlreadyInvited",
		});
		expect(
			await run((m) =>
				m.invite({
					userId: ada.id,
					workspace: workspace.id,
					invitation: { email: bob.email, role: "viewer", resend: true },
				}),
			),
		).toMatchObject({ id: first.id, role: "viewer" });
		expect(
			await run((m) =>
				m.invite({
					userId: ada.id,
					workspace: workspace.id,
					invitation: { email: ada.email, role: "member" },
				}),
			),
		).toEqual({
			failed: "AlreadyMember",
		});
	});

	it("stops a cancelled invitation's link working", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await person("Bob");
		const invitation = await run((m) =>
			m.invite({
				userId: ada.id,
				workspace: workspace.id,
				invitation: { email: bob.email, role: "member" },
			}),
		);
		if ("failed" in invitation) throw new Error(invitation.failed);

		await run((m) => m.cancelInvitation({ userId: ada.id, invitationId: invitation.id }));

		expect(await run((m) => m.invitations({ userId: ada.id, workspace: workspace.id }))).toEqual(
			[],
		);
		expect(await run((m) => m.accept({ userId: bob.id, invitationId: invitation.id }))).toEqual({
			failed: "ResourceHidden",
		});
	});

	it("promotes and demotes, and lets a viewer read the roster and administer nobody", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await person("Bob");
		const kim = await person("Kim");
		const bobMember = await join(workspace.id, ada.id, bob);
		await join(workspace.id, ada.id, kim, "viewer");

		await run((m) =>
			m.changeRole({
				userId: ada.id,
				workspace: workspace.id,
				memberId: bobMember.id,
				role: "admin",
			}),
		);
		expect(await run((m) => m.members({ userId: ada.id, workspace: workspace.id }))).toContainEqual(
			expect.objectContaining({ id: bobMember.id, role: "admin" }),
		);
		await run((m) =>
			m.changeRole({
				userId: ada.id,
				workspace: workspace.id,
				memberId: bobMember.id,
				role: "member",
			}),
		);

		expect(await run((m) => m.members({ userId: kim.id, workspace: workspace.id }))).toHaveLength(
			3,
		);
		expect(
			await run((m) =>
				m.invite({
					userId: kim.id,
					workspace: workspace.id,
					invitation: { email: "nope@example.com", role: "member" },
				}),
			),
		).toEqual({
			failed: "ActionForbidden",
		});
		expect(
			await run((m) =>
				m.remove({ userId: kim.id, workspace: workspace.id, memberId: bobMember.id }),
			),
		).toEqual({
			failed: "ActionForbidden",
		});
		expect(
			await run((m) =>
				m.changeRole({
					userId: kim.id,
					workspace: workspace.id,
					memberId: bobMember.id,
					role: "admin",
				}),
			),
		).toEqual({
			failed: "ActionForbidden",
		});
	});

	it("keeps the last administrator", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await person("Bob");
		await join(workspace.id, ada.id, bob);
		const members = await run((m) => m.members({ userId: ada.id, workspace: workspace.id }));
		if ("failed" in members) throw new Error(members.failed);
		const adaMember = members.find((one) => one.user.id === ada.id);
		if (!adaMember) throw new Error("Ada is missing");

		expect(
			await run((m) =>
				m.remove({ userId: ada.id, workspace: workspace.id, memberId: adaMember.id }),
			),
		).toEqual({
			failed: "LastAdministrator",
		});
		expect(
			await run((m) =>
				m.changeRole({
					userId: ada.id,
					workspace: workspace.id,
					memberId: adaMember.id,
					role: "member",
				}),
			),
		).toEqual({
			failed: "LastAdministrator",
		});
		expect(await run((m) => m.leave({ userId: ada.id, workspace: workspace.id }))).toEqual({
			failed: "LastAdministrator",
		});
	});

	it("hides a workspace from somebody outside it", async () => {
		const { workspace } = await workspaceOfAda();
		const eve = await person("Eve");

		expect(await run((m) => m.members({ userId: eve.id, workspace: workspace.id }))).toEqual({
			failed: "ResourceHidden",
		});
	});

	it("takes a removed member's Personal pod and pod grants, and does not restore them when they rejoin", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await person("Bob");
		const bobMember = await join(workspace.id, ada.id, bob);
		const [shared] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId: workspace.id,
					kind: "shared",
					name: "Private",
					slug: `private-${unique()}`,
				})
				.returning(),
		);
		if (!shared) throw new Error("The pod was not created");
		await onDatabase((db) =>
			db.insert(podMember).values({ workspaceId: workspace.id, podId: shared.id, userId: bob.id }),
		);

		await run((m) => m.remove({ userId: ada.id, workspace: workspace.id, memberId: bobMember.id }));
		await join(workspace.id, ada.id, bob);

		expect(
			await onDatabase((db) =>
				db
					.select()
					.from(podMember)
					.where(and(eq(podMember.podId, shared.id), eq(podMember.userId, bob.id))),
			),
		).toEqual([]);
		expect(
			await onDatabase((db) =>
				db
					.select({ id: pod.id })
					.from(pod)
					.where(and(eq(pod.workspaceId, workspace.id), eq(pod.ownerId, bob.id))),
			),
		).toHaveLength(1);
	});

	it("lets somebody who created a shared pod leave, and keeps the pod", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await person("Bob");
		await join(workspace.id, ada.id, bob);
		const [shared] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId: workspace.id,
					kind: "shared",
					name: "Launch",
					slug: `launch-${unique()}`,
					createdById: bob.id,
				})
				.returning(),
		);
		if (!shared) throw new Error("The pod was not created");

		expect(await run((m) => m.leave({ userId: bob.id, workspace: workspace.id }))).toBeUndefined();
		expect(
			await onDatabase((db) => db.select().from(pod).where(eq(pod.id, shared.id))),
		).toHaveLength(1);
	});

	it("matches an invitation to an address whatever its case", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await person("Bob");
		const invitation = await run((m) =>
			m.invite({
				userId: ada.id,
				workspace: workspace.id,
				invitation: { email: bob.email.toUpperCase(), role: "member" },
			}),
		);
		if ("failed" in invitation) throw new Error(invitation.failed);

		expect(
			await onDatabase((db) =>
				db
					.select({ email: workspaceInvite.email })
					.from(workspaceInvite)
					.where(eq(workspaceInvite.id, invitation.id)),
			),
		).toEqual([{ email: bob.email }]);
		expect(await run((m) => m.accept({ userId: bob.id, invitationId: invitation.id }))).toEqual({
			workspaceId: workspace.id,
		});
	});
});
