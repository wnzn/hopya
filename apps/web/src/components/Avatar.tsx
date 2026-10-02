import { useState } from "react";
import "../styles/profile-photos.css";

export default function Avatar({ name, photoUrl, className = "", label }: {
  name?: string;
  photoUrl?: string | null;
  className?: string;
  label?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  // Only the authenticated local photo endpoint can supply avatar images.
  const source = photoUrl && /^\/api\/v1\/users\/[a-f0-9-]{36}\/photo\?v=[a-f0-9-]{36}$/i.test(photoUrl) && photoUrl !== failedUrl ? photoUrl : null;
  const initial = Array.from(name?.trim() || "?")[0]!.toLocaleUpperCase();
  return <span className={`avatar profile-avatar ${className}`.trim()} role={label ? "img" : undefined}
    aria-label={label} aria-hidden={label ? undefined : true}>
    {source ? <img key={source} src={source} alt="" decoding="async" onError={() => setFailedUrl(source)} /> : initial}
  </span>;
}
