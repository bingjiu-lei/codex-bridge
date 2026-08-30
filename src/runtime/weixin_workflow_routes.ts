import crypto from 'node:crypto';
import type { InboundTextEvent } from '../types/platform.js';
import { JsonFileStore } from '../store/file_json/json_file_store.js';

export const WORKFLOW_ROUTE_MARKER_PREFIX = '[#CBWF:';
export const WORKFLOW_ROUTE_MARKER_SUFFIX = ']';

export interface WorkflowNotificationRoute {
  token: string;
  alias: string;
  platform: 'weixin';
  externalScopeId: string;
  bridgeSessionId: string;
  workflow: string;
  runId: string;
  title: string;
  status: 'succeeded' | 'failed';
  createdAt: number;
  expiresAt: number;
}

export interface RegisterWorkflowNotificationRouteInput {
  externalScopeId: string;
  bridgeSessionId: string;
  workflow?: string | null;
  runId: string;
  title?: string | null;
  status?: 'succeeded' | 'failed' | null;
  now?: number;
  expiresAt?: number;
}

export class FileJsonWorkflowNotificationRouteStore {
  constructor(filePath: string) {
    this.store = new JsonFileStore(filePath, []);
  }

  store: JsonFileStore<WorkflowNotificationRoute[]>;

  register(input: RegisterWorkflowNotificationRouteInput): WorkflowNotificationRoute {
    const now = input.now ?? Date.now();
    const externalScopeId = String(input.externalScopeId ?? '').trim();
    const bridgeSessionId = String(input.bridgeSessionId ?? '').trim();
    const runId = String(input.runId ?? '').trim();
    if (!externalScopeId || !bridgeSessionId || !runId) {
      throw new Error('Workflow notification route requires externalScopeId, bridgeSessionId, and runId.');
    }
    const records = this.list().filter((route) => route.expiresAt > now);
    const existing = records.find((route) => (
      route.platform === 'weixin'
      && route.externalScopeId === externalScopeId
      && route.bridgeSessionId === bridgeSessionId
      && route.runId === runId
    ));
    if (existing) {
      this.store.write(records);
      return existing;
    }
    const route: WorkflowNotificationRoute = {
      token: crypto.randomBytes(9).toString('base64url'),
      alias: nextWorkflowAlias(records.filter((route) => route.externalScopeId === externalScopeId).length),
      platform: 'weixin',
      externalScopeId,
      bridgeSessionId,
      workflow: String(input.workflow ?? 'bilibili-video').trim() || 'bilibili-video',
      runId,
      title: String(input.title ?? '视频工作流').trim() || '视频工作流',
      status: input.status === 'failed' ? 'failed' : 'succeeded',
      createdAt: now,
      expiresAt: input.expiresAt ?? now + (30 * 24 * 60 * 60 * 1000),
    };
    this.store.write([...records, route]);
    return route;
  }

  findForReferencedText(params: {
    externalScopeId: string;
    referenceText: string | null | undefined;
    now?: number;
  }): WorkflowNotificationRoute | null {
    const routeKey = extractWorkflowRouteToken(params.referenceText);
    if (!routeKey) {
      return null;
    }
    const now = params.now ?? Date.now();
    return this.list().find((route) => (
      (route.token === routeKey || route.alias === routeKey)
      && route.platform === 'weixin'
      && route.externalScopeId === params.externalScopeId
      && route.expiresAt > now
    )) ?? null;
  }

  list(): WorkflowNotificationRoute[] {
    return this.store.read().map((route, index) => ({
      ...route,
      alias: normalizeWorkflowAlias(route.alias) ?? nextWorkflowAlias(index),
      title: String(route.title ?? route.workflow ?? '视频工作流').trim() || '视频工作流',
      status: route.status === 'failed' ? 'failed' : 'succeeded',
    }));
  }

  findByAlias(externalScopeId: string, alias: string, now = Date.now()): WorkflowNotificationRoute | null {
    const normalizedAlias = normalizeWorkflowAlias(alias);
    if (!normalizedAlias) {
      return null;
    }
    return this.list().find((route) => (
      route.externalScopeId === externalScopeId
      && route.alias === normalizedAlias
      && route.expiresAt > now
    )) ?? null;
  }

  remove(token: string): boolean {
    const records = this.list();
    const next = records.filter((route) => route.token !== token);
    if (next.length === records.length) {
      return false;
    }
    this.store.write(next);
    return true;
  }
}

interface WorkflowFocus {
  externalScopeId: string;
  bridgeSessionId: string;
  alias: string;
  updatedAt: number;
}

export class FileJsonWorkflowFocusStore {
  constructor(filePath: string) {
    this.store = new JsonFileStore(filePath, []);
  }

  store: JsonFileStore<WorkflowFocus[]>;

  get(externalScopeId: string): WorkflowFocus | null {
    return this.store.read().find((focus) => focus.externalScopeId === externalScopeId) ?? null;
  }

  set(params: { externalScopeId: string; bridgeSessionId: string; alias: string }): WorkflowFocus {
    const next: WorkflowFocus = { ...params, updatedAt: Date.now() };
    const records = this.store.read().filter((focus) => focus.externalScopeId !== params.externalScopeId);
    this.store.write([...records, next]);
    return next;
  }

  clear(externalScopeId: string): boolean {
    const records = this.store.read();
    const next = records.filter((focus) => focus.externalScopeId !== externalScopeId);
    if (next.length === records.length) {
      return false;
    }
    this.store.write(next);
    return true;
  }
}

export class WeixinWorkflowRouteResolver {
  constructor({ routeStore, focusStore }: {
    routeStore: FileJsonWorkflowNotificationRouteStore;
    focusStore: FileJsonWorkflowFocusStore;
  }) {
    this.routeStore = routeStore;
    this.focusStore = focusStore;
  }

  routeStore: FileJsonWorkflowNotificationRouteStore;
  focusStore: FileJsonWorkflowFocusStore;

  resolveInboundEvent(event: InboundTextEvent): InboundTextEvent {
    if (event.platform !== 'weixin') {
      return event;
    }
    const weixin = event.metadata?.weixin;
    const referenceText = weixin && typeof weixin === 'object'
      ? (weixin as Record<string, unknown>).referenceText
      : null;
    const route = this.routeStore.findForReferencedText({
      externalScopeId: event.externalScopeId,
      referenceText: typeof referenceText === 'string' ? referenceText : null,
    });
    if (route) {
      return withWorkflowRoute(event, route);
    }
    if (isDailyThreadCommand(event.text)) {
      this.focusStore.clear(event.externalScopeId);
      return event;
    }
    const focus = this.focusStore.get(event.externalScopeId);
    if (!focus) {
      return event;
    }
    return withWorkflowRoute(event, {
      token: focus.alias,
      alias: focus.alias,
      platform: 'weixin',
      externalScopeId: focus.externalScopeId,
      bridgeSessionId: focus.bridgeSessionId,
      workflow: 'bilibili-video',
      runId: '',
      title: '',
      status: 'succeeded',
      createdAt: focus.updatedAt,
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
  }

  handleCommand(event: InboundTextEvent): string | null {
    if (event.platform !== 'weixin') {
      return null;
    }
    const command = String(event.text ?? '').trim();
    if (/^\/inbox$/iu.test(command)) {
      const routes = this.routeStore.list()
        .filter((route) => route.externalScopeId === event.externalScopeId && route.expiresAt > Date.now())
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, 10);
      if (routes.length === 0) {
        return '最近没有可继续的工作流。日常聊天直接发送消息；新开日常对话用 /new 标题。';
      }
      return [
        '最近工作流：',
        ...routes.map((route) => `${route.alias}  ${route.title}（${route.status === 'failed' ? '失败' : '成功'}）`),
        '输入 /focus A 可连续处理某个工作流；/home 回日常。',
      ].join('\n');
    }
    const focusMatch = command.match(/^\/focus\s+((?:V-)?[A-Z]+)$/iu);
    if (focusMatch) {
      const route = this.routeStore.findByAlias(event.externalScopeId, focusMatch[1]);
      if (!route) {
        return `未找到 ${normalizeWorkflowAlias(focusMatch[1]) ?? focusMatch[1].toUpperCase()}。先发送 /inbox 查看最近工作流。`;
      }
      this.focusStore.set({
        externalScopeId: event.externalScopeId,
        bridgeSessionId: route.bridgeSessionId,
        alias: route.alias,
      });
      return `已切换到 ${route.alias}：${route.title}。接下来的不引用消息都会发往该工作流；发送 /home 回日常。`;
    }
    if (/^\/home$/iu.test(command)) {
      const changed = this.focusStore.clear(event.externalScopeId);
      return changed
        ? '已回到日常对话。之后可用 /new 标题 新开一个日常对话。'
        : '当前已经是日常对话。可用 /new 标题 新开一个日常对话。';
    }
    return null;
  }
}

export function formatWorkflowRouteMarker(alias: string): string {
  return `任务编号：${alias}`;
}

export function extractWorkflowRouteToken(value: string | null | undefined): string | null {
  const text = String(value ?? '');
  const legacy = text.match(/\[#CBWF:([A-Za-z0-9_-]{8,64})\]/u);
  if (legacy?.[1]) {
    return legacy[1];
  }
  const alias = text.match(/任务编号：\s*((?:V-)?[A-Z]+)/iu);
  return normalizeWorkflowAlias(alias?.[1]) ?? null;
}

function withWorkflowRoute(event: InboundTextEvent, route: WorkflowNotificationRoute): InboundTextEvent {
  return {
    ...event,
    metadata: {
      ...(event.metadata ?? {}),
      codexbridge: {
        ...readRecord(event.metadata?.codexbridge),
        overrideBridgeSessionId: route.bridgeSessionId,
        workflowNotificationToken: route.token,
        workflowRunId: route.runId,
        workflowAlias: route.alias,
      },
    },
  };
}

function isDailyThreadCommand(text: string): boolean {
  return /^\/(?:new|open)\b/iu.test(String(text ?? '').trim());
}

function nextWorkflowAlias(index: number): string {
  let value = index + 1;
  let suffix = '';
  while (value > 0) {
    value -= 1;
    suffix = String.fromCharCode(65 + (value % 26)) + suffix;
    value = Math.floor(value / 26);
  }
  return suffix;
}

function normalizeWorkflowAlias(value: unknown): string | null {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (/^V-[A-Z]+$/u.test(normalized)) {
    return normalized.slice(2);
  }
  return /^[A-Z]+$/u.test(normalized) ? normalized : null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}
