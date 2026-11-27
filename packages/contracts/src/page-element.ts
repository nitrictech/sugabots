import type { TagParseRule } from "@tiptap/pm/model";

/*
 * The elements and nodes of a page read from HTML, as ProseMirror's parser
 * hands them to a parse rule. They are named through the rule's own type,
 * not the browser's: the API reads HTML with linkedom and is built without
 * the browser's types, so there they are any element and node, while here and
 * in the web app, which are built with them, they are the browser's, checked
 * in full.
 */

/** An element of a page read from HTML, as a parse rule is handed one: an HTML element. */
export type PageElement = Parameters<NonNullable<TagParseRule["getAttrs"]>>[0];

/** An element among another's children, which may be an SVG element as well as an HTML one. */
export type PageChildElement = PageElement["children"][number];

/** A node among an element's child nodes: an element, words, or a comment. */
export type PageNode = PageElement["childNodes"][number];
