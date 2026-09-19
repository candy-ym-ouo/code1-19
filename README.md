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
- `POST /v1/chapters/:id/publish`（可带 `version` 乐观锁，按发布节点落全量/差量快照）
- `POST /v1/chapters/:id/rollback`（回滚到 `releaseNo`，`version` 必填，冲突返回 409）
- `GET /v1/chapters/:id/releases`、`GET /v1/chapters/:id/releases/:releaseNo`（沿差量链还原快照）
- `GET /v1/workspaces/:id/events`
- `GET /v1/realtime?workspaceId=...`（WebSocket）

### 章节版本仓库

发布与回滚由 `apps/api/src/version-store.ts`（LCS 差量原语）、`release-service.ts`（版本仓库服务）和 `release-repository.*.ts`（Postgres/内存两套同一事务契约的实现）支撑：

- **发布节点快照**：`ChapterRelease` 按 `(chapterId, releaseNo)` 追加保存。第 1、4、7… 个节点落全量快照，其余节点只存与上一节点的差量（块 ID 有序序列的 retain/insert/remove 脚本 + 内容 updates），差量链最长 2 级即可回到最近全量。
- **并发回滚版本校验**：写事务先 `SELECT ... FOR UPDATE` 锁章节行，再以 `WHERE id = ? AND version = ?` 做 CAS；并发回滚只有一个提交成功，另一个收到 `CHAPTER_VERSION_CONFLICT`(409)，用服务端最新 `version` 重试即可。
- **恢复后事件连续**：回滚不删除或改写历史，而是追加一个 `kind=ROLLBACK` 的新发布节点（强制全量，作为后续差量的新基准），并在 `CollaborationEvent` 追加 `chapter.rolledBack` 事件。`GET /v1/workspaces/:id/events` 的 `sequence` 因此无缺号，客户端可顺序重放。回滚时悬空的 `clipId`（片段已删除）会被置空并记录在事件载荷的 `missingClipIds` 中。

健康检查为 `GET /health` 和 `GET /ready`。

## 存储

默认将原始音频保存到仓库根目录下的 `storage/`，并通过带权限校验的 API 流式读取。可通过 `STORAGE_DIR` 修改路径。`docker-compose.yml` 中的 MinIO 使用 `object-storage` profile，当前不会随 `postgres redis` 一起启动：

```bash
docker compose --profile object-storage up -d minio
```

生产环境应使用独立数据库、Redis、对象存储和 secret manager，不要把 `.env` 或真实密钥提交到仓库。
