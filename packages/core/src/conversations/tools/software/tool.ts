import { sandboxPackageNameSchema, sandboxSoftwareChannelSchema } from "@sugabots/contracts";
import { tool } from "ai";
import { Effect, Schema } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import type { SandboxSoftware } from "../../../sandboxes/sandbox-software.ts";
import type { OpenSandbox } from "../sandbox/tools.ts";
import type { Request } from "../sandbox.ts";
import { currentNixpkgs, installSoftware, NIXPKGS } from "./profile.ts";

export const REQUEST_SOFTWARE_TOOL = "request_software";

/**
 * The `request_software` tool: an agent asking for a package from nixpkgs to
 * be installed in its pod's sandbox for good. Every call waits for someone
 * who manages the pod's sandbox to allow it (see
 * `tools/approval-deciders.ts`), so the tool only runs once they have; it
 * then installs the package, at the nixpkgs commit its channel is at, and
 * records it for every sandbox the pod has after.
 */
export function requestSoftware({
	turnId,
	software,
	openSandbox,
	run,
}: {
	turnId: string;
	software: Pick<SandboxSoftware.Interface, "allowedRequest" | "packagesOf" | "add">;
	openSandbox: OpenSandbox;
	run: RunEffect<never>;
}): Request {
	return {
		tool: tool({
			description: `Ask for a package from nixpkgs to be installed in the pod's sandbox for good, for every agent in the pod. An admin of this pod decides, and your reply waits until they have; once allowed, it's installed, on the PATH of every command, and given to every sandbox the pod has from then on. For software needed only now, run "nix shell nixpkgs#<name> -c <command>" instead, which needs no one's say. Find a package's name with "nix search nixpkgs <words>". Packages come from a NixOS release unless you ask for "unstable", which has newer versions.`,
			inputSchema: Schema.Struct({
				name: sandboxPackageNameSchema.annotate({
					description: "The package's name in nixpkgs, such as ffmpeg or python3Packages.pandas",
				}),
				channel: Schema.optional(sandboxSoftwareChannelSchema).annotate({
					description: `"stable", the default, for a NixOS release; "unstable" for newer versions`,
				}),
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ name, channel = "stable" }, { toolCallId }) => {
				const request = await run(software.allowedRequest({ turnId, sdkToolCallId: toolCallId }));
				if (!request) return { status: "failed", error: "The request wasn't allowed." };
				const { sandbox } = await openSandbox();
				const nixpkgsRev = await Effect.runPromise(currentNixpkgs(sandbox, channel));
				if (!nixpkgsRev) {
					return {
						status: "failed",
						error: `Couldn't reach ${NIXPKGS[channel]} to install from. Try again shortly.`,
					};
				}
				const wanted = { name, channel, nixpkgsRev };
				const kept = await run(software.packagesOf(request.pod));
				const installed = await Effect.runPromise(
					installSoftware(sandbox, wanted, [
						...kept.filter((other) => other.name !== name || other.channel !== channel),
						wanted,
					]),
				);
				if (installed.exitCode !== 0) {
					return {
						status: "failed",
						error: `Couldn't install ${name}: ${installed.stderr.text.trim().split("\n").at(-1) ?? "Nix failed"}`,
					};
				}
				await run(software.add(request, wanted));
				return {
					status: "installed",
					name,
					channel,
					note: "It's on the PATH of every command in the pod's sandbox now: run it by name.",
				};
			},
		}),
		refusal: () => undefined,
	};
}
