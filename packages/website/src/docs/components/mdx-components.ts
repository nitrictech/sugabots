import type { MDXComponents } from "mdx/types";
import { ApprovalPlayground } from "@/docs/components/approval-playground";
import { Careful, Tip } from "@/docs/components/bot-aside";
import { BuiltInTools } from "@/docs/components/built-in-tools";
import { ChannelMap } from "@/docs/components/channel-map";
import { Chat, Say } from "@/docs/components/chat-demo";
import { CompactionDemo } from "@/docs/components/compaction-demo";
import { proseComponents } from "@/docs/components/prose";
import { ProviderGrid } from "@/docs/components/provider-grid";
import { RoleMatrix } from "@/docs/components/role-matrix";
import { ScheduleBuilder } from "@/docs/components/schedule-builder";
import { Steps } from "@/docs/components/steps";
import { WhoReplies } from "@/docs/components/who-replies";

/** Everything a docs page can use without importing it: Markdown's elements, styled, and the docs' own components. */
export const docsComponents: MDXComponents = {
	...proseComponents,
	ApprovalPlayground,
	BuiltInTools,
	Careful,
	ChannelMap,
	Chat,
	CompactionDemo,
	ProviderGrid,
	RoleMatrix,
	Say,
	ScheduleBuilder,
	Steps,
	Tip,
	WhoReplies,
};
