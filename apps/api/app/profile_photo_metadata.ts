import { db } from './database.js'

export function profilePhotoUrl(userId: string | null, revision?: string | null): string | null {
  return userId && revision ? `/api/v1/users/${encodeURIComponent(userId)}/photo?v=${encodeURIComponent(revision)}` : null
}

export async function profilePhotoMetadata(userId: string): Promise<{ photoUrl: string | null }> {
  const photo = await db.get<{ revision: string }>('SELECT revision FROM profile_photos WHERE userId=?', userId)
  return { photoUrl: profilePhotoUrl(userId, photo?.revision) }
}
