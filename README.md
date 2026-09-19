# 口述家史编辑器

React + TypeScript 前端、Fastify API、BullMQ worker、PostgreSQL 和 Redis 组成的 pnpm monorepo。当前版本支持注册登录、创建工作区、上传真实音频、异步读取音频时长、创建固定时间范围片段、按时间段播放，以及章节/内容块和发布接口。

## 环境要求

- Node.js 22.13 或更高版本
- pnpm 9
- Docker（本地 PostgreSQL、Redis）
- FFmpeg 可选。worker 优先使用 `ffprobe`，未安装时会使用 `music-metadata` 读取常见音频时长

## 本地启动

```bash
cp .env.example .env
docker compose up -d postgres redis
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

打开 <http://localhost:5173>。首次注册会自动登录并创建一个默认工作区；上传音频后，worker 会异步读取元数据，状态变为 `READY` 后即可创建片段。

开发阶段也可以用 `pnpm db:push` 直接同步 schema。根目录脚本会自动读取 `.env`；若文件不存在则回退到 `.env.example`。

## 检查

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## 主要接口

- `POST /v1/auth/register`、`POST /v1/auth/login`
- `GET/POST /v1/workspaces`
- `POST /v1/workspaces/:id/recordings/uploads`
- `GET /v1/recordings/:id/file`（支持 HTTP Range）
- `GET/POST /v1/recordings/:id/clips`
- `PATCH /v1/clips/:id`（乐观锁，版本冲突返回 409）
- `GET/POST /v1/workspaces/:id/chapters`
- `PATCH /v1/chapters/:id`
- `POST /v1/chapters/:id/blocks`
- `POST /v1/chapters/:id/publish`（发布节点写入章节版本仓库，内容无变化返回 409）
- `GET /v1/chapters/:id/versions`（版本仓库，revision 倒序）
- `GET /v1/chapters/:id/versions/:revision`（按差量链重放出的历史完整内容）
- `POST /v1/chapters/:id/rollback`（回滚到指定 revision，必传乐观版本号，冲突返回 409）
- `GET /v1/workspaces/:id/events`
- `GET /v1/realtime?workspaceId=...`（WebSocket）

健康检查为 `GET /health` 和 `GET /ready`。

## 章节版本仓库

每次发布都会在 `ChapterVersion` 中保存一个版本节点：节点包含发布时的章节快照，以及相对上一节点的差量（内容块 added/updated/removed、标题与简介变化），并通过 `stateHash` + `parentStateHash` 组成哈希链。回滚时按 revision 顺序重放差量链重建目标节点的完整状态（`GET .../versions/:revision` 同源逻辑），同时校验哈希链，链损坏会返回 404/错误而不是静默恢复。

`POST /v1/chapters/:id/rollback` 请求体为 `{ revision, expectedChapterVersion }`（也接受别名 `expectedRevision`）：

- `revision` 是要恢复到的发布节点；`expectedChapterVersion` 必填，取自章节当前的 `version`（乐观锁）。
- 回滚在单个可串行化事务内执行：先 `SELECT ... FOR UPDATE` 锁定章节行串行化并发发布/回滚，再校验版本号，版本不一致返回 `409 CHAPTER_VERSION_CONFLICT`。
- 恢复时把线上内容块与目标快照对齐（删除/更新/沿用历史 id 新增），章节标题、简介与 `version` 一并更新；恢复目标引用的片段若已删除则自动解除关联。
- 恢复结果本身会作为新的 `ROLLBACK` 节点（带 `restoredFromRevision`）追加到版本链，之后仍可继续发布新版本。
- `rolled_back` 协作事件与数据恢复在同一事务写入，因此 `GET /v1/workspaces/:id/events` 的 sequence 始终连续、无空洞，事件 payload 内含恢复快照与 added/updated/removed 明细，其他端可据此同步。

## 存储

默认将原始音频保存到仓库根目录下的 `storage/`，并通过带权限校验的 API 流式读取。可通过 `STORAGE_DIR` 修改路径。`docker-compose.yml` 中的 MinIO 使用 `object-storage` profile，当前不会随 `postgres redis` 一起启动：

```bash
docker compose --profile object-storage up -d minio
```

生产环境应使用独立数据库、Redis、对象存储和 secret manager，不要把 `.env` 或真实密钥提交到仓库。
