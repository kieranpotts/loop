# Skills

Agent harnesses are converging on supporting the `./agent/skills/` path for dynamic retrieval of project-specific skills that are compatible with the [Agent Skills](https://agentskills.io/) conventions.

This is the primary skills path detected by OpenAI Codex, and it is supported as an alternative, agent-agnostic path by GitHub Copilot / VS Code, Gemini CLI, Google Antigravity, OpenCode, and Pi.

As of May 2026, Claude Code and Cursor do NOT dynamically retrieve skills from this path. If you use these agent harnesses you will need to find a workaround, eg. using symlinks from `.claude/skills/`.

See https://github.com/kieranpotts/skills for a template for AI skills.
