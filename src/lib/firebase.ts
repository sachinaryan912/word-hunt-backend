import { initializeApp, cert, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { env } from '../config/env';

// Local dev: explicit service-account key file. Cloud Run (and any other GCP
// runtime): Application Default Credentials via the attached service account.
// projectId is explicit because the Cloud Run *hosting* project is
// deliberately different from the Firebase *data* project — without this,
// ADC would infer the wrong project from the Cloud Run environment.
initializeApp({
  credential: env.hasServiceAccountFile ? cert(env.serviceAccountPath) : applicationDefault(),
  projectId: env.firebaseProjectId,
});

export const db = getFirestore();
export const auth = getAuth();
