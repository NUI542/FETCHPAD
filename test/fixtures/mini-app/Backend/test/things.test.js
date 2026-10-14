const test = require('node:test');

test('things', async () => {
  const base = `http://localhost:${process.env.PORT}/api`;
  async function api(method, url) {
    return fetch(base + url, { method });
  }
  await api('GET', '/things');
  await api('POST', '/things');
});
