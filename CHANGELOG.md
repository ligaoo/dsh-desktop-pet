# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Plugin system (`PetHost` + `definePlugin`) — everything is a plugin.
- Built-in plugins: `runtime`, `state`, `bridge`, `window`, `notifier`, `identity`, `memory`.
- Streaming replies (`assistant/chunk` `text-delta` accumulation).
- Long-term memory: persona, facts, episodic summaries, working history, and memory commands (`记住 / 忘了 / 你记得什么`).
- Desktop notifications (task done, approvals) with a local HTTP notify endpoint.
- Harness-host bridge (`harness-host`) for forwarding host approvals/task events to the pet, with optional approval answering.
- System tray + global hotkey for summoning the pet.
- Image skins (`pet.png` / per-mood images) with zero-config auto-detection.
- Auto-injected harness credentials from `~/.dsh/.credentials.yaml`.
- Multimodal image output: the chat log renders assistant images. `prompt()` now resolves a `{ response, images }` reply; image sources are extracted from `assistant/message` / `assistant/chunk` (`block-end`) `image` content blocks and, as a fallback, from `![alt](src)` / `<img src="…">` in the reply text (which are then stripped from the displayed text). The renderer CSP now allows `data:`/`blob:`/`https:` images.
- Image input (user → model): the chat composer accepts a pasted/dropped/picked image, shows a thumbnail, and sends it with the prompt. The pet persists the image into `pet-uploads/` under the session workspace and the model is told the file path, so it can open the picture with its own file tool. This keeps the SDK wire text-only (the model layer only accepts pre-registered durable attachments, which this transport cannot create) and leaves DSH source untouched.

### Changed
- Extracted from `deepseek-harness/packages/extensions/desktop-pet` into a standalone project with vendored SDK artifacts.

## [0.1.0] - 2026-08-19

Initial standalone release.
