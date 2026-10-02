import { uploadBodyImage, type ImageUploadTarget, type UploadedImage } from './images';

export type ImageJob = { id: number; file: File; state: 'uploading' | 'failed' | 'ready'; error?: string; image?: UploadedImage };
// Pending File objects live only in this tab's memory. Leaving/reopening an
// editor keeps retries available; beforeunload guards warn before losing them.
const queues = new Map<string, ImageUploadQueue>();
let nextId = 0;
let guardingUnload = false;
export class ImageUploadQueue {
  constructor(private uploader = uploadBodyImage) {}
  jobs: ImageJob[] = [];
  listeners = new Set<() => void>();
  getSnapshot = () => this.jobs;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  emit() { for (const listener of this.listeners) listener(); }
  async upload(job: ImageJob, target: ImageUploadTarget) {
    this.jobs = this.jobs.map(value => value.id === job.id ? { ...value, state: 'uploading', error: undefined } : value); this.emit();
    try {
      const image = job.image ?? await this.uploader(target, job.file);
      this.jobs = this.jobs.map(value => value.id === job.id ? { ...value, state: 'ready', image, error: undefined } : value);
    } catch (error) {
      this.jobs = this.jobs.map(value => value.id === job.id ? { ...value, state: 'failed', error: error instanceof Error ? error.message : 'Image upload failed. Retry or remove it.' } : value);
    }
    this.emit();
  }
  add(files: File[], target: ImageUploadTarget) {
    if (this.jobs.length + files.length > 10) throw new Error('Add at most 10 images at a time. No files from this selection were added.');
    for (const file of files) {
      const job: ImageJob = { id: ++nextId, file, state: 'uploading' };
      this.jobs = [...this.jobs, job];
      void this.upload(job, target);
    }
    this.emit();
  }
  remove(id: number) { this.jobs = this.jobs.filter(job => job.id !== id); this.emit(); }
  insertionFailed(id: number) {
    this.jobs = this.jobs.map(job => job.id === id ? { ...job, state: 'failed', error: 'The image could not fit here. Shorten the body or move the caret into normal text, then retry.' } : job); this.emit();
  }
}
export function imageQueue(key: string) {
  if (!guardingUnload && typeof window !== 'undefined') {
    guardingUnload = true;
    window.addEventListener('beforeunload', event => {
      if ([...queues.values()].some(queue => queue.jobs.length)) event.preventDefault();
    });
  }
  let queue = queues.get(key);
  if (!queue) { queue = new ImageUploadQueue(); queues.set(key, queue); }
  return queue;
}
