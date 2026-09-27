import type { MDXComponents } from "mdx/types";
import { Careful, Tip } from "@/docs/components/bot-aside";
import { Activity, Chat, Say } from "@/docs/components/chat-demo";
import { PodMap } from "@/docs/components/pod-map";
import { proseComponents } from "@/docs/components/prose";
import { Steps } from "@/docs/components/steps";

/** Everything a docs page can use without importing it: Markdown's elements, styled, and the docs' own components. */
export const docsComponents: MDXComponents = {
	...proseComponents,
	Activity,
	Careful,
	Chat,
	PodMap,
	Say,
	Steps,
	Tip,
};
