const BASE_URL = import.meta.env.VITE_API_URL || '/api';

async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  return res.json();
}

const send = (method, path, data) =>
  request(path, { method, body: data === undefined ? undefined : JSON.stringify(data) });

export const thingApi = {
  getAll: () => request('/things'),
  getMine: () => request('/things/mine'),
  getOne: (id) => request(`/things/${id}`),
  search: (q) => request(`/things/search?q=${encodeURIComponent(q)}`),
  create: (data) => send('POST', '/things', data),
  remove: (id) => send('DELETE', `/things/${id}`),
};

export const orphanApi = {
  ping: () => request('/nope'),
};
