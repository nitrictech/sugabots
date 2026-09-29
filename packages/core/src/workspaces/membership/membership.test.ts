import { and, eq, isNotNull } from "drizzle-orm";
import { ConfigProvider, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { Accounts } from "../../accounts/accounts.ts";
import { CurrentActor } from "../../authorization/current-actor.ts";
import {
	agent,
	pod,
	podMember,
	searchProvider,
	user,
	workspaceInvite,
	workspaceMember,
} from "../../database/schema.ts";
import { closeDatabase, onDatabase, testInfrastructure } from "../../database/testing.ts";
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
			Membership.layer.pipe(
				Layer.provide([
					testInfrastructure,
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
							env: {
								DATABASE_URL: process.env.DATABASE_URL ?? "",
								WEB_APP_URL,
							},
						}),
					),
				),
			),
		);
		runtimes.push(runtime);
		return {
			/** The operation's value when `userId` asks for it, or the tag it failed with. */
			run: <A, E extends { _tag: string }>(
				userId: string,
				operation: (membership: Membership.Interface) => Effect.Effect<A, E, CurrentActor.Service>,
			) =>
				runtime
					.runPromiseExit(
						Effect.flatMap(Membership.Service, operation).pipe(
							CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(userId)),
						),
					)
					.then((exit) => {
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

	/** A workspace Ada owns. */
	async function workspaceOfAda() {
		const ada = await person("Ada");
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
		role: "admin" | "member" | "viewer" = "member",
	) {
		const invitation = await run(inviterId, (m) =>
			m.invite({
				workspace: workspaceId,
				invitation: { email: invitee.email, role },
			}),
		);
		if ("failed" in invitation) throw new Error(invitation.failed);
		await run(invitee.id, (m) => m.accept({ invitationId: invitation.id }));
		const members = await run(inviterId, (m) => m.members({ workspace: workspaceId }));
		if ("failed" in members) throw new Error(members.failed);
		const member = members.find((one) => one.user.id === invitee.id);
		if (!member) throw new Error("The invitee did not join");
		return member;
	}

	it("makes the creator its owner, and provisions the workspace and their Personal pod", async () => {
		const { ada, workspace } = await workspaceOfAda();

		expect(await run(ada.id, (m) => m.members({ workspace: workspace.id }))).toEqual([
			expect.objectContaining({ role: "owner", user: expect.objectContaining({ id: ada.id }) }),
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
		expect(await run(ada.id, (m) => m.workspaces)).toEqual([workspace]);
	});

	it("keeps the time zone a workspace is created in, and is in UTC when given none", async () => {
		const ada = await person("Ada");

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
		const ada = await person("Ada");

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
		const bob = await person("Bob");

		const invitation = await run(ada.id, (m) =>
			m.invite({
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
		expect(await run(bob.id, (m) => m.invitation({ invitationId: invitation.id }))).toEqual({
			workspaceName: "Nitric",
			inviterName: "Ada",
		});
		expect(await run(bob.id, (m) => m.accept({ invitationId: invitation.id }))).toEqual({
			workspaceId: workspace.id,
		});
		expect(await run(bob.id, (m) => m.members({ workspace: workspace.id }))).toHaveLength(2);
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
		const invitation = await run(ada.id, (m) =>
			m.invite({
				workspace: workspace.id,
				invitation: { email: bob.email, role: "member" },
			}),
		);
		if ("failed" in invitation) throw new Error(invitation.failed);

		expect(await run(eve.id, (m) => m.invitation({ invitationId: invitation.id }))).toEqual({
			failed: "NotTheInvitee",
		});
		expect(await run(eve.id, (m) => m.accept({ invitationId: invitation.id }))).toEqual({
			failed: "NotTheInvitee",
		});
	});

	it("requires a proven address to accept only where the installation requires one", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await person("Bob", { verified: false });
		const invitation = await run(ada.id, (m) =>
			m.invite({
				workspace: workspace.id,
				invitation: { email: bob.email, role: "member" },
			}),
		);
		if ("failed" in invitation) throw new Error(invitation.failed);

		expect(
			await membershipWith(true).run(bob.id, (m) => m.accept({ invitationId: invitation.id })),
		).toEqual({
			failed: "EmailUnverified",
		});
		expect(await run(bob.id, (m) => m.accept({ invitationId: invitation.id }))).toEqual({
			workspaceId: workspace.id,
		});
	});

	it("refuses a second invitation to the same address unless it is a resend, and one to a member", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await person("Bob");
		const first = await run(ada.id, (m) =>
			m.invite({
				workspace: workspace.id,
				invitation: { email: bob.email, role: "member" },
			}),
		);
		if ("failed" in first) throw new Error(first.failed);

		expect(
			await run(ada.id, (m) =>
				m.invite({
					workspace: workspace.id,
					invitation: { email: bob.email, role: "member" },
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
		const invitation = await run(ada.id, (m) =>
			m.invite({
				workspace: workspace.id,
				invitation: { email: bob.email, role: "member" },
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
		const eve = await person("Eve");
		const invitation = await run(ada.id, (m) =>
			m.invite({ workspace: workspace.id, invitation: { email: eve.email, role: "member" } }),
		);
		if ("failed" in invitation) throw new Error(invitation.failed);
		const refusalOf = (invitationId: string) =>
			run(eve.id, (m) => m.cancelInvitation({ invitationId }).pipe(Effect.flip, Effect.orDie));

		const elsewhere = await refusalOf(invitation.id);
		const nowhere = await refusalOf(crypto.randomUUID());

		expect(elsewhere).toEqual(nowhere);
		expect(elsewhere).toMatchObject({ _tag: "ResourceHidden", resource: "invitation" });
		expect(await run(ada.id, (m) => m.invitations({ workspace: workspace.id }))).toHaveLength(1);
	});

	it("refuses to cancel an invitation for a member who may not manage members", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await person("Bob");
		await join(workspace.id, ada.id, bob);
		const invitation = await run(ada.id, (m) =>
			m.invite({
				workspace: workspace.id,
				invitation: { email: "someone@example.com", role: "member" },
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
		const bob = await person("Bob");
		const kim = await person("Kim");
		const bobMember = await join(workspace.id, ada.id, bob);
		await join(workspace.id, ada.id, kim, "viewer");

		await run(ada.id, (m) =>
			m.changeRole({
				workspace: workspace.id,
				memberId: bobMember.id,
				role: "admin",
			}),
		);
		expect(await run(ada.id, (m) => m.members({ workspace: workspace.id }))).toContainEqual(
			expect.objectContaining({ id: bobMember.id, role: "admin" }),
		);
		await run(ada.id, (m) =>
			m.changeRole({
				workspace: workspace.id,
				memberId: bobMember.id,
				role: "member",
			}),
		);

		expect(await run(kim.id, (m) => m.members({ workspace: workspace.id }))).toHaveLength(3);
		expect(
			await run(kim.id, (m) =>
				m.invite({
					workspace: workspace.id,
					invitation: { email: "nope@example.com", role: "member" },
				}),
			),
		).toEqual({
			failed: "ActionForbidden",
		});
		expect(
			await run(kim.id, (m) => m.remove({ workspace: workspace.id, memberId: bobMember.id })),
		).toEqual({
			failed: "ActionForbidden",
		});
		expect(
			await run(kim.id, (m) =>
				m.changeRole({
					workspace: workspace.id,
					memberId: bobMember.id,
					role: "admin",
				}),
			),
		).toEqual({
			failed: "ActionForbidden",
		});
	});

	it("puts an administrator in every shared pod, whether invited or promoted", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await person("Bob");
		const kim = await person("Kim");
		const [shared] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId: workspace.id,
					kind: "shared",
					name: "Launch",
					slug: `launch-${unique()}`,
				})
				.returning(),
		);
		if (!shared) throw new Error("The pod was not created");
		const inShared = () =>
			onDatabase((db) =>
				db
					.select({ userId: podMember.userId })
					.from(podMember)
					.where(eq(podMember.podId, shared.id)),
			).then((rows) => rows.map((row) => row.userId).toSorted());

		const bobMember = await join(workspace.id, ada.id, bob);
		await join(workspace.id, ada.id, kim, "admin");
		expect(await inShared()).toEqual([ada.id, kim.id].toSorted());

		await run(ada.id, (m) =>
			m.changeRole({
				workspace: workspace.id,
				memberId: bobMember.id,
				role: "admin",
			}),
		);
		expect(await inShared()).toEqual([ada.id, bob.id, kim.id].toSorted());
	});

	/** The membership `userId` holds in the workspace, as they see it on the roster. */
	async function membershipOf(workspaceId: string, userId: string) {
		const members = await run(userId, (m) => m.members({ workspace: workspaceId }));
		if ("failed" in members) throw new Error(members.failed);
		const own = members.find((one) => one.user.id === userId);
		if (!own) throw new Error("They are not in the workspace");
		return own;
	}

	it("keeps the owner, whom nobody demotes or removes and who cannot leave", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await person("Bob");
		await join(workspace.id, ada.id, bob, "admin");
		const adaMember = await membershipOf(workspace.id, ada.id);

		for (const actor of [ada.id, bob.id]) {
			expect(
				await run(actor, (m) => m.remove({ workspace: workspace.id, memberId: adaMember.id })),
			).toEqual({ failed: "OwnerStays" });
			expect(
				await run(actor, (m) =>
					m.changeRole({ workspace: workspace.id, memberId: adaMember.id, role: "member" }),
				),
			).toEqual({ failed: "OwnerStays" });
		}
		expect(await run(ada.id, (m) => m.leave({ workspace: workspace.id }))).toEqual({
			failed: "OwnerStays",
		});
		expect(await membershipOf(workspace.id, ada.id)).toMatchObject({ role: "owner" });
	});

	it("leaves making, unmaking and removing administrators to the owner", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await person("Bob");
		const kim = await person("Kim");
		const lee = await person("Lee");
		await join(workspace.id, ada.id, bob, "admin");
		const kimMember = await join(workspace.id, ada.id, kim, "admin");
		const leeMember = await join(workspace.id, ada.id, lee);

		expect(
			await run(bob.id, (m) =>
				m.changeRole({ workspace: workspace.id, memberId: leeMember.id, role: "admin" }),
			),
		).toEqual({ failed: "ActionForbidden" });
		expect(
			await run(bob.id, (m) =>
				m.changeRole({ workspace: workspace.id, memberId: kimMember.id, role: "member" }),
			),
		).toEqual({ failed: "ActionForbidden" });
		expect(
			await run(bob.id, (m) => m.remove({ workspace: workspace.id, memberId: kimMember.id })),
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
			m.changeRole({ workspace: workspace.id, memberId: leeMember.id, role: "viewer" }),
		);
		expect(await membershipOf(workspace.id, lee.id)).toMatchObject({ role: "viewer" });

		await run(ada.id, (m) =>
			m.changeRole({ workspace: workspace.id, memberId: kimMember.id, role: "member" }),
		);
		expect(await membershipOf(workspace.id, kim.id)).toMatchObject({ role: "member" });
		// An administrator may leave: the owner is still there to administer.
		expect(await run(bob.id, (m) => m.leave({ workspace: workspace.id }))).toBeUndefined();
	});

	it("transfers ownership, making the new owner an administrator of every shared pod and the old one an admin", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await person("Bob");
		const bobMember = await join(workspace.id, ada.id, bob, "viewer");
		const [shared] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId: workspace.id,
					kind: "shared",
					name: "Launch",
					slug: `launch-${unique()}`,
				})
				.returning(),
		);
		if (!shared) throw new Error("The pod was not created");

		expect(
			await run(ada.id, (m) =>
				m.transferOwnership({ workspace: workspace.id, memberId: bobMember.id }),
			),
		).toBeUndefined();

		expect(await membershipOf(workspace.id, bob.id)).toMatchObject({ role: "owner" });
		expect(await membershipOf(workspace.id, ada.id)).toMatchObject({ role: "admin" });
		expect(
			await onDatabase((db) =>
				db
					.select({ userId: podMember.userId })
					.from(podMember)
					.where(eq(podMember.podId, shared.id)),
			).then((rows) => rows.map((row) => row.userId).toSorted()),
		).toEqual([ada.id, bob.id].toSorted());
		// Ada holds nothing of the owner's now, and Bob can leave nothing behind.
		const adaMember = await membershipOf(workspace.id, ada.id);
		expect(
			await run(ada.id, (m) =>
				m.transferOwnership({ workspace: workspace.id, memberId: adaMember.id }),
			),
		).toEqual({ failed: "ActionForbidden" });
		expect(await run(bob.id, (m) => m.leave({ workspace: workspace.id }))).toEqual({
			failed: "OwnerStays",
		});
	});

	it("lets a workspace have only one owner", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await person("Bob");
		const bobMember = await join(workspace.id, ada.id, bob);

		await expect(
			onDatabase((db) =>
				db
					.update(workspaceMember)
					.set({ role: "owner" })
					.where(eq(workspaceMember.id, bobMember.id)),
			),
		).rejects.toThrow();
	});

	it("hides a workspace from somebody outside it", async () => {
		const { workspace } = await workspaceOfAda();
		const eve = await person("Eve");

		expect(await run(eve.id, (m) => m.members({ workspace: workspace.id }))).toEqual({
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

		await run(ada.id, (m) => m.remove({ workspace: workspace.id, memberId: bobMember.id }));
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

		expect(await run(bob.id, (m) => m.leave({ workspace: workspace.id }))).toBeUndefined();
		expect(
			await onDatabase((db) => db.select().from(pod).where(eq(pod.id, shared.id))),
		).toHaveLength(1);
	});

	it("matches an invitation to an address whatever its case", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await person("Bob");
		const invitation = await run(ada.id, (m) =>
			m.invite({
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
		expect(await run(bob.id, (m) => m.accept({ invitationId: invitation.id }))).toEqual({
			workspaceId: workspace.id,
		});
	});

	it("says what a member may do in the workspace, and hides it from anybody else", async () => {
		const { ada, workspace } = await workspaceOfAda();
		const bob = await person("Bob");
		const eve = await person("Eve");
		await join(workspace.id, ada.id, bob, "viewer");

		expect(await run(ada.id, (m) => m.access({ workspace: workspace.slug }))).toMatchObject({
			role: "owner",
			permissions: {
				manageMembers: true,
				createPods: true,
				manageAdmins: true,
				transferOwnership: true,
			},
		});
		expect(await run(bob.id, (m) => m.access({ workspace: workspace.id }))).toMatchObject({
			role: "viewer",
			permissions: {
				manageMembers: false,
				createPods: false,
				manageAdmins: false,
				transferOwnership: false,
			},
		});
		expect(await run(eve.id, (m) => m.access({ workspace: workspace.id }))).toEqual({
			failed: "ResourceHidden",
		});
	});
});
