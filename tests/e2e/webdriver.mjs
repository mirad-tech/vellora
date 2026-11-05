import { setTimeout as delay } from 'node:timers/promises';

const elementKey = 'element-6066-11e4-a52e-4f735466cecf';

export async function webdriverRequest(url, method = 'GET', body, timeout = 15_000) {
  const response = await fetch(url, {
    method, signal: AbortSignal.timeout(timeout),
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  });
  const reply = await response.json();
  if (!response.ok || reply.value?.error) {
    throw new Error(method + ' ' + new URL(url).pathname + ': ' + (reply.value?.message ?? response.status));
  }
  return reply.value;
}

export async function waitFor(description, check, timeout = 15_000) {
  const until = Date.now() + timeout;
  do {
    if (await check()) return;
    await delay(100);
  } while (Date.now() < until);
  throw new Error('Timed out waiting for ' + description);
}

export async function openWebDriverSession(baseUrl, application, args) {
  const result = await webdriverRequest(baseUrl + '/session', 'POST', {
    capabilities: { alwaysMatch: {
      browserName: 'wry',
      'tauri:options': { application, args }
    } }
  }, 90_000);
  if (!result?.sessionId) throw new Error('The WebDriver response omitted its session ID.');
  const sessionUrl = baseUrl + '/session/' + encodeURIComponent(result.sessionId);
  const request = (method, endpoint, payload) => webdriverRequest(sessionUrl + endpoint, method, payload);
  const execute = (script, ...parameters) => request('POST', '/execute/sync', {
    script: 'return (' + script.toString() + ')(...arguments);', args: parameters
  });
  const keyActions = actions => request('POST', '/actions', {
    actions: [{ type: 'key', id: 'keyboard', actions }]
  });
  const key = (value, type = 'keyDown') => ({ type, value });
  const click = async selector => {
    const element = await request('POST', '/element', { using: 'css selector', value: selector });
    if (!element?.[elementKey]) throw new Error('Could not locate ' + selector);
    return request('POST', '/element/' + encodeURIComponent(element[elementKey]) + '/click', {});
  };
  const control = '\uE009';

  return {
    capabilities: result.capabilities,
    execute,
    click,
    async controlClick(selector) {
      try {
        await keyActions([key(control)]);
        await click(selector);
      } finally {
        await request('DELETE', '/actions');
      }
    },
    press: value => keyActions([key(value), key(value, 'keyUp')]),
    type: value => keyActions(Array.from(value).flatMap(character => [key(character), key(character, 'keyUp')])),
    shortcut: value => keyActions([key(control), key(value), key(value, 'keyUp'), key(control, 'keyUp')]),
    screenshot: () => request('GET', '/screenshot'),
    close: () => request('DELETE', '')
  };
}
