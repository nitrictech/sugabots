import { Effect } from "effect";
import { seedProject } from "../workspaces/projects/seed.test-support.ts";
import { query, transaction } from "./database.ts";
import { bot, member, membership, workspace } from "./schema.ts";
import { runOnPostgres } from "./testing.ts";

type WorkspaceFields = Partial<typeof workspace.$inferInsert>;
type MemberFields = Partial<typeof member.$inferInsert>;
type Role = NonNullable<(typeof membership.$inferInsert)["role"]>;
type WorkspaceMember = MemberFields & { role?: Role };
type BotFields = Partial<Omit<typeof bot.$inferInsert, "workspaceId">>;
type ProjectFields = Omit<Parameters<typeof seedProject>[1], "workspaceId">;

function inserted<Row>([row]: readonly Row[]): Row {
	if (!row) throw new Error("Fixture insert returned no row");
	return row;
}

const workspaceRow = (fields: WorkspaceFields) =>
	query((db) =>
		db
			.insert(workspace)
			.values({
				name: "Workspace",
				slug: `workspace-${crypto.randomUUID()}`,
				...fields,
			})
			.returning(),
	).pipe(Effect.map(inserted));

const memberRow = (fields: MemberFields) =>
	query((db) =>
		db
			.insert(member)
			.values({
				name: "Member",
				email: `member-${crypto.randomUUID()}@example.com`,
				...fields,
			})
			.returning(),
	).pipe(Effect.map(inserted));

const membershipRows = (values: (typeof membership.$inferInsert)[]) =>
	query((db) => db.insert(membership).values(values));

export const createTestWorkspace = (fields: WorkspaceFields = {}) =>
	runOnPostgres(workspaceRow(fields));

export function createTestMember(
	fields: MemberFields = {},
	inWorkspace?: { workspaceId: string; role: Role },
) {
	if (!inWorkspace) return runOnPostgres(memberRow(fields));
	return runOnPostgres(
		transaction(
			Effect.gen(function* () {
				const created = yield* memberRow(fields);
				yield* membershipRows([{ ...inWorkspace, memberId: created.id }]);
				return created;
			}),
		),
	);
}

export const addTestMemberships = (...values: (typeof membership.$inferInsert)[]) =>
	runOnPostgres(membershipRows(values));

type WorkspaceFixture<Names extends string> = {
	workspace: typeof workspace.$inferSelect;
	members: Record<Names, typeof member.$inferSelect>;
};

type WorkspaceProjectFixture<Names extends string> = WorkspaceFixture<Names> & {
	project: Effect.Success<ReturnType<typeof seedProject>>;
};

export function createWorkspaceFixture<Names extends string>(
	fields: WorkspaceFields,
	members: Record<Names, WorkspaceMember>,
	options: (members: WorkspaceFixture<Names>["members"]) => {
		project: ProjectFields;
		bot?: BotFields;
	},
): Promise<WorkspaceProjectFixture<Names>>;
export function createWorkspaceFixture<Names extends string>(
	fields: WorkspaceFields,
	members: Record<Names, WorkspaceMember>,
): Promise<WorkspaceFixture<Names>>;
export function createWorkspaceFixture<Names extends string>(
	fields: WorkspaceFields,
	members: Record<Names, WorkspaceMember>,
	options?: (members: WorkspaceFixture<Names>["members"]) => {
		project: ProjectFields;
		bot?: BotFields;
	},
) {
	return runOnPostgres(
		transaction(
			Effect.gen(function* () {
				const space = yield* workspaceRow(fields);
				const namedMembers = {} as WorkspaceFixture<Names>["members"];
				const memberships = [];
				for (const name in members) {
					const { role, ...fields } = members[name];
					const created = yield* memberRow(fields);
					namedMembers[name] = created;
					if (role) memberships.push({ workspaceId: space.id, memberId: created.id, role });
				}
				if (memberships.length) yield* membershipRows(memberships);
				const fixture = { workspace: space, members: namedMembers };
				if (!options) return fixture;

				const { bot: botFields, project: projectFields } = options(namedMembers);
				const lead = botFields
					? yield* query((db) =>
							db
								.insert(bot)
								.values({
									name: "Lead",
									handle: "lead",
									color: "sky",
									eyes: "pill",
									...botFields,
									workspaceId: space.id,
								})
								.returning({ id: bot.id }),
						).pipe(Effect.map(inserted))
					: undefined;
				const project = yield* query((db) =>
					seedProject(db, {
						...projectFields,
						workspaceId: space.id,
						leadBotId: lead?.id ?? projectFields.leadBotId,
					}),
				);
				return { ...fixture, project };
			}),
		),
	);
}
