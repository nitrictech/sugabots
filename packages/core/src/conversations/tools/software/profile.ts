import { Effect } from "effect";
import type { SandboxSoftware } from "../../../sandboxes/sandbox-software.ts";
import { Sandboxes } from "../../../sandboxes/sandboxes.ts";

/**
 * The Nix profile the pod's packages are installed into, shared by its agents.
 * The image puts its `bin` on every login shell's PATH.
 */
export const SOFTWARE_PROFILE = "/nix/var/nix/profiles/sugabots";

/** What the profile was last built from, so a sandbox that has it all builds nothing. */
const BUILT_FROM = `${SOFTWARE_PROFILE}.built-from`;

const INSTALL = { timeout: "15 minutes", maxOutputCharacters: 4_000 } as const;

/** nixpkgs as an agent names it, by the channel a package comes from. */
export const NIXPKGS = { stable: "nixpkgs", unstable: "nixpkgs-unstable" } as const;

/** Where a package is built from: nixpkgs at its commit. */
function flakeRef(software: SandboxSoftware.Package) {
	return `github:NixOS/nixpkgs/${software.nixpkgsRev}#${software.name}`;
}

/** What the profile holds when it has exactly `packages`, in a stable order. */
function builtFrom(packages: readonly SandboxSoftware.Package[]) {
	return packages.map(flakeRef).sort().join("\n");
}

/**
 * Gives the sandbox exactly the pod's packages, rebuilding its profile if they
 * changed since it was last built. Fails as the command does, with its output.
 */
export const syncSoftware = (
	sandbox: Sandboxes.Sandbox,
	packages: readonly SandboxSoftware.Package[],
) => {
	const want = builtFrom(packages);
	const refs = packages.map((software) => Sandboxes.shellQuoted(flakeRef(software))).join(" ");
	const rebuild = [
		`rm -f ${SOFTWARE_PROFILE} ${SOFTWARE_PROFILE}-*-link`,
		...(refs ? [`nix profile install --profile ${SOFTWARE_PROFILE} ${refs}`] : []),
		`printf '%s' ${Sandboxes.shellQuoted(want)} > ${BUILT_FROM}`,
	].join(" && ");
	return sandbox.exec(
		`if [ "$(cat ${BUILT_FROM} 2>/dev/null)" = ${Sandboxes.shellQuoted(want)} ]; then exit 0; fi; ${rebuild}`,
		INSTALL,
	);
};

/**
 * The nixpkgs commit `channel` is at now, which a new package is installed
 * from and kept at.
 */
export const currentNixpkgs = (sandbox: Sandboxes.Sandbox, channel: keyof typeof NIXPKGS) =>
	Effect.map(
		sandbox.exec(`nix flake metadata ${NIXPKGS[channel]} --json`, {
			timeout: "5 minutes",
			maxOutputCharacters: 20_000,
		}),
		(ran) => {
			if (ran.exitCode !== 0) return undefined;
			const rev = (JSON.parse(ran.stdout.text) as { locked?: { rev?: unknown } }).locked?.rev;
			return typeof rev === "string" ? rev : undefined;
		},
	);

/**
 * Installs one more package into the profile, then marks the profile as built
 * from `packages`, the pod's packages with it, so the next sync builds
 * nothing.
 */
export const installSoftware = (
	sandbox: Sandboxes.Sandbox,
	software: SandboxSoftware.Package,
	packages: readonly SandboxSoftware.Package[],
) =>
	sandbox.exec(
		[
			`nix profile install --profile ${SOFTWARE_PROFILE} ${Sandboxes.shellQuoted(flakeRef(software))}`,
			`printf '%s' ${Sandboxes.shellQuoted(builtFrom(packages))} > ${BUILT_FROM}`,
		].join(" && "),
		INSTALL,
	);
