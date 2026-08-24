# Deploying to Cloud Run

`.github/workflows/deploy-cloudrun.yml` builds the Docker image and deploys it to
Cloud Run whenever `master` is updated (merge your PRs from `main` into `master`
to trigger a deploy). It's configured to stay cheap while still being correct:

- **`--min-instances=1`** — one instance stays warm at all times, so Socket.IO connections never
  hit a cold start. This costs a small constant amount (very roughly $10-15/month for 512Mi/1
  vCPU running continuously) rather than the near-$0 you'd get from `--min-instances=0` (scale to
  zero when idle). Chosen deliberately over the cheaper default — change it back to `0` if
  occasional multi-second cold starts on the first connection after idle are acceptable.
- **`--max-instances=1`** — this one is not a cost knob, it's a correctness requirement. Match/
  room/matchmaking state lives in the process's memory (`src/socket/state.ts`), so a second
  concurrent instance would have its own disconnected copy of that state and silently break
  matches, queue entries, and room codes. Keep this at `1` until that state is moved to Redis or
  similar — do not raise it without doing that migration first.
- **`512Mi` / `1 CPU`** — enough for Express + Socket.IO + firebase-admin without paying for
  headroom you don't need.

No secret key is baked into the image: the container authenticates to Firebase using
Application Default Credentials via its attached runtime service account.

## Two GCP projects, on purpose

Cloud Run hosting lives in **`word-hunt-506509`**. The actual Firebase data (Firestore, Auth,
FCM) lives in the separate **`word-hunting-game`** project. That means the runtime service
account — which exists in `word-hunt-506509` — needs its `roles/firebase.admin` grant made
**on `word-hunting-game`**, a cross-project IAM binding, not on its own project. The app also
sets `projectId` explicitly in `src/lib/firebase.ts` (via the `FIREBASE_PROJECT_ID` env var) so
Application Default Credentials don't default to inferring `word-hunt-506509` from the Cloud Run
environment.

## One-time setup

Run this once, e.g. in [Cloud Shell](https://console.cloud.google.com/?cloudshell=true) (no
local `gcloud` install needed).

```bash
HOST_PROJECT_ID=word-hunt-506509      # where Cloud Run/Artifact Registry/service accounts live
FIREBASE_PROJECT_ID=word-hunting-game # where Firestore/Auth/FCM data lives
REGION=us-central1

gcloud config set project "$HOST_PROJECT_ID"

# 1. Enable the required APIs on the hosting project
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  iam.googleapis.com cloudresourcemanager.googleapis.com

# 2. Artifact Registry repo to hold the built images
gcloud artifacts repositories create word-hunt-backend \
  --repository-format=docker --location="$REGION" \
  --description="Word Hunting backend images"

# 3. Runtime service account — what Cloud Run runs AS. Lives in the host
#    project, but its Firebase Admin SDK access is granted on the *Firebase*
#    project (cross-project binding — this is the part that's easy to miss).
gcloud iam service-accounts create word-hunt-backend-runtime \
  --project="$HOST_PROJECT_ID" \
  --display-name="Word Hunting backend runtime"
gcloud projects add-iam-policy-binding "$FIREBASE_PROJECT_ID" \
  --member="serviceAccount:word-hunt-backend-runtime@${HOST_PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/firebase.admin"

# 4. Deployer service account — what GitHub Actions authenticates AS to push
#    images and deploy. Least-privilege: can push to Artifact Registry,
#    deploy Cloud Run services, and "act as" the runtime SA above. All of
#    this is scoped to the host project.
gcloud iam service-accounts create word-hunt-backend-deployer \
  --project="$HOST_PROJECT_ID" \
  --display-name="Word Hunting backend GitHub Actions deployer"
gcloud projects add-iam-policy-binding "$HOST_PROJECT_ID" \
  --member="serviceAccount:word-hunt-backend-deployer@${HOST_PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/run.admin"
gcloud projects add-iam-policy-binding "$HOST_PROJECT_ID" \
  --member="serviceAccount:word-hunt-backend-deployer@${HOST_PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"
gcloud iam service-accounts add-iam-policy-binding \
  "word-hunt-backend-runtime@${HOST_PROJECT_ID}.iam.gserviceaccount.com" \
  --member="serviceAccount:word-hunt-backend-deployer@${HOST_PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"

# 5. Key for the deployer SA — this is what goes into the GCP_SA_KEY secret.
gcloud iam service-accounts keys create deployer-key.json \
  --iam-account="word-hunt-backend-deployer@${HOST_PROJECT_ID}.iam.gserviceaccount.com"
cat deployer-key.json
```

GitHub repo secrets (`Settings → Secrets and variables → Actions`) — already set for this repo:

| Secret | Value |
|---|---|
| `GCP_PROJECT_ID` | `word-hunt-506509` (hosting project — Artifact Registry, Cloud Run) |
| `FIREBASE_PROJECT_ID` | `word-hunting-game` (Firebase data project) |
| `GCP_SA_KEY` | the deployer service account's JSON key |

Delete `deployer-key.json` locally once it's pasted into the secret — it's a long-lived
credential and shouldn't sit on disk longer than necessary.

Work happens on `main`; opening a PR from `main` into `master` and merging it triggers the
deploy (the workflow only fires on pushes to `master`, the repo's default branch). The deployed
URL is printed at the end of the run (Actions tab → latest run → "Print service URL" step) —
that's what the Flutter app's `API_BASE_URL` should point to.

## A more secure alternative (optional)

The setup above uses a downloadable JSON key for the deployer service account, which is simple
but is a long-lived secret. [Workload Identity Federation](https://github.com/google-github-actions/auth#setting-up-workload-identity-federation)
lets GitHub Actions authenticate without any stored key at all — worth switching to later if
this becomes more than a side project.
