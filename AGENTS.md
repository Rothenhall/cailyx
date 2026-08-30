# Cailyx — Project Guidelines for AI Agents

## Overview

Cailyx is a modular monorepo containing a **Next.js frontend** (`frontend/`) and a **NestJS backend** (`backend/`). The project follows a structured, modular codebase architecture with in-code documentation and API documentation.

## Project Structure

```
Cailyx/
├── AGENTS.md              # This file — agent & architecture guidelines
├── docs/                  # Plans, architecture docs, analysis
│   └── PLAN.md            # High-level build plan
├── frontend/              # Next.js application (client-facing UI)
│   ├── .env               # Local environment variables (gitignored)
│   ├── .env.example       # Template for frontend env vars (committed)
│   └── src/
│       ├── app/            # Next.js App Router pages & layouts
│       ├── components/     # Reusable UI components
│       ├── lib/           # Utility functions & shared logic
│       ├── hooks/          # Custom React hooks
│       ├── services/      # API service layer (backend communication)
│       ├── types/          # TypeScript type definitions
│       └── styles/         # Global styles & theme
└── backend/               # NestJS application (API server)
    ├── .env               # Local environment variables (gitignored)
    ├── .env.example       # Template for backend env vars (committed)
    └── src/
        ├── app.module.ts           # Root application module
        ├── main.ts                 # Application entry point
        ├── common/                 # Shared utilities, guards, interceptors, decorators
        │   ├── decorators/
        │   ├── filters/
        │   ├── guards/
        │   ├── interceptors/
        │   ├── pipes/
        │   └── utils/
        ├── config/                 # Configuration module
        │   └── configuration.ts
        └── modules/                # Feature modules (modular architecture)
            └── (feature-name)/      # Each feature is a self-contained sub-module
                ├── dto/            # Data Transfer Objects
                ├── entities/       # Database entities/models
                ├── services/       # Business logic
                ├── controllers/    # Route handlers
                ├── *.module.ts     # Module definition
                └── README.md       # Module-specific documentation
```

## Architecture Principles

### 1. Modular Codebase
- **Everything is a module.** Each feature/domain is self-contained in its own module directory under `modules/`.
- Backend modules follow NestJS module conventions: each module has its own controllers, services, DTOs, entities, and a `*.module.ts` file.
- Frontend follows feature-based organization within the `src/` directory.
- Modules should have clear boundaries and minimal cross-dependencies. Use dependency injection and shared `common/` utilities for cross-cutting concerns.

### 2. One Module at a Time
- **Build sequentially, never all at once.** Work on one feature module end-to-end (backend + frontend + docs) before starting the next.
- Do not scaffold or stub multiple modules simultaneously. A module is either being actively built or it doesn't exist yet.
- Each module must be fully functional, tested, and documented before moving to the next one.
- The only exception is shared infrastructure (`auth`, `projects`, `config`) which must exist before feature modules can be built.

### 3. Tool & Technology Analysis Before Building
- **Before building any module, produce a detailed analysis document** that defines:
  - What the module does and which SOP/workflow it maps to
  - Every external tool, library, API, and service the module needs
  - **For each tool/service: list 2-3 options** with pros, cons, pricing, and a recommendation
  - External APIs needed (name the specific API, what data it provides, authentication method)
  - Database entities/tables this module creates
  - API endpoints this module exposes
  - Frontend pages/components this module needs
- **The user must approve the tool choices before any code is written.** Present the analysis as a decision document, wait for the user to pick which tools to use, then build with those choices.
- Never silently pick a library or service. Never install a dependency without it being part of an approved analysis.
- Save the approved analysis as `docs/analysis/<module-name>.md` so it serves as the module's build spec.

### 4. Structured Codebase
- Follow consistent naming conventions:
  - **Files:** `kebab-case.ts` (e.g., `user-service.ts`)
  - **Classes:** `PascalCase` (e.g., `UserService`)
  - **Interfaces/Types:** `PascalCase` (e.g., `UserDto`)
  - **Variables/Functions:** `camelCase`
- Directory structure should reflect domain boundaries.
- Group related code together (controller + service + dto + entity in the same module folder).

### 5. Documentation
- **In-code documentation:** Every module, service, controller, and component should have JSDoc/TSDoc comments explaining its purpose.
- **API Documentation:** The backend uses Swagger/OpenAPI. All endpoints, DTOs, and responses are auto-documented via `@ApiTags`, `@ApiOperation`, `@ApiResponse`, and `@ApiProperty` decorators.
- **Module README:** Each module has a `README.md` explaining its purpose, dependencies, API endpoints, and usage.
- **Analysis docs:** Before a module is built, its analysis lives in `docs/analysis/<module-name>.md`. After approval, this becomes the build spec.
- Keep documentation close to the code it describes.

### 6. Configuration & Environment
- Environment variables are managed via `.env` files.
- `.env.example` files are committed to the repository as templates; `.env` files are gitignored.
- Never commit secrets or real credentials.
- Use validated configuration modules (e.g., NestJS `@nestjs/config` with Joi/Zod schema validation).
- When a module needs external API keys, add the new env vars to both `.env` and `.env.example` in the backend.

## Tech Stack

| Layer      | Technology           |
|------------|---------------------|
| Frontend   | Next.js (App Router), TypeScript, Tailwind CSS |
| Backend    | NestJS, TypeScript   |
| API Docs   | Swagger / OpenAPI    |
| Package Mgr | npm                 |

## Development Commands

### Frontend
```bash
cd frontend
npm install
npm run dev      # Start dev server (http://localhost:3000)
npm run build    # Production build
npm run lint     # Run linter
```

### Backend
```bash
cd backend
npm install
npm run start:dev   # Start dev server (http://localhost:3001)
npm run build       # Production build
npm run lint        # Run linter
```

## Post-Module-Completion Checklist

**Every time a module is marked complete, the following must be done before moving to the next module. No exceptions.**

### 1. Module README
Create or update `backend/src/modules/<module-name>/README.md` with:
- Module purpose (one sentence)
- Architecture (file tree with one-line descriptions)
- Public API (methods/endpoints with signatures)
- Dependencies (other modules, npm packages, external services)
- Environment variables (name, default, description)
- Consumers (which modules call this one)
- PRD alignment table (requirement ID → status → notes)
- Testing notes (what was tested, results)


### 1b. Module-Level Docs
Move module-specific spec and requirements docs INTO the module folder:
` 
backend/src/modules/<module-name>/
  README.md          # Module overview, API, PRD alignment, test results
  SPEC.md            # Detailed module spec (what it does, how)
  REQUIREMENTS.md    # External tools, APIs, infrastructure needed
  SETUP-STATUS.md    # What is installed, what is pending
` 
The docs/ folder at the project root is for project-level docs only:
` 
docs/
  PRD.md                    # Product Requirements Document
  PLAN.md                   # Build plan and phases
  API.md                    # REST API documentation with setup instructions
  MODULES-STATUS.md         # Module-by-module state (living)
  PRODUCTION-READINESS.md   # Everything needed to go live: secrets, infra, hardening
  aeo-research-*.md         # Research findings
` 

**Also maintain (project root):**
- `CHANGELOG.md` — a running record of what shipped, how it was verified, and
  what it left for later. Add an entry on every meaningful change.
- `docs/PRODUCTION-READINESS.md` — keep the secrets / infra / hardening checklist
  current whenever a new integration, env var, or external dependency is added.

### 2. API Documentation
Update `docs/API.md` with:
- All new REST endpoints (method, path, request body, response shape)
- Example request and response JSON
- Status codes and error shapes
- Mark planned/stub endpoints clearly

### 3. PRD Alignment Check
Create or update a PRD alignment table in the module README:
```
| PRD Requirement | Status | Notes |
|---|---|---|
| FR-X.X | ✅ / ⚠️ / ❌ | ... |
```
- ✅ = fully implemented and tested
- ⚠️ = partially implemented (note what's missing)
- ❌ = not implemented (note why — deferred, needs another module, etc.)

### 4. Docs Update
- Update `docs/PLAN.md` if the module changes the build plan or phase order
- Save any research findings to `docs/` (e.g., `docs/aeo-research-2026.md`)
- If external tools/APIs were chosen, record the decision in `docs/analysis/<module-name>.md`

### 5. Code Quality Verification
- [ ] `npx tsc --noEmit` passes with zero errors
- [ ] All public methods have JSDoc comments
- [ ] No `any` types (use proper interfaces)
- [ ] Module imports/exports are clean
- [ ] `app.module.ts` is updated if the module is new
- [ ] `.env` and `.env.example` are updated with new env vars

### 6. Test Verification
- [ ] Module compiles and starts without errors
- [ ] At least one end-to-end test was run (real URL, real API call)
- [ ] Test results are recorded in the module README

### 7. Git-Ready
- [ ] No test files or temporary scripts left in the repo
- [ ] `.env` is NOT committed (only `.env.example`)
- [ ] All new files are in the correct directory structure

**Only after all 7 items are complete may the next module be started.**

---
## Agent Rules

1. **Always follow the modular structure.** New features go in `modules/` (backend) or appropriate `src/` subdirectory (frontend).
2. **One module at a time.** Never scaffold multiple feature modules at once. Finish one before starting the next.
3. **Analysis before code.** Before building any module, produce a tool/technology analysis doc in `docs/analysis/<module-name>.md` with options for each tool/API. Wait for user approval before writing code.
4. **Never install unapproved dependencies.** Every npm package, external API, or service must appear in an approved analysis doc before it's added.
5. **Document as you build.** Add JSDoc comments, Swagger decorators, and module READMEs.
6. **Never commit `.env` files** — only `.env.example` templates.
7. **Use TypeScript everywhere.** No plain JavaScript.
8. **Validate all input** with DTOs and validation pipes (backend) / form validation (frontend).
9. **Keep dependencies minimal.** Only add packages that are necessary and approved.
10. **Test before committing.** Ensure `npm run build` passes for both frontend and backend.
11. **Respect existing patterns.** Follow conventions already established in the codebase.
12. **Connected API tools.** Every module should expose clean REST APIs that can be consumed independently by the frontend or by external systems. Modules are tools that connect to each other.
13. **Post-completion checklist.** After completing any module, run through the Post-Module-Completion Checklist above (README, API docs, PRD alignment, code quality, test verification). No exceptions.
