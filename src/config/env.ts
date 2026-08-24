import 'dotenv/config';
import path from 'path';
import fs from 'fs';

const serviceAccountPath = path.resolve(__dirname, '../../serviceAccountKey.json');

// Cloud Run always sets K_SERVICE. There, Firebase Admin uses Application
// Default Credentials via the attached runtime service account instead of a
// key file — nothing to bake into the image. Locally we still require the
// key file for a clear, fast failure instead of a confusing ADC error.
const isCloudRun = !!process.env.K_SERVICE;

if (!isCloudRun && !fs.existsSync(serviceAccountPath)) {
  throw new Error(
    `Missing ${serviceAccountPath}. Download it from Firebase Console > Project Settings > ` +
      `Service Accounts > Generate new private key, and save it there.`,
  );
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  serviceAccountPath,
  hasServiceAccountFile: fs.existsSync(serviceAccountPath),
};
