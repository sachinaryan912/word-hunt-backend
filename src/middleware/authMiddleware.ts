import { Request, Response, NextFunction } from 'express';
import { auth } from '../lib/firebase';

export interface AuthedRequest extends Request {
  uid?: string;
}

export async function authMiddleware(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing_token' });
    return;
  }
  const idToken = header.slice('Bearer '.length);
  try {
    const decoded = await auth.verifyIdToken(idToken);
    req.uid = decoded.uid;
    next();
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
}

export async function verifySocketToken(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  try {
    const decoded = await auth.verifyIdToken(token);
    return decoded.uid;
  } catch {
    return null;
  }
}
