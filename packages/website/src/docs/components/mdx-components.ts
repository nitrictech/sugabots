import type { MDXComponents } from "mdx/types";
import { ApprovalPlayground } from "@/docs/components/approval-playground";
import { Careful, Tip } from "@/docs/components/bot-aside";
import { BuiltInTools } from "@/docs/components/built-in-tools";
import { Chat, Say } from "@/docs/components/chat-demo";
import { CompactionDemo } from "@/docs/components/compaction-demo";
import { ProjectMap } from "@/docs/components/project-map";
import { proseComponents } from "@/docs/components/prose";
import { ProviderGrid } from "@/docs/components/provider-grid";
import { RoleMatrix } from "@/docs/components/role-matrix";
import { RoutineBuilder } from "@/docs/components/routine-builder";
import { Steps } from "@/docs/components/steps";
import { WhoReplies } from "@/docs/components/who-replies";

/** Everything a docs page can use without importing it: Markdown's elements, styled, and the docs' own components. */
export const docsComponents: MDXComponents = {
	...proseComponents,
	ApprovalPlayground,
	BuiltInTools,
	Careful,
	ProjectMap,
	Chat,
	CompactionDemo,
	ProviderGrid,
	RoleMatrix,
	Say,
	RoutineBuilder,
	Steps,
	Tip,
	WhoReplies,
};
