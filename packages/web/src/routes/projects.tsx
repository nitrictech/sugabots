import type { Project } from "@sugabots/contracts";
import { createRoute, Navigate, Outlet } from "@tanstack/react-router";
import { prefetchChat, useProjectChatPlace, useProjectChats } from "@/lib/chats.ts";
import { API_DID_NOT_ANSWER, failureMessage } from "@/lib/failure.ts";
import { chatLink } from "@/lib/links.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { findProject, useJoinProject, useProjects } from "@/lib/projects.ts";
import { FilesPage } from "@/screens/Files.tsx";
import { MobileOwner } from "@/shell/MobileHome.tsx";
import { OwnerNotFound } from "@/shell/OwnerNotFound.tsx";
import { ProjectsDirectory } from "@/shell/ProjectsDirectory.tsx";
import { Panes } from "@/shell/Shell.tsx";
import { Button } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import {
	ChatPage,
	ChatScreen,
	preloadChatScreenForWideLayout,
	RoutedChat,
	type SearchChange,
} from "./chat.tsx";
import { lazyNamed } from "./lazy-screen.tsx";
import { useProjectRouteOwner } from "./owner.ts";
import { type ChatSearch, validateChatSearch, validateFileSearch } from "./search.ts";
import { shellRoute } from "./workspace.tsx";

const NewChatPage = lazyNamed(() => import("@/screens/NewChatPage.tsx"), "NewChatPage");

/** Every project the person is in or could join, and making another. */
export const projectsRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/projects",
	component: () => (
		<Panes>
			<ProjectsDirectory />
		</Panes>
	),
});

export const projectRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/projects/$project",
	loader: preloadChatScreenForWideLayout,
	component: ProjectRoute,
});

/** A project's page beside the sidebar. */
function ProjectRoute() {
	const { project: slug } = projectRoute.useParams();
	const { data: projects, isPending, error } = useProjects();
	const project = findProject(projects, slug);
	if (isPending) return <Panes>{null}</Panes>;
	if (!project) return <OwnerNotFound kind="project" error={error} />;
	// A public project the person isn't in, opened by its address: what it is, and Join.
	if (!project.isMember) {
		return (
			<Panes>
				<JoinProject project={project} />
			</Panes>
		);
	}
	return (
		<Panes>
			<Outlet />
		</Panes>
	);
}

/** A project the person isn't in: its name and what it's for, with Join where they may. */
function JoinProject({ project }: { project: Project }) {
	const join = useJoinProject();
	return (
		<EmptyState
			title={project.name}
			actions={
				<>
					{project.permissions.join ? (
						<Button disabled={join.isPending} onClick={() => join.mutate(project.id)}>
							Join {project.name}
						</Button>
					) : (
						<span>Ask someone in it to add you.</span>
					)}
					{join.isError && <span role="alert">{failureMessage(join.error)}</span>}
				</>
			}
		>
			{project.description ?? "You're not in this project yet."}
		</EmptyState>
	);
}

/**
 * A project opened without a chat chosen: on a phone, its sidebar as a
 * page, to pick from, as a bot's is; on a wider screen, its newest chat, or,
 * while it has none, starting one, as a bot's index always does.
 */
export const projectIndexRoute = createRoute({
	getParentRoute: () => projectRoute,
	path: "/",
	loader: () => ChatPage.preload(),
	component: () => {
		const project = findProject(useProjects().data, projectIndexRoute.useParams().project);
		const wide = useMediaQuery(SIDE_BY_SIDE);
		if (!project) return null;
		return wide ? <OpenNewestChat project={project} /> : <MobileOwner owner={{ project }} />;
	},
});

function OpenNewestChat({ project }: { project: Project }) {
	const list = useProjectChats(project.id);
	if (list.isError) {
		return <EmptyState title="Could not open this project">{API_DID_NOT_ANSWER}</EmptyState>;
	}
	if (!list.data) return null;
	const [newest] = list.data.chats;
	if (!newest) return <ProjectNewChat project={project} />;
	return <Navigate {...chatLink({ project, chatId: newest.chat.id })} replace />;
}

/** Starting a chat in `project` from its first message. */
function ProjectNewChat({ project }: { project: Project }) {
	return <NewChatPage key={project.id} owner={{ project }} />;
}

/** Starting a chat in the project, from its first message. */
export const projectNewChatRoute = createRoute({
	getParentRoute: () => projectRoute,
	path: "/new",
	component: () => {
		const project = findProject(useProjects().data, projectNewChatRoute.useParams().project);
		return project ? <ProjectNewChat project={project} /> : null;
	},
});

export const projectFilesRoute = createRoute({
	getParentRoute: () => projectRoute,
	path: "/files",
	component: () => {
		const owner = useProjectRouteOwner();
		return owner ? <FilesPage owner={owner} /> : null;
	},
});

export const projectFileRoute = createRoute({
	getParentRoute: () => projectRoute,
	path: "/files/$file",
	validateSearch: (search: Record<string, unknown>) => validateFileSearch(search),
	component: () => {
		const owner = useProjectRouteOwner();
		const { file } = projectFileRoute.useParams();
		const { version } = projectFileRoute.useSearch();
		return owner ? <FilesPage owner={owner} selectedId={file} version={version} /> : null;
	},
});

/** One of a project's chats. */
export const projectChatRoute = createRoute({
	getParentRoute: () => projectRoute,
	path: "/$chat",
	validateSearch: (search: Record<string, unknown>) => validateChatSearch(search),
	// On every hover, not once per 30 s: the query cache, not the router,
	// decides what of the chat is still fresh.
	preloadStaleTime: 0,
	// Also run while the pointer is on a link here, so it is loading before the click.
	loader: ({ context, params }) => {
		prefetchChat(context.queries, params.chat);
		return ChatPage.preload();
	},
	component: () => {
		const { project, chat } = projectChatRoute.useParams();
		const navigate = projectChatRoute.useNavigate();
		const search = projectChatRoute.useSearch();
		return (
			<ProjectChatScreen
				projectSlug={project}
				chatId={chat}
				search={search}
				navigate={(change) => void navigate(change)}
			/>
		);
	},
});

/**
 * One of the chats of the project at `projectSlug`, one of its
 * chats or automations' feeds, at its own address; see `RoutedChat`.
 */
export function ProjectChatScreen({
	projectSlug,
	chatId,
	search,
	navigate,
}: {
	projectSlug: string;
	chatId: string;
	search: ChatSearch;
	navigate: (change: SearchChange) => void;
}) {
	return (
		<ChatScreen place={useProjectChatPlace(projectSlug, chatId)}>
			{(found, signedIn) => (
				<RoutedChat
					found={found}
					chatId={chatId}
					signedIn={signedIn}
					search={search}
					navigate={navigate}
				/>
			)}
		</ChatScreen>
	);
}
