import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImageUploadQueue } from './image-upload-queue';
import type { UploadedImage } from './images';
import { readTextDraft, writeTextDraft } from './text-drafts';

// Distinct failure protected: a failed/pending clipboard File must survive
// closing its composer, and a late response must not resurrect a removed image.
test('image queue retains retry files and completed uploads across composer subscriptions', async () => {
  let rejectUpload: (error: Error) => void = () => {};
  let resolveUpload: (image: UploadedImage) => void = () => {};
  let attempts = 0;
  const queue = new ImageUploadQueue(() => {
    attempts++;
    return new Promise<UploadedImage>((resolve, reject) => { resolveUpload = resolve; rejectUpload = reject; });
  });
  const file = new File(['bytes retained'], 'clipboard.png', { type: 'image/png' });
  const target = { workspaceId: 'workspace', kind: 'task-body' as const };
  const image = { id: 'id', name: file.name, url: '/private-image', downloadUrl: '/download', expiresAt: 'later' };
  let notifications = 0;
  const unsubscribe = queue.subscribe(() => { notifications++; });
  queue.add([file], target);
  unsubscribe();
  rejectUpload(new Error('offline'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queue.jobs[0].state, 'failed');
  assert.equal(queue.jobs[0].file, file);
  assert.equal(queue.jobs[0].error, 'offline');
  const retry = queue.upload(queue.jobs[0], target);
  resolveUpload(image); await retry;
  assert.equal(queue.jobs[0].state, 'ready');
  assert.equal(queue.jobs[0].image, image);
  queue.insertionFailed(queue.jobs[0].id);
  await queue.upload(queue.jobs[0], target);
  assert.equal(attempts, 2, 'Retrying an insertion reuses uploaded bytes');
  queue.remove(queue.jobs[0].id);
  queue.add([file], target);
  queue.remove(queue.jobs[0].id);
  resolveUpload(image);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queue.jobs.length, 0);
  assert.ok(notifications > 0);
});

test('denied browser storage retains a text/image-reference draft for SPA recovery and honors explicit clearing', (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('Storage denied'); } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  });
  const key = 'test:account:workspace:resource';
  const draft = 'Keep text and ![image](/private-image)';
  assert.equal(writeTextDraft(key, draft), false);
  assert.equal(readTextDraft(key), draft);
  assert.equal(readTextDraft(`${key}:another-user`), null);
  assert.equal(writeTextDraft(key, ''), false);
  assert.equal(readTextDraft(key), null);
});
