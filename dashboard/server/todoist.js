// Shopping list in a Todoist project (API v1). Env: TODOIST_TOKEN (Settings > Integrations > Developer);
// optional TODOIST_PROJECT = project name (default "Groceries"). The frame never talks to Todoist: this
// server does, so the frame's old CA store doesn't matter.
// A task is one item. Title = "Eggs ×2" (count suffix; "x2" typed on a phone works too). Category and
// is a Todoist label (@produce); the store is the section the task sits in (Walmart, Costco, Chinese).
const API = 'https://api.todoist.com/api/v1/';
let projectId = null; // looked up by name once per process/isolate

export function todoistConfigured(env) { return !!env.TODOIST_TOKEN; }

async function call(env, method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: Object.assign({ Authorization: 'Bearer ' + env.TODOIST_TOKEN }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 401 || r.status === 403) throw new Error('Todoist sign-in failed — check TODOIST_TOKEN');
  if (r.status === 429) { const e = new Error('rate limited'); e.status = 429; throw e; }
  if (!r.ok) throw new Error('Todoist HTTP ' + r.status);
  const text = await r.text();
  return text ? JSON.parse(text) : {};
}

// Paginated endpoints answer { results, next_cursor }.
async function all(env, path) {
  const out = [];
  let cursor = '';
  do {
    const d = await call(env, 'GET', path + (path.includes('?') ? '&' : '?') + 'limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    out.push(...(d.results || []));
    cursor = d.next_cursor || '';
  } while (cursor);
  return out;
}

async function project(env) {
  if (projectId) return projectId;
  const name = String(env.TODOIST_PROJECT || 'Groceries').trim().toLowerCase();
  const p = (await all(env, 'projects')).find((x) => String(x.name).trim().toLowerCase() === name);
  if (!p) throw new Error('No Todoist project named "' + (env.TODOIST_PROJECT || 'Groceries') + '"');
  projectId = p.id;
  return projectId;
}

export function parseTitle(content) {
  const m = String(content || '').trim().match(/^(.*?)\s*[x×]\s*(\d{1,3})$/i);
  return m && m[1] ? { name: m[1].trim(), qty: Math.max(1, +m[2]) } : { name: String(content || '').trim(), qty: 1 };
}
const titleOf = (name, qty) => String(name).trim() + (qty > 1 ? ' ×' + qty : '');
const item = (t) => {
  const p = parseTitle(t.content);
  return { id: t.id, name: p.name, qty: p.qty, note: t.description || '', labels: t.labels || [], sectionId: t.section_id || null };
};

export async function shoppingList(env) {
  const id = await project(env);
  const [tasks, sections] = await Promise.all([all(env, 'tasks?project_id=' + encodeURIComponent(id)), all(env, 'sections?project_id=' + encodeURIComponent(id))]);
  return { configured: true, project: env.TODOIST_PROJECT || 'Groceries', sections: sections.map((s) => ({ id: s.id, name: s.name })), items: tasks.map(item) };
}

// What actually gets bought: completed items from the last 90 days, most often first. Todoist keeps the
// history, so it survives restarts and needs no storage of our own. Cached for 10 minutes.
let hist = { at: 0, data: null };
export async function shoppingHistory(env) {
  if (hist.data && Date.now() - hist.at < 10 * 60 * 1000) return hist.data;
  const id = String(await project(env));
  const until = new Date(), since = new Date(+until - 90 * 864e5);
  const seen = new Map();
  let cursor = '';
  for (let page = 0; page < 5; page++) { // 5 x 200 completed items is plenty for a household
    const d = await call(env, 'GET', 'tasks/completed/by_completion_date?limit=200&since=' + encodeURIComponent(since.toISOString()) +
      '&until=' + encodeURIComponent(until.toISOString()) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    (d.items || []).filter((t) => String(t.project_id) === id).forEach((t) => {
      const name = parseTitle(t.content).name, key = name.toLowerCase();
      if (!key) return;
      const e = seen.get(key) || { name, count: 0, last: '' };
      e.count++;
      if (String(t.completed_at || '') > e.last) { e.last = String(t.completed_at || ''); e.name = name; } // newest spelling wins
      seen.set(key, e);
    });
    cursor = d.next_cursor || '';
    if (!cursor) break;
  }
  const items = [...seen.values()].sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : -1)).slice(0, 30).map((e) => ({ name: e.name, count: e.count }));
  hist = { at: Date.now(), data: { configured: true, items } };
  return hist.data;
}

// body: { op: 'add'|'update'|'delete', id, name, qty, labels (replaces all), note, done }
export async function shoppingWrite(env, b) {
  const bad = (m) => { const e = new Error(m); e.status = 400; return e; };
  if (b.op === 'add') {
    if (!b.name || !String(b.name).trim()) throw bad('name required');
    const t = await call(env, 'POST', 'tasks', {
      content: titleOf(b.name, +b.qty || 1), project_id: await project(env),
      labels: (b.labels || []).map(String), description: b.note || undefined, section_id: b.sectionId || undefined
    });
    return { item: item(t) };
  }
  if (!b.id) throw bad('id required');
  const id = encodeURIComponent(b.id);
  if (b.op === 'delete') { await call(env, 'DELETE', 'tasks/' + id); return { ok: true }; }
  if (b.op === 'update') {
    if (b.done === true) await call(env, 'POST', 'tasks/' + id + '/close');
    else if (b.done === false) await call(env, 'POST', 'tasks/' + id + '/reopen');
    const patch = {};
    if (b.name != null && b.qty != null) patch.content = titleOf(b.name, +b.qty || 1);
    if (Array.isArray(b.labels)) patch.labels = b.labels.map(String);
    if (Object.keys(patch).length) await call(env, 'POST', 'tasks/' + id, patch);
    // sectionId: a section id moves the task there; null takes it out of any section (back to the project's top).
    if ('sectionId' in b) await call(env, 'POST', 'tasks/' + id + '/move', b.sectionId ? { section_id: b.sectionId } : { project_id: await project(env) });
    return { ok: true };
  }
  throw bad('unknown op');
}
