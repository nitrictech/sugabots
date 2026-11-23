# Glossary

The words Sugabots uses for its concepts. The product, the docs, bot prompts, comments and identifiers all use these and no others. The **Code** column is the name in the code. A few older names are kept on purpose because something outside the code stores or calls them; [Kept names](#kept-names) lists each with why. `node lint/check-glossary.ts --report` counts the retired words left elsewhere that it can check: those that only ever meant what is retired. A word whose meaning changed, such as task, routine, schedule or document, it leaves to the reader.

A comment explains with these definitions. "Whoever can talk to the bot can read and join its threads" is right; "everyone in the channel reads its tasks" is not, even where the code it describes is not renamed yet.

## People and the workspace

| Term | Meaning | Code |
|---|---|---|
| **Workspace** | A team's space: its people, bots, projects and settings. Everything below belongs to one workspace. A person may belong to several. | `workspace` |
| **Server** | One Sugabots installation, holding one or more workspaces. | `Installation` |
| **Person** | Someone with an account, in one or more workspaces. | `user` |
| **Role** | What a person may do in a workspace: **owner**, **admin**, **member** or **viewer**. | `workspace_member.role` |
| **Owner** | The one person who created the workspace, or was handed it. Can do everything an admin can, and hand ownership to someone else. | |
| **Admin** | May manage the workspace's settings, people and every bot, and sees private bots in lists (not their threads). Admins are members of every project people made. | |
| **Member** | May create bots and projects, talk to public bots and take part in projects. | |
| **Viewer** | May read what they reach and take part, but not create or change anything. | |
| **Invitation** | An email inviting someone to the workspace with a role. | `workspace_invite` |
| **Setup** | Making a new workspace: its creator becomes its owner. | `onboarding` |
| **Workspace settings** | Settings for the whole workspace: models, computers, web search, allowed and blocked hosts, time zone, people and usage. | |

## Bots

| Term | Meaning | Code |
|---|---|---|
| **Bot** | An AI teammate with a name, handle, look, model and instructions. Every bot people talk to, Personal Assistants included, has its own hidden **default project**, which it leads alone, so it has **threads**, **files**, **computers**, **connections** and **automations** just as a project does. | `bot` |
| **Handle** | A bot's or person's `@name`. A bot people made has one no other such bot in the workspace has. A person's is made from their name, so two people can share one, as "Sam Rose" and "Sam-Rose" both have `@sam-rose`, and a mention of it mentions both. | `handle` |
| **Creator** | The person who made a bot. The creator and admins may change it. | `createdById` |
| **Public bot** | A bot everyone in the workspace can see and talk to, along with its threads and files. Only public bots can be added to projects. | `visibility: "public"` |
| **Private bot** | A bot only its creator can see and talk to. Admins see that it exists, not its threads. Other bots may still ask it for help. | `visibility: "private"` |
| **Pinned bot** | A bot a person has pinned to their sidebar. The sidebar shows pinned bots only; the rest are found by browsing. A bot is pinned for its creator when made. | `pinned_bot` |
| **Personal Assistant** | Each person's own bot that nobody else can talk to: a guide that knows the workspace, points them to the right bot, tells them what needs their attention, and does things for them with their approval. Neither public nor private: only its person ever sees it. Always first in the sidebar. We manage its instructions; its person may change its name and look, add connections, and manage, run and answer the approvals of its **automations**. | `bot` with `assistantOf` |
| **System bot** | A bot that does background work and nobody talks to: **Compaction**, which shortens long conversations. | `systemBotKey`: `compact` |
| **Instructions** | A bot's prompt: who it is and how it works. A new bot starts by interviewing its creator to write them. | `prompt` |
| **Model** | The language model a bot runs on, from one of the workspace's model providers. | `model` |

## Projects and conversations

| Term | Meaning | Code |
|---|---|---|
| **Project** | A long-running piece of work shared by many people and many bots, led by one **lead bot**, holding its **threads**, **files**, **computers**, **connections**, **automations** and (to come) **tasks**. **Public** projects are listed in the project directory for anyone to find and join, but nobody is made a member; **private** ones are invitation-only. Any project member but a viewer may invite or remove people, and add bots, which must be public; a bot made private leaves every project people made, so it must first be replaced as lead in each of those it leads, as it must before it is deleted. The owner and admins are members of every project people made, and can be neither removed nor leave; anyone else may leave. | `project` |
| **Thread** | A conversation in a project, with the project's people and bots; a project is made of its threads and has no chat of its own. A **bot's threads** are the threads of its default project: conversations with that one bot. Whoever can talk to the bot can read and join its threads. A thread can be marked done. | `project_thread` |
| **Lead bot** | The one bot that works on a project and answers its threads by default. Every project has one, chosen from public bots; a bot's default project is led by the bot. | `project.lead_bot_id` |
| **Default project** | The hidden project every bot people talk to has (Personal Assistants included, system bots not), with only that bot in it as lead: where its own threads, files, computers, connections and automations live. Never listed in the project directory; nobody joins it; whoever can talk to the bot reaches it. Made and deleted with its bot. | `project` with `default_of_bot_id` |
| **Project member** | A person or bot in a project. | `project_member`, `project_bot` |
| **Project directory** | The list of public projects, and the private ones you're in, where you find, join and create projects. | |
| **Task** | *To come:* a piece of work on a project's board (Kanban), which people and bots move through its stages. | |
| **Message** | One post in a thread, by a person or a bot. | `message` |
| **Mention** | `@handle` in a message. Mentioning a bot asks it to reply; mentioning several bots asks each of them, at the same time. | `mention` |
| **Turn** | One bot working on a reply: reading, using tools and writing. | `turn` |
| **Floor** | Which bots reply to a message in a thread, the same rule in every project: the project's bots it mentions, each at once; else the project's bot it replies to; else, when it mentions only people, the lead bot reads it and may stay silent, reacting 👀; else the lead bot. Mentions of bots outside the project are ignored, so in a bot's own threads only that bot can answer, by the same rule: it may stay silent on a message that mentions only people, and with no model it does not answer one. In an automation feed, the lead bot answers every message unless it mentions only people, when no bot does; mentions bring in no other bot. | `FloorControl` |
| **Collaboration** | A bot asking any other bot, public or private, for help. The other bot works in a thread of its own and its answer comes back to the asker. | `collaboration` |
| **Tool** | Something a bot can do besides write: run commands, search the web, use a connection. | `tool` |
| **Approval** | A person allowing or refusing a tool call before it runs. | `approval` |
| **Inbox** | What needs a person's attention: mentions, replies, finished work. | `inbox` |

## A project's resources

A bot's resources are its default project's.

| Term | Meaning | Code |
|---|---|---|
| **File** | A file a person uploaded or a bot made, such as a document or an HTML page, in a thread. A project's **Files** are those from its threads, so a bot's are those from its own threads. | `file` |
| **Computer** | A machine a project's bots work on: run commands, keep files, use a desktop. A bot working in a project's thread uses the project's computer. An **online computer** runs at the workspace's computer provider and is paused when idle; a **personal computer** (to come, with the desktop app) is a person's own machine they let a bot use. | `computer` |
| **Computer provider** | The service the workspace's computers run at. | `computer_provider` |
| **Allowed host** | An internet address a computer may reach, set for the workspace or for one project. | `allowed_host`, `project_allowed_host` |
| **Blocked host** | An address no computer may reach. | `blocked_host` |
| **Connection** | A service a project is connected to: an MCP server or an HTTP endpoint, signed in with a key or OAuth, or its GitHub app. Belongs to one project. A bot working in a project's thread uses the project's connections and its own. | `connection` |
| **GitHub app** | A project's own GitHub App, made for it and installed on a GitHub account or organisation. Each project, so each bot, has at most one. | `connection` of kind `github` |
| **Repository** | A GitHub repository a project works on, picked from what its GitHub app's installation can reach. | `repository` |
| **Automation** | Work a project's lead bot does on its own, with instructions, started by its routines and triggers, in a thread of the project, on its computer. | `automation` |
| **Routine** | When an automation runs on a timetable, such as every weekday at 9. | `automation_trigger` of kind `routine` |
| **Trigger** | An event that starts an automation: a **webhook** call or a **GitHub** event. An automation may have several routines and triggers. | `automation_trigger` |
| **Automation feed** | Where an automation posts its results and lists its runs, in its project. Anyone in the project may answer there, and the lead bot replies. | `automation_feed` |
| **Run** | One time an automation ran, with its own thread. | `run` |
| **Usage** | What the workspace spent on models, by model and by bot. | `usage` |

## Kept names

Older names the code keeps on purpose, because something outside the code stores or calls them. Anywhere else, use the glossary's word; `lint/check-glossary.ts` refuses any of the retired words it checks, and the rest are for review to catch.

| Name | Where | Why it is kept |
|---|---|---|
| `agentId`, `threadId` | the turn and compaction workflows' payloads | The workflow engine stores payloads, and their idempotency keys are built from them, so runs already stored must still be read. |
| `routineId`, `executionId` | an automation run's workflow payload | The same: the workflow engine stores them. |
| `"routine"` (workflow name), `routine:` (lane key) | `automation.workflow.ts` | The workflow engine and the lanes store both. |
| `"routine"` (a turn's reason) | the `turn` table and the turn workflow's payloads | Stored turns and running workflows hold it. In code the reason is `automation`, mapped by `storedTurnReason` and `turnReasonOfStored`. |
| `artifacts/` (blob key prefix) | the blob store, for the files bots write (`files/files.ts`) | Stored blobs are kept under it, and a file's versions are added beside them. |
| Migration names and SQL | `packages/core/drizzle/` | Migrations are history: each names the tables as they were when it ran. |

### The `conversation` table

Not a word people see. Messages, turns, tool calls, compactions, read state and files each belong to one conversation, so they all point at one shared parent: a `conversation` row holding only what every kind has (its workspace, kind, title and times). What makes each kind what it is lives in its own table, keyed by the same id: `project_thread` (its project, who started it, when it was done or archived), `automation_feed`, `collaboration`, `run` and `system_conversation`. Say "conversation" in code that works the same for every kind; otherwise name the kind.

## Retired terms

Words for things that no longer exist. Don't use them, even in comments explaining old behaviour.

| Term | Was | Now |
|---|---|---|
| **Pod** | A group of people and bots sharing a computer, connections and access. | **Public** and **private** bots, and **projects**; resources belong to each **project**, a bot's to its default project. |
| **Personal pod** | A person's private pod. | Their **Personal Assistant** and **private** bots. |
| **Pod chat** | A pod's chat. | A project's **threads**. |
| **Bot channel** | A bot's own channel inside a pod. | The bot's **threads**. |
| **Crew** | The bots in a pod. | A project's bots. |
| **Channel** | A long-running space for many people and bots. | **Project**. |
| **Main chat**, **main thread** | A channel's or project's own conversation, beside its threads, which every project had and none could archive. | Gone: a project is made of its **threads**, any of which can be archived. |
| **Task** (a conversation with one bot) | A conversation with one bot about one piece of work. | A bot's **thread**. "Task" is kept for work on a project's board. |
| **Schedule** (an automation's) | When an automation runs on a timetable. | **Routine**. |
| **Artifact** | Something a bot made to keep. | A **file**. |
| **Document** (as a kind of thing) | What a bot makes. | A **file**; "document" only describes what a file contains. |
| **Sandbox** | A bot's machine. | **Computer**. |
| **Routine** (work a bot does on its own) | An automation as a whole. | **Automation**; a routine is now when an automation runs on a timetable. |
| **Agent** | A bot. | **Bot**. |
| **Summary**, **bot summary**, **Summariser** | A short account of one conversation, or of what a bot had been doing across its threads, and the system bot that wrote them. | Gone. |
| **Scribe** | The system bot that wrote summaries, named as a character. | Gone, with summaries. |
| **Direct message** | A conversation between two or more people, with no bots, which only its people saw. | Gone: people talk in a project's **threads**, or with bots. |
