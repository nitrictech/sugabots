import { randomUUID } from "node:crypto";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import type { Artifact, LiveArtifactKind } from "@sugabots/contracts";
import type { EditRequest } from "@sugabots/contracts/live-document";
import { eq } from "drizzle-orm";
import { Effect, Exit, Layer, Scope, Stream } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { applyUpdate, Doc, encodeStateAsUpdate, XmlElement, type XmlFragment, XmlText } from "yjs";
import { BlobStore } from "../blob-store/blob-store.ts";
import { agent, artifact, pod, thread, user, workspace } from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { unimplemented } from "../testing.ts";
import { Artifacts } from "./artifacts.ts";
import { LiveDocuments } from "./live.ts";

describe.skipIf(!process.env.DATABASE_URL)("a live document, against Postgres", () => {
	let by: Artifacts.AgentInThread;

	beforeEach(async () => {
		by = await anAgentInThread();
	});

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

	it("writes an agent's edit to a deck into its live copy, keeping the version as a snapshot of it", async () => {
		const { authoring, live } = await services();
		const made = await runOnPostgres(
			authoring.create(by, {
				kind: "slides",
				title: "Launch review",
				content: "<!-- layout: title -->\n\n# Launch review\n\n---\n\n## Goals\n\n- Ship on Friday",
			}),
		);
		const person = await joinAsPerson(live, made, "Kim");
		// Kim retitles the deck in their editor.
		textInSlide(person.document.getXmlFragment("default"), 0).insert(
			"Launch review".length,
			" (draft 2)",
		);
		await until(async () =>
			(await runOnPostgres(authoring.read(by, made.id))).content.includes("(draft 2)"),
		);

		const written = await runOnPostgres(
			authoring.edit(by, {
				artifactId: made.id,
				baseVersion: 1,
				oldText: "Ship on Friday",
				newText: "Ship on Monday",
			}),
		);

		expect(written).toMatchObject({
			version: 2,
			content:
				"<!-- layout: title -->\n\n# Launch review (draft 2)\n\n---\n\n<!-- layout: bullets -->\n\n## Goals\n\n- Ship on Monday",
		});
		await until(() => slideTexts(person.document).includes("Ship on Monday"));
		person.destroy();
	});

	it.each([
		{
			what: "document",
			kind: "document",
			says: "slides",
			content: "# Launch plan\n\nShip on Friday.",
		},
		{
			what: "deck",
			kind: "slides",
			says: "document",
			content: "<!-- layout: title -->\n\n# Launch review\n\n---\n\n## Goals\n\n- Ship on Friday",
		},
	] as const)(
		"neither deletes nor writes over a live $what whose artifact's row says its kind is $says, which it cannot read as that",
		async ({ kind, says, content }) => {
			const { authoring, live } = await services();
			const made = await runOnPostgres(authoring.create(by, { kind, title: "Launch", content }));
			const person = await joinAsPerson(live, made, "Kim");
			const shown = person.document.getXmlFragment("default").toString();
			// Nothing changes an artifact's kind: this stands in for a live document stored as another kind than its row says.
			await onDatabase((db) =>
				db.update(artifact).set({ kind: says }).where(eq(artifact.id, made.id)),
			);

			const rewritten = await Effect.runPromise(
				live.rewrite(made.id, authorIn(by.threadId), (markdown) =>
					markdown.replace("Friday", "Monday"),
				),
			);

			expect(rewritten).toMatchObject({ outcome: "blocked", blocked: "unreadable" });
			// Long enough for a write to reach the person's editor, which nothing here can watch.
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(person.document.getXmlFragment("default").toString()).toBe(shown);
			person.destroy();
		},
	);

	it("writes into a blank document someone has opened", async () => {
		const { authoring, live } = await services();
		const made = await runOnPostgres(
			authoring.create(by, { kind: "document", title: "Notes", content: "" }),
		);
		const person = await joinAsPerson(live, made, "Kim");

		const rewritten = await Effect.runPromise(
			live.rewrite(made.id, authorIn(by.threadId), () => "First line."),
		);

		expect(rewritten).toMatchObject({ outcome: "written", markdown: "First line." });
		await until(() => textOf(person.document) === "First line.");
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
});

describe.skipIf(!process.env.DATABASE_URL)("a live deck", () => {
	let by: Artifacts.AgentInThread;
	const scope = Effect.runSync(Scope.make());
	afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)));

	beforeEach(async () => {
		by = await anAgentInThread();
	});

	/**
	 * The live documents over `blobs`, a blob store in memory standing in for
	 * the one beside the versions, running until `running` closes. Another run
	 * over the same `blobs` is the API started again.
	 */
	const liveDocuments = (blobs = new Map<string, Uint8Array>(), running = scope) =>
		runOnPostgres(
			LiveDocuments.make.pipe(
				Effect.provide(
					unimplemented(BlobStore.Service, {
						get: (key) =>
							Effect.fromNullishOr(blobs.get(key)).pipe(
								Effect.map((bytes) => ({
									stream: Stream.succeed(bytes),
									contentType: "application/octet-stream",
									size: bytes.length,
								})),
								Effect.mapError(() => new BlobStore.NotFound({ key })),
							),
						put: (key, content) =>
							Stream.runCollect(content.stream).pipe(
								Effect.map((chunks) => {
									const bytes = Buffer.concat(chunks);
									blobs.set(key, bytes);
									return { size: bytes.length };
								}),
							),
					}),
				),
				Scope.provide(running),
			),
		);

	/** An artifact of `kind` in the pod, holding `content`, which nobody has opened. */
	const anArtifact = async (kind: LiveArtifactKind, content: string) => {
		const [row] = await onDatabase((db) =>
			db
				.insert(artifact)
				.values({ workspaceId: by.workspaceId, podId: by.podId, kind, title: "Launch review" })
				.returning(),
		);
		if (!row) throw new Error("fixture");
		return { id: row.id, content };
	};

	/** A deck nobody has opened, holding `content`. */
	const aDeck = (content: string) => anArtifact("slides", content);

	const planner = () => authorIn(randomUUID());

	const SIX_SLIDES = [
		"<!-- layout: title -->\n\n# Launch review",
		"<!-- layout: section -->\n\n## Where we are",
		"<!-- layout: bullets -->\n\n## Goals\n\n- Ship on Friday\n- Tell support first",
		"<!-- layout: quote -->\n\n> Nothing a person writes is lost.",
		"<!-- layout: bullets -->\n\n## Risks\n\n- None yet",
		"<!-- layout: section -->\n\n## Questions",
	].join("\n\n---\n\n");

	it("changes only the slide a rewrite changes, keeping what a person typed elsewhere before it arrived", async () => {
		const live = await liveDocuments();
		const made = await aDeck(SIX_SLIDES);
		const person = await joinAsPerson(live, made, "Kim");
		const content = person.document.getXmlFragment("default");
		const elementsBefore = elementsIn(content);
		// What Kim types into the fifth slide, before the rewrite reaches their editor.
		const typing = new Doc();
		applyUpdate(typing, encodeStateAsUpdate(person.document));
		textInSlide(typing.getXmlFragment("default"), 4).insert("Risks".length, " we see");

		const rewritten = await Effect.runPromise(
			live.rewrite(made.id, planner(), (markdown) =>
				markdown.replace("Ship on Friday", "Ship on Monday"),
			),
		);
		await until(() => slideTexts(person.document).includes("Ship on Monday"));
		applyUpdate(person.document, encodeStateAsUpdate(typing));

		expect(rewritten?.outcome).toBe("written");
		// No slide, and nothing in one, was put in another's place: each is changed where it is.
		const elementsAfter = elementsIn(content);
		expect(elementsAfter).toHaveLength(elementsBefore.length);
		expect(elementsAfter.every((element, index) => element === elementsBefore[index])).toBe(true);
		await until(async () =>
			((await Effect.runPromise(live.markdown(made.id))) ?? "").includes("Risks we see"),
		);
		expect(await Effect.runPromise(live.markdown(made.id))).toBe(
			SIX_SLIDES.replace("Ship on Friday", "Ship on Monday").replace("## Risks", "## Risks we see"),
		);
		person.destroy();
	});

	it("shows a layout an agent was asked for from inside the deck on the slide, reading as before", async () => {
		const live = await liveDocuments();
		const made = await aDeck(SIX_SLIDES);
		const author = planner();
		const person = await joinAsPerson(live, made, "Kim");
		person.document.getMap<EditRequest>("editRequests").set(author.threadId, {
			instruction: "Put the goals in two columns",
			agent: "Planner",
			answered: false,
		});
		// Long enough for the request to reach the API's copy of the document, which nothing here can watch.
		await new Promise((resolve) => setTimeout(resolve, 150));

		const rewritten = await Effect.runPromise(
			live.rewrite(made.id, author, (markdown) =>
				markdown.replace(
					"<!-- layout: bullets -->\n\n## Goals",
					"<!-- layout: columns -->\n\n## Goals",
				),
			),
		);

		expect(rewritten?.outcome).toBe("suggested");
		const goals = person.document.getXmlFragment("default").get(2) as XmlElement;
		await until(() => goals.getAttribute("layout") === "columns");
		// The slide says, to every editor, the layout it is proposed to have and the one it has.
		expect(JSON.parse(goals.getAttribute("suggestion") as string)).toMatchObject([
			{
				type: "modification",
				attrs: { attrName: "layout", previousValue: "bullets", newValue: "columns" },
			},
		]);
		expect(await Effect.runPromise(live.markdown(made.id))).toBe(SIX_SLIDES);
		person.destroy();
	});

	it("neither deletes nor writes over a part of a slide from a newer version of the app", async () => {
		const live = await liveDocuments();
		const made = await aDeck(SIX_SLIDES);
		const person = await joinAsPerson(live, made, "Kim");
		const body = (person.document.getXmlFragment("default").get(1) as XmlElement).get(
			0,
		) as XmlElement;
		body.push([new XmlElement("fromANewerVersion")]);
		// Long enough for the block to reach the API's copy of the document, which nothing here can watch.
		await new Promise((resolve) => setTimeout(resolve, 150));

		const rewritten = await Effect.runPromise(
			live.rewrite(made.id, planner(), (markdown) => markdown.replace("Friday", "Monday")),
		);

		expect(rewritten).toMatchObject({ outcome: "blocked", blocked: "unreadable" });
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(body.toArray().map((block) => (block as XmlElement).nodeName)).toEqual([
			"heading",
			"fromANewerVersion",
		]);
		person.destroy();
	});

	it.each([
		{ what: "deck", kind: "slides", content: SIX_SLIDES },
		{ what: "document", kind: "document", content: "# Launch plan\n\nShip on Friday." },
	] as const)(
		"gives an editor that kept a $what nobody changed the same one back after the API restarts, not a second copy",
		async ({ kind, content }) => {
			const made = await anArtifact(kind, content);
			const blobs = new Map<string, Uint8Array>();
			const firstRun = Effect.runSync(Scope.make());
			const person = await joinAsPerson(await liveDocuments(blobs, firstRun), made, "Kim");
			const held = person.document;
			const shown = held.getXmlFragment("default").toString();

			// The API stops and starts again while Kim's editor stays open, holding its copy.
			await Effect.runPromise(Scope.close(firstRun, Exit.void));
			person.destroy();
			const restarted = await liveDocuments(blobs);
			const rejoined = await joinAsPerson(restarted, made, "Kim", held);
			// Long enough for what the editor held to reach the API's copy of the document, which nothing here can watch.
			await new Promise((resolve) => setTimeout(resolve, 150));

			expect(held.getXmlFragment("default").toString()).toBe(shown);
			expect(await Effect.runPromise(restarted.markdown(made.id))).toBe(made.content);
			rejoined.destroy();
		},
	);

	it("gives an editor that kept a deck nobody changed the same deck back when it rejoins, after everyone had left", async () => {
		const live = await liveDocuments();
		const made = await aDeck(SIX_SLIDES);
		const person = await joinAsPerson(live, made, "Kim");
		const held = person.document;
		const shown = held.getXmlFragment("default").toString();

		// Kim, alone in the deck, drops off and reconnects with the copy their editor kept.
		person.destroy();
		// Long enough for the API to see that nobody is left in the deck, which nothing here can watch.
		await new Promise((resolve) => setTimeout(resolve, 150));
		const rejoined = await joinAsPerson(live, made, "Kim", held);
		// Long enough for what the editor held to reach the API's copy of the deck.
		await new Promise((resolve) => setTimeout(resolve, 150));

		expect(held.getXmlFragment("default").toString()).toBe(shown);
		expect(await Effect.runPromise(live.markdown(made.id))).toBe(SIX_SLIDES);
		rejoined.destroy();
	});
});

/**
 * An agent in a thread of its own, in a pod of a workspace of its own, which
 * a case's artifacts are made in.
 */
async function anAgentInThread(): Promise<Artifacts.AgentInThread> {
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
	return { workspaceId, podId: room.id, agentId: writer.id, threadId: where.id };
}

/** An agent changing a live document from the thread `threadId`, as people in it see it. */
const authorIn = (threadId: string): LiveDocuments.Author => ({
	name: "Planner",
	threadId,
	look: { color: "green", face: "pill", shape: "circle" },
});

afterAll(async () => {
	await closeDatabase();
});

/**
 * A person's editor in the live document of `made`, an artifact a case made:
 * the sync client the web app uses, over a socket that goes straight to
 * `live.join` in place of the API's WebSocket route. It holds `document`,
 * which an editor that was in the live document before and kept its copy
 * brings back with it.
 */
async function joinAsPerson(
	live: LiveDocuments.Interface,
	made: Pick<Artifact, "id" | "content">,
	name: string,
	document = new Doc(),
) {
	class SocketToLive extends EventTarget {
		readyState = 0;
		binaryType = "arraybuffer";
		private participant: LiveDocuments.Participant | undefined;

		constructor() {
			super();
			void Effect.runPromise(
				live.join(made, {
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
		name: made.id,
		document,
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

/** The first run of text on a deck's slide `index`: its title, where a person's caret would be. */
function textInSlide(fragment: XmlFragment, index: number): XmlText {
	const slide = fragment.get(index) as XmlElement;
	const body = slide.get(0) as XmlElement;
	const text = (body.get(0) as XmlElement).get(0);
	if (!(text instanceof XmlText)) throw new Error(`Slide ${index + 1} doesn't start with text`);
	return text;
}

/** The text on a deck's slides, each slide's run together. */
const slideTexts = (document: Doc) =>
	elementsIn(document.getXmlFragment("default"))
		.flatMap((element) => element.toArray())
		.filter((child) => child instanceof XmlText)
		.map(String)
		.join(" ");

/** Every element in shared content, depth first. */
const elementsIn = (shared: XmlFragment | XmlElement): XmlElement[] =>
	shared
		.toArray()
		.filter((child) => child instanceof XmlElement)
		.flatMap((element) => [element, ...elementsIn(element)]);

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
