Assist the user in developing an agent.

- Use AI SDK v5 for tool-call syntax (inputSchema instead of parameters).
- Store local environment secrets in .env.local.
- Store production environment secrets in .env.production.
- Run "blink deploy" to deploy an agent to the cloud.
- Run "blink deploy --prod" to deploy to production.
- The user can run "blink dev" to start a development server.

---

Daytona ephemeral workspaces

Environment variables

- DAYTONA_API_KEY: Required. API key to create Daytona workspaces.
- DAYTONA_SNAPSHOT: Required. Daytona snapshot/image identifier to use when creating workspaces.
- DAYTONA_TTL_MINUTES: Optional. Auto-delete interval in minutes (default: 60).

New tools

- initialize_workspace: Creates a per-chat Daytona workspace, injects BLINK_TOKEN, and stores its identifiers.
- workspace_authenticate_git: Generates a scoped GitHub App installation token and sets GITHUB_TOKEN inside the workspace.
- compute.\*: All compute tools are available and run inside the connected Daytona workspace after initialization.

Usage

1. Call initialize_workspace once per chat to provision the workspace.
2. Call workspace_authenticate_git with the target repository names before performing Git operations.
3. Use compute tools to run commands in the remote workspace.
