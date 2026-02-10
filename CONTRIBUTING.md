# Contributing to AI Maestro Gateways

Thank you for your interest in contributing! This guide will help you get started.

## How to Contribute

1. **Fork** the repository
2. **Create a branch** for your feature or fix (`git checkout -b feature/my-change`)
3. **Make your changes** and write tests if applicable
4. **Run type checks** to ensure nothing is broken
5. **Commit** with a clear message describing the change
6. **Open a Pull Request** against `main`

## Development Setup

### Prerequisites

- Node.js 22+
- npm 10+

### Getting Started

Each gateway is an independent Node.js project. To work on a specific gateway:

```bash
cd discord-gateway   # or slack-gateway, email-gateway, whatsapp-gateway
cp .env.example .env # configure your local environment
npm install
npm run dev          # start with file watching
```

### Running Type Checks

```bash
cd <gateway-dir>
npm run typecheck    # runs tsc --noEmit
```

### Running Tests

```bash
cd <gateway-dir>
npm test             # if tests exist for that gateway
```

## Code Style

- **Language:** TypeScript (strict mode)
- **Module system:** ESM (`"type": "module"` in package.json)
- **Runtime:** tsx (TypeScript execution without build step)
- **Formatting:** Use consistent indentation (2 spaces)
- **Naming:** camelCase for variables/functions, PascalCase for types/interfaces
- **Imports:** Use `.js` extensions in import paths (required for ESM)
- **Error handling:** Always handle errors gracefully; log with `[CONTEXT]` prefixes

## Pull Requests

- Keep PRs focused on a single change
- Include a clear description of what the PR does and why
- Reference any related issues
- Make sure type checks pass before requesting review
- Update `.env.example` if you add new environment variables
- Update the gateway's README if you change behavior

## Adding a New Gateway

To add a new gateway to the monorepo:

1. **Create the directory** at the repo root (e.g., `telegram-gateway/`)
2. **Initialize the project:**
   ```bash
   mkdir telegram-gateway && cd telegram-gateway
   npm init -y
   ```
3. **Follow the existing structure:**
   ```
   telegram-gateway/
   ├── .env.example          # All env vars with placeholder values
   ├── .gitignore            # node_modules, dist, .env
   ├── Dockerfile            # Multi-stage build (see other gateways)
   ├── ecosystem.config.cjs  # pm2 configuration
   ├── package.json          # Scripts: start, dev, typecheck
   ├── tsconfig.json
   └── src/
       ├── config.ts         # Load env vars with dotenv
       ├── content-security.ts # Trust model + injection scanning
       ├── inbound.ts        # Platform -> AI Maestro
       ├── outbound.ts       # AI Maestro -> Platform
       ├── server.ts         # Express health/management + main()
       └── types.ts          # TypeScript interfaces
   ```
4. **Implement the content security module** with the standard trust model (operator/external) and injection pattern scanner
5. **Add a health endpoint** at `GET /health`
6. **Add the gateway** to the CI matrix in `.github/workflows/ci.yml`
7. **Add a service** to `docker-compose.yml`
8. **Create a Dockerfile** following the multi-stage pattern
9. **Update the root README** with the new gateway info
