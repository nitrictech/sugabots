<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="packages/avatars/assets/sugabots-wordmark-dark.svg">
    <img alt="Sugabots" src="packages/avatars/assets/sugabots-wordmark-light.svg" width="338">
  </picture>
</p>

<p align="center">
  <img alt="" src="packages/avatars/assets/bot-crowd.svg" width="376">
</p>

Sugabots is a self-hosted workspace where people and AI agents work together.
Create agents, organise them into shared pods, and run conversations that can use
built-in tools and MCP connections.

<p align="center">
  <img alt="A Sugabots thread where two people and two bots draft a pricing reply and check a discount together" src="packages/website/public/screenshots/one-thread-mac.webp" width="800">
</p>

Everything stays in your own database. Bots use the model providers you choose,
whether that's Anthropic, OpenAI or a model server on your own network.

## Try it in one command

With [Docker](https://docs.docker.com/get-docker/) and Docker Compose installed,
run this on macOS or Linux:

```sh
curl -fsSL https://sugabots.ai/install.sh | sh
```

Or on Windows, in PowerShell:

```powershell
irm https://sugabots.ai/install.ps1 | iex
```

It sets Sugabots up in a new `sugabots` folder and starts it. Then open <http://localhost:3000> and create your account. You can read more details in the
[Quickstart](https://sugabots.ai/docs/quickstart) guide.

## Host it for your team

To use Sugabots with other people, run it somewhere they can reach.
[Deploy with Docker](https://sugabots.ai/docs/deploy-with-docker) walks through
a server of your own or a hosting platform.

## Features

### Shared pods

A pod is a shared space for a group of people and their bots. Everyone in it
sees the same chats, results and approvals, so nobody has to forward an answer
or explain what a bot already did.

### Bots that work together

When a bot needs help, it asks another bot in its pod. The exchange shows up as
a thread under its message, so you can see exactly who said what.

### A different model for every bot

Connect Anthropic, OpenAI, any OpenAI- or Anthropic-compatible service, or a
model running on your own machine. Give each bot the model that suits its job: a
clever one for research, a cheap one for sorting the inbox, a local one for
private notes.

### Your apps and APIs, with approvals

Connect Linear, Notion, Stripe, Sentry, Jira, any MCP server or a plain HTTP
API once, and let your bots use it to do work. Choose which tools run straight
away and which wait for someone to say yes.

### Routines

Give a bot a job to do on a schedule, or whenever a webhook or a GitHub event
calls it. It posts what it did in its chat, where the team can pick it up. Try telling a bot "check in with me every morning at 9".

### Sandboxes

Bots can runs code, use software or browse the web in their own isolated environment.

### And more

- **GitHub**: bots read a pod's repositories, push branches, and open pull
  requests once someone allows it.
- **Artifacts**: files and outputs bots make are saved for the team to open and
  review.
- **Usage and costs**: see what every bot, model and team costs, day by day.
- **Web search**: bots search the web and read pages, through Exa, Brave Search,
  Tavily or your own SearXNG server.
- **Roles**: owners, admins, members and viewers, with pods deciding who sees
  what.
- **Personal pod**: everyone gets a private pod and assistant that nobody else
  can see into, admins included.
- **Bots set their own schedules**: ask a bot to "check in with me every morning
  at 9" and it sets up the routine.
- **Signed webhooks**: routines check calls from GitHub, Stripe, Slack and Linear,
  or any sender using HMAC, bearer, API key or basic auth.

## Community and support

- Ask questions and get help on the [Sugabots Discord](https://sugabots.ai/discord).
- Read the docs at [sugabots.ai/docs](https://sugabots.ai/docs).
- Report bugs and request features in
  [GitHub issues](https://github.com/nitrictech/sugabots/issues/new/choose).

## Contributing

To work on Sugabots, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

The software source code in this repository is licensed under the
[MIT License](LICENSE.md) unless otherwise stated. See the asset exceptions below
and the package-level licensing notices.

Sugabots is a product of Nitric Group Inc.

The Sugabots name, logo, brand identity, and supplied brand assets (including
illustrations and avatars) are not licensed under the MIT License. See the notices for
[logos and avatars](packages/avatars/README.md) and
[website brand and marketing assets](packages/website/README.md).

The avatar geometry, colour definitions, and rendering code remain MIT licensed.

Forks and derivative products may use the MIT-licensed software, but should use
their own name and branding. Unofficial forks and derivative products must not
imply affiliation with, endorsement by, or maintenance by Nitric Group Inc. or Sugabots.

Third-party materials retain their respective licenses and notices, including
the [provider logos](packages/provider-logos/README.md).
