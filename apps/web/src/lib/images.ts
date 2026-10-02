import { api, workspacePath } from './api';

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const imageUrl = new RegExp(`^/api/v1/workspaces/${uuid}/(?:images/${uuid}|items/${uuid}/attachments/${uuid})/inline$`);
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export type BodyImage = { src: string; alt: string };
export type ImageUploadTarget = { workspaceId: string; kind: 'task-body' | 'task-comment' | 'document-comment'; resourceId?: string };
export type UploadedImage = { id: string; url: string; downloadUrl: string; expiresAt: string; name: string };

// Images have a narrower policy than ordinary links: no remote tracking, data,
// blob, SVG, arbitrary same-origin endpoints, query parameters or redirects.
export function isSafeImageUrl(url: string): boolean { return imageUrl.test(url); }
export function imageMarkdown({ src, alt }: BodyImage): string {
  return isSafeImageUrl(src) ? `![${alt.replace(/[\r\n]/g, ' ').replace(/[\\\[\]`*_~]/g, '\\$&')}](${src})` : '';
}
export function decodeImageAlt(alt: string): string { return alt.replace(/\\([\\\[\]`*_~])/g, '$1'); }

export async function uploadBodyImage(target: ImageUploadTarget, file: File): Promise<UploadedImage> {
  if (!file.size || file.size > IMAGE_MAX_BYTES) throw new Error('Choose an image no larger than 10 MiB.');
  if (!IMAGE_ACCEPT.split(',').includes(file.type)) throw new Error('Choose a PNG, JPEG, GIF, or WebP image.');
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read the image. Your file is kept for retry.'));
    reader.readAsDataURL(file);
  });
  return api<UploadedImage>(`${workspacePath(target.workspaceId)}/images`, 'POST', {
    kind: target.kind, ...(target.resourceId ? { resourceId: target.resourceId } : {}),
    name: file.name || 'Pasted image.png', contentType: file.type, data,
  });
}
