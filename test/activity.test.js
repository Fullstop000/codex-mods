import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionActivityReader } from '../src/activity.js';

const ACTIVE_ID = '01234567-89ab-cdef-0123-456789abcdef';
const ARCHIVED_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const RESUMED_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const UNRELATED_ID = 'cccccccc-dddd-eeee-ffff-000000000000';
const WARNING = 'Some session activity could not be resolved; affected sessions were omitted.';

async function withCodexHome(run) {
  const root = await mkdtemp(join(tmpdir(), 'codex-session-activity-'));
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function responseMessage(timestamp, role = 'assistant') {
  return { type: 'response_item', timestamp: new Date(timestamp).toISOString(), payload: { type: 'message', role } };
}

function eventMessage(timestamp, type = 'user_message') {
  return { type: 'event_msg', timestamp: new Date(timestamp).toISOString(), payload: { type } };
}

function sessionMeta(id) { return { type: 'session_meta', payload: { id } }; }
function line(record) { return `${JSON.stringify(record)}\n`; }

test('uses the latest user or assistant message across active and archived rollouts', async () => {
  await withCodexHome(async root => {
    const active = join(root, 'sessions', '2026', '10');
    const archived = join(root, 'archived_sessions', 'nested');
    await mkdir(active, { recursive: true });
    await mkdir(archived, { recursive: true });
    const now = Date.now();
    const activeFile = join(active, `rollout-active-${ACTIVE_ID}.jsonl`);
    const archivedFile = join(archived, `rollout-archived-${ACTIVE_ID.toUpperCase()}.jsonl`);
    await writeFile(activeFile, [line(eventMessage(now - 40 * 3600_000)), line({ type: 'response_item', timestamp: new Date(now).toISOString(), payload: { type: 'function_call' } })].join(''));
    await writeFile(archivedFile, line(responseMessage(now - 12 * 3600_000, 'user')));

    // A hard-linked duplicate rollout must not change the aggregate or be scanned twice.
    try { await link(archivedFile, join(archived, `rollout-copy-${ACTIVE_ID}.jsonl`)); }
    catch (error) { if (!['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error; }

    const result = await createSessionActivityReader(root)([ACTIVE_ID.toUpperCase()]);
    assert.deepEqual(result, { lastMessages: { [ACTIVE_ID]: now - 12 * 3600_000 }, warning: null });
  });
});

test('uses the resumed suffix rollout when its header resolves to the canonical ID', async () => {
  await withCodexHome(async root => {
    const directory = join(root, 'sessions', '2026', '09');
    await mkdir(directory, { recursive: true });
    const now = Date.now();
    await writeFile(join(directory, `rollout-2026-09-20T12-00-00-${ACTIVE_ID}.jsonl`),
      line(sessionMeta(ACTIVE_ID)) + line(responseMessage(now - 65 * 3600_000)));
    await writeFile(join(directory, `rollout-2026-09-21T12-31-33-${ACTIVE_ID}_${RESUMED_ID}.jsonl`),
      line(sessionMeta(ACTIVE_ID.toUpperCase())) + line(eventMessage(now - 5 * 60_000)));

    assert.deepEqual(await createSessionActivityReader(root)([ACTIVE_ID]), {
      lastMessages: { [ACTIVE_ID]: now - 5 * 60_000 }, warning: null,
    });
  });
});

test('resumed header may resolve to another UUID only when it is a filename candidate', async () => {
  await withCodexHome(async root => {
    const directory = join(root, 'sessions');
    await mkdir(directory, { recursive: true });
    const now = Date.now();
    await writeFile(join(directory, `rollout-2026-09-21T12-31-33-${ACTIVE_ID}_${RESUMED_ID.toUpperCase()}.jsonl`),
      line(sessionMeta(RESUMED_ID.toUpperCase())) + line(responseMessage(now - 20 * 60_000, 'user')));

    assert.deepEqual(await createSessionActivityReader(root)([ACTIVE_ID, RESUMED_ID]), {
      lastMessages: { [RESUMED_ID]: now - 20 * 60_000 }, warning: null,
    });
  });
});

test('mismatched resumed headers invalidate every filename candidate instead of misattributing activity', async () => {
  await withCodexHome(async root => {
    const directory = join(root, 'sessions');
    await mkdir(directory, { recursive: true });
    const now = Date.now();
    await writeFile(join(directory, `rollout-canonical-${ACTIVE_ID}.jsonl`),
      line(sessionMeta(ACTIVE_ID)) + line(responseMessage(now - 70 * 3600_000)));
    await writeFile(join(directory, `rollout-2026-09-21T12-31-33-${ACTIVE_ID}_${RESUMED_ID}.jsonl`),
      line(sessionMeta(UNRELATED_ID)) + line(responseMessage(now - 2 * 60_000)));

    assert.deepEqual(await createSessionActivityReader(root)([ACTIVE_ID, RESUMED_ID]), {
      lastMessages: {}, warning: WARNING,
    });
  });
});

test('recovers a corrected resumed header in place without exposing the old canonical activity', async () => {
  await withCodexHome(async root => {
    const directory = join(root, 'sessions');
    await mkdir(directory, { recursive: true });
    const now = Date.now();
    await writeFile(join(directory, `rollout-canonical-${ACTIVE_ID}.jsonl`),
      line(sessionMeta(ACTIVE_ID)) + line(responseMessage(now - 70 * 3600_000)));
    const resumedPath = join(directory, `rollout-2026-09-21T12-31-33-${ACTIVE_ID}_${RESUMED_ID}.jsonl`);
    await writeFile(resumedPath, '{"type":"session_meta","payload":{"id":"');

    const read = createSessionActivityReader(root);
    assert.deepEqual(await read([ACTIVE_ID, RESUMED_ID]), { lastMessages: {}, warning: WARNING });

    await writeFile(resumedPath, line(sessionMeta(ACTIVE_ID)) + line(eventMessage(now - 5 * 60_000)));
    await new Promise(resolve => setTimeout(resolve, 1_100));
    assert.deepEqual(await read([ACTIVE_ID, RESUMED_ID]), {
      lastMessages: { [ACTIVE_ID]: now - 5 * 60_000 }, warning: null,
    });
  });
});

test('missing resumed headers omit affected candidates with a warning', async () => {
  await withCodexHome(async root => {
    const directory = join(root, 'sessions');
    await mkdir(directory, { recursive: true });
    const now = Date.now();
    await writeFile(join(directory, `rollout-2026-09-21T12-31-33-${ACTIVE_ID}_${RESUMED_ID}.jsonl`),
      line(responseMessage(now - 90 * 3600_000)));

    assert.deepEqual(await createSessionActivityReader(root)([ACTIVE_ID, RESUMED_ID]), {
      lastMessages: {}, warning: WARNING,
    });
  });
});

test('discovers a new resumed file for a cached ID and deduplicates a canonical hard link', async t => {
  await withCodexHome(async root => {
    const directory = join(root, 'sessions');
    await mkdir(directory, { recursive: true });
    const now = Date.now();
    const canonical = join(directory, `rollout-canonical-${ACTIVE_ID}.jsonl`);
    const resumed = join(directory, `rollout-2026-09-21T12-31-33-${ACTIVE_ID}_${RESUMED_ID}.jsonl`);
    await writeFile(canonical, line(sessionMeta(ACTIVE_ID)) + line(responseMessage(now - 60 * 3600_000)));
    const read = createSessionActivityReader(root);
    assert.equal((await read([ACTIVE_ID])).lastMessages[ACTIVE_ID], now - 60 * 3600_000);

    const resumedContents = line(sessionMeta(ACTIVE_ID)) + line(eventMessage(now - 10 * 60_000));
    await writeFile(resumed, resumedContents);
    const alias = join(directory, `rollout-2026-09-21T12-31-34-${ACTIVE_ID}_${RESUMED_ID}.jsonl`);
    try { await link(resumed, alias); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
        t.diagnostic(`Hard links unavailable (${error.code}); skipped hard-link assertion.`);
      } else throw error;
      }
    await new Promise(resolve => setTimeout(resolve, 1_100));
    assert.deepEqual(await read([ACTIVE_ID]), { lastMessages: { [ACTIVE_ID]: now - 10 * 60_000 }, warning: null });
  });
});

test('ignores later tool and metadata records when finding last message', async () => {
  await withCodexHome(async root => {
    const directory = join(root, 'sessions');
    await mkdir(directory, { recursive: true });
    const now = Date.now();
    const records = [
      responseMessage(now - 60 * 3600_000, 'user'),
      { type: 'response_item', timestamp: new Date(now - 1_000).toISOString(), payload: { type: 'custom_tool_call' } },
      { type: 'event_msg', timestamp: new Date(now).toISOString(), payload: { type: 'token_count' } },
    ];
    await writeFile(join(directory, `rollout-test-${ACTIVE_ID}.jsonl`), records.map(line).join(''));
    const result = await createSessionActivityReader(root)([ACTIVE_ID]);
    assert.deepEqual(result, { lastMessages: { [ACTIVE_ID]: now - 60 * 3600_000 }, warning: null });
  });
});

test('accepts legacy event_msg message markers', async () => {
  await withCodexHome(async root => {
    const directory = join(root, 'sessions');
    await mkdir(directory, { recursive: true });
    const now = Date.now();
    await writeFile(join(directory, `rollout-test-${ARCHIVED_ID}.jsonl`), line(eventMessage(now - 3_600_000, 'agent_message')));
    const result = await createSessionActivityReader(root)([ARCHIVED_ID]);
    assert.deepEqual(result, { lastMessages: { [ARCHIVED_ID]: now - 3_600_000 }, warning: null });
  });
});

test('re-reads a cached tail after append', async () => {
  await withCodexHome(async root => {
    const directory = join(root, 'sessions');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `rollout-test-${ACTIVE_ID}.jsonl`);
    const now = Date.now();
    await writeFile(path, line(responseMessage(now - 70 * 3600_000)));
    const read = createSessionActivityReader(root);
    assert.equal((await read([ACTIVE_ID])).lastMessages[ACTIVE_ID], now - 70 * 3600_000);

    await writeFile(path, line(responseMessage(now - 20 * 60_000)), { flag: 'a' });
    const result = await read([ACTIVE_ID]);
    assert.deepEqual(result, { lastMessages: { [ACTIVE_ID]: now - 20 * 60_000 }, warning: null });
  });
});

test('parses a valid record after a large line crosses a tail chunk boundary', async () => {
  await withCodexHome(async root => {
    const directory = join(root, 'sessions');
    await mkdir(directory, { recursive: true });
    const now = Date.now();
    const bigMetadataLine = JSON.stringify({ type: 'diagnostic_metadata', padding: 'x'.repeat(128 * 1024) }) + '\n';
    const path = join(directory, `rollout-test-${ACTIVE_ID}.jsonl`);
    await writeFile(path, line(responseMessage(now - 2 * 3600_000, 'user')) + bigMetadataLine);
    const result = await createSessionActivityReader(root)([ACTIVE_ID]);
    assert.deepEqual(result, { lastMessages: { [ACTIVE_ID]: now - 2 * 3600_000 }, warning: null });
  });
});

test('omits a session with an incomplete trailing record, then refreshes when it completes', async () => {
  await withCodexHome(async root => {
    const directory = join(root, 'sessions');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `rollout-test-${ACTIVE_ID}.jsonl`);
    const now = Date.now();
    const full = JSON.stringify(responseMessage(now - 30 * 60_000));
    await writeFile(path, line(responseMessage(now - 80 * 3600_000)) + full.slice(0, -10));
    const read = createSessionActivityReader(root);
    assert.deepEqual(await read([ACTIVE_ID]), { lastMessages: {}, warning: WARNING });

    await writeFile(path, `${full.slice(-10)}\n`, { flag: 'a' });
    assert.deepEqual(await read([ACTIVE_ID]), { lastMessages: { [ACTIVE_ID]: now - 30 * 60_000 }, warning: null });
  });
});

test('invalid or future message timestamps suppress a potentially false Legacy result', async () => {
  await withCodexHome(async root => {
    const directory = join(root, 'sessions');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `rollout-test-${ACTIVE_ID}.jsonl`);
    const now = Date.now();
    await writeFile(path, line(responseMessage(now - 90 * 3600_000, 'user')) + line({
      type: 'response_item', timestamp: 'not-a-timestamp', payload: { type: 'message', role: 'assistant' },
    }));
    const read = createSessionActivityReader(root);
    assert.deepEqual(await read([ACTIVE_ID]), { lastMessages: {}, warning: WARNING });

    await writeFile(path, line({
      type: 'response_item', timestamp: new Date(Date.now() + 60_000).toISOString(), payload: { type: 'message', role: 'assistant' },
    }));
    assert.deepEqual(await read([ACTIVE_ID]), { lastMessages: {}, warning: WARNING });
  });
});

test('detects truncation and inode replacement instead of keeping cached activity', async () => {
  await withCodexHome(async root => {
    const directory = join(root, 'sessions');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `rollout-test-${ACTIVE_ID}.jsonl`);
    const now = Date.now();
    await writeFile(path, line(responseMessage(now - 100 * 3600_000)));
    const read = createSessionActivityReader(root);
    assert.equal((await read([ACTIVE_ID])).lastMessages[ACTIVE_ID], now - 100 * 3600_000);

    await writeFile(path, line(responseMessage(now - 3 * 3600_000)), { flag: 'w' });
    assert.equal((await read([ACTIVE_ID])).lastMessages[ACTIVE_ID], now - 3 * 3600_000);

    const replacement = join(directory, 'replacement.jsonl');
    await writeFile(replacement, line(responseMessage(now - 30 * 60_000)));
    await rename(replacement, path);
    assert.equal((await read([ACTIVE_ID])).lastMessages[ACTIVE_ID], now - 30 * 60_000);
  });
});

test('refreshes the index when a rollout moves from active to archived storage', async () => {
  await withCodexHome(async root => {
    const active = join(root, 'sessions', '2026', '10');
    const archived = join(root, 'archived_sessions', '2026', '10');
    await mkdir(active, { recursive: true });
    await mkdir(archived, { recursive: true });
    const filename = `rollout-moved-${ACTIVE_ID}.jsonl`;
    const source = join(active, filename);
    const destination = join(archived, filename);
    const now = Date.now();
    await writeFile(source, line(responseMessage(now - 55 * 3600_000)));
    const read = createSessionActivityReader(root);
    assert.equal((await read([ACTIVE_ID])).lastMessages[ACTIVE_ID], now - 55 * 3600_000);

    await rename(source, destination);
    assert.equal((await read([ACTIVE_ID])).lastMessages[ACTIVE_ID], now - 55 * 3600_000);
  });
});

test('ignores symlinked files and directories; rescans when an ID is unknown', async () => {
  await withCodexHome(async root => {
    const sessions = join(root, 'sessions');
    const outside = join(root, 'outside');
    const outsideNested = join(outside, 'nested');
    await mkdir(sessions, { recursive: true });
    await mkdir(outsideNested, { recursive: true });
    const outsideFile = join(outsideNested, `rollout-outside-${ACTIVE_ID}.jsonl`);
    await writeFile(outsideFile, line(responseMessage(Date.now() - 2 * 3600_000)));
    try {
      await symlink(outsideFile, join(sessions, `rollout-link-${ACTIVE_ID}.jsonl`));
      await symlink(outsideFile, join(sessions, `rollout-2026-09-21T12-31-33-${ACTIVE_ID}_${RESUMED_ID}.jsonl`));
      await symlink(outsideNested, join(sessions, 'linked-dir'));
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    }

    const read = createSessionActivityReader(root);
    assert.deepEqual(await read([ACTIVE_ID]), { lastMessages: {}, warning: null });

    await writeFile(join(sessions, `rollout-new-${ARCHIVED_ID}.jsonl`), line(eventMessage(Date.now() - 5 * 60_000)));
    await new Promise(resolve => setTimeout(resolve, 1_010));
    assert.ok((await read([ARCHIVED_ID])).lastMessages[ARCHIVED_ID]);
  });
});

test('omits an ID when any matching rollout cannot be resolved', async () => {
  await withCodexHome(async root => {
    const active = join(root, 'sessions');
    const archived = join(root, 'archived_sessions');
    await mkdir(active, { recursive: true });
    await mkdir(archived, { recursive: true });
    const now = Date.now();
    await writeFile(join(active, `rollout-valid-${ACTIVE_ID}.jsonl`), line(responseMessage(now - 4 * 3600_000)));
    await writeFile(join(archived, `rollout-partial-${ACTIVE_ID}.jsonl`), line(responseMessage(now - 2 * 3600_000)).slice(0, -3));
    assert.deepEqual(await createSessionActivityReader(root)([ACTIVE_ID]), { lastMessages: {}, warning: WARNING });
  });
});
