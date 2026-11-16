# Achilles

An experimental TypeScript liquidity-automation monorepo for Solana and Sui. Achilles manages concentrated-liquidity positions, evaluates strategy state, executes rebalances, and reports operational events across supported protocols.

> This is portfolio software, not financial advice. Transaction-producing flows should be reviewed and tested with a dedicated low-value wallet before use.

## What it does

- Runs a central poller and bot engine for concentrated-liquidity pools across **Orca** and **Raydium** on Solana, plus **Bluefin** and **Cetus** on Sui.
- Executes two automated strategies: **InRange** maintains paired range positions, while **Chaser** follows price movement with a single managed position.
- Uses **Jupiter** for Solana quotes and swap execution during rebalance flows, with state persistence, health checks, and Slack operational alerts.
- Provides a Next.js admin dashboard for configuring bots, monitoring pollers, viewing pools, and operating the system.
- Includes a parlay-analysis service that combines market data, vector retrieval, and LLM-assisted analysis.

## Architecture

| Area | Responsibility |
| --- | --- |
| `apps/bot` | Central poller, pool adapters, strategy engine, health checks, and notifications |
| `apps/client` | Next.js operator and admin dashboard |
| `apps/parlay-server` | Parlay analysis API and market-processing service |
| `packages/orca`, `packages/jupiter`, `packages/metaplex` | Reusable Solana position, swap, and metadata tooling |
| `packages/db`, `packages/utils`, `packages/redpanda` | Persistence, shared chain helpers, Slack, and event infrastructure |

## Getting started

### Prerequisites

- Node.js 18 or later
- pnpm 10
- A Solana RPC endpoint

```bash
pnpm install
pnpm build
```

Create a local `.env` file with only the services you intend to use. Never commit it.

```dotenv
# RPC endpoint used by Solana pool adapters and Jupiter
RPC=https://your-rpc-provider.example

# Shared application state
MONGO_URI=mongodb://localhost:27017/achilles

# Optional Slack alerts
SLACK_BOT_TOKEN=your-sandbox-token
DEFAULT_CHANNEL_ID=your-sandbox-channel

# Required by parlay analysis when that service is enabled
OPENAI_API_KEY=your-sandbox-key
PINECONE_API_KEY=your-sandbox-key
INTERNAL_SECRET=replace-with-a-long-random-value
```

Start the operator dashboard:

```bash
pnpm --dir apps/client dev
```

## Development notes

The workspace uses pnpm workspaces and Turbo. The root scripts cover the common build, lint, format, and type-check tasks:

```bash
pnpm build
pnpm lint
pnpm type-check
```

Some packages depend on external infrastructure such as RPC providers, MongoDB, Prisma-backed databases, and Slack. Configure only what a particular app requires, and use sandbox credentials while developing.

## Safety and scope

- Do not place private keys, API keys, connection strings, or production endpoints in tracked files.
- Rebalance and position-management commands can submit on-chain transactions; review their parameters and expected transaction effects first.
- The project targets Solana and Sui mainnet integrations, with a companion admin dashboard and parlay-analysis service.

## License

No license is currently specified. Add one before distributing or accepting outside contributions.
