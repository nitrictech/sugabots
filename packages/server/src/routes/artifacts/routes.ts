import { Artifacts } from "@sugabots/core/artifacts/artifacts";
import { ArtifactPages } from "@sugabots/core/artifacts/pages";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const artifactRoutes = HttpApiBuilder.group(ServerApi, "artifacts", (handlers) =>
	Effect.gen(function* () {
		const artifacts = yield* Artifacts.Service;
		const pages = yield* ArtifactPages.Service;
		return handlers
			.handle("list", ({ params }) =>
				artifacts.list(params).pipe(asSessionUser, asHttpError(refusals)),
			)
			.handle("get", ({ params }) =>
				artifacts.get(params).pipe(asSessionUser, asHttpError(refusals)),
			)
			.handle("versions", ({ params }) =>
				artifacts.versions(params).pipe(asSessionUser, asHttpError(refusals)),
			)
			.handle("getVersion", ({ params }) =>
				artifacts.getVersion(params).pipe(asSessionUser, asHttpError(refusals)),
			)
			.handle("pageAddress", ({ params }) =>
				pages.address(params).pipe(
					Effect.map((url) => ({ url: url ?? null })),
					asSessionUser,
					asHttpError(refusals),
				),
			)
			.handle("remove", ({ params }) =>
				artifacts.remove(params).pipe(asSessionUser, asHttpError(refusals)),
			);
	}),
);
