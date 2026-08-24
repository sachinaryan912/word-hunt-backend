import { db } from './firebase';

export async function getBlockedUids(uid: string): Promise<Set<string>> {
  const snap = await db.collection('players').doc(uid).collection('blocked').get();
  return new Set(snap.docs.map((d) => d.id));
}
