import type { InputOf } from "@sugabots/contracts/operations";
import { Effect, Layer, Scope } from "effect";
import { ComputerProviderStore } from "../../../computers/computer-provider-store.ts";
import { ComputerSignIn } from "../../../computers/computer-sign-in.ts";
import type { ProjectComputers } from "../../../computers/project-computers.ts";
import { localComputerEgress, recordingIds } from "../../../computers/testing.ts";
import type { Database } from "../../../database/database.ts";
import { runOnPostgres } from "../../../database/testing.ts";
import {
	copyChatFile,
	readFile,
	runCommand,
	shareFile,
	useBrowser,
	writeFile,
} from "../../../operations/computers/use-computer.ts";
import type { BotPrincipal } from "../../../principal.ts";
import { TurnComputers } from "./turn-computers.ts";

/** The computers operations a bot works on its computer through, by name. */
const workOnComputer = {
	"computers.runCommand": runCommand,
	"computers.readFile": readFile,
	"computers.writeFile": writeFile,
	"computers.copyChatFile": copyChatFile,
	"computers.shareFile": shareFile,
	"computers.useBrowser": useBrowser,
};

type WorkOnComputer = keyof typeof workOnComputer;

/**
 * A step of `principal`'s turn, on `turn`'s computer, held open until `scope`
 * closes, and a call to one of the computers operations in it, made as the
 * bot loop makes it, against the test database. A call's refusal rejects.
 */
export async function stepOnComputer(
	computers: TurnComputers.Interface,
	principal: BotPrincipal,
	turn: TurnComputers.Turn,
	scope: Scope.Scope,
) {
	const step = await runOnPostgres(Scope.provide(scope)(computers.forStep(principal, turn)));
	const call = async <Name extends WorkOnComputer>(
		name: Name,
		input: InputOf<Name>,
	): Promise<Record<string, unknown>> => {
		const called: Effect.Effect<object, unknown, Database | TurnComputers.Service> = workOnComputer[
			name
		].run(principal, input as never, { kind: "request" });
		return {
			...(await runOnPostgres(Effect.provideService(called, TurnComputers.Service, computers))),
		};
	};
	return { step, call };
}

export const localComputerTools = (computerIds: Set<string>) =>
	Layer.mergeAll(ComputerSignIn.none, recordingIds(computerIds), localComputerEgress);

export async function destroyWorkspaceComputers(
	workspaceId: string,
	computers: ProjectComputers.Interface,
) {
	const providers = await runOnPostgres(
		Effect.provide(ComputerProviderStore.Service, ComputerProviderStore.layer),
	);
	const provider = await runOnPostgres(providers.enabled(workspaceId));
	if (provider) await runOnPostgres(computers.destroyAllMadeBy(workspaceId, provider));
}
