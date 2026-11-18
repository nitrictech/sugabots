# Glossary

The words Sugabots uses for its concepts. The product, the docs, bot prompts, comments and identifiers all use these and no others. The **Code** column is the name in the code; where the code still uses an older one, [Code renames](#code-renames) maps it, and `node lint/check-glossary.ts --report` counts what is left.

A comment explains with these definitions. "Everyone who can see the bot reads its tasks" is right; "everyone in the pod reads its threads" is not, even where the code it describes is not renamed yet.

## People and the workspace

| Term | Meaning | Code |
|---|---|---|
| **Workspace** | A team's space: its people, bots, channels and settings. Everything below belongs to one workspace. A person may belong to several. | `workspace` |
| **Server** | One Sugabots installation, holding one or more workspaces. | `Installation` |
| **Person** | Someone with an account, in one or more workspaces. | `user` |
| **Role** | What a person may do in a workspace: **owner**, **admin**, **member** or **viewer**. | `workspace_member.role` |
| **Owner** | The one person who created the workspace, or was handed it. Can do everything an admin can, and hand ownership to someone else. | |
| **Admin** | May manage the workspace's settings, people and every bot, and sees private bots in lists (not their tasks). Admins are members of every channel. | |
| **Member** | May create bots and channels, talk to public bots and take part in channels. | |
| **Viewer** | May read what they reach and take part, but not create or change anything. | |
| **Invitation** | An email inviting someone to the workspace with a role. | `workspace_invite` |
| **Setup** | Making a new workspace: its creator becomes its owner. | `onboarding` |
| **Workspace settings** | Settings for the whole workspace: models, computers, web search, allowed and blocked hosts, time zone, people and usage. | |

## Bots

| Term | Meaning | Code |
|---|---|---|
| **Bot** | An AI teammate with a name, handle, look, model and instructions. Owns its tasks, files, computer, connections, repositories and automations. | `bot` |
| **Handle** | A bot's or person's `@name`, unique across the workspace. | `handle` |
| **Creator** | The person who made a bot. The creator and admins may change it. | `createdById` |
| **Public bot** | A bot everyone in the workspace can see and talk to, along with its tasks and files. Only public bots can be added to channels. | `visibility: "public"` |
| **Private bot** | A bot only its creator can see and talk to. Admins see that it exists, not its tasks. Other bots may still ask it for help. | `visibility: "private"` |
| **Pinned bot** | A bot a person has pinned to their sidebar. The sidebar shows pinned bots only; the rest are found by browsing. A bot is pinned for its creator when made. | `pinned_bot` |
| **Personal Assistant** | Each person's own bot that nobody else can talk to: a guide that knows the workspace, points them to the right bot, tells them what needs their attention, and does things for them with their approval. Neither public nor private: only its person ever sees it. Always first in the sidebar. We manage its instructions; its person may change its look and add connections. | `bot` with `assistantOf` |
| **System bot** | A bot that does background work and nobody talks to: the **Summariser** writes summaries, **Compaction** shortens long conversations. | `systemBotKey`: `summarise`, `compact` |
| **Instructions** | A bot's prompt: who it is and how it works. A new bot starts by interviewing its creator to write them. | `prompt` |
| **Model** | The language model a bot runs on, from one of the workspace's model providers. | `model` |

## Conversations

| Term | Meaning | Code |
|---|---|---|
| **Channel** | A long-running project shared by many people and many bots, holding its main chat, threads and files. **Public** channels are listed in the channel directory for anyone to find and join, but nobody is made a member; **private** ones are invitation-only. Any channel member or an admin may invite or remove people, and anyone may leave. Members add bots, which must be public; a bot made private leaves every channel. Admins are members of every channel. | `channel` |
| **Main chat** | A channel's own conversation, with all its people and bots, where work is discussed and threads are started. | `channel_conversation` with `main` |
| **Thread** | One focused conversation in a channel, beside its main chat, listed under the channel in the sidebar. Every channel member sees it. Only a channel has threads: a bot's conversations are tasks, and a reply to a message is just a message. | `channel_conversation` |
| **Channel member** | A person or bot in a channel. | `channel_member`, `channel_bot` |
| **Channel directory** | The list of public channels, and the private ones you're in, where you find, join and create channels. | |
| **Task** | A conversation with one bot about one piece of work. Whoever can see the bot may see it and join in. Can be marked done. | `task` |
| **Direct message** | A conversation between two or more people, with no bots. Only its people see it. | `direct_message` |
| **Message** | One post in a main chat, thread, task or direct message, by a person or a bot. | `message` |
| **Mention** | `@handle` in a message. Mentioning a bot asks it to reply; mentioning several bots asks each of them, at the same time. | `mention` |
| **Turn** | One bot working on a reply: reading, using tools and writing. | `turn` |
| **Floor** | Which bots reply to a message. In a task, the bot it's with; in a channel's main chat or threads, the bots mentioned, or the bot being replied to; in a direct message, none. | `FloorControl` |
| **Collaboration** | A bot asking any other bot, public or private, for help. The other bot works in a task of its own and its answer comes back to the asker. | `collaboration` |
| **Tool** | Something a bot can do besides write: run commands, search the web, use a connection. | `tool` |
| **Approval** | A person allowing or refusing a tool call before it runs. | `approval` |
| **Inbox** | What needs a person's attention: mentions, replies, finished work. | `inbox` |
| **Summary** | The Summariser's short account of one conversation. | `summary` |
| **Bot summary** | An at-a-glance account of what a bot has been doing across all its tasks. | `bot_summary` |

## A bot's resources

| Term | Meaning | Code |
|---|---|---|
| **File** | A file a person uploaded or a bot made, such as a document or an HTML page, in a task or a channel's conversation. A bot's **Files** are those from its tasks; a channel's are those from its main chat and threads. | `file` |
| **Computer** | A bot's one machine, where it runs commands and keeps files. Paused when idle. | `computer` |
| **Computer provider** | The service the workspace's computers run at. | `computer_provider` |
| **Allowed host** | An internet address a computer may reach, set for the workspace or for one bot. | `allowed_host` |
| **Blocked host** | An address no computer may reach. | `blocked_host` |
| **Connection** | A service a bot is connected to: an MCP server or an HTTP endpoint, signed in with a key or OAuth, or its GitHub app. Belongs to one bot. | `connection` |
| **GitHub app** | A bot's own GitHub App, made for it and installed on a GitHub account or organisation. Each bot has at most one. | `connection` of kind `github` |
| **Repository** | A GitHub repository a bot works on, picked from what its GitHub app's installation can reach. | `repository` |
| **Automation** | Work a bot does on its own, with instructions, started by its triggers. | `automation` |
| **Trigger** | What starts an automation: a **schedule**, a **webhook** call, or a **GitHub** event. An automation may have several, of any kind. | `automation_trigger` |
| **Run** | One time an automation ran, with its own task. | `run` |
| **Usage** | What the workspace spent on models, by model and by bot. | `usage` |

## Code renames

Old names still in the code, and what replaces them. Rename a name when you touch the code that uses it; `lint/check-glossary.ts` lists every retired word, and refuses the ones marked failing.

| Old name | New name |
|---|---|
| `agent`, `agentId`, `Agent*` | `bot`, `botId`, `Bot*` |
| `systemAgentKey`, system agent | `systemBotKey`, system bot |
| `provisionedKey: "personal-assistant"` | `assistantOf` |
| `pod`, `pod_member`, `podId` | `channel`, `channel_member`, `channelId` |
| `crew`, `crewOf` | the channel's bots, `channelBotsOf` |
| `thread` (the table) | `conversation`, see below |
| thread type `conversation` | `task` |
| thread type `pod_chat` | `channel_conversation`; `main` marks the main chat |
| thread type `direct`, `direct_member` | `direct_message`, `direct_message_member` |
| thread types `routine`, `routine_feed` | `run`, `automation_feed` |
| thread type `system_agent` | `system` |
| `thread_summary` | `summary` |
| `thread_file` | `file` (one table with what bots make) |
| `artifact`, `artifact_version` | `file`, `file_version` (one table with uploaded files) |
| `sandbox`, `sandbox_provider`, `sandbox_lease` | `computer`, `computer_provider`, `computer_lease` |
| `sandbox_allowed_host`, `sandbox_blocked_host` | `allowed_host`, `blocked_host` |
| `routine` | `automation` |
| `routine_trigger`, kind `cron` | `automation_trigger`, kind `schedule` |
| `routine_execution` | `run` |
| `activity` (the inbox) | `inbox` |
| `tool-approvals` | `approvals` |

### The `conversation` table

Not a word people see. Messages, turns, tool calls, summaries, read state and files each belong to one main chat, thread, task or direct message, so they all point at one shared parent: a `conversation` row holding only what every kind has (its workspace, kind, title and times). What makes each kind what it is lives in its own table, keyed by the same id: `task` (its bot, who started it, when it was done), `channel_conversation` (its channel, whether it's the main chat, when it was archived), `direct_message` and its members, `collaboration` and `run`. Say "conversation" in code that works the same for every kind; otherwise name the kind.

## Retired terms

Words for things that no longer exist. Don't use them, even in comments explaining old behaviour.

| Term | Was | Now |
|---|---|---|
| **Pod** | A group of people and bots sharing a computer, connections and access. | **Public** and **private** bots, and **channels**; resources belong to each **bot**. |
| **Personal pod** | A person's private pod. | Their **Personal Assistant** and **private** bots. |
| **Pod chat** | A pod's chat. | A channel's **main chat** and **threads**. |
| **Bot channel** | A bot's own channel inside a pod. | The bot's **tasks**. |
| **Crew** | The bots in a pod. | A channel's bots. |
| **Thread** (with a bot) | A conversation with one bot. | **Task**. A thread is a conversation in a channel. |
| **Artifact** | Something a bot made to keep. | A **file**. |
| **Document** (as a kind of thing) | What a bot makes. | A **file**; "document" only describes what a file contains. |
| **Sandbox** | A bot's machine. | **Computer**. |
| **Routine** | Work a bot does on its own, or one of its schedules. | **Automation**, and its **schedule** triggers. |
| **Agent** | A bot. | **Bot**. |
| **Scribe** | The system bot that writes summaries, named as a character. | **Summariser**. |
