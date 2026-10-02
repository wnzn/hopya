import { Node, mergeAttributes } from '@tiptap/core';
import { isSafeImageUrl } from '../lib/images';

// Inline atom preserves images in paragraphs, lists and quotes without adding
// a package or widening the Markdown/HTML content contract.
export const RichTextImage = Node.create({
  name: 'image', inline: true, group: 'inline', atom: true, draggable: true,
  addAttributes() { return { src: { default: null }, alt: { default: '' } }; },
  parseHTML() {
    return [{ tag: 'img[src]', getAttrs: element => isSafeImageUrl(element.getAttribute('src') ?? '') ? {} : false }];
  },
  renderHTML({ HTMLAttributes }) {
    if (!isSafeImageUrl(String(HTMLAttributes.src ?? ''))) return ['span', {}, String(HTMLAttributes.alt ?? 'Unsupported image')];
    return ['img', mergeAttributes(HTMLAttributes, { loading: 'lazy', decoding: 'async', class: 'rich-text-image' })];
  },
});
