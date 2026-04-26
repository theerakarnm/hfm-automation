
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

---
# 🎯 Context Engineering Template - Global Rules for AI Assistants

This repository is a comprehensive template for **Context Engineering** - the discipline of engineering context for AI coding assistants. This CLAUDE.md file provides global instructions that AI assistants should follow when working in this repository.

## 📋 Repository Structure

This is a **template repository** with multiple use cases demonstrating context engineering patterns:

```
context-engineering-intro/
├── .claude/
│   └── commands/              # Slash commands for workflows
│       ├── generate-prp.md    # Generate Product Requirements Prompts
│       └── execute-prp.md     # Execute PRPs to implement features
├── PRPs/                      # Product Requirements Prompts
│   ├── templates/
│   │   └── prp_base.md       # Base PRP template
│   └── EXAMPLE_*.md          # Example PRPs
├── examples/                  # Code examples (add your own)
├── use-cases/                # Specialized use case templates
│   ├── pydantic-ai/          # Building PydanticAI agents
│   ├── agent-factory-with-subagents/  # Multi-agent factory system
│   ├── mcp-server/           # Building MCP servers
│   ├── template-generator/   # Template generation
│   └── ai-coding-workflows-foundation/  # AI workflow foundation
├── claude-code-full-guide/   # Complete Claude Code documentation
├── CLAUDE.md                 # This file - global rules
├── INITIAL.md                # Template for feature requests
├── INITIAL_EXAMPLE.md        # Example feature request
└── README.md                 # Getting started guide
```

## 🎯 Primary Workflow: PRP Pattern

This repository implements the **PRP (Product Requirements Prompt) workflow** for systematic feature implementation:

### Step 1: Create Feature Request (INITIAL.md)
Define what you want to build with:
- **FEATURE**: Detailed description of functionality
- **EXAMPLES**: Reference code patterns and existing files
- **DOCUMENTATION**: Links to relevant docs, APIs, libraries
- **OTHER CONSIDERATIONS**: Gotchas, requirements, edge cases

### Step 2: Generate PRP
```bash
/generate-prp INITIAL.md
```
This command:
1. Researches the codebase for similar patterns
2. Searches for relevant documentation
3. Creates a comprehensive implementation blueprint in `PRPs/`
4. Includes validation gates and test requirements

### Step 3: Execute PRP
```bash
/execute-prp PRPs/your-feature-name.md
```
This command:
1. Reads all context from the PRP
2. Creates detailed implementation plan (use TodoWrite tool)
3. Implements each step with validation
4. Runs tests and fixes issues
5. Ensures all success criteria are met

## 🔄 Working with Use Cases

Each use case in `use-cases/` has its own specialized context:

- **When working in `use-cases/pydantic-ai/`**: Follow the PydanticAI-specific rules in that directory's CLAUDE.md
- **When working in `use-cases/agent-factory-with-subagents/`**: Follow the agent factory orchestration workflow
- **When working in `use-cases/mcp-server/`**: Follow MCP server development patterns
- **When at repository root**: Follow the general rules below

## 🧱 Code Structure & Modularity

- **Never create a file longer than 500 lines of code.** Refactor by splitting into modules when approaching this limit.
- **Organize code into clearly separated modules**, grouped by feature or responsibility:
  - For **AI agents**: `agent.py`, `tools.py`, `prompts.py`, `models.py`, `dependencies.py`
  - For **APIs**: `routes/`, `services/`, `models/`, `schemas/`
  - For **libraries**: Logical module separation by feature
- **Use clear, consistent imports** (prefer relative imports within packages)
- **Use python-dotenv and load_dotenv()** for environment variables - never hardcode secrets
- **Create .env.example files** showing required environment variables

## 🧪 Testing & Reliability

- **Always create comprehensive tests** for new features using pytest
- **Tests should mirror the main structure** in a `/tests` folder
- **Include at least**:
  - 1 test for expected/happy path
  - 1 edge case test
  - 1 failure/error case test
- **For AI agents**: Use TestModel/FunctionModel for testing without API calls
- **Run tests before marking tasks complete**

## ✅ Task Management with TodoWrite

- **Use TodoWrite tool proactively** for multi-step tasks to track progress
- **Create specific, actionable items** with clear completion criteria
- **Mark tasks completed immediately** after finishing them
- **Keep exactly ONE task in_progress** at any time
- **Include both forms** for each task:
  - `content`: Imperative form ("Run tests", "Build feature")
  - `activeForm`: Present continuous ("Running tests", "Building feature")

## 📎 Style & Conventions

### Python (Primary Language)
- **Follow PEP8** with type hints throughout
- **Use `pydantic` for data validation** and settings management
- **Use `black` for formatting** (or ruff format)
- **Write docstrings for every function** using Google style:
  ```python
  def example(param1: str) -> dict:
      """
      Brief summary of what function does.

      Args:
          param1: Description of parameter.

      Returns:
          Description of return value.
      """
  ```

### Security Best Practices
- **Never hardcode API keys or secrets**
- **Always use .env files** with python-dotenv
- **Validate all external inputs** using Pydantic models
- **Implement proper error handling** without exposing sensitive information

## 📚 Documentation & Explainability

- **Update README.md** when features are added or setup steps change
- **Comment non-obvious code** for mid-level developer understanding
- **Add inline `# Reason:` comments** for complex logic explaining the "why"
- **Create comprehensive PRPs** with all necessary context for one-pass implementation
- **Include validation gates** in PRPs (executable commands that must pass)

## 🧠 AI Assistant Behavior Rules

### Context Engineering Principles
- **Always use the PRP workflow** for complex features (3+ steps)
- **Research extensively** before generating PRPs:
  - Search codebase for similar patterns
  - Find relevant documentation online
  - Identify integration points and gotchas
- **Include ALL necessary context** in PRPs:
  - Documentation URLs with specific sections
  - Code examples from the codebase
  - Library quirks and version-specific issues
  - Existing patterns to follow

### General Behavior
- **Never assume missing context** - ask clarifying questions
- **Never hallucinate libraries or functions** - only use verified packages
- **Always confirm file paths exist** before referencing them
- **Never delete or overwrite code** unless explicitly instructed
- **Avoid over-engineering**:
  - Don't add unrequested features
  - Don't create abstractions for one-time operations
  - Don't add error handling for impossible scenarios
  - Keep solutions simple and focused
- **Use specialized tools over bash** when available (Read, Edit, Write, Glob, Grep)
- **Use the Explore agent** for codebase exploration rather than direct searches

### Proactive Tool Usage
- **Use TodoWrite** for multi-step tasks to track progress
- **Use Task tool with Explore agent** for codebase questions
- **Use WebSearch** for researching documentation and best practices
- **Use parallel tool calls** when operations are independent

## 🎨 Context Engineering Best Practices

### When Creating PRPs
1. **Be explicit and comprehensive** - don't assume the AI knows preferences
2. **Provide many examples** - show what to do AND what not to do
3. **Include validation gates** - executable tests that must pass
4. **Reference documentation** - specific URLs and sections
5. **Document gotchas** - library quirks, common pitfalls, version issues

### When Executing PRPs
1. **Read the entire PRP first** - understand all context and requirements
2. **Create detailed plan with TodoWrite** - break down into manageable steps
3. **Follow patterns from examples** - don't invent new approaches
4. **Run validation gates** - iterate until all tests pass
5. **Verify success criteria** - ensure all requirements met

## 🔍 Slash Commands Reference

Custom commands available in `.claude/commands/`:

- **`/generate-prp INITIAL.md`** - Generate comprehensive Product Requirements Prompt
- **`/execute-prp PRPs/feature.md`** - Execute PRP to implement feature
- Use case-specific commands may be available in `use-cases/*/. claude/commands/`

## 🚨 Important Anti-Patterns to Avoid

### NEVER:
- ❌ Skip the PRP workflow for complex features
- ❌ Hardcode API keys, secrets, or sensitive data
- ❌ Create files without reading similar existing files first
- ❌ Skip testing phases or mark tasks complete with failing tests
- ❌ Ignore validation gates in PRPs
- ❌ Over-engineer with unnecessary abstractions
- ❌ Add backwards-compatibility hacks for unused code
- ❌ Create PLANNING.md or TASK.md files (use TodoWrite tool instead)
- ❌ Commit to implementing before understanding requirements

### ALWAYS:
- ✅ Use environment variables via python-dotenv
- ✅ Create comprehensive tests for new features
- ✅ Follow existing code patterns and conventions
- ✅ Document implementation decisions
- ✅ Validate against requirements before marking complete
- ✅ Use TodoWrite for task tracking on multi-step features
- ✅ Ask clarifying questions when requirements are unclear

## 📖 Learning Resources

- **README.md** - Quick start guide and overview
- **claude-code-full-guide/README.md** - Complete Claude Code documentation
- **PRPs/templates/prp_base.md** - Template for creating PRPs
- **PRPs/EXAMPLE_*.md** - Example PRPs showing best practices
- **use-cases/** - Specialized templates for different use cases

## 🎓 Using This Template

This repository serves as both:
1. **A template** - Fork or copy for your own projects
2. **A learning resource** - Study the patterns and workflows
3. **A use case library** - Explore specialized implementations

When starting a new project:
1. Copy relevant files (CLAUDE.md, INITIAL.md, .claude/commands/)
2. Customize for your tech stack and conventions
3. Add your own examples to the `examples/` directory
4. Create PRPs for your features using the workflow

---

**Remember**: Context Engineering is about providing AI assistants with **all the information they need** to implement features correctly on the first try. The more context you provide upfront, the better the results.

---