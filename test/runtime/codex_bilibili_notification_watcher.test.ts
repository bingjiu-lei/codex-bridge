import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFileJsonRepositories } from '../../src/store/file_json/create_file_json_repositories.js';
import {
  CodexBilibiliNotificationWatcher,
  extractBilibiliTerminalEvent,
} from '../../src/runtime/codex_bilibili_notification_watcher.js';
import { FileJsonWorkflowNotificationRouteStore } from '../../src/runtime/weixin_workflow_routes.js';

function terminalRecord(status: 'uploading' | 'succeeded' | 'failed') {
  return {
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'thread-desktop-1',
      turn_id: 'turn-1',
      item: {
        type: 'McpToolCall',
        id: 'tool-call-1',
        server: 'bilibili-mcp',
        tool: 'bili_upload_status',
        arguments: { job_id: 'job-1' },
        status: 'completed',
        result: {
          content: [{ type: 'text', text: JSON.stringify({
            job_id: 'job-1', status, title: '测试视频', last_error: status === 'failed' ? '上传端拒绝' : '',
            result: status === 'succeeded' ? { bvid: 'BV1TEST' } : undefined,
          }) }],
        },
      },
    },
  };
}

test('extractBilibiliTerminalEvent accepts only explicit upload terminal states', () => {
  assert.equal(extractBilibiliTerminalEvent(terminalRecord('uploading')), null);
  assert.deepEqual(extractBilibiliTerminalEvent(terminalRecord('succeeded')), {
    threadId: 'thread-desktop-1', turnId: 'turn-1', runId: 'job-1', status: 'succeeded',
    title: '测试视频', detail: 'BV号：BV1TEST',
  });
  assert.equal(extractBilibiliTerminalEvent(terminalRecord('failed'))?.detail, '上传端拒绝');
});

test('CodexBilibiliNotificationWatcher binds a desktop Codex thread and sends one routable notification', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-bili-watcher-'));
  const sessionsDir = path.join(root, 'sessions');
  const runtimeDir = path.join(root, 'runtime');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const rollout = path.join(sessionsDir, 'rollout-thread-desktop-1.jsonl');
  fs.writeFileSync(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id: 'thread-desktop-1', cwd: 'D:\\githubPro' } })}\n`);
  const repositories = createFileJsonRepositories(runtimeDir);
  repositories.platformBindings.save({
    platform: 'weixin', externalScopeId: 'wx-owner', bridgeSessionId: 'daily-session', updatedAt: Date.now(),
  });
  const sent: string[] = [];
  const watcher = new CodexBilibiliNotificationWatcher({
    stateFile: path.join(runtimeDir, 'watcher.json'),
    routeStore: new FileJsonWorkflowNotificationRouteStore(path.join(runtimeDir, 'routes.json')),
    bridgeSessions: repositories.bridgeSessions,
    platformBindings: repositories.platformBindings,
    platformPlugin: { sendText: async ({ content }) => { sent.push(content); return { success: true }; } },
    providerProfileId: 'openai-default',
    sessionsDir,
  });
  watcher.start();
  fs.appendFileSync(rollout, `${JSON.stringify(terminalRecord('succeeded'))}\n`);
  await watcher.scanNow();
  await watcher.scanNow();
  watcher.stop();

  assert.equal(sent.length, 1);
  assert.match(sent[0], /BV号：BV1TEST/u);
  const session = repositories.bridgeSessions.list().find((candidate) => candidate.codexThreadId === 'thread-desktop-1');
  assert.ok(session);
  assert.equal(new FileJsonWorkflowNotificationRouteStore(path.join(runtimeDir, 'routes.json')).list()[0].bridgeSessionId, session.id);
});
