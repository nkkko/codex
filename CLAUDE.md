# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Test Commands
- Build: `npm run build`
- Dev mode: `npm run build:dev`
- Format check: `npm run format`
- Format fix: `npm run format:fix`
- Lint: `npm run lint`
- Lint fix: `npm run lint:fix`
- Typecheck: `npm run typecheck`
- Run tests: `npm run test`
- Run single test: `npm run test -- -t "test name pattern"`

## Code Style Guidelines
- Use TypeScript with strict typing
- Indent using 2 spaces
- Max line width: 80 characters
- Use semicolons at the end of statements
- Use trailing commas in multiline objects/arrays
- Use ESM module format (import/export)
- Use camelCase for variables/functions, PascalCase for classes/interfaces
- Prefer const over let, avoid var
- Document functions with JSDoc comments for complex logic
- Handle errors with try/catch blocks and appropriate logging
- Follow React hooks naming convention (use* prefix)
- Organize imports with built-ins first, then external packages, then local modules