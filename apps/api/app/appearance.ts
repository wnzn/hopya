import { z } from 'zod'

// Shared by every hierarchy resource; persisted values are catalog IDs, never markup.
export const nodeIcon = z.enum(['diamond', 'briefcase', 'target', 'home', 'star', 'heart', 'globe', 'clock', 'mapPin', 'settings', 'lock', 'users', 'user', 'folder', 'archive', 'bookmark', 'list', 'checklist', 'calendar', 'flag', 'package', 'shoppingBag', 'fileText', 'inbox', 'trash', 'pencil', 'eye', 'eyeOff', 'sparkles', 'code', 'link', 'comment', 'save'])
const legacyNodeColors = {
  slate: '#64748b', orange: '#c45d0a', amber: '#9a7411', green: '#4d7a47',
  teal: '#17776f', blue: '#2563a6', violet: '#7652a8', rose: '#a5415b',
} as const
export const nodeColor = z.union([
  z.string().regex(/^#[0-9a-fA-F]{6}$/).transform((value) => value.toLowerCase()),
  z.enum(['slate', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'rose']).transform((value) => legacyNodeColors[value]),
])
export type NodeIcon = z.infer<typeof nodeIcon>
