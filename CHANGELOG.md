# Changelog

All notable changes to this project are tracked here. The project follows semantic versioning:

- `patch`: bug fixes and small UX improvements.
- `minor`: backward-compatible features.
- `major`: breaking changes to setup, data format, or API behavior.

## 2.1.0 - 2026-09-26

### Added

- Prompt-writing step that turns a user's intent into detailed page prompts through the APIMart OpenAI Responses API.
- Per-project chat history saved with the project, without storing the API key.
- Delete action on each history item in the left project list. Deleting the last project leaves a blank one, and only removes local images referenced by that project.

### Changed

- The three-step flow is now: write prompts, generate pages, export PPTX. ZIP and PDF remain on the export page.
- The same local APIMart key is used for both text prompts and image generation. The open-source tree ships with an empty `config.example.json` and no private data.

## 2.0.0 - 2026-07-23

### Added

- Windows-first three-step workspace for Claude/OpenClaw prompt import, page review, image generation, and ZIP/PDF/PPTX export.
- Built-in base prompt, anonymous three-page example, and Chinese prompt guide using `<!-- PAGE -->` separators.
- Local reference-image proxy for JPEG, PNG, WebP, and GIF files up to 20MB.
- Cross-platform smart launcher with Node.js 18+ checks, first-run dependency installation, free-port discovery, and automatic browser opening.
- Allowlisted clean share package with secret scanning and private-data exclusions.

### Changed

- APIMart is fixed to `https://api.apimart.ai` with model `gpt-image-2-official`; generation defaults are fixed to 16:9, auto quality, one PNG per page, with 1K/2K/4K resolution selection.
- API configuration responses now expose only whether a Key is configured; the Key stays in the local backend configuration file.
- The primary and only browser entry is now `index.html`, using local CSS and local Lucide icons without a frontend build step.
- CLI commands are reduced to `health`, `config`, `batch`, `generate`, `task`, and `manifest`.

### Removed

- History, statistics, asset library, saved projects, templates, snapshots, chat, manual task recovery, and text-model configuration from the product surface.
- Markdown/Obsidian illustration workflows and arbitrary local-file APIs.
- Tailwind CDN, Electron-era pages, unused direct dependencies, and one-off regeneration scripts.

## 1.5.0 - 2026-05-07

### Added

- Browser workspace based on `index_auto.html` for PPT image generation and Markdown illustration workflows.
- Card-based Markdown illustration editor for editing prompt blocks, generated image prompts, and raw Markdown directly in the browser.
- Runtime model configuration panel with separate image-generation API settings and text-processing API settings.
- Local Markdown load/save/update endpoints for browser-based editing.
- Text-processing model integration for generating better illustration prompts when an OpenAI-compatible text API is configured.
- CLI `batch` workflow for Codex / Claude Code to fill prompt batches into the browser workspace and wait for user confirmation.

### Changed

- Root URL opens the browser workspace.
- Image generation API base can be configured at runtime instead of only through environment variables.
- Electron desktop packaging has been removed; the project is now a local Web + CLI tool.

## 1.4.0 - 2026-05-07

### Added

- Two-step Markdown illustration workflow: write editable image prompts into the document first, then generate images after approval.
- Prompt blocks can be edited directly in Obsidian/Markdown before generation.
- Generated image blocks retain the source prompt in comments, so images can be restored to editable prompts and regenerated.
- CLI flags: `--write-prompts`, `--from-prompts`, and `--restore-prompts`.

## 1.3.0 - 2026-05-07

### Added

- Markdown/Obsidian illustration mode for adding generated images to `.md` documents.
- Runtime API Key handoff from the browser to the local backend, allowing Claude Code and CLI tools to call image generation without storing the key on disk.
- `/api/illustrate-md` endpoint for selecting text-heavy sections, generating diagrams, saving images to `attachments/`, and inserting embeds back into the document.
- `scripts/illustrate-md.js` and `npm run illustrate:md` for CLI-style usage.

## 1.2.1 - 2026-05-07

### Added

- `start-server.command` startup script for launching the backend service and opening the browser.

## 1.2.0 - 2026-05-07

### Added

- Style preset selector for loading global prompt prefixes before PPT image generation.
- Built-in presets for McKinsey-style consulting visuals, Apple minimal visuals, technology enterprise visuals, and warm illustration visuals.
- Single-channel batch generation queue: the next page starts only after the current page completes or fails.
- Batch queue progress text in the top status area and button label.

### Changed

- Generation now composes the selected global prefix with each page prompt at submit time, so style selection still applies after importing pages.
- Row polling timers are cleared per request when a row completes or fails.

## 1.1.0 - 2026-05-07

### Added

- Local project autosave and restore through `data/project.json`.
- Local generation history through `data/history.json`.
- Local asset library through `assets/` and generated-image indexing from `ppt_images/`.
- Server-side generation proxy with idempotency keys to avoid duplicate submissions from double clicks.
- UI entries for material library, history, version display, and autosave status.
- Version-management scripts: `release:patch`, `release:minor`, and `release:major`.

### Changed

- Removed the hardcoded API Key from the HTML input.
- Generation and task polling now go through the local service instead of calling the remote API directly.

## 1.0.0 - 2026-05-07

### Added

- Initial PPT image batch generation UI.
- Markdown page import.
- Automatic generated-image downloads.
