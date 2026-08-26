import { db } from './firebase';
import { profileRef } from './profileStore';
import { todayDateKey } from './dailyChallenge';
import { PlayerProfileDoc } from '../types';

export const FREE_ROOMS_PER_DAY = 5;
export const EXTRA_ROOM_COST_XP = 10;

export type RoomReservation = { ok: true; xpCharged: number } | { ok: false; reason: 'insufficient_xp' };

/** Atomically counts this room creation against the daily free limit, charging XP once it's exceeded. */
export async function reserveRoomCreation(uid: string): Promise<RoomReservation> {
  const ref = profileRef(uid);
  const today = todayDateKey();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const profile = snap.data() as PlayerProfileDoc;
    const countToday = profile.roomsCreatedDate === today ? profile.roomsCreatedToday : 0;

    if (countToday < FREE_ROOMS_PER_DAY) {
      tx.update(ref, {
        roomsCreatedDate: today,
        roomsCreatedToday: countToday + 1,
        updatedAt: Date.now(),
      });
      return { ok: true, xpCharged: 0 };
    }

    if (profile.xp < EXTRA_ROOM_COST_XP) {
      return { ok: false, reason: 'insufficient_xp' };
    }

    tx.update(ref, {
      roomsCreatedDate: today,
      roomsCreatedToday: countToday + 1,
      xp: profile.xp - EXTRA_ROOM_COST_XP,
      updatedAt: Date.now(),
    });
    return { ok: true, xpCharged: EXTRA_ROOM_COST_XP };
  });
}

/**
 * Undoes reserveRoomCreation's charge for a room that closed without a guest
 * ever joining — the host backing out (via 'back', leaving, disconnecting,
 * or letting it expire) before anyone showed up shouldn't cost them one of
 * their free rooms for the day or the XP they paid past that limit.
 */
export async function refundRoomCreation(uid: string, xpCharged: number): Promise<void> {
  const ref = profileRef(uid);
  const today = todayDateKey();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const profile = snap.data() as PlayerProfileDoc;
    const update: Record<string, unknown> = { updatedAt: Date.now() };
    if (profile.roomsCreatedDate === today && profile.roomsCreatedToday > 0) {
      update.roomsCreatedToday = profile.roomsCreatedToday - 1;
    }
    if (xpCharged > 0) {
      update.xp = profile.xp + xpCharged;
    }
    tx.update(ref, update);
  });
}
