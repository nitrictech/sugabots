# Glossary

**One name for each thing. Synonyms are banned.**

The words Sugabots uses for its concepts, and for how it is built. The product, the docs, bot prompts, comments, identifiers and commit messages all use these and no others. If a word you need isn't here, add it here first, in the same change. If two words seem to mean the same thing, one of them is wrong.

Each table's **Banned synonyms** are words members reach for that mean the same thing: don't use them for it. [Retired terms](#retired-terms) are banned too.

This glossary describes the terms used in this version.

A library's word, such as Effect's `Layer`, `Scope` or `Workflow`, MCP's tool or models.dev's price tiers, means only what that library means by it.

A comment explains with these definitions. "Whoever can talk to the bot can read and join its chats" is right; "everyone in the channel reads its tasks" is not, even where the code it describes is not renamed yet.

## Members and the workspace

| Term | Meaning | Banned synonyms |
|---|---|---|
| **Workspace** | A team's space: its members, bots, projects and settings. Everything below belongs to one workspace. A member may belong to several. | organisation, org, tenant, account |
| **Server** | One Sugabots installation, holding one or more workspaces. | instance, deployment, site |
| **Member** | Someone with an account, in one or more workspaces. | human, individual, person, user |
| **Role** | What a member may do in a workspace: **owner**, **admin**, **editor** or **viewer**. | access level, permission level |
| **Owner** | The one member who created the workspace, or was handed it. Can do everything an admin can, and **hand over** ownership to another member in the workspace. Only the owner may make or remove admins. | super admin, creator (a bot's), transfer (of ownership) |
| **Admin** | May manage the workspace's settings, its members (but not other admins) and every bot (a personal bot, Personal Assistants included, only to delete it or switch off its automations and connectors), and knows personal bots exist (not their chats). Admins are members of every project members made. | superuser, moderator, manager |
| **Editor** | May create bots and projects, talk to public bots and take part in projects. | user (for this role) |
| **Viewer** | May read what they reach, take part in chats, and make Personal Assistants. They can manage their own personal bots and start their automation runs. | guest, observer, read-only member |
| **Invitation** | An email inviting someone to the workspace with a role. It stays **pending** until accepted, expires after a set number of days, and can be sent again. | invite (as a noun), join link, outstanding invite |
| **Notification** | A push or email telling a member something needs them. It goes to the members who reach where it happened; an approval also goes to its approvers, who see only its fixed fields if they don't reach the chat. | alert, ping |
| **Membership** | A member's place in one workspace, with its role. Role changes and removal act on a membership. | seat, enrolment |
| **Operator** | Whoever runs a server: sets its server settings and reads its log messages. | sysadmin, host |

## Bots

| Term | Meaning | Banned synonyms |
|---|---|---|
| **Bot** | An AI teammate with a name, handle, avatar, model and instructions. Every bot members talk to, Personal Assistants included, has its own hidden **default project**, which it leads alone, so it has **chats**, **files**, **computers**, **connectors** and **automations** just as a project does. | agent, AI, assistant (except a Personal Assistant), character, persona, model |
| **Handle** | A bot's or member's `@name`. A bot members made has one no other such bot in the workspace has. A Personal Assistant's is unique only among its creator's: each member's first is `@personal-assistant`, the next `@personal-assistant-2`, and no other bot may take those. A member's is made from their name, so two members can share one, as "Sam Rose" and "Sam-Rose" both have `@sam-rose`, and a mention of it mentions both. | username, tag |
| **Creator** | The member who made a bot. They manage a personal bot of their own whatever their role. They can manage a public or private bot they made if they reach it and have a role other than viewer. | owner (a role), maker |
| **Public bot** | A bot everyone in the workspace can see and talk to, along with its chats and files. It can be added to any project. Whoever can change its settings can make it private. | shared bot, workspace bot |
| **Private bot** | A bot only its members can see and talk to, and whose chats and files only they read. Its members are the workspace's owner and admins, its creator and anyone invited. A bot converted during an upgrade keeps its former membership, so its creator may need to be added back. Any bot member except a viewer can invite or remove members. The owner, admins and any creator who is a member stay in the bot while they belong to the workspace and hold that status. A private bot can join and lead private projects. Project members can talk to it there and other bots there may ask it for help. Whoever can change its settings can make it public, clearing the member list. | unlisted bot, invite-only bot |
| **Personal bot** | A bot only its creator can see and talk to, which acts with their permissions: acting for them, it reaches what they reach, within its turn's bounds, and asks them before any call that changes something. It can't be shared: whether a bot is personal is chosen when it is made, and never changes. Its creator manages it, whatever their role. Admins see that it exists, not its chats. It can't be added to projects, so no other bot can ask it for help. | hidden bot, secret bot |
| **Personal Assistant** | A personal bot with the workspace guide's tools and instructions we manage: a guide that knows the workspace, points its creator to the right bot, tells them what needs their attention, and does things for them with their approval. Each member is given one as they first join a workspace, which counts them as its creator; they may make more, or delete theirs and have none. Its creator manages it as any personal bot of theirs, whatever their role, its **automations** included, but not its instructions, which we keep, nor its handle. Its creator's Personal Assistants always sit at the top of their sidebar, and can't be unpinned. | PA (in the product), concierge |
| **Workspace guide** | A Personal Assistant's tool for its creator's workspace: the projects they see, the bots they reach and what waits for them, with a link to each. Other bots don't have it. | directory, overview |
| **System bot** | A bot that does background work and nobody talks to: **Compaction**, which shortens long chats. | internal bot, service bot, background bot |
| **Instructions** | A bot's prompt: who it is and how it works. A new bot starts by interviewing its creator to write them. | system prompt, persona, profile |
| **Model** | The language model a bot runs on, from one of the workspace's model providers. | LLM (in the product), engine, brain |
| **Interview** | How a new bot asks its creator questions to write its instructions. | onboarding (a bot's), setup wizard |
| **Model provider** | A service the workspace's models come from, signed in with a key. | LLM provider, vendor, backend |
| **Built-in tool** | A tool Sugabots ships, such as running a command or searching the web, rather than one from a connector. | native tool, core tool, system tool |
| **Connector tool** | A tool a connector's server describes, with the server's own name, description and hints. | MCP tool, server tool, remote tool |
| **Tool call** | One use of a tool in a step: its input, and its output or error. | function call, invocation, tool part |
| **Tool source** | What a tool call reached: a connector, or one built-in tool such as web search. | app |
| **Subscription sign-in** | Signing a model provider in with a member's plan instead of a key. | OAuth (for this), account link |
| **Computer use** | A bot's switch that lets it work on its project's computer. The bot's creator, the workspace's owner or an admin can turn it on if they can change the bot's settings. It works while the workspace has an enabled computer provider. | sandbox access, shell access |
| **Description** | One line on what a bot is for, read by members and other bots. Separate from its instructions. | bio, tagline, summary |
| **Compacted history** | What a bot rereads in place of a long chat's older messages: a condensed account of them, then the newest messages word for word. Nothing in the chat is deleted. | summary, recap, truncation |

## Projects and chats

| Term | Meaning | Banned synonyms |
|---|---|---|
| **Project** | A long-running piece of work shared by many members and many bots, led by one **lead bot**, holding its **chats**, **files**, **computers**, **connectors** and **automations**. **Public** projects are open to anyone in the workspace to find and join, but nobody is made a member; **private** ones are invitation-only. Any project member but a viewer may invite or remove members, and add bots: a public bot to any project, a private bot only to a private one, and a personal bot to none. A project with a private bot stays private until the bot leaves, and a bot made private leaves every public project, so it must first be replaced as lead in each public one it leads, as it must in every one before it is deleted. The owner and admins are members of every project members made, and can be neither removed nor leave; anyone else may leave. | space, room, team, folder, workspace |
| **Chat** | Anywhere messages are posted. Most are a project's chats, with its members and bots: a project is made of its chats, with no main chat beside them. A **bot's own chats** are the chats of its default project. The bot's visibility decides who can take part: everyone in the workspace for a public bot, its members for a private bot, and only its creator for a personal bot. A project's chat can be marked resolved. An automation's feed, a run and a system bot's work each have a chat of their own too. | thread, topic, room, DM, conversation |
| **Lead bot** | The one bot that works on a project and answers its chats by default. Every project has one, chosen from the bots that may be in it: a public bot for any project, or a private bot for a private one. A bot's default project is led by the bot. | main bot, primary bot, default bot |
| **Default project** | The hidden project every bot members talk to has (Personal Assistants included, system bots not), with only that bot in it as lead: where its own chats, files, computers, connectors and automations live. Nobody finds or joins it; whoever can talk to the bot reaches it. Made and deleted with its bot. | home project, personal project, bot project |
| **Project member** | A member or bot in a project. | collaborator (a collaboration is a bot asking a bot) |
| **Message** | One post in a chat, by a member or a bot. | post, comment |
| **Mention** | `@handle` in a message. Mentioning a bot asks it to reply; mentioning several bots asks each of them, at the same time. | tag, ping |
| **Turn** | One bot working on a reply: reading, using tools and writing through the **bot loop**. It is made of **steps** and acts for its **asker**. The asker's permissions are checked when the turn starts and apply until it ends, including after waiting for approval. The settings for a tool call are checked when the call starts. | run (an automation's), job, generation, response |
| **Floor** | Which bots reply to a message in a chat, the same rule in every project. A member's message goes to the project's bots it mentions, each at once; else to the project's bot it replies to; else, when it mentions only members, the lead bot reads it and may stay silent, reacting 👀; else to the lead bot. A bot's message goes only to the project's other bots it mentions, as a **collaboration**, each acting for the asking turn's asker (or run), only one deep, so a helper's own mentions start no turn; it starts no other bot's turn, apart from a brief. Mentions of bots outside the project are ignored, so in a bot's own chats only that bot can answer, by the same rule: it may stay silent on a message that mentions only members, and with no model it does not answer one. In an automation feed, the lead bot answers every member's message unless it mentions only members, when no bot does; mentions, a bot's included, bring in no other bot. | routing, dispatch, turn-taking |
| **Collaboration** | A bot asking another bot in the chat's project, its **helper**, for help, by mentioning it in the chat: the only way a bot's message gives another bot a turn, apart from a brief, so bots can't keep each other talking. The helper replies there, as any mentioned bot does, for the same asker (or run), within the chat's bounds. If a turn's mentions started helper turns, once it and they have all ended the asking bot gets one more turn there, a **hand-back**, to use the answers; an interrupted turn gets none. Collaborations go one deep: only the bot answering a member's message, a brief or a run can ask, so a helper's mentions start no turn, and a hand-back turn can ask only bots not already asked for that message. A bot outside the project must first be added to it. | delegation, handoff, subagent, subtask |
| **Brief** | What a bot writes, when its asker asks, to move work to a new chat with itself or another bot: the new chat's first message, answered for the same asker. It always waits for its asker's approval. | kickoff message, handover note |
| **Tool** | Something a bot can do besides write: run commands, search the web, use a connector. | function (except in a model provider's API), action, skill, command |
| **Approval** | A member allowing or denying a tool call before it runs, or Sugabots allowing it automatically when its tool access is **Allow**. A member's decision applies to the exact call and details shown. Allowing a connector write or delete requires permission to make that call when deciding. A call that needs approval is refused if its input cannot be shown in full. | confirmation, consent, sign-off, reject, permission (what the core checks) |
| **Resolved** | A chat someone has marked finished. It is kept, and can be reopened. | done, archived, closed |
| **Attachment** | A file added to a message, within the size and count limits. Once sent it is one of the chat's files. | upload (as a noun), enclosure |
| **Reply** | A message that answers another message. | response, answer |
| **Author** | The member, bot or automation that wrote a message. | sender, poster |
| **Group mention** | `@here` or `@channel` in a message: it notifies everyone who can see the chat, and never gives a bot a turn. No bot may take either as its handle. | @everyone, @all, broadcast |
| **Participant** | A member or bot who has taken part in a chat. Participants are notified about it; it is not the same as being a project member. | member (of a chat), collaborator |
| **Approver** | A member who may answer an approval under the first rule that fits. For a host request, the workspace's owner and admins for a project members made, or whoever can change the bot's settings in its default project. For another call from a personal bot, its creator. For a call made by an automation, the workspace's owner and admins or the creator who can manage the bot doing the run, if they can read the run's chat. For other calls, the turn's asker. | decider, reviewer |
| **Chat kind** | Which kind a chat is: a project chat, an automation feed, a run or a system chat. | chat type |
| **System chat** | A system bot's chat, where it works for another chat. | — |
| **Root chat** | The automation feed a run's chat hangs under. | — |
| **Served chat** | The chat a system chat works for. | — |
| **Read cursor** | How far a member has read a chat; any message after it is **unread**. | read state, seen, read receipt |

## A project's resources

A bot's resources are its default project's.

| Term | Meaning | Banned synonyms |
|---|---|---|
| **File** | A file in a chat. It is either an **attachment**, which a member added to a message and which stays as it was sent, or one a bot made, such as a document or an HTML page, which belongs to the project and keeps every version. A project's **Files** are those from its chats, so a bot's are those from its own chats. | asset, blob (outside the blob store) |
| **Page address** | A bot-made page's secret address, which opens only that page and expires after minutes. | sealed address, share link |
| **Computer** | A machine a project's bots work on: run commands, keep files, use a desktop. A bot working in a project's chat uses the project's computer once its **computer use** is on. An **online computer** runs at the workspace's computer provider and **sleeps** when idle. | VM, container, box, environment, server (a Sugabots installation) |
| **Computer provider** | The service the workspace's computers run at. | cloud, backend, host (an allowed host is an address) |
| **Allowed host** | An internet address a computer may reach, set for the workspace or for one project. Allowing a bot's host request adds the host to its project's allowed hosts: project policy, kept for whatever computer the project has, so a reset keeps it. | whitelist, allowed domain, allowed site |
| **Blocked host** | An address no computer may reach. | blacklist, denylist, blocked domain |
| **Connector** | A service a project is connected to: an MCP server or an HTTP endpoint, signed in with a key or OAuth, or its GitHub app. Belongs to one project. A bot working in a project's chat uses the project's connectors and, of its own, those that are on there: all of them in its default project, and in any other only those the workspace's owner or an admin turned on there, for whoever may talk to the bot in that project. Changing a connector's address turns it off again in every project until someone turns it on again. | connection, integration, plugin, extension, app (a GitHub app is one kind) |
| **Built-in connector** | A hosted MCP server Sugabots ships settings for, which a project connects in one step. | preset, catalog entry, app directory, marketplace |
| **GitHub app** | A project's own GitHub App, made for it and installed on a GitHub account or organisation. Each project, so each bot, has at most one. An installation on a member's own GitHub account records that member, and is uninstalled when they leave the workspace or are removed from it. | GitHub integration, GitHub bot |
| **Repository** | A GitHub repository a project works on, picked from what its GitHub app's installation can reach. | repo (in the product) |
| **Automation** | Work a project's lead bot does on its own, with instructions, started by its routines and triggers, in a chat of the project, on its computer. | workflow (the workflow engine's word), job, cron job |
| **Routine** | When an automation runs on a timetable, such as every weekday at 9, in the workspace's time zone. | cron, timer, recurrence |
| **Trigger** | An event that starts an automation: a **webhook** call or a **GitHub** event. An automation may have several routines and triggers. | hook (alone), listener, event |
| **Automation feed** | The chat where an automation posts and records its runs, in its project. Anyone in the project may answer there, and the lead bot replies. | log, history, output |
| **Run** | One time an automation ran, with its own chat. | job, invocation, instance |
| **Usage** | What the workspace spent on models, by model and by bot. | billing, credits, consumption |
| **Cost** | What one model request cost, in US dollars: the figure the model provider reports, or else an estimate from its model's price. A local model provider's or a subscription sign-in's requests cost nothing. Usage adds these up. | price, spend, charge, bill, estimated cost |
| **Search provider** | The service web search runs through. | search engine, search backend |
| **Tool access** | Whether a connector's tool may run: **Allow** (it runs), **Ask** (it waits for approval) or **Off** (bots can't use it). | tool permission, tool policy |
| **Credential** | The **secret** a connector or provider signs in with: a key or an OAuth sign-in. An OAuth sign-in records the member who made it. A connector's is deleted when they leave the workspace or are removed from it; while a model provider signs in with their subscription, they can't leave or be removed until another member signs it in or it is given a key. | token |
| **Secret** | A value Sugabots stores encrypted for one stated use, such as a credential or a webhook secret, which opens only for that same use, so one can't be passed off as another. | seal, sealed value, encrypted value, vault |
| **Desktop viewer** | A member's live connection to a computer's desktop, to watch or use it. | VNC, screen share, remote view |
| **Webhook** | A URL that starts an automation when it is called. | hook (alone), callback, endpoint |
| **Webhook secret** | How a webhook's caller proves itself: a webhook source's own signature, an HMAC signature, a bearer token, basic auth, an API-key header, or none, which lets anyone with the address start a run. | token, key (a connector's) |
| **Webhook filter** | Tests on a webhook call's body that must all pass before a run starts. | condition, rule, match |
| **Paused** | An automation switched off, by a member or by itself after two failed runs in a row: its routines and triggers start no runs until it is resumed. | disabled, inactive, suspended, asleep |
| **Manual run** | A run someone started by hand, outside the automation's routines and triggers. | run now, ad-hoc run, test run |
| **Unknown cost** | A model request's cost when its model's price isn't known: the request is counted, but adds nothing to usage. | unpriced request, free request, no price |
| **Webhook source** | The known sender a webhook is set up for (GitHub, Stripe, Slack or Linear), whose own signature it checks; or generic. | sender, integration |
| **Connector augmentation** | Tools Sugabots adds to a connector whose server leaves something undone, such as Linear's, which can't send a file. They are given tool access and approved like the server's own, under the connector's name. | extension, plugin, shim |
| **File version** | A numbered copy kept each time a bot writes or edits a file. Deleting the file deletes every version. | revision, snapshot |
| **Trusted host** | A host every computer may reach whatever the settings, such as code hosts and package registries. | default host, built-in allowlist |
| **Network mode** | Whether computers reach every host except blocked ones (**open**, the default), or only trusted and allowed hosts (**allowed hosts only**). | allowlist mode, firewall |
| **Host request** | A bot's request, in its chat, to add a host to its project's allowed hosts. A blocked host is refused at once. Approval adds the host for the project, even if its computer is replaced. | network access request, allowlist request |
| **Chat folder** | Each chat's own folder on its project's computer, where bots clone, install and build. | working directory, workdir, scratch |
| **Computer lease** | A turn using a computer, or a member watching its desktop, which keeps it awake. Only a turn's lease holds off a computer reset, upgrade or disk clearing; a lease left behind expires. | lock, keepalive, hold |
| **Computer sign-in** | What a project's computer is signed in to, such as its repositories. The computer provider adds the credentials outside the computer, so it holds only placeholders. | injected credentials, git credentials |

## Architecture

Words for how Sugabots is built, which [the architecture docs](https://github.com/nitrictech/sugabots-architecture-docs/blob/main/README.md) explain.

| Term | Meaning | Banned synonyms |
|---|---|---|
| **Entrypoint** | A way into the core: the **HTTP API** (which the web app, the SDK and the desktop viewer use), the **event stream**, **webhooks**, the **scheduler** and the **bot loop**. An entrypoint authenticates through an authenticator, decodes input with an operation's schema, calls the operation and encodes the result. It decides nothing about who may do what. | entry point, adapter, handler, door |
| **Scheduler** | The entrypoint for work that falls due: routines, and upkeep such as putting an idle computer to sleep. Nothing comes in through it; it authenticates the work it starts from stored ids. | cron (a routine's word), job runner, worker |
| **Bot loop** | The entrypoint bots work through, in turns, automation runs and system bots' work. It runs a turn: calls the bot's model, offers it the operations exposed to it as tools, and calls each tool the model picks as an operation for the turn's principal. | agent loop, agent runtime, runner, harness, executor |
| **Principal** | Who an operation acts for, as an entrypoint authenticated them: a member signed in, a bot acting for its asker, an automation's run, a webhook, work Sugabots does on its own (a system bot's, or upkeep), or whoever holds a page address. Operations take it as an argument. | actor, caller, user, identity |
| **Authenticator** | The code in core that checks what came in through an entrypoint (a session's cookie or token, a webhook's signature, a page address, or the stored ids of a turn, a run or a piece of system work) and builds its principal. Nothing else builds one. | auth middleware, identity provider, session check |
| **Asker** | The member a turn acts for: whoever wrote the message it answers. When a bot wrote it, as a collaboration's mention or a brief that starts a chat, the asker carries over from the turn that wrote it; a personal bot's automations' runs act for its creator. A turn acts for its asker: its tools have no more access than the asker and the bot both have, only the asker may steer it, and anyone else's message gets a turn of its own. Other automations' runs have no asker. | requester, initiator, user |
| **Operation** | One thing a principal can do, such as `chats.setResolved`, defined once: its contract, in `@sugabots/contracts`, with a name, a description, input and output schemas and its errors; and its body, in core's **operation registry**. Every entrypoint calls the same one. | use case, action, command, mutation, endpoint (an HTTP route) |
| **Long-running operation** | An operation that lasts as long as its caller follows it: following a stream, or the desktop viewer. It proves access as it starts, keeps only ids, and proves again, naming its values afresh, on each change of who reaches what; it ends once a proof is refused, or its session ends or expires. | live query, watcher |
| **Exposure manifest** | Each operation's explicit decision for the HTTP API and for the bot loop, in its contract: offered, or held back with a reason; over HTTP, also served at an endpoint of its own, with the reason; for the bot loop, also covered by a named tool that does the same. For a tool, it also says when a bot's call needs approval: never, always, or by its tool access. | publication list, tool registry |
| **Service** | An Effect `Context.Service` in core that does the work and the IO. Services demand proofs. A **store** is the service that owns one **aggregate**'s rows. | manager, helper (a collaboration's), DAO, util |
| **Permission** | Something the core checks before an operation goes ahead. For example, `project.update` lets the workspace's owner and admins change a project's settings. In a private bot's default project, the owner, admins and a creator who is a member of the bot with a role other than viewer can change the bot's settings with `bot.update` and manage its automations and connectors. A bot acting for its asker has the asker's permissions in what they both reach, within its turn's bounds. A bot working on an automation can use what it reaches in the automation's project. It can't manage that project, invite members or add bots. A personal bot's manual runs and runs from routines act for its creator. | scope, capability, right, privilege |
| **Reach** | Whether someone can see a project, bot or chat at all. A project is reached by its members; a bot by everyone in the workspace when public, by its members when private and by its creator when personal; and a bot's default project through its bot. A private bot in a project is talked to there by the project's members, who reach the project, not the bot. A bot itself reaches the projects it is a member of and its own default project; a personal bot, acting for its creator, what they reach. Admins see that a personal bot exists without reaching it. | access (for this meaning) |
| **Admission** | The access check when a request, turn or automation run starts. An admitted turn keeps its authority through an approval wait or a new execution. Each tool call checks current settings and what its approval covers, and each approval decision checks the member who makes it. Streams and desktop viewers check again as they follow changes. | — |
| **Proof** | An opaque, frozen value recording that a fact was checked about specific named values, such as `ReachesProject<P, J>`, which services demand as an argument. Made only in `core/src/proofs/`, readable only while the operation that named its values runs, and never stored. | standing, token, guard, witness, evidence, assertion |
| **Prover** | The one function in `core/src/proofs/` that checks one fact and returns its proof, or fails with a typed error. | checker, guard, policy, authorizer |
| **Named value** | An id given a name only the type checker sees, by `named(...)`, so proofs can be about that exact value. Readable only while the operation that named it runs. | branded value (brands are a different thing) |
| **Hidden** | The refusal for something the principal can't reach, whatever they asked, so an id can't be probed for. | — |
| **Forbidden** | The refusal for something the principal reaches but may not act on. | unauthorised, 403 |
| **Tier** | How long something lives once built: **process** (once, at boot), **workspace** (kept empty: the workspace is passed to each call) or **request** (one operation call: an HTTP request, a tool call or one of the bot loop's records of the turn it runs, a webhook call, or a piece of work the scheduler starts; streams prove again as they go). A longer-lived thing may not depend on a shorter-lived one. | scope, lifetime, level, layer |
| **Lane** | A key that runs one workflow at a time, such as one bot in one chat. What arrives while it's busy joins a waiting one it belongs with, replaces one, or queues. | queue, mutex, slot |
| **Step** | One model request and the tool calls it makes. A turn is made of steps; the tools and settings offered stay fixed for a step. | iteration, round, cycle, turn (a turn is the whole reply) |
| **Turn input** | A steer or an interrupt recorded for a running turn. A steer is read at its next step; an interrupt is also signalled to the process running the step, which stops it at once. | — |
| **Turn bounds** | What a bot acting for its asker, or an automation's run, may reach in a turn: **chat bounds** (for most turns, a helper's included: the chat's project and the bot's own connectors that are on there) or **member bounds** (a personal bot's own turns and its automations' routine and manual runs: everything its creator reaches). A brief's first turn gets chat bounds in its new chat, and wider ones only if the asking turn had them. | scope, sandbox, context |
| **Steer** | A message from the asker that reaches a running turn and is read before its next step, or in one more step if it arrives after the last. One that arrives while the turn waits for approval withdraws the approval. Anyone else's message waits for a turn of its own. | nudge, inject, follow-up |
| **Interrupt** | Ending a running turn partway through: the step under way stops, any approval it waits for is withdrawn, and the turn ends. Its asker may interrupt it, and so may anyone who may manage its project and reaches its chat, and for a run's turn, those who may approve its calls. An interrupted turn gets no hand-back. | stop, cancel, abort, halt, kill |
| **Step text** | The words one step wrote; a message's text is its steps' text joined. | — |
| **Thinking** | What a model works through before it replies, kept with its step and in the checkpoint. A model thinks when its provider offers adaptive or default thinking. Anyone who can read the chat can see the thinking the provider returns as text. | reasoning (except in a model provider's API), chain of thought, thoughts |
| **Event** | A recorded change, written to the **event outbox** in the same transaction as the change, then sent to the event stream. Token-stream pieces are ephemeral events that skip the outbox. | update, change, signal, broadcast |
| **Ledger** | The record of every model request and its cost, which usage is read from. | log, meter |
| **Token stream** | A reply reaching clients as it is written, in batches of ephemeral events. Each step's full text is stored. | streaming, live typing |
| **Checkpoint** | What a turn keeps so it can resume after waiting or a restart, its thinking included. | snapshot, save state |
| **Execution fence** | A check in a turn's write transaction that its execution is still current and its turn is still running. A superseded execution can't write. | guard (for a turn's writes) |
| **Event stream** | The entrypoint that pushes events to clients as they happen, over server-sent events. | event bus (in the product), realtime, websocket |
| **Store** | The service that owns one aggregate's rows: the only one that reads and writes them. | DAO, table |
| **Aggregate** | Rows a store owns and changes together. | entity, table |
| **Egress** | The server's own requests out to the internet, to model providers, connectors and web pages, under its rules for private addresses. A computer's traffic is governed by its **network mode** instead. | outbound, network access |
| **Blob store** | Where file contents are kept. | bucket, storage, S3 |
| **Model request** | One call to a model provider. A step makes one; usage and the ledger count them. | model call, completion, inference |
| **Dialect** | One model provider's variation on the API it speaks. | flavour, adapter, format |
| **Changes** (an operation's) | Whether an operation changes anything; a personal bot asks its creator before calling one that does. | mutating, mutates |
| **Write/delete tool call** | A tool call that may change or delete something outside Sugabots. A tool is treated this way unless its connector server marks it read-only or someone who manages the connector chooses otherwise. A turn that fails after one is not retried, and members are told to check what it did. | mutating tool call, side effect, destructive call |
| **Long tool result** | A tool result too long to give the model whole. It is kept as a file in the chat, and the model gets its start and a way to read the rest. | overflow, spill file, truncated output |
| **Stream** | One event stream a client follows: a workspace's, a chat's or a member's own. | channel, topic, room |
| **Stream audience** | Who may hear an event on a workspace's stream: those who reach its chat, or for an event about no chat, its project, and for anything else, such as a bot or a membership, those who reach it. | subscribers, listeners |
| **Retry** | A failed turn starting again by itself, up to a limit, unless it made a write/delete tool call. | rerun, restart |
| **Request purpose** | What a model request was made for: a bot's turn, compaction, a model test or a connector test. It decides whose usage the request counts as: background work is never charged to a bot. | activity, reason, kind |

## Errors

| Term | Meaning | Banned synonyms |
|---|---|---|
| **Error** | An expected way an operation can go wrong, as one tagged error class that implements `DomainError`. | failure, exception, problem |
| **Defect** | A bug or something unexpected. Never a `DomainError`: logged in full, and shown only as a fixed message with a reference id. | crash, panic, internal error, unknown error |
| **User message** | The words members read, and bots read in the bot loop, written in our own words: what happened, what is safe, who can fix it, and a way on. | error text, display message, copy |
| **Log message** | Words for operators, which may quote other systems' text and ids. | debug message, details |
| **Display name** | A name members chose, such as a bot's or a project's, put into a user message. | label, title |
| **Public error** | The only shape an error takes when it leaves the core. | API error, wire error |
| **Reference id** | The id shown with a defect, which finds its full log entry. | error id, trace id, incident number |
| **Upstream error** | An error from a model provider, connector or computer provider. Its text goes in the log message; the user message is ours. | provider error, third-party error |
| **Refusal** | An expected error where the core says no, logged at Info. Hidden and Forbidden are refusals; an upstream error is not. | rejection |
| **Retryable** | Whether sending the same request again might work, and how long to wait if the other side said. | transient, recoverable |

## Retired terms

Words for things that no longer exist. Don't use them, even in comments explaining old behaviour.

| Term | Was | Now |
|---|---|---|
| **Pod** | A group of members and bots sharing a computer, connectors and access. | **Public** and **private** bots, and **projects**; resources belong to each **project**, a bot's to its default project. |
| **Personal pod** | A member's private pod. | Their **personal** bots, **Personal Assistants** included. |
| **Pod chat** | A pod's chat. | A project's **chats**. |
| **Bot channel** | A bot's own channel inside a pod. | The bot's **chats**. |
| **Crew** | The bots in a pod. | A project's bots. |
| **Channel** | A long-running space for many members and bots. | **Project**. |
| **Main chat**, **main thread** | A channel's or project's own chat, beside its other chats, which every project had and none could archive. | Gone: a project is made of its **chats**, any of which can be marked **resolved**. |
| **Task** (a chat with one bot) | A chat with one bot about one piece of work. | A bot's **chat**. |
| **Schedule** (an automation's) | When an automation runs on a timetable. | **Routine**. |
| **Artifact** | Something a bot made to keep. | A **file**. |
| **Document** (as a kind of thing) | What a bot makes. | A **file**; "document" only describes what a file contains. |
| **Sandbox** | A bot's machine. | **Computer**. |
| **Routine** (work a bot does on its own) | An automation as a whole. | **Automation**; a routine is now when an automation runs on a timetable. |
| **Agent** | A bot. | **Bot**. |
| **Summary**, **bot summary**, **Summariser** | A short account of one chat, or of what a bot had been doing across its chats, and the system bot that wrote them. | Gone. |
| **Scribe** | The system bot that wrote summaries, named as a character. | Gone, with summaries. |
| **Inbox** | What needed a member's attention: mentions, replies, finished work. | Gone: their **Personal Assistants** tell them what needs their attention. |
| **Direct message** | A chat between two or more members, with no bots, which only its members saw. | Gone: members talk in a project's **chats**, or with bots. |
| **Archive** (a chat) | Removing a chat from its list for good, by a manager. | Gone: a chat is **resolved**, and can be reopened. |
| **Collaboration chat** | A chat nested under the asking chat, where a helper worked and members only read. | Gone: a helper replies in the asking chat, as a **collaboration**. |

## Kept names

These identifiers keep their spelling for compatibility. Migrations, and the test that runs them over old rows, keep older names too.

| Name | Where | Why it is kept |
|---|---|---|
| Migration names and SQL | `packages/core/drizzle/` | Migrations are history: each names the tables as they were when it ran. |
| `sugabots-sandbox` | `packages/contracts/src/computer-providers.ts`, `docker/computer/Dockerfile`, the computer publishing workflows in `.github/workflows/`, and `build:computer` in `package.json`. | The published computer image and E2B template keep the names that registries, workspace settings and E2B accounts already reference. |
| `PROVIDER_AUTHORITY=sandbox-provider` | `docker/computer/sugabots-desktop` | Persisted browser profiles use this certificate name. The desktop script uses the same name to remove the previous certificate before trusting its replacement. |
| `resume` | `packages/core/src/chats/turns/requests.ts` | Stored turn workflow payloads use this name for a hand-back, so a workflow can resume after an upgrade. |
| `/workspace/threads` and `/workspace/agents` | Computer folder upgrade | Existing work is moved from these paths the first time it is used after upgrading. |
| `legacy-facilitation` | Model request ledger | Requests made by the retired Facilitator still count as system usage. |
| The upgrade test's rows | `packages/core/src/database/upgrade.test*.ts` | It writes an installation as `main` left it, by `main`'s names, and checks what the migrations make of it. |
| `/api/connections/oauth/callback` | Connector OAuth sign-in | Authorization servers keep this registered callback address when a member signs in again. |
| Old webhook and GitHub app addresses | `packages/server/src/http/renamed-paths.ts` and its test | GitHub apps and webhook senders keep posting to the addresses they were given before the upgrade, so the server still answers them. |
| Old docs addresses | `packages/website/src/renamed-docs.ts` | Links and search results still point at the pages' old names, which redirect to the new ones. |
| Old names in the upgrade notes | `packages/docs/content/upgrading-to-projects.mdx` | Operators upgrading need to read what pods, routines and connections became. |

### The `chat` table

Messages, turns, tool calls, compactions, read cursors and files each belong to one chat, so they all point at one shared parent: a `chat` row holding only what every kind has (its workspace, kind, title and times). What makes each kind what it is lives in its own table: `project_chat` (its project, who started it, when it was resolved), `automation_feed` and `system_chat`, keyed by the chat's id, and `run`, which has an id of its own and points at its chat. Say "chat" in code that works the same for every kind; otherwise name the kind.

### Spelling in identifiers

Identifiers spell colour `color`, as CSS and every library do. The avatars package calls the avatar it draws a "face".
