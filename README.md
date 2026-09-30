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

The application consists of a React web app, a Hono API, and PostgreSQL. Your
accounts, conversations, configuration, and encrypted provider credentials stay
in your database. Model requests go only to the providers you configure, which
can be hosted services such as Anthropic and OpenAI or an OpenAI- or
Anthropic-compatible model server on your own network.

## Set up Sugabots

This guide runs PostgreSQL in Docker and the web app and API directly on your
machine. It is the simplest supported way to try or operate Sugabots on one
computer.

### 1. Install the prerequisites

You need:

- [Node.js](https://nodejs.org/) 26 or newer; `.nvmrc` contains the expected version
- [Bun](https://bun.sh/) 1.4.2 or newer
- [Docker](https://docs.docker.com/get-docker/) with Docker Compose

Check that they are available:

```sh
node --version
bun --version
docker compose version
```

### 2. Install dependencies

```sh
nvm use # Optional
bun install
```

### 3. Configure the installation

Create your local environment file:

```sh
cp .env.example .env
```

Open `.env` and replace both development keys before storing any provider
credentials:

```dotenv
BETTER_AUTH_SECRET=<output of openssl rand -base64 32>
CREDENTIALS_ENCRYPTION_KEY=<output of another openssl rand -base64 32>
```

Generate each value separately:

```sh
openssl rand -base64 32
```

The remaining defaults are ready for a localhost installation. Keep `.env`
private and backed up. Losing `CREDENTIALS_ENCRYPTION_KEY` makes saved
credentials unreadable; changing `BETTER_AUTH_SECRET` signs everyone
out.

### 4. Start PostgreSQL

```sh
docker compose up -d
docker compose ps
```

Wait for `postgres` to report `healthy`, then create the database schema:

```sh
bun run db:migrate
```

PostgreSQL stores its data in the `sugabots_postgres_data` Docker volume, so
restarting or recreating the container does not remove your data. If you want to
reset your data, just delete the volume.

### 5. Start Sugabots

```sh
bun run dev
```

Keep this terminal open. It runs the API and web app together and reloads them
when source files change. On its first run, Portless creates a local certificate
authority, adds it to your system trust store, and may ask for administrator
access to start its HTTPS proxy.

Open <https://sugabots.localhost>, create an account, and follow the onboarding
flow. Development email is printed in the terminal, including the verification
link.

The local services are:

| Service          | Address                                     |
| ---------------- | ------------------------------------------- |
| Web app          | <https://sugabots.localhost>                |
| API              | <https://sugabots.localhost/api>            |
| API health check | <https://sugabots.localhost/api/health>     |
| PostgreSQL       | `localhost:5436`                            |

The API answers under `/api` of the address the web app is served from. In
development Vite serves the app and proxies `/api` to the API process; in a
deployment the API serves the built app itself. Either way the browser sees
one origin and nothing about the installation's address is built into the
app. Hosting the web app on an origin of its own is still supported: see
`WEB_APP_URL` and `VITE_API_URL` in `.env.example`.

Portless gives the app stable local names, HTTPS, and HTTP/2. Use these commands
to inspect or troubleshoot it:

```sh
bunx portless list
bunx portless doctor
```

## Run it again

After the first setup:

```sh
docker compose up -d
bun run db:migrate
bun run dev
```

Press `Ctrl-C` to stop the web app and API. Stop PostgreSQL separately with:

```sh
docker compose stop
```

## Update an installation

Stop `bun run dev`, then run:

```sh
git pull --ff-only
bun install
docker compose up -d
bun run db:migrate
bun run dev
```

Back up your PostgreSQL volume and `.env` before updating an installation that
contains data you care about.

## Reset everything

The following removes the database volume and all Sugabots data:

```sh
docker compose down -v
docker compose up -d
bun run db:migrate
```

Do not run `docker compose down -v` unless you intend to delete every account,
workspace, conversation, and saved credential.

## Deploy with Docker

One image runs the whole application: the API, serving the built web app at
every path outside `/api`. Any platform that builds a `Dockerfile` from a
repository can run it, such as Railway, Render or Suga; point the service at
the repository root and give it a PostgreSQL 18 database.

```sh
docker build -t sugabots .
```

The container takes the variables `.env.example` describes. `PUBLIC_URL`
is the installation's public address, the one in the browser's address bar.
On start it applies pending database migrations, then listens on `$PORT`; set
`SUGABOTS_SKIP_MIGRATIONS=true` to skip that, for example when a deploy step
migrates or several instances share a database.

To host the web app on an origin of its own instead, set its address in
`WEB_APP_URL` and build the web app with `VITE_API_URL`; the image still
serves its own copy at its own address.

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
