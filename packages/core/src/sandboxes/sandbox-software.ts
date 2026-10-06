export * as SandboxSoftware from "./sandbox-software.ts";

import type { PodSandboxSoftware, SandboxSoftwareChannel } from "@sugabots/contracts";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../authorization/access.ts";
import { Authorization } from "../authorization/authorization.ts";
import type { CurrentActor } from "../authorization/current-actor.ts";
import { query, serviceOperations } from "../database/database.ts";
import { sandboxPodPackage, thread, toolCall, user } from "../database/schema.ts";

/**
 * The software each pod's sandbox has beyond its image: packages from
 * nixpkgs, each at the nixpkgs commit it was installed from. An agent asks
 * for one and someone who manages the pod's sandbox allows it; every sandbox
 * the pod has is given the same packages, so a new one gets them back.
 *
 * Seeing a pod's software takes `pod.read`; removing a package takes
 * `sandbox.manage`.
 */
export interface Interface {
	readonly podSoftware: (
		podId: string,
	) => Effect.Effect<PodSandboxSoftware, AuthorizationDenied, CurrentActor.Service>;
	/** Removing a package the pod doesn't have changes nothing. */
	readonly removePackage: (input: {
		podId: string;
		name: string;
		channel: SandboxSoftwareChannel;
	}) => Effect.Effect<PodSandboxSoftware, AuthorizationDenied, CurrentActor.Service>;
	/** The pod's packages, to give its sandbox. */
	readonly packagesOf: (pod: Pod) => Effect.Effect<readonly Package[]>;
	/**
	 * The request the turn's call `sdkToolCallId` made for software, if a
	 * person allowed it: what {@link add} records the package by.
	 */
	readonly allowedRequest: (input: {
		turnId: string;
		sdkToolCallId: string;
	}) => Effect.Effect<AllowedRequest | undefined>;
	/** Records a package the request's pod now has, installed from `nixpkgsRev`. */
	readonly add: (request: AllowedRequest, installed: Package) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/SandboxSoftware",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("SandboxSoftware");
	const authorization = yield* Authorization.Service;

	const rowsOf = (pod: Pod) =>
		query((db) =>
			db
				.select()
				.from(sandboxPodPackage)
				.where(
					and(
						eq(sandboxPodPackage.workspaceId, pod.workspaceId),
						eq(sandboxPodPackage.podId, pod.podId),
					),
				)
				.orderBy(asc(sandboxPodPackage.name), asc(sandboxPodPackage.channel)),
		);

	const softwareOf = (pod: Pod) =>
		Effect.gen(function* () {
			const rows = yield* rowsOf(pod);
			const adderIds = [...new Set(rows.flatMap((row) => (row.addedById ? [row.addedById] : [])))];
			const adders =
				adderIds.length === 0
					? []
					: yield* query((db) =>
							db
								.select({ id: user.id, name: user.name })
								.from(user)
								.where(inArray(user.id, adderIds)),
						);
			const names = new Map(adders.map((adder) => [adder.id, adder.name]));
			return {
				packages: rows.map((row) => ({
					name: row.name,
					channel: row.channel,
					nixpkgsRev: row.nixpkgsRev,
					addedByName: (row.addedById && names.get(row.addedById)) ?? null,
					addedAt: row.createdAt.toISOString(),
				})),
			} satisfies PodSandboxSoftware;
		});

	const podOf = (standing: { pod: { id: string; workspaceId: string } }): Pod => ({
		workspaceId: standing.pod.workspaceId,
		podId: standing.pod.id,
	});

	return Service.of({
		podSoftware: (podId) =>
			operation(
				"podSoftware",
				Effect.flatMap(authorization.pod(podId, "pod.read"), (standing) =>
					softwareOf(podOf(standing)),
				),
			),

		removePackage: ({ podId, name, channel }) =>
			operation(
				"removePackage",
				Effect.gen(function* () {
					const pod = podOf(yield* authorization.pod(podId, "sandbox.manage"));
					yield* query((db) =>
						db
							.delete(sandboxPodPackage)
							.where(
								and(
									eq(sandboxPodPackage.podId, pod.podId),
									eq(sandboxPodPackage.channel, channel),
									eq(sandboxPodPackage.name, name),
								),
							),
					);
					return yield* softwareOf(pod);
				}),
			),

		packagesOf: (pod) =>
			operation(
				"packagesOf",
				Effect.map(rowsOf(pod), (rows) =>
					rows.map(({ name, channel, nixpkgsRev }) => ({ name, channel, nixpkgsRev })),
				),
			),

		allowedRequest: ({ turnId, sdkToolCallId }) =>
			operation(
				"allowedRequest",
				Effect.gen(function* () {
					const [call] = yield* query((db) =>
						db
							.select({
								workspaceId: thread.workspaceId,
								podId: thread.podId,
								approvalStatus: toolCall.approvalStatus,
								decidedById: toolCall.decidedById,
							})
							.from(toolCall)
							.innerJoin(thread, eq(thread.id, toolCall.threadId))
							.where(and(eq(toolCall.turnId, turnId), eq(toolCall.sdkToolCallId, sdkToolCallId)))
							.limit(1),
					);
					if (call?.approvalStatus !== "allowed") return undefined;
					return allowed({
						pod: { workspaceId: call.workspaceId, podId: call.podId },
						decidedById: call.decidedById,
					});
				}),
			),

		add: (request, installed) =>
			operation(
				"add",
				query((db) =>
					db
						.insert(sandboxPodPackage)
						.values({ ...request.pod, ...installed, addedById: request.decidedById })
						.onConflictDoUpdate({
							target: [sandboxPodPackage.podId, sandboxPodPackage.channel, sandboxPodPackage.name],
							set: { nixpkgsRev: installed.nixpkgsRev, addedById: request.decidedById },
						}),
				).pipe(Effect.asVoid),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(Authorization.layer));

export interface Pod {
	readonly workspaceId: string;
	readonly podId: string;
}

/** A package the pod's sandbox has: its attribute in nixpkgs, and the build it comes from. */
export interface Package {
	readonly name: string;
	readonly channel: SandboxSoftwareChannel;
	readonly nixpkgsRev: string;
}

declare const allowedBrand: unique symbol;

/** A request for software a person allowed, as only {@link Interface.allowedRequest} finds one. */
export interface AllowedRequest {
	readonly pod: Pod;
	/** Who allowed it; null once they've left. */
	readonly decidedById: string | null;
	readonly [allowedBrand]: true;
}

const allowed = (request: Omit<AllowedRequest, typeof allowedBrand>) => request as AllowedRequest;
