export * as TurnComputers from "./turn-computers.ts";

import { posix } from "node:path";
import type { BotColor } from "@sugabots/contracts";
import { NoComputerProvider } from "@sugabots/contracts/errors/computers";
import type { InputOf, OutputOf } from "@sugabots/contracts/operations";
import { MAX_SHARED_FILE_MEGABYTES } from "@sugabots/contracts/operations/computers";
import { UserText, userText } from "@sugabots/errors";
import { Context, Effect, Layer, type Scope, Semaphore, Stream } from "effect";
import { contentType as mediaTypeForName } from "mime-types";
import { BlobStore } from "../../../blob-store/blob-store.ts";
import { reachOf } from "../../../computers/allowed-hosts.ts";
import { BOT_CACHES } from "../../../computers/computer-disk-clearing.ts";
import { ComputerProviderStore } from "../../../computers/computer-provider-store.ts";
import { Computers } from "../../../computers/computers.ts";
import { ProjectComputers } from "../../../computers/project-computers.ts";
import { effectRunner, serviceOperations } from "../../../database/database.ts";
import { ChatFileStore } from "../../../files/chat-file-store.ts";
import { Ids } from "../../../ids/ids.ts";
import type { BotPrincipal } from "../../../principal.ts";
import type { Approved } from "../../../proofs/approved.ts";
import {
	type CanUseChatComputer,
	proveCanUseChatComputer,
} from "../../../proofs/can-use-computer.ts";
import { named } from "../../../proofs/proof.ts";
import { processLayer, Tier } from "../../../tiers.ts";
import { type BrowserSession, browserSession, isBrowserTool } from "../browser/browser.ts";
import { type Failed, failed } from "../failed.ts";
import { MAX_IMAGE_BYTES, shownImageType } from "../images.ts";
import { unreadableFileRefusal } from "../unreadable-file.ts";
import { type Copy, copyIntoComputer, safeFileName } from "./attachments.ts";
import {
	type AttachToReply,
	arrivalNote,
	type ComputerAtPlace,
	diskNote,
	megabytes,
	networkNote,
	openOncePerTurn,
	type Place,
	placeOf,
	readSharableFile,
	type TurnComputer,
} from "./tools.ts";

/**
 * The computer a bot's turn works on: its chat's project's, opened by the
 * step's first call that needs it and kept for the rest of the step, which
 * holds a lease on it. The computers operations use it, each having proved
 * `CanUseChatComputer` for its call, and find the step's computer by the
 * turn and execution that proof names. A step that may not use it is still
 * told why in its note; its calls are refused by that proof.
 */
export interface Interface {
	/**
	 * The turn's computer for a step, opened on first use and found by the
	 * computers operations for the rest of the step. While the scope is open
	 * the turn's lease on it is renewed; it is released when the scope closes,
	 * which is when the step ends.
	 */
	readonly forStep: (
		principal: BotPrincipal,
		turn: Turn,
	) => Effect.Effect<Step, never, Scope.Scope>;
	readonly requireComputer: <P, C>(
		canUse: CanUseChatComputer<P, C>,
	) => Effect.Effect<void, NoComputerProvider>;
	readonly runCommand: <P, C, X>(
		canUse: CanUseChatComputer<P, C>,
		approved: Approved<P, X, [C], "computers.runCommand">,
		input: InputOf<"computers.runCommand">,
	) => Effect.Effect<OutputOf<"computers.runCommand">, NoComputerProvider>;
	readonly readFile: <P, C, X>(
		canUse: CanUseChatComputer<P, C>,
		approved: Approved<P, X, [C], "computers.readFile">,
		input: InputOf<"computers.readFile">,
	) => Effect.Effect<OutputOf<"computers.readFile">, NoComputerProvider>;
	readonly writeFile: <P, C, X>(
		canUse: CanUseChatComputer<P, C>,
		approved: Approved<P, X, [C], "computers.writeFile">,
		input: InputOf<"computers.writeFile">,
	) => Effect.Effect<OutputOf<"computers.writeFile">, NoComputerProvider>;
	/**
	 * Copies a file in the chat into the chat's folder in the computer. The
	 * file is looked up first, so an id that names none never starts the
	 * computer.
	 */
	readonly copyChatFile: <P, C, X>(
		canUse: CanUseChatComputer<P, C>,
		approved: Approved<P, X, [C], "computers.copyChatFile">,
		input: InputOf<"computers.copyChatFile">,
	) => Effect.Effect<OutputOf<"computers.copyChatFile">, NoComputerProvider>;
	/**
	 * Attaches a file from the computer to the turn's reply, where members see
	 * it as soon as it is. One file at a time, since each is held whole on its
	 * way out. Only a turn in a project's chat can share one.
	 */
	readonly shareFile: <P, C, X>(
		canUse: CanUseChatComputer<P, C>,
		approved: Approved<P, X, [C], "computers.shareFile">,
		input: InputOf<"computers.shareFile">,
	) => Effect.Effect<OutputOf<"computers.shareFile">, NoComputerProvider>;
	/** Calls one of the browser tools in the bot's browser in the chat. */
	readonly useBrowser: <P, C, X>(
		canUse: CanUseChatComputer<P, C>,
		approved: Approved<P, X, [C], "computers.useBrowser">,
		input: InputOf<"computers.useBrowser">,
	) => Effect.Effect<OutputOf<"computers.useBrowser">, NoComputerProvider>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/TurnComputers") {
	declare readonly [Tier]: "process";
}

/** A step's computer, as the operations find it. */
interface StepComputer {
	/** The project the computer is, which the operation's proof must name. */
	readonly projectId: string | null;
	readonly place: Place;
	readonly acceptsImages: boolean;
	/** The computer, opened on first use; none when the workspace has no computer provider. */
	readonly computer: TurnComputer | undefined;
	readonly browser: BrowserSession | undefined;
	readonly attach: AttachToReply | undefined;
	/** Lets one file at a time be shared. */
	readonly sharing: Semaphore.Semaphore;
}

const DIRECTORY_COMMAND = { timeout: "30 seconds", maxOutputCharacters: 2_000 } as const;
/** Of each stream, kept from the end. */
const MAX_OUTPUT_CHARACTERS = 20_000;
const MAX_READ_CHARACTERS = 100_000;
/** Enough for {@link MAX_READ_CHARACTERS} of any text: UTF-8 takes up to four bytes a character. */
const MAX_READ_BYTES = MAX_READ_CHARACTERS * 4;
/** The extensions of images read_file shows the model. */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

const NO_COMPUTER_NOTE =
	"You have no computer in this turn, so calls to the computer tools are refused. If the chat needs one, say so: someone who manages this project's computer can turn on your computer use.";

export const make = Effect.gen(function* () {
	const providers = yield* ComputerProviderStore.Service;
	const projectComputers = yield* ProjectComputers.Service;
	const computers = yield* Computers.Service;
	const files = yield* ChatFileStore.Service;
	const ids = yield* Ids.Service;
	const operation = yield* serviceOperations<Interface>("TurnComputers");
	// Each step's computer, by its turn and execution, for as long as the step runs.
	const steps = new Map<string, StepComputer>();
	const keyOf = (turnId: string, executionNumber: number) => `${turnId}/${executionNumber}`;

	/** The step's computer `canUse` was proved for, in the chat and project it names. */
	const stepOf = <P, C>(canUse: CanUseChatComputer<P, C>) =>
		Effect.gen(function* () {
			const step = steps.get(keyOf(canUse.turn, canUse.executionNumber));
			if (!step || step.projectId !== canUse.project) {
				return yield* Effect.die(
					new Error("A computer operation ran outside the step of the turn it was proved for"),
				);
			}
			if (!step.computer) return yield* new NoComputerProvider();
			return { ...step, computer: step.computer };
		});

	const forStep: Interface["forStep"] = (principal, turn) =>
		Effect.gen(function* () {
			const { workspaceId, projectId, turnId, chatId, botId, acceptsImages, attach } = turn;
			const key = keyOf(turnId, principal.executionNumber);
			const place = placeOf({ chatId, botId });
			// Each call proves this again; the note tells a bot that may not use the computer why it has none.
			const usable = yield* operation("forStep", canAskForComputer(principal));
			const provider = projectId === null ? undefined : yield* providers.enabled(workspaceId);
			const register = (step: StepComputer) =>
				Effect.acquireRelease(
					Effect.sync(() => steps.set(key, step)),
					// A step of the same turn and execution can start before this
					// one's scope has closed, and register under the same key.
					() =>
						Effect.sync(() => {
							if (steps.get(key) === step) steps.delete(key);
						}),
				);
			const sharing = Semaphore.makeUnsafe(1);
			if (!provider || projectId === null) {
				yield* register({
					projectId,
					place,
					acceptsImages,
					computer: undefined,
					browser: undefined,
					attach,
					sharing,
				});
				return { note: NO_COMPUTER_NOTE, atPlace: undefined, signsIn: false, asksForHosts: false };
			}
			const project = { workspaceId, projectId };
			const at = computers.forAccess(provider.access);
			const [reach, disk] = yield* operation(
				"forStep",
				Effect.all([reachOf(project, at), projectComputers.diskOf(project)]),
			);
			// Each step holds a lease of its own, so a step's release can't end the
			// lease of another step of the turn that is still running.
			const holder: ProjectComputers.Holder = { kind: "turn", id: `${key}/${yield* ids.random}` };
			yield* Effect.addFinalizer(() => projectComputers.release(holder));
			yield* Effect.forkScoped(
				projectComputers
					.renew(holder)
					.pipe(Effect.delay(ProjectComputers.LEASE_RENEWAL), Effect.forever),
			);
			// The browser and other tools work through promises, with the step's services.
			const run = effectRunner<never>({
				runPromiseExit: Effect.runPromiseExitWith(yield* Effect.context<never>()),
			});
			// Opening the computer serves every call in the step, so it stops when
			// the step ends rather than with the call that started it.
			const stepEnded = yield* Effect.abortSignal;
			const prepared = projectComputers.open(project, provider, holder).pipe(
				// The folders are made on first use, so any computer gains them.
				Effect.tap(({ computer }) =>
					computer.exec(`mkdir -p '${place.folder}' '${place.home}'`, DIRECTORY_COMMAND),
				),
			);
			const computer: TurnComputer = {
				open: openOncePerTurn(() => run(prepared, { signal: stepEnded })),
				run,
			};
			const browser = browserSession(computer, place, turn);
			yield* Effect.addFinalizer(() =>
				Effect.tryPromise(() => browser.close()).pipe(
					Effect.catch((cause) => Effect.logWarning("Closing a bot's browser failed", cause)),
				),
			);
			yield* register({ projectId, place, acceptsImages, computer, browser, attach, sharing });
			if (!usable) {
				return {
					note: NO_COMPUTER_NOTE,
					atPlace: undefined,
					signsIn: false,
					asksForHosts: false,
				};
			}
			return {
				note: [placeNote(place), networkNote(reach), diskNote(disk)]
					.filter((line) => line !== undefined)
					.join("\n\n"),
				atPlace: { ...computer, place },
				signsIn: at.capabilities.credentials !== "none",
				asksForHosts: reach.kind === "allowed-hosts-only",
			};
		});

	return Service.of({
		forStep,
		requireComputer: (canUse) => Effect.asVoid(stepOf(canUse)),

		runCommand: (canUse, _approved, { command, timeout_seconds }) =>
			Effect.flatMap(stepOf(canUse), ({ computer, place }) =>
				inComputer(computer, (opened) =>
					opened
						.exec(`bash -lc ${Computers.shellQuoted(command)}`, {
							cwd: place.folder,
							env: { HOME: place.home },
							timeout: `${timeout_seconds} seconds`,
							maxOutputCharacters: MAX_OUTPUT_CHARACTERS,
						})
						.pipe(
							Effect.map((execution) => ({
								...(execution.exitCode === null
									? { timedOut: true as const }
									: { exitCode: execution.exitCode }),
								stdout: shown(execution.stdout),
								stderr: shown(execution.stderr),
							})),
						),
				),
			),

		readFile: (canUse, _approved, { path }) =>
			Effect.flatMap(stepOf(canUse), ({ computer, place, acceptsImages }) => {
				const asImage =
					acceptsImages && IMAGE_EXTENSIONS.has(posix.extname(path).slice(1).toLowerCase());
				const where = absolute(place, path);
				return inComputer(computer, (opened) =>
					opened
						.readFile(where, asImage ? MAX_IMAGE_BYTES : MAX_READ_BYTES)
						.pipe(
							Effect.map(({ content, sizeBytes }) =>
								asImage ? imageRead(where, content, sizeBytes) : textRead(content, sizeBytes),
							),
						),
				);
			}),

		writeFile: (canUse, _approved, { path, content }) =>
			Effect.flatMap(stepOf(canUse), ({ computer, place }) =>
				inComputer(computer, (opened) =>
					opened
						.writeFile(absolute(place, path), new TextEncoder().encode(content))
						.pipe(Effect.as({ written: absolute(place, path) })),
				),
			),

		copyChatFile: (canUse, _approved, { file }) =>
			Effect.flatMap(stepOf(canUse), ({ computer, place }) =>
				files.read({ chatId: canUse.chat.value, fileId: file }).pipe(
					Effect.flatMap((found) =>
						inComputer(computer, (opened) => copyChatFileInto(opened, place, found, ids)),
					),
					Effect.catchTags({
						ChatFileNotFound: refusedRead,
						BlobStoreUnavailable: refusedRead,
						BlobStoreRejected: refusedRead,
					}),
				),
			),

		shareFile: (canUse, _approved, { path, name }) =>
			Effect.flatMap(stepOf(canUse), ({ computer, place, attach, sharing }) => {
				if (!attach) {
					return Effect.succeed(failed(userText`Files can be shared only in a project's chats.`));
				}
				return inComputer(computer, (opened) =>
					sharing.withPermits(1)(shareFrom(opened, absolute(place, path), name, attach)),
				);
			}),

		useBrowser: (canUse, _approved, { tool, arguments: input }) =>
			Effect.flatMap(stepOf(canUse), ({ browser, acceptsImages }) => {
				if (!browser || !isBrowserTool(tool, acceptsImages)) {
					return Effect.succeed(failed(userText`There is no browser tool by that name.`));
				}
				return Effect.tryPromise({
					try: (signal) => browser.call(tool, input, signal),
					catch: (cause) => cause,
				}).pipe(Effect.orDie);
			}),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(
	Layer.provide([
		ProjectComputers.layer,
		Computers.layer,
		ComputerProviderStore.layer,
		ChatFileStore.layer,
	]),
);

/** What a step is told of its computer, and what other tools working there use. */
export interface Step {
	/** What the model is told of the computer with the turn, as it may change between turns. */
	readonly note: string | undefined;
	/** The computer and the bot's place in it, when the bot may use it, for other tools that work there. */
	readonly atPlace: ComputerAtPlace | undefined;
	/** Whether the computer's provider signs its requests in, outside it. */
	readonly signsIn: boolean;
	/** Whether the computer reaches only the hosts allowed it, so the bot may ask for more. */
	readonly asksForHosts: boolean;
}

/** A turn that may work on the computer of the project its chat is in. */
export interface Turn {
	readonly workspaceId: string;
	/** The project whose computer the turn uses; none for a turn that works in no project. */
	readonly projectId: string | null;
	readonly turnId: string;
	readonly chatId: string;
	readonly botId: string;
	/** The bot's colour, which its desktop is drawn in. */
	readonly color: BotColor;
	/** Whether the bot browses so members watching its desktop can follow. */
	readonly naturalBrowsing: boolean;
	/** Whether the bot's model takes images, which results then may carry. */
	readonly acceptsImages: boolean;
	/**
	 * Attaches a file to the turn's reply, where members can be shown it. Given
	 * only for a turn in a project's chat, because a chat serves the files in
	 * it to its project's members; a run or automation feed has no page that
	 * shows a reply's files.
	 */
	readonly attach?: AttachToReply;
}

/** Whether the turn's bot may use its chat's computer now, as `CanUseChatComputer` decides. */
const canAskForComputer = (principal: BotPrincipal) =>
	named(principal, principal.chat, (acting, chat) =>
		Effect.asVoid(proveCanUseChatComputer(acting, chat)),
	).pipe(
		Effect.as(true),
		Effect.orElseSucceed(() => false),
	);

/**
 * Whether the turn's host request for `host` should wait for an approver:
 * not when the bot may not use its computer, nor for a host the workspace
 * blocked, which nobody could allow, so the call runs at once to be refused.
 */
/**
 * Runs `work` in the step's computer, turning a refusal it can act on into a
 * result, with what the bot needs to know of how the computer came back.
 */
function inComputer<A extends object>(
	computer: TurnComputer,
	work: (
		computer: Computers.Computer,
	) => Effect.Effect<A | Failed, Computers.Unavailable | Computers.FileFailed>,
): Effect.Effect<(A & { note?: UserText }) | Failed> {
	return Effect.gen(function* () {
		const opened = yield* Effect.tryPromise({
			try: () => computer.open(),
			catch: (cause) => cause,
		}).pipe(
			Effect.catchIf(
				(cause): cause is Computers.Unavailable => cause instanceof Computers.Unavailable,
				(unavailable) => Effect.succeed(failed(unavailable.userMessage)),
			),
			Effect.orDie,
		);
		if ("status" in opened) return opened;
		const note = arrivalNote(opened.arrival);
		const result = yield* work(opened.computer).pipe(
			Effect.catchTags({
				ComputerUnavailable: (failure) => Effect.succeed(failed(failure.userMessage)),
				ComputerFileFailed: (failure) =>
					Effect.succeed(failed(userText`${failure.reason}: ${UserText.unchecked(failure.path)}`)),
			}),
		);
		if ("status" in result && result.status === "failed") return result;
		return note ? { ...result, note } : result;
	});
}

/**
 * Where the bot works in its computer, for the turn's note rather than
 * `run_command`'s description: it names the chat, which differs between
 * chats, and the tools lead the provider's cached prompt.
 */
function placeNote(place: Place): string {
	return `On your computer, commands start in this chat's folder, ${place.folder}: kept between your turns in the chat, so clone and build here. Your home folder, ${place.home} (also $HOME), is kept across all your chats in the project: keep notes, settings and tools you want everywhere there. When the computer's disk runs short, the folders of finished chats, such as ended automation runs and chats marked resolved, are cleared, and so are the caches in your home (${BOT_CACHES.map((cache) => `~/${cache}`).join(", ")}): push anything that must outlast its chat, or keep it elsewhere in your home.`;
}

/** A path the bot gave, relative to the chat's folder unless it starts with `/`. */
function absolute(place: Place, path: string) {
	return posix.resolve(place.folder, path);
}

function shown(output: Computers.CapturedOutput) {
	return output.truncated ? `[earlier output left out]\n${output.text}` : output.text;
}

function textRead(content: Uint8Array, sizeBytes: number) {
	const text = new TextDecoder().decode(content);
	return text.length > MAX_READ_CHARACTERS || sizeBytes > content.length
		? {
				content: text.slice(0, MAX_READ_CHARACTERS),
				truncated: `Only the first ${MAX_READ_CHARACTERS} characters of this ${sizeBytes}-byte file are shown.`,
			}
		: { content: text };
}

function imageRead(where: string, content: Uint8Array, sizeBytes: number) {
	if (sizeBytes > MAX_IMAGE_BYTES) {
		return failed(userText`The image is larger than ${MAX_IMAGE_BYTES} bytes.`);
	}
	const mediaType = shownImageType(content);
	if (mediaType === undefined) {
		return failed(userText`The file isn't a PNG, JPEG, GIF or WebP image, whatever its name says.`);
	}
	return {
		text: `The image at ${where}.`,
		images: [{ data: Buffer.from(content).toString("base64"), mediaType }],
	};
}

/** Copies `found` into the computer, reading its bytes only when there is no copy yet. */
function copyChatFileInto(
	computer: Computers.Computer,
	place: Place,
	found: ChatFileStore.StoredFile,
	ids: Ids.Interface,
): Effect.Effect<Copy | Failed, Computers.Unavailable | Computers.FileFailed> {
	const content = Effect.map(Stream.runCollect(found.stream), (chunks) => Buffer.concat(chunks));
	return copyIntoComputer(computer, place.folder, found, content, ids).pipe(
		// The file can still go while it is read, such as with its chat.
		Effect.catchTags({
			ChatFileNotFound: refusedRead,
			BlobStoreUnavailable: refusedRead,
			BlobStoreRejected: refusedRead,
		}),
	);
}

function refusedRead(failure: ChatFileStore.FileNotFound | BlobStore.Failure) {
	return Effect.map(unreadableFileRefusal(failure), failed);
}

/** What sharing a file tells the bot: the name members see it under, and its id. */
interface Shared {
	shared: string;
	file: string;
	note: UserText;
}

/** Reads the file at `path` as the bots' user, then attaches it to the reply, refusing one too large. */
function shareFrom(
	computer: Computers.Computer,
	path: string,
	name: string | undefined,
	attach: AttachToReply,
): Effect.Effect<Shared | Failed, Computers.Unavailable | Computers.FileFailed> {
	return Effect.gen(function* () {
		const read = yield* readSharableFile(
			computer,
			path,
			(sizeBytes) =>
				userText`The file is ${megabytes(sizeBytes)} MB; files up to ${MAX_SHARED_FILE_MEGABYTES} MB can be shared.`,
		);
		if ("status" in read) return read;
		const shownName = safeFileName(name ?? posix.basename(path));
		const contentType =
			shownImageType(read.content) ?? (mediaTypeForName(shownName) || "application/octet-stream");
		return yield* attach({ name: shownName, contentType, content: read.content }).pipe(
			Effect.map((file): Shared | Failed => ({
				shared: file.name,
				file: file.id,
				note: userText`Members see it under your reply now; it needn't be described again.`,
			})),
			Effect.catch((failure) => {
				if (failure instanceof BlobStore.Unavailable)
					return notKept(
						failure,
						userText`The file couldn't be kept right now. Try again shortly.`,
					);
				if (failure instanceof BlobStore.Rejected)
					return notKept(failure, userText`The workspace's file storage refused the file.`);
				return Effect.succeed(failed(failure.userMessage));
			}),
		);
	});
}

/** Logs why the file store couldn't keep a shared file, and tells the bot `error`. */
function notKept(failure: BlobStore.Failure, error: UserText) {
	return Effect.logWarning("Keeping a file a bot shared failed", failure).pipe(
		Effect.as(failed(error)),
	);
}
