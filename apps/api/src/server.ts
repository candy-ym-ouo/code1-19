import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { Prisma, PrismaClient, Role } from '@prisma/client';
import argon2 from 'argon2';
import { createReadStream } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import {
  chapterBlockCreateSchema,
  chapterCreateSchema,
  chapterRollbackSchema,
  chapterUpdateSchema,
  clipSchema,
  clipUpdateSchema,
} from '@history/contracts';
import {
  listChapterVersions,
  loadSnapshotAt,
  savePublishSnapshot,
  saveRollbackSnapshot,
  toVersionSummary,
  VersionConflictError,
} from './versions/repository.js';
import { applyBlockDelta, type VersionBlock } from './versions/engine.js';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
const ALLOWED_AUDIO_EXTENSIONS = /\.(aac|aiff|flac|m4a|mp3|mp4|oga|ogg|opus|wav|webm)$/i;
const DEFAULT_JWT_SECRET = 'development-secret-change-me-development';

class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const registerSchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string().min(8).max(128),
    displayName: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

const loginSchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string().min(1).max(128),
  })
  .strict();

const workspaceCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    timezone: z.string().trim().min(1).max(80).default('Asia/Shanghai'),
  })
  .strict();

const sequenceSchema = z.coerce.number().int().nonnegative().default(0);

type AuthUser = { id: string; email: string };
type JwtRequest = FastifyRequest & { user: AuthUser };
type DbClient = PrismaClient | Prisma.TransactionClient;

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDir, '../../..');
const configuredStorage = process.env.STORAGE_DIR || './storage';
const storage = path.isAbsolute(configuredStorage)
  ? configuredStorage
  : path.resolve(repositoryRoot, configuredStorage);

await mkdir(storage, { recursive: true });

const prisma = new PrismaClient();
const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 4000);
const webOrigins = (process.env.WEB_ORIGIN || process.env.APP_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});
redis.on('error', (error) => app.log.warn({ err: error }, 'Redis connection error'));

const mediaQueue = new Queue('media', { connection: redis });

await app.register(cors, {
  origin: webOrigins,
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
});
await app.register(cookie);
await app.register(jwt, {
  secret: process.env.JWT_SECRET || DEFAULT_JWT_SECRET,
});
await app.register(multipart, {
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 20 },
});
await app.register(websocket);

function validationError<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(400, 'INVALID_INPUT', '输入格式不正确', parsed.error.flatten());
  }
  return parsed.data;
}

async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await req.jwtVerify();
  } catch {
    await reply.code(401).send({
      error: { code: 'UNAUTHENTICATED', message: '请先登录' },
    });
  }
}

function authUser(req: FastifyRequest): AuthUser {
  return req.user as AuthUser;
}

async function findMembership(workspaceId: string, userId: string, roles?: Role[]) {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  if (!membership || (roles && !roles.includes(membership.role))) {
    return null;
  }
  return membership;
}

async function requireMembership(
  req: FastifyRequest,
  workspaceId: string,
  roles?: Role[],
): Promise<void> {
  const membership = await findMembership(workspaceId, authUser(req).id, roles);
  if (!membership) {
    throw new HttpError(404, 'NOT_FOUND', '资源不存在');
  }
}

async function recordEvent(
  db: DbClient,
  workspaceId: string,
  actorId: string,
  resourceType: string,
  resourceId: string,
  operation: string,
  payload: unknown,
) {
  return db.collaborationEvent.create({
    data: {
      workspaceId,
      actorId,
      resourceType,
      resourceId,
      operation,
      payloadJson: payload as Prisma.InputJsonValue,
    },
  });
}

function recordingDto<T extends { sizeBytes: bigint }>(recording: T) {
  return { ...recording, sizeBytes: recording.sizeBytes.toString() };
}

function parseByteRange(header: string, size: number): { start: number; end: number } | null {
  if (!header.startsWith('bytes=')) return null;
  const value = header.slice(6).trim();
  if (!value || value.includes(',')) return null;

  const match = /^(\d*)-(\d*)$/.exec(value);
  if (!match) return null;

  const [, startText, endText] = match;
  if (!startText && !endText) return null;

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    const start = Math.max(size - suffixLength, 0);
    return { start, end: size - 1 };
  }

  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return null;
  }

  return { start, end: Math.min(requestedEnd, size - 1) };
}

async function resolveRequestUser(req: FastifyRequest): Promise<AuthUser | null> {
  const header = req.headers.authorization;
  const queryToken = typeof (req.query as { token?: unknown } | undefined)?.token === 'string'
    ? (req.query as { token: string }).token
    : undefined;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : queryToken;
  if (!token) return null;

  try {
    return await app.jwt.verify<AuthUser>(token);
  } catch {
    return null;
  }
}

app.setErrorHandler((error, req, reply) => {
  if (error instanceof HttpError) {
    return reply.code(error.statusCode).send({
      error: { code: error.code, message: error.message, details: error.details },
      requestId: req.id,
    });
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      return reply.code(409).send({
        error: { code: 'CONFLICT', message: '数据已存在' },
        requestId: req.id,
      });
    }
    if (error.code === 'P2025') {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: '资源不存在' },
        requestId: req.id,
      });
    }
  }

  const unknownError = error as {
    statusCode?: number;
    code?: string;
    message?: string;
  };
  const statusCode =
    unknownError.statusCode && unknownError.statusCode < 500
      ? unknownError.statusCode
      : 500;
  if (statusCode >= 500) {
    req.log.error({ err: error }, 'request failed');
  }

  return reply.code(statusCode).send({
    error: {
      code:
        statusCode >= 500
          ? 'INTERNAL_SERVER_ERROR'
          : unknownError.code || 'BAD_REQUEST',
      message:
        statusCode >= 500 ? '服务器内部错误' : unknownError.message || '请求失败',
    },
    requestId: req.id,
  });
});

app.setNotFoundHandler((req, reply) =>
  reply.code(404).send({
    error: { code: 'NOT_FOUND', message: '接口不存在' },
    requestId: req.id,
  }),
);

app.get('/health', async () => ({ ok: true }));

app.get('/ready', async (_req, reply) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    if (redis.status !== 'ready') await redis.ping();
    return { ok: true };
  } catch {
    return reply.code(503).send({ ok: false });
  }
});

app.post('/v1/auth/register', async (req, reply) => {
  const body = validationError(registerSchema, req.body);
  const passwordHash = await argon2.hash(body.password);

  try {
    const user = await prisma.user.create({
      data: {
        email: body.email.toLowerCase(),
        passwordHash,
        displayName: body.displayName || body.email.split('@')[0],
      },
      select: { id: true, email: true, displayName: true },
    });
    const token = await app.jwt.sign(
      { id: user.id, email: user.email },
      { expiresIn: '2h' },
    );
    return reply.code(201).send({ data: { token, user } });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return reply.code(409).send({
        error: { code: 'EMAIL_EXISTS', message: '邮箱已注册' },
      });
    }
    throw error;
  }
});

app.post('/v1/auth/login', async (req, reply) => {
  const body = validationError(loginSchema, req.body);
  const user = await prisma.user.findUnique({
    where: { email: body.email.toLowerCase() },
  });

  if (!user || !(await argon2.verify(user.passwordHash, body.password))) {
    return reply.code(401).send({
      error: { code: 'INVALID_CREDENTIALS', message: '邮箱或密码错误' },
    });
  }

  const token = await app.jwt.sign(
    { id: user.id, email: user.email },
    { expiresIn: '2h' },
  );
  return {
    data: {
      token,
      user: { id: user.id, email: user.email, displayName: user.displayName },
    },
  };
});

app.get('/v1/me', { preHandler: authenticate }, async (req) => ({
  data: await prisma.user.findUnique({
    where: { id: authUser(req).id },
    select: { id: true, email: true, displayName: true },
  }),
}));

app.post('/v1/workspaces', { preHandler: authenticate }, async (req, reply) => {
  const body = validationError(workspaceCreateSchema, req.body);
  const user = authUser(req);
  const workspace = await prisma.workspace.create({
    data: {
      name: body.name,
      timezone: body.timezone,
      ownerId: user.id,
      members: { create: { userId: user.id, role: Role.OWNER } },
    },
  });
  return reply.code(201).send({ data: workspace });
});

app.get('/v1/workspaces', { preHandler: authenticate }, async (req) => {
  const user = authUser(req);
  return {
    data: await prisma.workspace.findMany({
      where: { members: { some: { userId: user.id } }, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
    }),
  };
});

app.post(
  '/v1/workspaces/:id/recordings/uploads',
  { preHandler: authenticate },
  async (req, reply) => {
    const workspaceId = (req.params as { id: string }).id;
    await requireMembership(req, workspaceId, [Role.OWNER, Role.EDITOR]);

    let upload;
    try {
      upload = await req.file();
    } catch (error) {
      if (error instanceof app.multipartErrors.RequestFileTooLargeError) {
        throw new HttpError(413, 'FILE_TOO_LARGE', '文件超过 5 GB 限制');
      }
      throw error;
    }

    if (!upload) {
      throw new HttpError(400, 'FILE_REQUIRED', '请选择录音文件');
    }

    const originalName = path.basename(upload.filename || 'recording');
    const hasAudioMime =
      upload.mimetype.startsWith('audio/') ||
      ['application/ogg', 'video/mp4', 'video/webm'].includes(upload.mimetype);
    if (!hasAudioMime || !ALLOWED_AUDIO_EXTENSIONS.test(originalName)) {
      upload.file.resume();
      throw new HttpError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        '只支持常见音频文件（mp3、wav、m4a、aac、flac、ogg、opus、webm）',
      );
    }

    const id = crypto.randomUUID();
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-180) || 'recording';
    const filePath = path.join(storage, `${id}-${safeName}`);
    let recordingPersisted = false;

    try {
      await pipeline(upload.file, createWriteStream(filePath, { flags: 'wx' }));
      if (upload.file.truncated) {
        throw new HttpError(413, 'FILE_TOO_LARGE', '文件超过 5 GB 限制');
      }

      const fileStat = await stat(filePath);
      if (fileStat.size <= 0) {
        throw new HttpError(400, 'EMPTY_FILE', '录音文件为空');
      }

      const recording = await prisma.recording.create({
        data: {
          id,
          workspaceId,
          title: originalName,
          originalPath: filePath,
          mimeType: upload.mimetype,
          sizeBytes: BigInt(fileStat.size),
          durationMs: 0,
          createdById: authUser(req).id,
          status: 'PROCESSING',
        },
      });

      recordingPersisted = true;

      try {
        await mediaQueue.add(
          'media.process',
          { recordingId: recording.id },
          {
            jobId: recording.id,
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: { age: 3600, count: 1000 },
            removeOnFail: { age: 24 * 3600, count: 1000 },
          },
        );
      } catch (error) {
        await prisma.recording.update({
          where: { id: recording.id },
          data: {
            status: 'FAILED',
            processingError: '媒体队列不可用，请稍后重试',
          },
        });
        req.log.error({ err: error }, 'failed to enqueue media job');
        throw new HttpError(503, 'MEDIA_QUEUE_UNAVAILABLE', '媒体队列不可用，请稍后重试');
      }

      return reply.code(201).send({ data: recordingDto(recording) });
    } catch (error) {
      if (!recordingPersisted) {
        await unlink(filePath).catch(() => undefined);
      }
      throw error;
    }
  },
);

app.get('/v1/workspaces/:id/recordings', { preHandler: authenticate }, async (req) => {
  const workspaceId = (req.params as { id: string }).id;
  await requireMembership(req, workspaceId);
  const rows = await prisma.recording.findMany({
    where: { workspaceId },
    include: {
      _count: { select: { clips: { where: { deletedAt: null } } } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return { data: rows.map(recordingDto) };
});

app.get('/v1/recordings/:id/file', async (req, reply) => {
  const recordingId = (req.params as { id: string }).id;
  const recording = await prisma.recording.findUnique({ where: { id: recordingId } });
  if (!recording) {
    throw new HttpError(404, 'NOT_FOUND', '录音不存在');
  }

  const user = await resolveRequestUser(req);
  if (!user || !(await findMembership(recording.workspaceId, user.id))) {
    throw new HttpError(404, 'NOT_FOUND', '录音不存在');
  }

  const filePath = recording.playbackPath || recording.originalPath;
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    throw new HttpError(404, 'FILE_NOT_FOUND', '录音文件不存在');
  }

  const rangeHeader = req.headers.range;
  const range = rangeHeader ? parseByteRange(rangeHeader, fileStat.size) : null;
  if (rangeHeader && !range) {
    return reply
      .code(416)
      .header('Content-Range', `bytes */${fileStat.size}`)
      .send();
  }

  reply
    .type(recording.mimeType || 'application/octet-stream')
    .header('Accept-Ranges', 'bytes')
    .header('Cache-Control', 'private, no-store')
    .header('X-Content-Type-Options', 'nosniff');

  if (!range) {
    return reply
      .header('Content-Length', fileStat.size)
      .send(createReadStream(filePath));
  }

  return reply
    .code(206)
    .header('Content-Length', range.end - range.start + 1)
    .header('Content-Range', `bytes ${range.start}-${range.end}/${fileStat.size}`)
    .send(createReadStream(filePath, { start: range.start, end: range.end }));
});

app.get('/v1/recordings/:id/clips', { preHandler: authenticate }, async (req) => {
  const recordingId = (req.params as { id: string }).id;
  const recording = await prisma.recording.findUnique({ where: { id: recordingId } });
  if (!recording) {
    throw new HttpError(404, 'NOT_FOUND', '录音不存在');
  }
  await requireMembership(req, recording.workspaceId);

  return {
    data: await prisma.clip.findMany({
      where: { recordingId, deletedAt: null },
      orderBy: { startMs: 'asc' },
    }),
  };
});

app.post('/v1/recordings/:id/clips', { preHandler: authenticate }, async (req, reply) => {
  const recordingId = (req.params as { id: string }).id;
  const recording = await prisma.recording.findUnique({ where: { id: recordingId } });
  if (!recording) {
    throw new HttpError(404, 'NOT_FOUND', '录音不存在');
  }
  await requireMembership(req, recording.workspaceId, [Role.OWNER, Role.EDITOR]);

  if (recording.status !== 'READY' || recording.durationMs <= 0) {
    throw new HttpError(409, 'RECORDING_NOT_READY', '录音仍在处理中');
  }

  const parsed = clipSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new HttpError(400, 'INVALID_CLIP', '片段时间范围无效', parsed.error.flatten());
  }
  if (parsed.data.endMs > recording.durationMs) {
    throw new HttpError(400, 'INVALID_CLIP', '片段超出录音时长');
  }
  if (parsed.data.speakerPersonId) {
    const person = await prisma.person.findFirst({
      where: {
        id: parsed.data.speakerPersonId,
        workspaceId: recording.workspaceId,
        deletedAt: null,
      },
    });
    if (!person) {
      throw new HttpError(400, 'INVALID_SPEAKER', '关联人物不存在');
    }
  }

  const { version: _version, ...clipData } = parsed.data;
  const user = authUser(req);
  const clip = await prisma.$transaction(async (tx) => {
    const created = await tx.clip.create({
      data: {
        ...clipData,
        recordingId: recording.id,
        workspaceId: recording.workspaceId,
        createdById: user.id,
        updatedById: user.id,
        speakerPersonId: clipData.speakerPersonId ?? null,
      },
    });
    await recordEvent(
      tx,
      recording.workspaceId,
      user.id,
      'clip',
      created.id,
      'created',
      created,
    );
    return created;
  });

  return reply.code(201).send({ data: clip });
});

app.patch('/v1/clips/:id', { preHandler: authenticate }, async (req, reply) => {
  const clipId = (req.params as { id: string }).id;
  const old = await prisma.clip.findUnique({ where: { id: clipId } });
  if (!old || old.deletedAt) {
    throw new HttpError(404, 'NOT_FOUND', '片段不存在');
  }
  await requireMembership(req, old.workspaceId, [Role.OWNER, Role.EDITOR]);

  const parsed = clipUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new HttpError(400, 'INVALID_CLIP', '片段数据无效', parsed.error.flatten());
  }

  const recording = await prisma.recording.findUnique({ where: { id: old.recordingId } });
  if (!recording || recording.status !== 'READY') {
    throw new HttpError(409, 'RECORDING_NOT_READY', '录音尚未就绪');
  }

  const startMs = parsed.data.startMs ?? old.startMs;
  const endMs = parsed.data.endMs ?? old.endMs;
  if (startMs < 0 || endMs <= startMs || endMs > recording.durationMs) {
    throw new HttpError(400, 'INVALID_CLIP', '片段时间范围无效或超出录音时长');
  }

  const speakerPersonId =
    parsed.data.speakerPersonId === undefined
      ? old.speakerPersonId
      : parsed.data.speakerPersonId;
  if (speakerPersonId) {
    const person = await prisma.person.findFirst({
      where: { id: speakerPersonId, workspaceId: old.workspaceId, deletedAt: null },
    });
    if (!person) {
      throw new HttpError(400, 'INVALID_SPEAKER', '关联人物不存在');
    }
  }

  const user = authUser(req);
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.clip.updateMany({
      where: { id: old.id, version: parsed.data.version, deletedAt: null },
      data: {
        title: parsed.data.title ?? old.title,
        startMs,
        endMs,
        summary: parsed.data.summary ?? old.summary,
        transcript: parsed.data.transcript ?? old.transcript,
        speakerPersonId,
        updatedById: user.id,
        version: { increment: 1 },
      },
    });

    if (result.count === 0) return null;
    const current = await tx.clip.findUniqueOrThrow({ where: { id: old.id } });
    await recordEvent(
      tx,
      old.workspaceId,
      user.id,
      'clip',
      current.id,
      'updated',
      current,
    );
    return current;
  });

  if (!updated) {
    const server = await prisma.clip.findUnique({ where: { id: old.id } });
    return reply.code(409).send({
      error: {
        code: 'CLIP_VERSION_CONFLICT',
        message: '片段已被其他成员修改',
        details: { server },
      },
    });
  }

  return { data: updated };
});

app.get('/v1/workspaces/:id/chapters', { preHandler: authenticate }, async (req) => {
  const workspaceId = (req.params as { id: string }).id;
  await requireMembership(req, workspaceId);
  return {
    data: await prisma.chapter.findMany({
      where: { workspaceId },
      include: {
        blocks: {
          orderBy: { position: 'asc' },
          include: { clip: { where: { deletedAt: null } } },
        },
      },
      orderBy: { updatedAt: 'desc' },
    }),
  };
});

app.post('/v1/workspaces/:id/chapters', { preHandler: authenticate }, async (req, reply) => {
  const workspaceId = (req.params as { id: string }).id;
  await requireMembership(req, workspaceId, [Role.OWNER, Role.EDITOR]);
  const body = validationError(chapterCreateSchema, req.body);
  const user = authUser(req);

  const chapter = await prisma.$transaction(async (tx) => {
    const created = await tx.chapter.create({
      data: {
        workspaceId,
        title: body.title,
        intro: body.intro,
        createdById: user.id,
      },
    });
    await recordEvent(tx, workspaceId, user.id, 'chapter', created.id, 'created', created);
    return created;
  });
  return reply.code(201).send({ data: chapter });
});

app.patch('/v1/chapters/:id', { preHandler: authenticate }, async (req, reply) => {
  const chapterId = (req.params as { id: string }).id;
  const old = await prisma.chapter.findUnique({ where: { id: chapterId } });
  if (!old) throw new HttpError(404, 'NOT_FOUND', '章节不存在');
  await requireMembership(req, old.workspaceId, [Role.OWNER, Role.EDITOR]);

  const body = validationError(chapterUpdateSchema, req.body);
  const user = authUser(req);
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.chapter.updateMany({
      where: { id: old.id, version: body.version },
      data: {
        title: body.title ?? old.title,
        intro: body.intro ?? old.intro,
        version: { increment: 1 },
      },
    });
    if (result.count === 0) return null;

    const current = await tx.chapter.findUniqueOrThrow({ where: { id: old.id } });
    await recordEvent(
      tx,
      old.workspaceId,
      user.id,
      'chapter',
      current.id,
      'updated',
      current,
    );
    return current;
  });

  if (!updated) {
    const server = await prisma.chapter.findUnique({ where: { id: old.id } });
    return reply.code(409).send({
      error: {
        code: 'CHAPTER_VERSION_CONFLICT',
        message: '章节已被其他成员修改',
        details: { server },
      },
    });
  }
  return { data: updated };
});

app.post('/v1/chapters/:id/blocks', { preHandler: authenticate }, async (req, reply) => {
  const chapterId = (req.params as { id: string }).id;
  const chapter = await prisma.chapter.findUnique({ where: { id: chapterId } });
  if (!chapter) throw new HttpError(404, 'NOT_FOUND', '章节不存在');
  await requireMembership(req, chapter.workspaceId, [Role.OWNER, Role.EDITOR]);

  const body = validationError(chapterBlockCreateSchema, req.body);
  if (body.clipId) {
    const clip = await prisma.clip.findFirst({
      where: {
        id: body.clipId,
        workspaceId: chapter.workspaceId,
        deletedAt: null,
      },
    });
    if (!clip) throw new HttpError(400, 'INVALID_CLIP', '关联片段不存在');
  }

  const user = authUser(req);
  const block = await prisma.$transaction(async (tx) => {
    const created = await tx.chapterBlock.create({
      data: {
        chapterId: chapter.id,
        type: body.type ?? 'paragraph',
        position:
          body.position ||
          `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
        contentJson: (body.content ?? {}) as Prisma.InputJsonValue,
        clipId: body.clipId ?? null,
      },
    });
    await recordEvent(
      tx,
      chapter.workspaceId,
      user.id,
      'chapterBlock',
      created.id,
      'created',
      created,
    );
    return created;
  });
  return reply.code(201).send({ data: block });
});

app.post('/v1/chapters/:id/publish', { preHandler: authenticate }, async (req, reply) => {
  const chapterId = (req.params as { id: string }).id;
  const existing = await prisma.chapter.findUnique({
    where: { id: chapterId },
    select: { id: true, workspaceId: true },
  });
  if (!existing) throw new HttpError(404, 'NOT_FOUND', '章节不存在');
  await requireMembership(req, existing.workspaceId, [Role.OWNER, Role.EDITOR]);

  const user = authUser(req);
  try {
    const published = await prisma.$transaction(
      async (tx) => {
        // 锁定章节行，串行化并发发布/回滚，避免 revision 竞争
        const [locked] = await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT id FROM "Chapter" WHERE id = ${chapterId} FOR UPDATE`,
        );
        if (!locked) throw new HttpError(404, 'NOT_FOUND', '章节不存在');

        // 锁后重读章节与内容块，避免事务外快照与锁后状态不一致
        const chapter = await tx.chapter.findUniqueOrThrow({
          where: { id: chapterId },
          include: {
            blocks: {
              include: {
                clip: {
                  include: { recording: { select: { status: true } } },
                },
              },
            },
          },
        });

        if (chapter.blocks.length === 0) {
          throw new HttpError(
            400,
            'PUBLISH_VALIDATION_FAILED',
            '章节至少需要一个内容块',
          );
        }
        const invalidBlock = chapter.blocks.find(
          (block) =>
            block.clip &&
            (block.clip.deletedAt !== null || block.clip.recording.status !== 'READY'),
        );
        if (invalidBlock) {
          throw new HttpError(
            400,
            'PUBLISH_VALIDATION_FAILED',
            '章节包含不可播放或已归档的片段',
          );
        }

        const version = await savePublishSnapshot({
          db: tx,
          chapter: {
            id: chapter.id,
            workspaceId: chapter.workspaceId,
            title: chapter.title,
            intro: chapter.intro,
          },
          blocks: chapter.blocks.map((block) => ({
            id: block.id,
            type: block.type,
            position: block.position,
            contentJson: block.contentJson,
            clipId: block.clipId,
          })),
          createdById: user.id,
        });

        const updated = await tx.chapter.update({
          where: { id: chapter.id },
          data: { status: 'PUBLISHED', version: { increment: 1 } },
        });
        await recordEvent(
          tx,
          chapter.workspaceId,
          user.id,
          'chapter',
          updated.id,
          'published',
          { chapter: updated, revision: version.revision, versionId: version.id },
        );
        return { updated, version };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return { data: { chapter: published.updated, version: published.version } };
  } catch (error) {
    if (error instanceof VersionConflictError) {
      return mapVersionError(reply, error);
    }
    throw error;
  }
});

function mapVersionError(reply: FastifyReply, error: VersionConflictError) {
  if (error.code === 'VERSION_NOT_FOUND') {
    return reply.code(404).send({
      error: { code: 'VERSION_NOT_FOUND', message: error.message, details: error.details },
    });
  }
  return reply.code(409).send({
    error: { code: error.code, message: error.message, details: error.details },
  });
}

app.get('/v1/chapters/:id/versions', { preHandler: authenticate }, async (req) => {
  const chapterId = (req.params as { id: string }).id;
  const chapter = await prisma.chapter.findUnique({
    where: { id: chapterId },
    select: { id: true, workspaceId: true },
  });
  if (!chapter) throw new HttpError(404, 'NOT_FOUND', '章节不存在');
  await requireMembership(req, chapter.workspaceId);

  const [versions, current] = await Promise.all([
    listChapterVersions(prisma, chapterId),
    prisma.chapterVersion.findFirst({
      where: { chapterId },
      orderBy: { revision: 'desc' },
      select: { revision: true },
    }),
  ]);
  return { data: { latestRevision: current?.revision ?? 0, versions } };
});

app.get(
  '/v1/chapters/:id/versions/:revision',
  { preHandler: authenticate },
  async (req, reply) => {
    const chapterId = (req.params as { id: string }).id;
    const params = validationError(
      z.object({ revision: z.coerce.number().int().positive() }).strict(),
      { revision: (req.params as { revision?: string }).revision },
    );
    const chapter = await prisma.chapter.findUnique({
      where: { id: chapterId },
      select: { id: true, workspaceId: true },
    });
    if (!chapter) throw new HttpError(404, 'NOT_FOUND', '章节不存在');
    await requireMembership(req, chapter.workspaceId);

    try {
      const { snapshot } = await loadSnapshotAt(prisma, chapterId, params.revision);
      return {
        data: {
          chapterId,
          revision: params.revision,
          title: snapshot.title,
          intro: snapshot.intro,
          blocks: snapshot.blocks,
        },
      };
    } catch (error) {
      if (error instanceof VersionConflictError) {
        return mapVersionError(reply, error);
      }
      throw error;
    }
  },
);

app.post(
  '/v1/chapters/:id/rollback',
  { preHandler: authenticate },
  async (req, reply) => {
    const chapterId = (req.params as { id: string }).id;
    const existing = await prisma.chapter.findUnique({
      where: { id: chapterId },
      select: { id: true, workspaceId: true },
    });
    if (!existing) throw new HttpError(404, 'NOT_FOUND', '章节不存在');
    await requireMembership(req, existing.workspaceId, [Role.OWNER, Role.EDITOR]);

    const body = validationError(chapterRollbackSchema, req.body);
    // 必填的乐观版本号（防止基于过期状态并发回滚）
    const expectedChapterVersion =
      body.expectedRevision ?? body.expectedChapterVersion ?? 0;
    const user = authUser(req);

    try {
      const result = await prisma.$transaction(
        async (tx) => {
          // 锁定章节行：并发回滚/发布在此串行排队
          const [locked] = await tx.$queryRaw<Array<{ version: number }>>(
            Prisma.sql`SELECT version FROM "Chapter" WHERE id = ${chapterId} FOR UPDATE`,
          );
          if (!locked) throw new HttpError(404, 'NOT_FOUND', '章节不存在');

          // 乐观版本校验：调用方必须基于最新章节版本发起回滚
          if (locked.version !== expectedChapterVersion) {
            throw new VersionConflictError(
              'CHAPTER_VERSION_CONFLICT',
              '章节已被其他成员修改，请刷新后重试',
              { expected: expectedChapterVersion, current: locked.version },
            );
          }

          // 锁后重读章节，差量基线使用实时标题/简介
          const chapter = await tx.chapter.findUniqueOrThrow({
            where: { id: chapterId },
          });

          // 1. 重放差量，重建目标发布节点的完整状态（含哈希链校验）
          const { snapshot: restored } = await loadSnapshotAt(
            tx,
            chapterId,
            body.revision,
          );

          // 2. 读取当前线上内容块，计算恢复差量
          const liveBlocks = await tx.chapterBlock.findMany({
            where: { chapterId },
            orderBy: { position: 'asc' },
          });
          const currentBlocks: VersionBlock[] = liveBlocks.map((block) => ({
            id: block.id,
            type: block.type,
            position: block.position,
            contentJson: block.contentJson,
            clipId: block.clipId,
          }));

          // 恢复目标里引用的片段若已被删除，解除关联（SetNull），避免悬空外键
          const existingClipIds = new Set(
            (
              await tx.clip.findMany({
                where: {
                  workspaceId: chapter.workspaceId,
                  id: { in: restored.blocks.map((block) => block.clipId).filter(Boolean) as string[] },
                  deletedAt: null,
                },
                select: { id: true },
              })
            ).map((clip) => clip.id),
          );
          const detachedClipIds: string[] = [];
          for (const block of restored.blocks) {
            if (block.clipId && !existingClipIds.has(block.clipId)) {
              detachedClipIds.push(block.clipId);
              block.clipId = null;
            }
          }

          // 3. 把线上状态对齐到恢复目标：先删后增（恢复出来的块沿用历史 id）
          const restoredIds = new Set(restored.blocks.map((block) => block.id));
          const toDelete = currentBlocks
            .filter((block) => !restoredIds.has(block.id))
            .map((block) => block.id);
          const restoredById = new Map(restored.blocks.map((block) => [block.id, block]));
          const toCreate: VersionBlock[] = [];
          const toUpdate: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];

          for (const current of currentBlocks) {
            const target = restoredById.get(current.id);
            if (!target) continue;
            const data: Record<string, unknown> = {};
            if (current.type !== target.type) data.type = target.type;
            if (current.position !== target.position) data.position = target.position;
            if (current.clipId !== target.clipId) data.clipId = target.clipId;
            if (JSON.stringify(current.contentJson) !== JSON.stringify(target.contentJson)) {
              data.contentJson = target.contentJson as Prisma.InputJsonValue;
            }
            if (Object.keys(data).length > 0) {
              toUpdate.push({ where: { id: current.id }, data });
            }
          }
          for (const target of restored.blocks) {
            if (!currentBlocks.some((block) => block.id === target.id)) toCreate.push(target);
          }

          if (toDelete.length > 0) {
            await tx.chapterBlock.deleteMany({
              where: { chapterId, id: { in: toDelete } },
            });
          }
          for (const update of toUpdate) {
            await tx.chapterBlock.update({ where: update.where, data: update.data });
          }
          for (const block of toCreate) {
            await tx.chapterBlock.create({
              data: {
                id: block.id,
                chapterId,
                type: block.type,
                position: block.position,
                contentJson: block.contentJson as Prisma.InputJsonValue,
                clipId: block.clipId,
              },
            });
          }

          // 4. 恢复章节标题/简介，章节乐观版本号 +1
          const updated = await tx.chapter.update({
            where: { id: chapterId },
            data: {
              title: restored.title,
              intro: restored.intro,
              status: 'PUBLISHED',
              version: { increment: 1 },
            },
          });

          // 5. 恢复结果保存为新的 ROLLBACK 版本节点（差量快照）。
          //    差量基线是恢复前的线上实时状态（含发布后的草稿编辑）。
          const version = await saveRollbackSnapshot({
            db: tx,
            chapter: { id: chapterId, workspaceId: chapter.workspaceId },
            restored: {
              title: restored.title,
              intro: restored.intro,
              blocks: restored.blocks,
            },
            current: {
              title: chapter.title,
              intro: chapter.intro,
              blocks: currentBlocks,
            },
            restoredFromRevision: body.revision,
            createdById: user.id,
          });

          // 6. 同一事务写入协作事件：sequence 连续、无空洞
          const event = await recordEvent(
            tx,
            chapter.workspaceId,
            user.id,
            'chapter',
            chapterId,
            'rolled_back',
            {
              chapter: updated,
              revision: version.revision,
              versionId: version.id,
              restoredFromRevision: body.revision,
              snapshot: {
                title: restored.title,
                intro: restored.intro,
                blocks: restored.blocks,
              },
              detachedClipIds,
              changes: {
                added: applyBlockDelta([], {
                  added: toCreate,
                  updated: [],
                  removed: [],
                }),
                updated: toUpdate.map((item) => ({
                  id: item.where.id,
                  fields: Object.keys(item.data),
                })),
                removed: toDelete,
              },
            },
          );

          return {
            chapter: updated,
            version: toVersionSummary(version),
            event: { id: event.id, sequence: event.sequence },
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return { data: result };
    } catch (error) {
      if (error instanceof VersionConflictError) {
        return mapVersionError(reply, error);
      }
      // 可串行化冲突 / 唯一约束竞争：交给全局处理器转 409
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        ['P2034', 'P2002', '40001'].includes((error as { code?: string }).code ?? '')
      ) {
        return reply.code(409).send({
          error: {
            code: 'VERSION_REVISION_CONFLICT',
            message: '并发版本操作冲突，请刷新后重试',
          },
        });
      }
      throw error;
    }
  },
);

app.get('/v1/workspaces/:id/events', { preHandler: authenticate }, async (req) => {
  const workspaceId = (req.params as { id: string }).id;
  await requireMembership(req, workspaceId);
  const query = validationError(
    z.object({ afterSequence: sequenceSchema }).strict(),
    req.query,
  );
  return {
    data: await prisma.collaborationEvent.findMany({
      where: {
        workspaceId,
        sequence: { gt: query.afterSequence },
      },
      orderBy: { sequence: 'asc' },
      take: 500,
    }),
  };
});

app.get('/v1/realtime', { websocket: true }, async (socket: any, req: any) => {
  const user = await resolveRequestUser(req);
  const workspaceId = String(req.query?.workspaceId || '');
  if (
    !user ||
    !workspaceId ||
    !(await findMembership(workspaceId, user.id))
  ) {
    socket.close(1008, 'forbidden');
    return;
  }

  socket.send(JSON.stringify({ type: 'connected', at: new Date().toISOString() }));
  socket.on('message', (raw: Buffer) => {
    try {
      const message = JSON.parse(raw.toString()) as { type?: string };
      if (message.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', at: new Date().toISOString() }));
      }
    } catch {
      socket.send(JSON.stringify({ type: 'error', message: '消息格式错误' }));
    }
  });
});

app.addHook('onClose', async () => {
  await mediaQueue.close();
  if (redis.status !== 'end') redis.disconnect();
  await prisma.$disconnect();
});

try {
  await app.listen({ port, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
