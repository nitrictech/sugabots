import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import { bot, project, workspace } from "../database/schema.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";
import type { HoldsWorkspaceLock } from "./workspace-lock.ts";

type ProjectDeletionKind = "project" | "bot" | "membership";

export interface DeletionRecorded<W> extends Proof<"DeletionRecorded", [W]> {
	readonly workspace: Named<W, string>;
}

export interface ProjectDeletionRecorded<W, J> extends Proof<"ProjectDeletionRecorded", [W, J]> {
	readonly workspace: Named<W, string>;
	readonly project: Named<J, string>;
}

export interface DeletionStarted<W> extends Proof<"DeletionStarted", [W]> {
	readonly workspace: Named<W, string>;
}

export interface ProjectDeletionStarted<W, J, K extends ProjectDeletionKind>
	extends Proof<"ProjectDeletionStarted", [W, J]> {
	readonly targetKind: K;
	readonly targetId: string;
	readonly workspace: Named<W, string>;
	readonly project: Named<J, string>;
}

const DeletionRecordedProof = defineProof("DeletionRecorded");
const ProjectDeletionRecordedProof = defineProof("ProjectDeletionRecorded");
const DeletionStartedProof = defineProof("DeletionStarted");
const ProjectDeletionStartedProof = defineProof("ProjectDeletionStarted");

const workspaceDeletion = (workspaceId: string) =>
	query((db) =>
		db
			.select({ id: workspace.id })
			.from(workspace)
			.where(and(eq(workspace.id, workspaceId), eq(workspace.deleting, true))),
	);

const deletingProject = (workspaceId: string, projectId: string) =>
	and(eq(project.workspaceId, workspaceId), eq(project.id, projectId), eq(project.deleting, true));

export const proveDeletionRecorded = <W>(workspace: Named<W, string>) =>
	Effect.gen(function* () {
		const [deleting] = yield* workspaceDeletion(workspace.value);
		if (!deleting) return undefined;
		const proof: DeletionRecorded<W> = DeletionRecordedProof.prove([workspace], { workspace });
		return proof;
	});

export const proveProjectDeletionRecorded = <W, J>(
	workspace: Named<W, string>,
	projectId: Named<J, string>,
) =>
	Effect.gen(function* () {
		const [deleting] = yield* query((db) =>
			db
				.select({ id: project.id })
				.from(project)
				.where(deletingProject(workspace.value, projectId.value)),
		);
		if (!deleting) return undefined;
		const proof: ProjectDeletionRecorded<W, J> = ProjectDeletionRecordedProof.prove(
			[workspace, projectId],
			{ workspace, project: projectId },
		);
		return proof;
	});

export const proveWorkspaceDeletionStarted = <P, W>(lock: HoldsWorkspaceLock<P, W>) =>
	Effect.gen(function* () {
		const workspaceId = lock.workspace.value;
		const [deleting] = yield* workspaceDeletion(workspaceId);
		if (!deleting) return undefined;
		const proof: DeletionStarted<W> = DeletionStartedProof.prove([lock.workspace], {
			workspace: lock.workspace,
		});
		return proof;
	});

export const proveProjectDeletionStarted = <P, W, J>(
	lock: HoldsWorkspaceLock<P, W>,
	projectId: Named<J, string>,
) =>
	Effect.gen(function* () {
		const workspaceId = lock.workspace.value;
		const [deleting] = yield* query((db) =>
			db
				.select({ defaultOf: project.defaultOfBotId, assistantOf: bot.assistantOf })
				.from(project)
				.leftJoin(
					bot,
					and(eq(bot.id, project.defaultOfBotId), eq(bot.workspaceId, project.workspaceId)),
				)
				.where(deletingProject(workspaceId, projectId.value)),
		);
		if (!deleting) return undefined;
		const prove = <K extends ProjectDeletionKind>(
			targetKind: K,
			targetId: string,
		): ProjectDeletionStarted<W, J, K> =>
			ProjectDeletionStartedProof.prove([lock.workspace, projectId], {
				targetKind,
				targetId,
				workspace: lock.workspace,
				project: projectId,
			});
		if (deleting.assistantOf) return prove("membership", deleting.assistantOf);
		if (deleting.defaultOf) return prove("bot", deleting.defaultOf);
		return prove("project", projectId.value);
	});
