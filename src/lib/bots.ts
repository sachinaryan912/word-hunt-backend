import { randomUUID } from 'crypto';
import { QueueEntry } from '../types';

const BOT_NAMES = [
  'Aarav Sharma', 'Priya Patel', 'Rohan Mehta', 'Ananya Iyer', 'Vikram Nair',
  'Sneha Reddy', 'Karan Malhotra', 'Divya Menon', 'Arjun Rao', 'Ishita Gupta',
  'Aditya Verma', 'Kavya Pillai', 'Rahul Joshi', 'Neha Kapoor', 'Siddharth Chatterjee',
  'Meera Krishnan', 'Varun Desai', 'Pooja Bhatt', 'Aryan Kulkarni', 'Riya Bansal',
  'Nikhil Agarwal', 'Tanvi Rathore', 'Kabir Singh', 'Anjali Chauhan', 'Dev Thakur',
  'Simran Kaur', 'Manish Yadav', 'Naina Bhalla', 'Yash Trivedi', 'Ritika Saxena',
  'Harsh Vardhan', 'Snehal Ghosh', 'Rajat Khanna', 'Bhavya Suri', 'Amit Dubey',
  'Shreya Nambiar', 'Gaurav Sethi', 'Lavanya Pandey', 'Om Prakash', 'Isha Chowdhury',
];

const RATING_JITTER = 80;
const MIN_BOT_RATING = 600;

/** A synthetic uid that can never collide with a real Firebase uid, so
 * every code path that touches Firestore for match players can cheaply
 * check `uid.startsWith('bot-')` if it ever needs to special-case one. */
export function isBotUid(uid: string): boolean {
  return uid.startsWith('bot-');
}

/** Builds a one-off bot opponent rated close to the waiting player, so the
 * match feels evenly matched instead of obviously synthetic. */
export function makeBotEntry(nearRating: number): QueueEntry {
  const jitter = Math.round((Math.random() - 0.5) * 2 * RATING_JITTER);
  const name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
  return {
    uid: `bot-${randomUUID()}`,
    displayName: name,
    rating: Math.max(MIN_BOT_RATING, nearRating + jitter),
    socketId: '',
    joinedAt: Date.now(),
    isBot: true,
  };
}
