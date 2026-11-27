import { type ContentMatch, Fragment, Mark, type Node, type NodeType } from "@tiptap/pm/model";

/**
 * `node` with everything in it holding what its schema allows: `node` itself
 * when it does already. A document's markdown can say what its schema has no
 * place for, such as a quote or a list item holding nothing, or code inside
 * a link, and a node its schema can't hold is one the editor can't show. So
 * what a node must hold and doesn't is added, empty; what stands where it is
 * allowed only inside another node is wrapped in that node, as words straight
 * in a list item are in a paragraph; and what can't be wrapped is replaced by
 * what it holds. What can't be placed anywhere, nor holds anything that can,
 * is left out, words included: words where no node that holds words may go,
 * or an image inside code.
 *
 * A mark its node doesn't allow is dropped, as is one that would push out a
 * mark kept already, as code pushes out every other. Marks come in the
 * schema's order, link first, so a link around code keeps its address.
 */
export function withValidContent(node: Node): Node {
	if (node.isLeaf) return node;
	const content = fittedContent(node.type, node.content.content.map(withValidContent));
	return content.eq(node.content) ? node : node.copy(content);
}

function fittedContent(type: NodeType, children: readonly Node[]): Fragment {
	const placed: Node[] = [];
	let match = type.contentMatch;
	const place = (node: Node) => {
		const child = withMarksAllowedIn(type, node);
		const missing = match.fillBefore(Fragment.from(child));
		const afterMissing = missing && match.matchFragment(missing)?.matchType(child.type);
		if (missing && afterMissing) {
			placed.push(...missing.content, child);
			match = afterMissing;
			return;
		}
		const wrapped = wrappedToFit(match, child);
		const afterWrapped = wrapped && match.matchType(wrapped.type);
		if (wrapped && afterWrapped) {
			placed.push(wrapped);
			match = afterWrapped;
			return;
		}
		// Left out only when it holds nothing that can be placed, as an image inside code.
		child.content.forEach(place);
	};
	children.forEach(place);
	const end = match.fillBefore(Fragment.empty, true);
	return Fragment.fromArray([...placed, ...(end?.content ?? [])]);
}

function withMarksAllowedIn(parent: NodeType, node: Node): Node {
	const marks = node.marks.reduce((kept, mark) => {
		if (!parent.allowsMarkType(mark.type)) return kept;
		const added = mark.addToSet(kept);
		return added.length === kept.length + 1 ? added : kept;
	}, Mark.none);
	return Mark.sameSet(marks, node.marks) ? node : node.mark(marks);
}

/** `node` inside the nodes that let it stand at `match`, or `undefined` when none do. */
function wrappedToFit(match: ContentMatch, node: Node): Node | undefined {
	const wrappers = match.findWrapping(node.type);
	if (!wrappers || wrappers.length === 0) return undefined;
	return wrappers.reduceRight<Node | undefined>(
		(inner, wrapper) => (inner ? (wrapper.createAndFill(null, inner) ?? undefined) : undefined),
		node,
	);
}
