# MileStack-new — customized edition

[简体中文](README.md) | English

Local project tasks, business descriptions, reference images and a Codex desktop execution entry point. Based on [SuperYang006/MileStack](https://github.com/SuperYang006/MileStack). Version **0.2.1-custom.1**; command name **`milestack`**.

## Features

- Plain-language business descriptions alongside acceptance criteria.
- Execute ready tasks in an existing same-project Codex desktop chat; conversation claiming remains available.
- Paste/upload images, preview them and exchange them through MCP.
- Automatically increment occupied HTTP ports.
- Optional Git traceability, manual developer approval before archival, and successors unblocked when dependencies enter review.
- Self-contained TypeScript/React source builds without machine-specific backup files or bundle patches.

## Install

Requires Node.js 22+ (24 LTS recommended), Git, and pnpm 10.29.2 for source development.

```sh
git clone https://github.com/jiaranpeng/MileStack-new.git
cd MileStack-new
corepack enable
pnpm install --frozen-lockfile
npm install --global .
milestack --version
```

The `prepare` lifecycle automatically builds the CLI and web UI. For a portable installation:

```sh
npm pack
npm install --global ./milestack-0.2.1-custom.1.tgz
```

After this release is pushed, direct Git installation is also supported:

```sh
npm install --global "git+https://github.com/jiaranpeng/MileStack-new.git"
```

`npm install -g milestack` installs the upstream registry distribution, not this edition.

## Use

```sh
cd /absolute/path/to/your/project
milestack init --client codex
milestack serve
```

Follow the printed URL. Ports start at 7331 and increment when occupied. Add to the project's `AGENTS.md`, then reconnect MCP:

```md
Before working on tasks, read and follow `.milestack/agent-instructions.md`.
```

Create a draft and confirm it, or create a ready task directly. Open ready-task details, select the project chat and click **执行任务**. Runtime status changes only after the agent actually claims the task.

Desktop execution is tested on Windows Codex desktop with its bundled local tools. Initial pairing requires starting the project service from a local Codex chat so it inherits the real connection context. The target chat needs the project MCP connected, and the desktop app must stay open. Paired projects can reuse the connection from ordinary terminals.

Images support PNG/JPEG/GIF/WebP, 10 MB per image and 20 per task. Paste in the image region using Ctrl+V/right-click, or select files. MCP creation accepts `imagePaths` or `imageIds`; `import_task_image` imports a picture and `get_task_image` returns its content. Old chat images are not automatically imported.

Back up the whole project `.milestack/`, including the SQLite database and image files. Pull this repository and rebuild/reinstall to upgrade. `milestack update` refreshes instructions without replacing this edition with the upstream registry package.

## Development

```sh
pnpm typecheck
pnpm typecheck:ui
pnpm test
pnpm build
```

See the [Chinese README](README.md) and [maintenance guide](docs/local-customization.zh-CN.md). Licensed under [Apache-2.0](LICENSE); upstream attribution is retained.
