(function initBatchRunner(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BatchRunner = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createBatchRunner() {
  'use strict';

  function sleep(delayMs) {
    return new Promise(resolve => setTimeout(resolve, delayMs));
  }

  async function runStaggeredBatch(items, options = {}) {
    const submit = options.submit;
    const waitForTerminal = options.waitForTerminal;
    const intervalMs = options.intervalMs ?? 1000;
    const wait = options.wait || sleep;
    const terminalPromises = [];

    if (typeof submit !== 'function' || typeof waitForTerminal !== 'function') {
      throw new TypeError('submit 和 waitForTerminal 必须是函数');
    }

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const submitted = await submit(item, index);

      if (submitted) {
        const terminalPromise = Promise.resolve()
          .then(() => waitForTerminal(item, index))
          .then(
            value => ({ status: 'fulfilled', value }),
            reason => ({ status: 'rejected', reason }),
          );
        terminalPromises.push(terminalPromise);
      }

      if (index < items.length - 1) await wait(intervalMs);
    }

    const results = [];
    for (const terminalPromise of terminalPromises) results.push(await terminalPromise);
    return results;
  }

  return { runStaggeredBatch };
}));
