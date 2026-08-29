import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FileJsonWorkflowNotificationRouteStore,
  FileJsonWorkflowFocusStore,
  formatWorkflowRouteMarker,
  WeixinWorkflowRouteResolver,
} from '../../src/runtime/weixin_workflow_routes.js';

function makeStores() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-workflow-routes-'));
  return {
    routeStore: new FileJsonWorkflowNotificationRouteStore(path.join(dir, 'routes.json')),
    focusStore: new FileJsonWorkflowFocusStore(path.join(dir, 'focus.json')),
  };
}

test('WeixinWorkflowRouteResolver routes a quoted workflow notification to its original bridge session', () => {
  const { routeStore, focusStore } = makeStores();
  const route = routeStore.register({
    externalScopeId: 'wxid_owner',
    bridgeSessionId: 'session-workflow-a',
    runId: 'upload-2026-08-30-a',
    now: Date.now(),
    expiresAt: Date.now() + 10_000,
  });
  const resolver = new WeixinWorkflowRouteResolver({ routeStore, focusStore });

  const event = resolver.resolveInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wxid_owner',
    text: '把标题改一下',
    metadata: {
      weixin: {
        referenceText: `【视频工作流已完成】\n${formatWorkflowRouteMarker(route.alias)}`,
      },
    },
  });

  assert.equal((event.metadata?.codexbridge as Record<string, unknown>).overrideBridgeSessionId, 'session-workflow-a');
  assert.equal((event.metadata?.codexbridge as Record<string, unknown>).workflowRunId, 'upload-2026-08-30-a');
});

test('WeixinWorkflowRouteResolver leaves unquoted and cross-scope messages on the daily binding', () => {
  const { routeStore, focusStore } = makeStores();
  const route = routeStore.register({
    externalScopeId: 'wxid_owner',
    bridgeSessionId: 'session-workflow-a',
    runId: 'upload-a',
  });
  const resolver = new WeixinWorkflowRouteResolver({ routeStore, focusStore });

  const unquoted = resolver.resolveInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wxid_owner',
    text: '今天有什么安排',
  });
  assert.equal(unquoted.metadata?.codexbridge, undefined);

  const otherPerson = resolver.resolveInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wxid_other',
    text: '继续处理',
    metadata: {
      weixin: { referenceText: formatWorkflowRouteMarker(route.alias) },
    },
  });
  assert.equal(otherPerson.metadata?.codexbridge, undefined);
});

test('WeixinWorkflowRouteResolver exposes inbox, focus, home, and preserves /new for daily conversations', () => {
  const { routeStore, focusStore } = makeStores();
  const first = routeStore.register({
    externalScopeId: 'wxid_owner', bridgeSessionId: 'session-a', runId: 'upload-a', title: '电影 A',
  });
  const second = routeStore.register({
    externalScopeId: 'wxid_owner', bridgeSessionId: 'session-b', runId: 'upload-b', title: '电影 B', status: 'failed',
  });
  const resolver = new WeixinWorkflowRouteResolver({ routeStore, focusStore });
  const inbox = resolver.handleCommand({ platform: 'weixin', externalScopeId: 'wxid_owner', text: '/inbox' });
  assert.match(inbox ?? '', /A\s+电影 A/u);
  assert.match(inbox ?? '', /B\s+电影 B/u);
  assert.match(inbox ?? '', /电影 B（失败）/u);

  assert.match(
    resolver.handleCommand({ platform: 'weixin', externalScopeId: 'wxid_owner', text: '/focus B' }) ?? '',
    /电影 B/u,
  );
  const focused = resolver.resolveInboundEvent({ platform: 'weixin', externalScopeId: 'wxid_owner', text: '继续处理' });
  assert.equal((focused.metadata?.codexbridge as Record<string, unknown>).overrideBridgeSessionId, 'session-b');

  const dailyNew = resolver.resolveInboundEvent({ platform: 'weixin', externalScopeId: 'wxid_owner', text: '/new 新话题' });
  assert.equal(dailyNew.metadata?.codexbridge, undefined);
  assert.equal(focusStore.get('wxid_owner'), null);

  assert.match(resolver.handleCommand({ platform: 'weixin', externalScopeId: 'wxid_owner', text: '/home' }) ?? '', /日常/u);
  assert.equal(second.alias, 'B');
  assert.equal(first.alias, 'A');
});
