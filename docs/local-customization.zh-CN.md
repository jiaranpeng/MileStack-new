# 定制版开发与维护

本仓库基于 SuperYang006/MileStack 0.2.1。版本 `0.2.1-custom.1`，命令名 `milestack`。

## 独立构建和安装

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm typecheck:ui
pnpm test
pnpm build
npm pack
npm install --global ./milestack-0.2.1-custom.1.tgz
```

所有定制逻辑均在 TypeScript/React 源码中实现，无需安装备份、生成代码补丁或其他电脑的 `.milestack` 数据。`prepare` 自动构建，`prepack` 检查类型和测试。包内包含 CLI、网页、独立适配器、共享 JS chunk 和前向迁移。源码安装后也可直接 `npm install --global .`，此方式应保留源码目录。

`pnpm-workspace.yaml` 仅允许 SQLite 和 esbuild 必要的依赖构建脚本。`tsx` 显式列为开发依赖，测试不依赖 pnpm 私有目录；打包安装后的运行不需要开发工具。

## 默认工作流和兼容性

默认 `manual-approval`：提交 Git 可选，AI 审核不自动归档，人工确认后完成，前置任务进入审核后可推进后续任务。打开项目时会协调旧版已批准记录。

核心开发接口保留显式 `workflowPolicy: "reviewed-commit"`，供要求上游固定提交/Git 集成门槛的嵌入场景与兼容测试使用。CLI 默认定制策略。旧策略测试显式选择它，`tests/core/manual-approval.test.ts` 验证定制默认值。

## 桌面连接与图片

首次从 Codex 本地聊天启动项目网页服务，再打开就绪任务详情读取聊天列表，保存真实调用会话和工具管道。连接保存在 `.milestack/desktop-connection.json`，不会提交 Git。后续普通终端可复用连接。Windows 桌面重启后仅在发现唯一管道时自动重连；多实例不猜测目标。

依赖桌面版附带的 `codex-app-tools`，接口升级后可能需要适配。只暴露读取项目聊天和派发指定任务，不提供任意桌面工具代理。派发记录持久化，超时不自动重发。未配对、聊天忙、项目不符或 MCP 未连接时明确报告。

图片副本在 `.milestack/images/`，数据库保存引用。备份整个 `.milestack/`。移除引用不直接删除可能被其他任务使用的文件；取消录入产生的未关联上传也保留本地。旧任务图片不自动补录，新工具需重连旧 MCP 会话。

## 制品验收与升级

```powershell
node tests/mcp/installed-customization-smoke.mjs dist/index.js
```

该检查验证图片导入、原文件移走后的读取、可选 Git 和人工验收流程。在已运行 7331 服务时，可手动执行 `node tests/server/installed-port-smoke.mjs dist/index.js` 检查新增两个服务的端口和项目隔离。

定制包通过发行标识防止 `milestack update` 自动安装上游 npm 包。升级请拉取本仓库、重建并重新安装，再重启网页和 MCP。数据库先备份再迁移。

提交保留源码、测试、迁移、锁文件、构建配置和文档。忽略 `node_modules`、`dist`、压缩包、项目 `.milestack` 数据、`.codex`、`.idea` 和日志。推送、发布和打标签由维护者执行。
