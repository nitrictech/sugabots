import type { InputOf } from "@sugabots/contracts/operations";
import { Effect, Scope } from "effect";
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
		].run(principal, input as never, { kind: "request", request: `test-${name}` });
		return {
			...(await runOnPostgres(Effect.provideService(called, TurnComputers.Service, computers))),
		};
	};
	return { step, call };
}
