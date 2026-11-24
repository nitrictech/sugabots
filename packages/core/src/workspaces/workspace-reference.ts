import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import { workspace } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";

/**
 * The id of the workspace `reference` names, by its id or its slug, for an
 * operation whose input names a workspace either way to name and prove. A
 * reference shaped like an id is taken as one, as no slug is shaped like an
 * id. A slug no workspace has comes back as it is, and proves hidden like an
 * id nobody reaches, so a refusal never says whether a slug is taken.
 */
export const workspaceIdOf = (reference: string) =>
	isUuid(reference)
		? Effect.succeed(reference)
		: query((db) =>
				db
					.select({ id: workspace.id })
					.from(workspace)
					.where(eq(workspace.slug, reference))
					.limit(1),
			).pipe(Effect.map(([found]) => found?.id ?? reference));
