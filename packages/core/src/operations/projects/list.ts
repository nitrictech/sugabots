import { projectsContracts } from "@sugabots/contracts/operations/projects";
import { Effect } from "effect";
import { Projects } from "../../workspaces/projects/projects.ts";
import { defineOperation } from "../operation.ts";
import { readingWorkspace } from "../workspace-openings.ts";

export const list = defineOperation(projectsContracts["projects.list"], (principal, input) =>
	Effect.gen(function* () {
		const projects = yield* Projects.Service;
		return yield* readingWorkspace(principal, input.workspace, (canRead) => projects.list(canRead));
	}),
);
