import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import type { Artifact } from "@sugabots/contracts";
import type { EditRequest } from "@sugabots/contracts/live-document";
import { Effect, Layer } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Doc, XmlElement, type XmlFragment, XmlText } from "yjs";
import { agent, pod, thread, user, workspace } from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { Artifacts } from "./artifacts.ts";
import { LiveDocuments } from "./live.ts";

describe.skipIf(!process.env.DATABASE_URL)("a live document, against Postgres", () => {
	let by: Artifacts.AgentInThread;

	/** The agents' authoring and the live documents it writes to, built together so they share one. */
	const services = () =>
		runOnPostgres(
			Effect.provide(
				Effect.all({ authoring: Artifacts.Authoring, live: LiveDocuments.Service }),
				Layer.merge(Artifacts.authoringLayer, LiveDocuments.layer),
			),
		);

	it("takes a person's and an agent's edits at once, each seeing the other's", async () => {
		const { authoring, live } = await services();
		const made = await runOnPostgres(
			authoring.create(by, {
				kind: "document",
				title: "Launch plan",
				content: "# Launch plan\n\nShip on Friday.",
			}),
		);
		const person = await joinAsPerson(live, made, "Kim");

		// The person retitles the plan in their editor.
		firstTextOf(person.document.getXmlFragment("default")).insert(
			"Launch plan".length,
			" (draft 2)",
		);
		const written = await runOnPostgres(
			authoring.edit(by, {
				artifactId: made.id,
				baseVersion: 1,
				oldText: "Ship on Friday.",
				newText: "Ship on Monday.",
			}),
		);

		await until(() => textOf(person.document).includes("Ship on Monday."));
		expect(textOf(person.document)).toBe("Launch plan (draft 2)Ship on Monday.");
		expect(written).toMatchObject({
			version: 2,
			content: "# Launch plan (draft 2)\n\nShip on Monday.",
		});
		expect(namesIn(person)).toEqual(["Kim", "Scribe"]);
		person.destroy();
	});

	it("gives an agent what people wrote, once they have left", async () => {
		const { authoring, live } = await services();
		const made = await runOnPostgres(
			authoring.create(by, { kind: "document", title: "Notes", content: "First draft." }),
		);
		const person = await joinAsPerson(live, made, "Kim");
		firstTextOf(person.document.getXmlFragment("default")).insert(0, "Kim's ");
		await until(async () =>
			(await runOnPostgres(authoring.read(by, made.id))).content.startsWith("Kim's"),
		);
		person.destroy();

		// A second process start: nothing in memory, only what was stored.
		const later = await services();
		expect(await runOnPostgres(later.authoring.read(by, made.id))).toMatchObject({
			content: "Kim's First draft.",
		});
	});

	it("shows a change somebody asked for from inside the document as a suggestion, writing nothing", async () => {
		const { authoring, live } = await services();
		const made = await runOnPostgres(
			authoring.create(by, {
				kind: "document",
				title: "Launch plan",
				content: "Ship on Friday.",
			}),
		);
		const person = await joinAsPerson(live, made, "Kim");
		// Kim asks Scribe for an edit from inside the document, which starts the thread Scribe works in.
		const requests = person.document.getMap<EditRequest>("editRequests");
		requests.set(by.threadId, {
			instruction: "Move it to Monday",
			agent: "Scribe",
			answered: false,
		});
		// Long enough for the request to reach the API's copy of the document, which nothing here can watch.
		await new Promise((resolve) => setTimeout(resolve, 150));

		const refusal = await runOnPostgres(
			Effect.flip(
				authoring.edit(by, {
					artifactId: made.id,
					baseVersion: 1,
					oldText: "Friday",
					newText: "Monday",
				}),
			),
		);

		expect(refusal._tag).toBe("ArtifactChangeSuggested");
		// The person's editor holds both wordings, marked; the document still reads as it did.
		await until(() => textOf(person.document).includes("Monday."));
		expect(textOf(person.document)).toMatch(
			/^Ship on <deletion[^>]*>Friday\.<\/deletion><insertion[^>]*>Monday\.<\/insertion>$/,
		);
		expect(await runOnPostgres(authoring.read(by, made.id))).toMatchObject({
			version: 1,
			content: "Ship on Friday.",
		});
		expect(requests.get(by.threadId)?.answered).toBe(true);
		person.destroy();
	});

	it("shows a whole paragraph an agent adds on request as a suggestion too", async () => {
		const { authoring, live } = await services();
		const made = await runOnPostgres(
			authoring.create(by, { kind: "document", title: "Launch plan", content: "Ship on Friday." }),
		);
		const person = await joinAsPerson(live, made, "Kim");
		person.document
			.getMap<EditRequest>("editRequests")
			.set(by.threadId, { instruction: "Add a line on sales", agent: "Scribe", answered: false });
		// Long enough for the request to reach the API's copy of the document, which nothing here can watch.
		await new Promise((resolve) => setTimeout(resolve, 150));

		const refusal = await runOnPostgres(
			Effect.flip(
				authoring.replace(by, {
					artifactId: made.id,
					baseVersion: 1,
					content: "Ship on Friday.\n\nBrief sales too.",
				}),
			),
		);

		expect(refusal._tag).toBe("ArtifactChangeSuggested");
		const blocks = person.document.getXmlFragment("default");
		await until(() => blocks.length === 2);
		// The new paragraph says it is proposed, in the attribute that reaches everyone.
		expect((blocks.get(1) as XmlElement).getAttribute("suggestion")).toContain("insertion");
		expect(await runOnPostgres(authoring.read(by, made.id))).toMatchObject({
			version: 1,
			content: "Ship on Friday.",
		});
		person.destroy();
	});

	it("neither deletes nor writes over a block from a newer version of the app, which it cannot read", async () => {
		const { authoring, live } = await services();
		const made = await runOnPostgres(
			authoring.create(by, { kind: "document", title: "Launch plan", content: "Ship on Friday." }),
		);
		const person = await joinAsPerson(live, made, "Kim");
		const blocks = person.document.getXmlFragment("default");
		blocks.push([new XmlElement("fromANewerVersion")]);
		// Long enough for the block to reach the API's copy of the document, which nothing here can watch.
		await new Promise((resolve) => setTimeout(resolve, 150));

		const read = await runOnPostgres(authoring.read(by, made.id));
		const refusal = await runOnPostgres(
			Effect.flip(
				authoring.edit(by, {
					artifactId: made.id,
					baseVersion: 1,
					oldText: "Friday",
					newText: "Monday",
				}),
			),
		);

		expect(read.content).toBe("Ship on Friday.");
		expect(refusal._tag).toBe("ArtifactUnreadable");
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(blocks.toArray().map((block) => (block as XmlElement).nodeName)).toEqual([
			"paragraph",
			"fromANewerVersion",
		]);
		expect(textOf(person.document)).toBe("Ship on Friday.");
		person.destroy();
	});

	it("leaves a document nobody has opened as its versions", async () => {
		const { authoring, live } = await services();
		const made = await runOnPostgres(
			authoring.create(by, {
				kind: "document",
				title: "Notes",
				content: "Text with a [^1] footnote.",
			}),
		);

		expect(await runOnPostgres(live.markdown(made.id))).toBeUndefined();
		expect(await runOnPostgres(authoring.read(by, made.id))).toMatchObject({
			content: "Text with a [^1] footnote.",
		});
	});

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Live ${stamp}`, slug: `live-${stamp}` })
				.returning(),
		);
		const [member] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Kim", email: `kim-${stamp}@example.com` })
				.returning(),
		);
		if (!space || !member) throw new Error("fixture");
		const workspaceId = space.id;
		const [room] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({ workspaceId, kind: "shared", name: "Planning", slug: `planning-${stamp}` })
				.returning(),
		);
		if (!room) throw new Error("fixture");
		const [writer] = await onDatabase((db) =>
			db
				.insert(agent)
				.values({
					workspaceId,
					podId: room.id,
					name: "Scribe",
					handle: `scribe-${stamp}`,
					color: "green",
					face: "pill",
					model: "claude-opus-4-1-20250805",
					createdById: member.id,
				})
				.returning(),
		);
		if (!writer) throw new Error("fixture");
		const [where] = await onDatabase((db) =>
			db
				.insert(thread)
				.values({
					workspaceId,
					podId: room.id,
					hostAgentId: writer.id,
					type: "collaboration",
					title: "Planning",
				})
				.returning(),
		);
		if (!where) throw new Error("fixture");
		by = { workspaceId, podId: room.id, agentId: writer.id, threadId: where.id };
	});
});

/**
 * A person's editor in `artifact`'s live document: the sync client the web
 * app uses, over a socket that goes straight to `live.join` in place of the
 * API's WebSocket route.
 */
async function joinAsPerson(live: LiveDocuments.Interface, artifact: Artifact, name: string) {
	class SocketToLive extends EventTarget {
		readyState = 0;
		binaryType = "arraybuffer";
		private participant: LiveDocuments.Participant | undefined;

		constructor() {
			super();
			void runOnPostgres(
				live.join(artifact, {
					send: (bytes) =>
						this.dispatchEvent(new MessageEvent("message", { data: bytes.slice().buffer })),
					close: () => this.close(),
				}),
			).then((participant) => {
				this.participant = participant;
				this.readyState = 1;
				this.dispatchEvent(new Event("open"));
			});
		}

		send(data: Uint8Array) {
			this.participant?.receive(data);
		}

		close() {
			if (this.readyState === 3) return;
			this.readyState = 3;
			this.participant?.leave();
			this.dispatchEvent(new Event("close"));
		}
	}

	const provider = new HocuspocusProvider({
		name: artifact.id,
		document: new Doc(),
		websocketProvider: new HocuspocusProviderWebsocket({
			url: "ws://live.invalid",
			WebSocketPolyfill: SocketToLive,
		}),
	});
	const synced = new Promise((resolve) => provider.on("synced", resolve));
	// A provider handed its socket doesn't start listening to it by itself.
	provider.attach();
	await synced;
	provider.setAwarenessField("user", { name });
	return provider;
}

/** The first run of text in the document, where a person's caret would be. */
function firstTextOf(fragment: XmlFragment): XmlText {
	const block = fragment.get(0) as XmlElement;
	const text = block.get(0);
	if (!(text instanceof XmlText)) throw new Error("The document doesn't start with text");
	return text;
}

const textOf = (document: Doc) =>
	document
		.getXmlFragment("default")
		.toArray()
		.map((block) => (block as XmlElement).toArray().join(""))
		.join("");

/** Who the person sees in the document, themselves included. */
const namesIn = (person: HocuspocusProvider) =>
	[...(person.awareness?.getStates().values() ?? [])]
		.map((state) => (state.user as { name: string } | undefined)?.name)
		.filter((name) => name !== undefined)
		.sort();

async function until(condition: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 5_000;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error("Waited 5 seconds for the document to catch up");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
