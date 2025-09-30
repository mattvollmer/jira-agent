# Jira Agent

AI-powered agent that integrates Jira, GitHub, and workspace management for streamlined development workflows.

## Available Tools

### 📋 Jira Tools (8 tools)
- **`jira_reply`** - Post final answer as Jira comment (mentions requester)
- **`jira_add_comment`** - Add comment with ADF mention support
- **`jira_get_issue_by_url`** - Fetch issue details by URL
- **`jira_get_issue_context`** - Get full issue context (parent, subtasks, links, comments)
- **`jira_find_user`** - Find users by name/email, return accountId
- **`jira_list_projects`** - List projects with key, name, URL
- **`jira_list_tasks`** - List issues with status/assignee filters
- **`jira_create_issue`** - Create issues with smart project/type inference

### 🐙 GitHub Tools (43 tools)
Comprehensive GitHub integration with `github_` prefix:

**Repository & Organization**: Search repos, get repo info, list contributors/releases, manage installations

**Issues & Pull Requests**: Create/update/search issues and PRs, manage comments, get PR details (PRs created as drafts by default)

**Code Analysis**: Read files, grep patterns, list directories, search code, view commits/diffs, list PR files

**Reviews & Collaboration**: Manage PR reviews/comments, create reactions, reply to review comments

**Actions & CI/CD**: List workflow runs/jobs, get job logs for debugging

**Projects**: List org projects and project items

**Users**: Get user information

### 💻 Workspace & Development Tools (15 tools)
**Workspace Setup**:
- **`initialize_workspace`** - Initialize Daytona workspace
- **`workspace_authenticate_git`** - Authenticate for Git push/pull

**Command Execution**:
- **`execute_bash`** / **`execute_bash_sync`** - Run commands with full output capture

**Process Management**:
- **`process_wait`** - Get process results
- **`process_grep_output`** - Search process output
- **`process_send_input`** / **`process_kill`** - Control running processes

**File Operations**:
- **`read_file`** - Read text/image files
- **`write_file`** - Write files
- **`edit_file`** - Make multiple file edits atomically

### 🕒 Utility
- **`get_current_date`** - Get current UTC date/time

## Key Features

- **Intelligent Integration**: Links Jira issues with GitHub PRs, creates draft PRs, enforces 'blink/' branch prefixes
- **Context-Aware**: Full Jira issue context, acceptance criteria extraction, comprehensive GitHub analysis  
- **Development Workflow**: Daytona workspace management, Git authentication, process management with output capture
- **Advanced Search**: GitHub code search, Jira filtering, pattern matching across files and outputs

## Environment Variables

```bash
# GitHub Integration  
GITHUB_APP_ID=your_github_app_id
GITHUB_APP_PRIVATE_KEY=your_base64_encoded_private_key
GITHUB_APP_INSTALLATION_ID=your_installation_id

# Jira Integration
JIRA_SITE_BASE=https://your-domain.atlassian.net
JIRA_DEFAULT_PROJECT=DEFAULT_PROJECT_KEY

# Workspace Management
DAYTONA_API_KEY=your_daytona_api_key
```

## Common Workflows

**Issue Management**: `jira_get_issue_context` → `github_create_issue` → `jira_add_comment`

**Development**: `initialize_workspace` → `workspace_authenticate_git` → create 'blink/' branches → `github_create_pull_request` (draft)

**Code Analysis**: `github_search_repositories` → `github_repository_read_file` → `github_get_pull_request_diff` → `execute_bash` + `process_grep_output`