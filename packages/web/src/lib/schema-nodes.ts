import type { Node, Schema } from "@tiptap/pm/model";

/**
 * A node of `schema`'s type `name`, with `attributes` and holding `content`.
 * Throws when the schema has no such type, which only a schema built without
 * the extension that adds it lacks.
 */
export function nodeOf(
	schema: Schema,
	name: string,
	content?: Node | readonly Node[],
	attributes?: Record<string, unknown>,
): Node {
	const type = schema.nodes[name];
	if (!type) throw new Error(`The schema has no ${name} node`);
	return type.create(attributes ?? null, content);
}
