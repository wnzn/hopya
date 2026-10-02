// Draft contents stay in this tab, scoped by account/workspace and resource.
// Memory also protects SPA close/reopen when browser storage is unavailable;
// that fallback cannot survive reload, so failures and unload risk stay explicit.
const memory = new Map<string, string>();
const volatile = new Set<string>();
let guardingUnload = false;
export function readTextDraft(key: string): string | null {
  if (memory.has(key)) return memory.get(key) || null;
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(key); } catch { return null; }
}
export function writeTextDraft(key: string, value: string): boolean {
  memory.set(key, value);
  if (!guardingUnload && typeof window !== 'undefined') {
    guardingUnload = true;
    window.addEventListener('beforeunload', event => { if (volatile.size) event.preventDefault(); });
  }
  if (value) volatile.add(key); else volatile.delete(key);
  try {
    if (typeof sessionStorage === 'undefined') return false;
    if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key);
    volatile.delete(key);
    return true;
  } catch { return false; }
}
