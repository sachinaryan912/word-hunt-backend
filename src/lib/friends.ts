import { db } from './firebase';

export async function getFriendUids(uid: string): Promise<string[]> {
  const snap = await db.collection('players').doc(uid).collection('friends').get();
  return snap.docs.map((d) => d.id);
}

export async function areFriends(a: string, b: string): Promise<boolean> {
  const doc = await db.collection('players').doc(a).collection('friends').doc(b).get();
  return doc.exists;
}

/** Firestore 'in' queries are capped at 30 values — chunk larger lists. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
