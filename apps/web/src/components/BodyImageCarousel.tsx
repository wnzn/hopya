import { useEffect, useState } from 'react';
import { bodyImages } from '../lib/rich-text';
import type { BodyImage } from '../lib/images';
import SolidIcon from './SolidIcon';
import '../styles/body-images.css';

function GalleryImage({ image, onOpen, title, onRetry }: { image: BodyImage; onOpen: () => void; title: string; onRetry: () => void }) {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  return <>
    <button type="button" className="gallery-image-open" onClick={onOpen} aria-label={`Open task: ${title}`}>
      <img src={image.src} alt={image.alt || 'Task body image'} loading="lazy" decoding="async"
        onLoad={() => setState('loaded')} onError={() => setState('failed')} hidden={state === 'failed'} />
    </button>
    {state !== 'loaded' && <span className="gallery-image-state" role="status">{state === 'failed' ? 'Image unavailable' : 'Loading image…'}</span>}
    {state === 'failed' && <button type="button" className="gallery-image-retry" onClick={onRetry}>Retry image</button>}
  </>;
}

export default function BodyImageCarousel({ description, title, onOpen }: { description: string; title: string; onOpen: () => void }) {
  const images = bodyImages(description);
  const [index, setIndex] = useState(0);
  const [retry, setRetry] = useState(0);
  useEffect(() => { setIndex(0); setRetry(0); }, [description]);
  const position = Math.min(index, Math.max(0, images.length - 1));
  const image = images[position];
  return <div className="task-card-media body-image-carousel" role="group" aria-roledescription={images.length > 1 ? 'carousel' : undefined} aria-label={`${title} body images`}>
    {image ? <GalleryImage key={`${image.src}:${retry}`} image={image} title={title} onOpen={onOpen} onRetry={() => setRetry(value => value + 1)} />
      : <button type="button" className="gallery-image-open gallery-image-empty" onClick={onOpen} aria-label={`Open task: ${title}`}><span>No body images</span></button>}
    {images.length > 1 && <div className="gallery-image-controls">
      <button type="button" aria-label={`Previous body image for ${title}`} disabled={position === 0} onClick={() => setIndex(position - 1)}><SolidIcon name="chevronLeft" /></button>
      <span aria-live="polite" aria-atomic="true">{position + 1} / {images.length}<span className="sr-only">{image?.alt ? `: ${image.alt}` : ''}</span></span>
      <button type="button" aria-label={`Next body image for ${title}`} disabled={position === images.length - 1} onClick={() => setIndex(position + 1)}><SolidIcon name="chevronRight" /></button>
    </div>}
  </div>;
}
