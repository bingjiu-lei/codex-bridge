import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BridgeSessionRepository, PlatformBindingRepository } from '../types/repository.js';
import { JsonFileStore } from '../store/file_json/json_file_store.js';
import {
  FileJsonWorkflowNotificationRouteStore,
  formatWorkflowRouteMarker,
} from './weixin_workflow_routes.js';

interface WatcherState {
  files: Record<string, number>;
  delivered: string[];
}

export interface BilibiliTerminalEvent {
  threadId: string;
  turnId: string;
  runId: string;
  status: 'succeeded' | 'failed';
  title: string;
  detail: string;
}

interface PlatformSender {
  sendText(input: { externalScopeId: string; content: string }): Promise<{ success: boolean; error?: string | null }>;
}

interface WatcherOptions {
  stateFile: string;
  routeStore: FileJsonWorkflowNotificationRouteStore;
  bridgeSessions: BridgeSessionRepository;
  platformBindings: PlatformBindingRepository;
  platformPlugin: PlatformSender;
  providerProfileId: string;
  sessionsDir?: string;
  defaultCwd?: string | null;
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
}

export class CodexBilibiliNotificationWatcher {
  private readonly stateStore: JsonFileStore<WatcherState>;
  private readonly routeStore: FileJsonWorkflowNotificationRouteStore;
  private readonly bridgeSessions: BridgeSessionRepository;
  private readonly platformBindings: PlatformBindingRepository;
  private readonly platformPlugin: PlatformSender;
  private readonly providerProfileId: string;
  private readonly sessionsDir: string;
  private readonly defaultCwd: string | null;
  private readonly pollIntervalMs: number;
  private readonly onError: (error: unknown) => void;
  private hasExistingState: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanPromise: Promise<void> | null = null;

  constructor(options: WatcherOptions) {
    this.hasExistingState = fs.existsSync(options.stateFile);
    this.stateStore = new JsonFileStore(options.stateFile, { files: {}, delivered: [] });
    this.routeStore = options.routeStore;
    this.bridgeSessions = options.bridgeSessions;
    this.platformBindings = options.platformBindings;
    this.platformPlugin = options.platformPlugin;
    this.providerProfileId = options.providerProfileId;
    this.sessionsDir = options.sessionsDir ?? path.join(os.homedir(), '.codex', 'sessions');
    this.defaultCwd = options.defaultCwd ?? null;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.onError = options.onError ?? (() => {});
  }

  start(): void {
    if (this.timer) {
      return;
    }
    if (!this.hasExistingState) {
      const files = Object.fromEntries(findRolloutFiles(this.sessionsDir).map((filePath) => [filePath, fileSize(filePath)]));
      this.stateStore.write({ files, delivered: [] });
      this.hasExistingState = true;
    }
    this.timer = setInterval(() => {
      void this.scanNow().catch(this.onError);
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async scanNow(): Promise<void> {
    if (this.scanPromise) {
      return this.scanPromise;
    }
    this.scanPromise = this.scan().finally(() => {
      this.scanPromise = null;
    });
    return this.scanPromise;
  }

  private async scan(): Promise<void> {
    const state = normalizeState(this.stateStore.read());
    const delivered = new Set(state.delivered);
    for (const filePath of findRolloutFiles(this.sessionsDir)) {
      const currentSize = fileSize(filePath);
      const priorOffset = Math.min(Math.max(0, state.files[filePath] ?? 0), currentSize);
      if (currentSize <= priorOffset) {
        state.files[filePath] = currentSize;
        continue;
      }
      const chunk = readFileChunk(filePath, priorOffset, currentSize - priorOffset);
      const lastNewline = chunk.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        continue;
      }
      const completeChunk = chunk.subarray(0, lastNewline + 1).toString('utf8');
      state.files[filePath] = priorOffset + lastNewline + 1;
      for (const line of completeChunk.split(/\r?\n/u)) {
        if (!line.trim()) {
          continue;
        }
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        const terminalEvent = extractBilibiliTerminalEvent(record);
        if (!terminalEvent) {
          continue;
        }
        const deliveryKey = `${terminalEvent.threadId}:${terminalEvent.runId}:${terminalEvent.status}`;
        if (delivered.has(deliveryKey)) {
          continue;
        }
        await this.deliver(filePath, terminalEvent);
        delivered.add(deliveryKey);
        state.delivered = [...delivered].slice(-500);
        this.stateStore.write(state);
      }
    }
    state.delivered = [...delivered].slice(-500);
    this.stateStore.write(state);
  }

  private async deliver(filePath: string, event: BilibiliTerminalEvent): Promise<void> {
    const scopes = [...new Set(this.platformBindings.list()
      .filter((binding) => binding.platform === 'weixin')
      .map((binding) => binding.externalScopeId))];
    if (scopes.length !== 1) {
      throw new Error(`Bilibili watcher requires exactly one WeChat scope; found ${scopes.length}.`);
    }
    const externalScopeId = scopes[0];
    const existingRoute = this.routeStore.list().find((route) => (
      route.externalScopeId === externalScopeId
      && route.runId === event.runId
      && route.status === event.status
    ));
    if (existingRoute) {
      return;
    }
    const sessionMeta = readSessionMeta(filePath);
    let session = this.bridgeSessions.list().find((candidate) => candidate.codexThreadId === event.threadId) ?? null;
    if (!session) {
      const now = Date.now();
      session = this.bridgeSessions.save({
        id: crypto.randomUUID(),
        providerProfileId: this.providerProfileId,
        codexThreadId: event.threadId,
        cwd: sessionMeta.cwd ?? this.defaultCwd,
        title: `视频工作流：${event.title}`,
        createdAt: now,
        updatedAt: now,
      });
    }
    const route = this.routeStore.register({
      externalScopeId,
      bridgeSessionId: session.id,
      runId: event.runId,
      title: event.title,
      status: event.status,
    });
    const content = [
      event.status === 'failed' ? '【视频工作流失败】' : '【视频工作流已完成】',
      event.title,
      event.status === 'failed' ? '上传状态：失败。' : '上传状态：成功。',
      ...(event.detail ? [`${event.status === 'failed' ? '原因' : '结果'}：${event.detail}`] : []),
      '引用回复此通知，会回到对应的 Codex 工作流对话。',
      formatWorkflowRouteMarker(route.alias),
    ].join('\n');
    const result = await this.platformPlugin.sendText({ externalScopeId, content });
    if (!result?.success) {
      this.routeStore.remove(route.token);
      throw new Error(result?.error || 'Automatic Bilibili terminal notification was not delivered.');
    }
  }
}

export function extractBilibiliTerminalEvent(record: unknown): BilibiliTerminalEvent | null {
  const root = readRecord(record);
  if (root.type !== 'event_msg') {
    return null;
  }
  const payload = readRecord(root.payload);
  if (payload.type !== 'item_completed') {
    return null;
  }
  const item = readRecord(payload.item);
  if (item.type !== 'McpToolCall' || String(item.server ?? '') !== 'bilibili-mcp') {
    return null;
  }
  const tool = String(item.tool ?? '');
  if (tool !== 'bili_upload_status' && tool !== 'bili_upload_video') {
    return null;
  }
  const result = readRecord(item.result);
  const parsed = parseBilibiliResult(result);
  const explicitStatus = String(parsed.status ?? '').toLowerCase();
  const failedCall = item.status === 'failed' || result.isError === true;
  const status = explicitStatus === 'succeeded'
    ? 'succeeded'
    : explicitStatus === 'failed' || failedCall
      ? 'failed'
      : null;
  if (!status) {
    return null;
  }
  const threadId = String(payload.thread_id ?? '').trim();
  const turnId = String(payload.turn_id ?? '').trim();
  if (!threadId || !turnId) {
    return null;
  }
  const argumentsRecord = readRecord(item.arguments);
  const runId = String(parsed.job_id ?? argumentsRecord.job_id ?? item.id ?? `${threadId}-${turnId}`).trim();
  const title = String(parsed.title ?? argumentsRecord.title ?? 'B站视频发布').trim() || 'B站视频发布';
  const bvid = String(readRecord(parsed.result).bvid ?? '').trim();
  const rawDetail = status === 'succeeded'
    ? (bvid ? `BV号：${bvid}` : '')
    : String(parsed.last_error ?? parsed.error ?? parsed.phase ?? firstResultText(result) ?? '上传失败');
  return {
    threadId,
    turnId,
    runId,
    status,
    title,
    detail: compactDetail(rawDetail),
  };
}

function parseBilibiliResult(result: Record<string, unknown>): Record<string, unknown> {
  const structured = readRecord(result.structuredContent);
  const candidates = [structured.result, firstResultText(result)];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      return readRecord(candidate);
    }
    if (typeof candidate !== 'string') {
      continue;
    }
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Preserve non-JSON connector errors for the failure detail below.
    }
  }
  return {};
}

function firstResultText(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const item = content.find((candidate) => readRecord(candidate).type === 'text');
  return String(readRecord(item).text ?? '').trim();
}

function compactDetail(value: unknown): string {
  const compact = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return compact.length > 300 ? `${compact.slice(0, 297)}...` : compact;
}

function normalizeState(value: unknown): WatcherState {
  const record = readRecord(value);
  return {
    files: readNumberRecord(record.files),
    delivered: Array.isArray(record.delivered) ? record.delivered.map(String).slice(-500) : [],
  };
}

function readNumberRecord(value: unknown): Record<string, number> {
  const record = readRecord(value);
  return Object.fromEntries(Object.entries(record)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])));
}

function readRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function readSessionMeta(filePath: string): { cwd: string | null } {
  try {
    const handle = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(256 * 1024);
      const bytes = fs.readSync(handle, buffer, 0, buffer.length, 0);
      const firstLine = buffer.subarray(0, bytes).toString('utf8').split(/\r?\n/u)[0];
      const record = JSON.parse(firstLine);
      return { cwd: typeof record?.payload?.cwd === 'string' ? record.payload.cwd : null };
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return { cwd: null };
  }
}

function readFileChunk(filePath: string, offset: number, length: number): Buffer {
  const handle = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytes = fs.readSync(handle, buffer, 0, length, offset);
    return buffer.subarray(0, bytes);
  } finally {
    fs.closeSync(handle);
  }
}

function findRolloutFiles(rootDir: string): string[] {
  const files: string[] = [];
  const stack = [rootDir];
  let visited = 0;
  while (stack.length > 0 && visited < 5_000) {
    const dir = stack.pop();
    if (!dir) {
      continue;
    }
    visited += 1;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(filePath);
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        files.push(filePath);
      }
    }
  }
  return files;
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}
