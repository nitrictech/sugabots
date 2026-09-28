import type { MDXComponents } from "mdx/types";
import { ApprovalPlayground } from "@/docs/components/approval-playground";
import { Careful, Tip } from "@/docs/components/bot-aside";
import { BuiltInTools } from "@/docs/components/built-in-tools";
import { Activity, Chat, Say } from "@/docs/components/chat-demo";
import { CompactionDemo } from "@/docs/components/compaction-demo";
import { PodGallery } from "@/docs/components/pod-gallery";
import { PodMap } from "@/docs/components/pod-map";
import { proseComponents } from "@/docs/components/prose";
import { ProviderGrid } from "@/docs/components/provider-grid";
import { RoleMatrix } from "@/docs/components/role-matrix";
import { RoutineBuilder } from "@/docs/components/routine-builder";
import { Steps } from "@/docs/components/steps";
import { SystemAgents } from "@/docs/components/system-agents";
import { WhoReplies } from "@/docs/components/who-replies";

/** Everything a docs page can use without importing it: Markdown's elements, styled, and the docs' own components. */
export const docsComponents: MDXComponents = {
	...proseComponents,
	Activity,
	ApprovalPlayground,
	BuiltInTools,
	Careful,
	Chat,
	CompactionDemo,
	PodGallery,
	PodMap,
	ProviderGrid,
	RoleMatrix,
	RoutineBuilder,
	Say,
	Steps,
	SystemAgents,
	Tip,
	WhoReplies,
};
