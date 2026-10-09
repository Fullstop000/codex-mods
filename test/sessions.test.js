import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionSizes } from '../src/sessions.js';

const ACTIVE_ID = '01234567-89ab-cdef-0123-456789abcdef';
const ARCHIVED_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

async function withCodexHome(run) {
  const root = await mkdtemp(join(tmpdir(), 'codex-session-sizes-'));
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('reads active and archived rollout file sizes recursively without reading contents', async () => {
  await withCodexHome(async root => {
    const active = join(root, 'sessions', '2026', '10');
    const archived = join(root, 'archived_sessions', 'nested');
    await mkdir(active, { recursive: true });
    await mkdir(archived, { recursive: true });
    await writeFile(join(active, `rollout-2026-10-09T00-00-${ACTIVE_ID}.jsonl`), 'active');
    await writeFile(join(active, `rollout-2026-10-09T01-00-${ACTIVE_ID}.jsonl`), 'another');
    await writeFile(join(archived, `rollout-2026-10-08T00-00-${ARCHIVED_ID}.jsonl`), 'archived');

    const result = await readSessionSizes(root);
    assert.deepEqual(result, {
      sizes: { [ACTIVE_ID]: 13, [ARCHIVED_ID]: 8 },
      warning: null,
    });
  });
});

test('refresh reflects file growth and deletion', async () => {
  await withCodexHome(async root => {
    const directory = join(root, 'sessions');
    await mkdir(directory);
    const first = join(directory, `rollout-first-${ACTIVE_ID}.jsonl`);
    const second = join(directory, `rollout-second-${ACTIVE_ID}.jsonl`);
    await writeFile(first, 'one');
    await writeFile(second, 'two');
    assert.equal((await readSessionSizes(root)).sizes[ACTIVE_ID], 6);

    await writeFile(first, 'one grew');
    assert.equal((await readSessionSizes(root)).sizes[ACTIVE_ID], 11);
    await unlink(second);
    assert.equal((await readSessionSizes(root)).sizes[ACTIVE_ID], 8);
    await unlink(first);
    assert.equal((await readSessionSizes(root)).sizes[ACTIVE_ID], undefined);
  });
});

test('ignores malformed names, unrelated files, and symlinks', async () => {
  await withCodexHome(async root => {
    const directory = join(root, 'sessions');
    const outside = join(root, 'outside');
    await mkdir(directory);
    await mkdir(outside);
    await writeFile(join(directory, `rollout-valid-${ACTIVE_ID}.jsonl`), 'ok');
    await writeFile(join(directory, 'rollout-nope.jsonl'), 'ignore');
    await writeFile(join(directory, `other-${ARCHIVED_ID}.jsonl`), 'ignore');
    await writeFile(join(directory, `rollout-bad-${ARCHIVED_ID}-extra.jsonl`), 'ignore');
    await writeFile(join(outside, `rollout-linked-${ARCHIVED_ID}.jsonl`), 'outside');
    try {
      await symlink(outside, join(directory, 'linked-directory'));
      await symlink(join(outside, `rollout-linked-${ARCHIVED_ID}.jsonl`), join(directory, `rollout-file-link-${ARCHIVED_ID}.jsonl`));
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    }

    const result = await readSessionSizes(root);
    assert.deepEqual(result, { sizes: { [ACTIVE_ID]: 2 }, warning: null });
  });
});

test('counts a hard-linked file once for one session when supported', async t => {
  await withCodexHome(async root => {
    const directory = join(root, 'sessions');
    await mkdir(directory);
    const original = join(directory, `rollout-original-${ACTIVE_ID}.jsonl`);
    const alias = join(directory, `rollout-alias-${ACTIVE_ID}.jsonl`);
    await writeFile(original, 'shared');
    try { await link(original, alias); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
        t.diagnostic(`Hard links unavailable (${error.code}); skipped hard-link assertion.`);
        return;
      }
      throw error;
    }
    assert.equal((await readSessionSizes(root)).sizes[ACTIVE_ID], 6);
  });
});

test('missing active and archived directories are normal', async () => {
  await withCodexHome(async root => {
    assert.deepEqual(await readSessionSizes(root), { sizes: {}, warning: null });
  });
});
