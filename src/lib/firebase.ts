import { initializeApp, cert, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { env } from '../config/env';

// Local dev: explicit service-account key file. Cloud Run (and any other GCP
// runtime): Application Default Credentials via the attached service account.
initializeApp({
  credential: env.hasServiceAccountFile ? cert(env.serviceAccountPath) : applicationDefault(),
});

export const db = getFirestore();
export const auth = getAuth();
