# Jira Agent

A comprehensive AI-powered agent that integrates Jira, GitHub, and workspace management capabilities to assist with project management, code development, and issue tracking.

## Overview

This agent provides a unified interface for managing Jira issues, GitHub repositories, and development workspaces. It's designed to streamline workflows by combining project management, code development, and collaboration tools in one intelligent assistant.

## Available Tools

### 🕒 Date & Time
- **`get_current_date`** - Get the current UTC date/time with weekday and human-formatted output

### 📋 Jira Tools
- **`jira_reply`** - Post your final answer as a Jira comment for the current issue (mentioning the requester)
- **`jira_add_comment`** - Add a comment to a Jira issue with support for ADF mentions
- **`jira_get_issue_by_url`** - Fetch a Jira issue by URL and return normalized fields
- **`jira_get_issue_context`** - Aggregate full context for a Jira issue (parent, subtasks, links, comments, attachments)
- **`jira_find_user`** - Find users by name or email and return accountId + displayName
- **`jira_list_projects`** - List Jira projects with key, id, name, and browse URL
- **`jira_list_tasks`** - List Task issues for a project, with optional status and assignee filters
- **`jira_create_issue`** - Create a Jira issue with intelligent project/type inference

### 🐙 GitHub Tools
The agent includes comprehensive GitHub integration with tools prefixed with `github_`:

#### Repository Management
- **`github_list_user_installations`** - List GitHub installations you have access to
- **`github_list_app_installations`** - List GitHub app installations
- **`github_get_organization`** - Get information about a GitHub organization
- **`github_search_repositories`** - Search for GitHub repositories using GitHub Search Syntax
- **`github_get_repository`** - Get detailed information about a specific repository
- **`github_list_repository_contributors`** - List contributors to a repository
- **`github_list_releases`** - List releases for a repository

#### Issues & Pull Requests
- **`github_search_issues`** - Search for issues or pull requests using GitHub Search Syntax
- **`github_get_issue`** - Get detailed information about a specific issue
- **`github_get_pull_request`** - Get detailed information about a pull request
- **`github_list_issue_comments`** - List comments on an issue or pull request
- **`github_create_issue`** - Create a new GitHub issue
- **`github_create_issue_comment`** - Create a comment on an issue
- **`github_update_issue`** - Update an existing issue
- **`github_create_pull_request`** - Create a pull request (automatically created as draft)
- **`github_update_pull_request`** - Update an existing pull request

#### Code & Files
- **`github_repository_read_file`** - Read a file from a repository (250 lines at a time)
- **`github_repository_grep_file`** - Search for patterns within a file
- **`github_repository_list_directory`** - List contents of a directory in a repository
- **`github_search_code`** - Search for code across repositories (rate-limited)
- **`github_list_commits`** - List commits for a repository with filtering options
- **`github_get_commit`** - Get detailed information about a specific commit
- **`github_get_commit_diff`** - Get the diff for a commit (250 line limit)
- **`github_list_pull_request_files`** - List files changed in a pull request
- **`github_get_pull_request_diff`** - Get the diff for a pull request (250 line limit)

#### Reviews & Comments
- **`github_list_pull_request_reviews`** - List reviews for a pull request
- **`github_get_pull_request_review`** - Get details of a specific review
- **`github_list_pull_request_review_comments`** - List review comments on a pull request
- **`github_create_pull_request_review_comment_reply`** - Reply to a pull request review comment
- **`github_create_issue_comment_reaction`** - Create reactions on issue comments
- **`github_create_pull_request_review_comment_reaction`** - Create reactions on PR review comments

#### Actions & CI/CD
- **`github_actions_list_runs`** - List GitHub Actions workflow runs
- **`github_actions_list_jobs`** - List jobs for a specific run
- **`github_actions_get_job_logs`** - Get logs for a job (250 line limit)

#### Projects
- **`github_list_organization_projects`** - List projects for an organization
- **`github_list_organization_project_items`** - List items in a project

#### User Management
- **`github_get_user`** - Get user information by username or get current authenticated user

### 💻 Workspace & Development Tools
- **`initialize_workspace`** - Initialize a Daytona workspace for development
- **`workspace_authenticate_git`** - Authenticate with Git repositories for push/pull operations

#### Command Execution
- **`execute_bash`** - Execute bash commands asynchronously with full output capture
- **`execute_bash_sync`** - Execute bash commands synchronously with full output capture

#### Process Management
- **`process_send_input`** - Send input to a running process
- **`process_kill`** - Kill a process by PID
- **`process_wait`** - Wait for a process to exit and get results
- **`process_grep_output`** - Search through stored process output

#### File Operations
- **`read_file`** - Read files from the workspace filesystem (supports images and text)
- **`write_file`** - Write files to the filesystem
- **`edit_file`** - Make multiple edits to a single file in one operation

## Key Features

### 🔄 Intelligent Integration
- Automatically links Jira issues with GitHub pull requests
- Creates draft PRs by default for review workflows
- Enforces branch naming conventions (prefixed with 'blink/')

### 📊 Context-Aware Operations
- Fetches full context for Jira issues including parent, subtasks, and links
- Extracts acceptance criteria from issue descriptions and comments
- Provides comprehensive GitHub repository and PR analysis

### 🛠️ Development Workflow
- Full workspace management with Daytona integration
- Git authentication for seamless repository operations
- Complete process management with output capture and analysis

### 🔍 Advanced Search & Analysis
- GitHub code search with syntax support
- Jira issue filtering by project, status, and assignee
- Pattern matching across files and process outputs

## Environment Variables

The agent requires several environment variables for full functionality:

```bash
# GitHub Integration
GITHUB_APP_ID=your_github_app_id
GITHUB_APP_PRIVATE_KEY=your_base64_encoded_private_key
GITHUB_APP_INSTALLATION_ID=your_installation_id
GITHUB_WEBHOOK_SECRET=your_webhook_secret
GITHUB_BOT_LOGIN=your_bot_username

# Jira Integration
JIRA_SITE_BASE=https://your-domain.atlassian.net
JIRA_DEFAULT_PROJECT=DEFAULT_PROJECT_KEY

# Workspace Management
DAYTONA_API_KEY=your_daytona_api_key
DAYTONA_SNAPSHOT=blink-workspace-august-17-2025
DAYTONA_TTL_MINUTES=60
```

## Usage Patterns

### Issue Management
1. Use `jira_get_issue_context` to understand the full scope of a ticket
2. Create related GitHub issues with `github_create_issue`
3. Track progress with `jira_add_comment` updates

### Development Workflow
1. Initialize workspace with `initialize_workspace`
2. Authenticate Git access with `workspace_authenticate_git`
3. Create feature branches (prefixed with 'blink/')
4. Make code changes using file operations
5. Create draft PRs with `github_create_pull_request`

### Code Analysis
1. Search repositories with `github_search_repositories`
2. Analyze files with `github_repository_read_file` and `github_repository_grep_file`
3. Review changes with `github_get_pull_request_diff`
4. Execute tests with `execute_bash` and analyze results with `process_grep_output`

This agent is designed to be a comprehensive assistant for modern software development workflows, bridging the gap between project management (Jira) and code development (GitHub) with powerful workspace capabilities.