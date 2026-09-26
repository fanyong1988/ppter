const test = require('node:test');
const assert = require('node:assert/strict');

const { runStaggeredBatch } = require('../public/batch-runner');

function sleep(delayMs) {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('等待测试条件超时');
    await sleep(2);
  }
}

test('提交严格串行且相邻请求在上一请求结束后错峰', async () => {
  const intervalMs = 25;
  const starts = [];
  const ends = [];
  const terminalResolvers = new Map();
  let activeSubmissions = 0;
  let maxActiveSubmissions = 0;

  const batch = runStaggeredBatch([1, 2, 3], {
    intervalMs,
    submit: async item => {
      activeSubmissions += 1;
      maxActiveSubmissions = Math.max(maxActiveSubmissions, activeSubmissions);
      starts[item] = Date.now();
      await sleep(5);
      ends[item] = Date.now();
      activeSubmissions -= 1;
      return true;
    },
    waitForTerminal: item => new Promise(resolve => terminalResolvers.set(item, resolve)),
  });

  await waitUntil(() => terminalResolvers.size === 3);
  assert.equal(maxActiveSubmissions, 1);
  assert.ok(starts[2] - ends[1] >= intervalMs - 2, '第 2 次提交应在第 1 次返回后等待节流间隔');
  assert.ok(starts[3] - ends[2] >= intervalMs - 2, '第 3 次提交应在第 2 次返回后等待节流间隔');

  terminalResolvers.forEach(resolve => resolve('completed'));
  await batch;
});

test('未等待首项生成完成即可提交后续任务', async () => {
  const events = [];
  let finishFirst;

  const batch = runStaggeredBatch([1, 2], {
    intervalMs: 5,
    submit: async item => {
      events.push(`submit-${item}`);
      return true;
    },
    waitForTerminal: item => {
      if (item === 1) return new Promise(resolve => { finishFirst = resolve; });
      events.push('terminal-2');
      return Promise.resolve('completed');
    },
  });

  await waitUntil(() => events.includes('submit-2'));
  assert.deepEqual(events.slice(0, 2), ['submit-1', 'submit-2']);
  finishFirst('completed');
  await batch;
});

test('单项提交失败后仍按节流间隔继续提交', async () => {
  const submitted = [];
  const waited = [];
  const terminalItems = [];

  await runStaggeredBatch([1, 2], {
    submit: async item => {
      submitted.push(item);
      return item !== 1;
    },
    waitForTerminal: async item => {
      terminalItems.push(item);
    },
    wait: async delayMs => {
      waited.push(delayMs);
    },
  });

  assert.deepEqual(submitted, [1, 2]);
  assert.deepEqual(waited, [1000]);
  assert.deepEqual(terminalItems, [2]);
});

test('意外的提交异常会向调用方传播', async () => {
  const submitted = [];

  await assert.rejects(runStaggeredBatch([1, 2], {
    submit: async item => {
      submitted.push(item);
      throw new Error('程序错误');
    },
    waitForTerminal: async () => 'completed',
  }), /程序错误/);

  assert.deepEqual(submitted, [1]);
});

test('终态拒绝会被立即收集且不阻止后续提交', async () => {
  const submitted = [];
  const results = await runStaggeredBatch([1, 2], {
    intervalMs: 0,
    submit: async item => {
      submitted.push(item);
      return true;
    },
    waitForTerminal: async item => {
      if (item === 1) throw new Error('轮询失败');
      return 'completed';
    },
  });

  assert.deepEqual(submitted, [1, 2]);
  assert.equal(results[0].status, 'rejected');
  assert.match(results[0].reason.message, /轮询失败/);
  assert.deepEqual(results[1], { status: 'fulfilled', value: 'completed' });
});

test('单页批量不会增加尾部等待', async () => {
  let waitCalls = 0;

  await runStaggeredBatch([1], {
    submit: async () => true,
    waitForTerminal: async () => 'completed',
    wait: async () => { waitCalls += 1; },
  });

  assert.equal(waitCalls, 0);
});
