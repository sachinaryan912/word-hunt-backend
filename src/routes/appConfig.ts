import { Router } from 'express';

// Bump ANDROID_LATEST_VERSION_CODE whenever a new Android build is released
// (must match versionCode / pubspec build number). Raise
// ANDROID_MIN_SUPPORTED_VERSION_CODE only when older builds must be forced to
// update (e.g. a breaking API change) — the client treats that as mandatory.
// Bumping this also triggers a one-time "update available" push to every
// user on the next server boot — see lib/updateNotifier.ts.
export const ANDROID_LATEST_VERSION_CODE = 1;
const ANDROID_MIN_SUPPORTED_VERSION_CODE = 1;
const ANDROID_UPDATE_URL = 'https://play.google.com/store/apps/details?id=com.cluifyy.word_hunting_app';

export const appConfigRouter = Router();

appConfigRouter.get('/', (_req, res) => {
  res.json({
    android: {
      latestVersionCode: ANDROID_LATEST_VERSION_CODE,
      minSupportedVersionCode: ANDROID_MIN_SUPPORTED_VERSION_CODE,
      updateUrl: ANDROID_UPDATE_URL,
    },
  });
});
