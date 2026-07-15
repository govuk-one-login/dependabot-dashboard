# Dependabot Dashboard

A standalone GOV.UK styled dashboard for managing Dependabot pull requests across multiple repositories.

## Features

- **Pre-flight checks**: Verifies gh CLI, Kiro/Ollama agent, and GPG signing are configured
- **PR management**: View, approve, merge, and update Dependabot PRs across repos
- **AI-powered fixes**: Use Kiro CLI or Ollama to automatically fix failing builds
- **GOV.UK Design System**: Full implementation for consistent government service UI

## Tech Stack

- **Frontend**: Vue 3 + TypeScript + Vite
- **Backend**: Express 5 + TypeScript (ESM)
- **Testing**: Vitest + happy-dom
- **Runtime**: Node.js 24+

## Project Structure

```
dependabot-dashboard/
├── server/              # TypeScript Express server
│   ├── index.ts         # Server entry point
│   ├── routes/          # API routes (dependabot + helpers)
│   └── tsconfig.json    # Server TypeScript config
├── src/                 # Vue.js frontend
│   ├── components/      # Reusable Vue components
│   │   └── dependabot/  # Dependabot-specific components
│   ├── views/           # Page components
│   ├── types/           # TypeScript types
│   ├── styles/          # SCSS styles
│   ├── App.vue          # Root component
│   └── main.ts          # Frontend entry point
├── index.html           # HTML template
├── package.json         # Dependencies and scripts
├── vite.config.ts       # Vite configuration
├── vitest.config.ts     # Vitest test configuration
└── tsconfig.json        # Frontend TypeScript config
```

## Getting Started

### Prerequisites

- Node.js 24+
- npm 10+

### Installation

```bash
npm install
```

### Development

Run both the server and client in development mode:

```bash
npm run dev
```

This will start:
- **Frontend**: http://localhost:3010 (Vite dev server)
- **Backend**: http://localhost:3011 (Express server)

The frontend proxies API requests to the backend.

### Individual Commands

```bash
# Run only the server
npm run dev:server

# Run only the client
npm run dev:client
```

### Testing

```bash
# Run tests once
npm test

# Watch mode
npm run test:watch

# With coverage
npm run test:coverage
```

## Configuration

### Prerequisites for Kiro AI Agent

The tool requires a Docker sandbox with kiro-cli configured. Set up the sandbox:

```bash
# Create the sandbox (if not already created)
sbx create di-kiro-ai-sandbox di-kiro

# Verify the sandbox is running
sbx ls

# Authenticate kiro-cli inside the sandbox
sbx exec di-kiro-ai-sandbox kiro-cli login
```

**Note**: The dashboard will automatically detect when the sandbox is running and use it for all AI-powered fixes. Make sure the sandbox is started before running the application.

## API Endpoints

| Endpoint                         | Method | Description                        |
| -------------------------------- | ------ | ---------------------------------- |
| `/api/dependabot-preflight`      | GET    | Pre-flight tool checks             |
| `/api/dependabot-categories`     | GET    | Repo category configuration        |
| `/api/dependabot-prs`            | GET    | List open Dependabot PRs           |
| `/api/dependabot-approve-pr`     | POST   | Approve a PR                       |
| `/api/dependabot-merge-pr`       | POST   | Merge a PR (squash + auto)         |
| `/api/dependabot-update-branch`  | POST   | Trigger @dependabot rebase         |
| `/api/dependabot-fix-pr`         | GET    | Fix PR with Kiro CLI (SSE stream)  |
| `/api/dependabot-fix-pr-ollama`  | GET    | Fix PR with Ollama (SSE stream)    |
| `/api/dependabot-push-fix`       | POST   | Push approved AI fix               |
| `/api/dependabot-discard-fix`    | POST   | Discard AI fix                     |
| `/api/dependabot-stop-fix`       | POST   | Cancel running AI fix              |
| `/api/dependabot-check-failures` | GET    | Get CI failure details for a PR    |
| `/api/dependabot-recreate-pr`    | POST   | Trigger @dependabot recreate       |
| `/api/dependabot-delete-branch`  | POST   | Close PR and delete branch         |
| `/health`                        | GET    | Server health check                |
