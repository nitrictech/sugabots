import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { type Database, query } from "../database/database.ts";
import { bot, project, workspace } from "../database/schema.ts";
import { defineProof, type Proof } from "./proof.ts";
import type { HoldsWorkspaceLock } from "./workspace-lock.ts";

type ProjectDeletionKind = "project" | "bot" | "membership";

export interface DeletionStarted<W, K extends ProjectDeletionKind | "workspace">
	extends Proof<"DeletionStarted", [W]> {
	readonly targetKind: K;
	readonly targetId: string;
	readonly workspaceId: string;
}

export interface ProjectDeletionStarted<W, K extends ProjectDeletionKind>
	extends DeletionStarted<W, K> {
	readonly projectId: string;
}

const DeletionStartedProof = defineProof("DeletionStarted");

export const proveWorkspaceDeletionStarted = <P, W>(lock: HoldsWorkspaceLock<P, W>) =>
	Effect.gen(function* () {
		const workspaceId = lock.workspace.value;
		const [deleting] = yield* query((db) =>
			db
				.select({ id: workspace.id })
				.from(workspace)
				.where(and(eq(workspace.id, workspaceId), eq(workspace.deleting, true))),
		);
		if (!deleting) return undefined;
		const proof: DeletionStarted<W, "workspace"> = DeletionStartedProof.prove([lock.workspace], {
			targetKind: "workspace",
			targetId: workspaceId,
			workspaceId,
		});
		return proof;
	});

export const proveProjectDeletionStarted = <P, W>(
	lock: HoldsWorkspaceLock<P, W>,
	projectId: string,
): Effect.Effect<
	| ProjectDeletionStarted<W, "project">
	| ProjectDeletionStarted<W, "bot">
	| ProjectDeletionStarted<W, "membership">
	| undefined,
	never,
	Database
> =>
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
				.where(
					and(
						eq(project.workspaceId, workspaceId),
						eq(project.id, projectId),
						eq(project.deleting, true),
					),
				),
		);
		if (!deleting) return undefined;
		const prove = <K extends ProjectDeletionKind>(
			targetKind: K,
			targetId: string,
		): ProjectDeletionStarted<W, K> =>
			DeletionStartedProof.prove([lock.workspace], {
				targetKind,
				targetId,
				workspaceId,
				projectId,
			});
		// A default project goes with its bot, or with the membership that owns its assistant.
		if (deleting.assistantOf) return prove("membership", deleting.assistantOf);
		if (deleting.defaultOf) return prove("bot", deleting.defaultOf);
		return prove("project", projectId);
	});
