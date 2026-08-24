# Deploying to Cloud Run

`.github/workflows/deploy-cloudrun.yml` builds the Docker image and deploys it to
Cloud Run on every push to `main`. It's configured to stay cheap:

- **`--min-instances=0`** — scales to zero when idle, so you pay nothing while nobody's playing.
- **`--max-instances=1`** — this isn't just about cost. Match/room/matchmaking state lives in
  the process's memory (`src/socket/state.ts`), so a second concurrent instance would split
  that state and break gameplay. One instance is both the cheapest and the only correct option
  until that state is moved to Redis or similar.
- **`512Mi` / `1 CPU`** — enough for Express + Socket.IO + firebase-admin without paying for
  headroom you don't need.
- Cloud Run's free tier (~180k vCPU-seconds and ~360k GiB-seconds per month, 2M requests) covers
  low-traffic usage entirely — expect close to $0/month until you have real concurrent players.

No secret key is baked into the image: the container authenticates to Firebase using
Application Default Credentials via its attached runtime service account.

## One-time setup

Run this once, e.g. in [Cloud Shell](https://console.cloud.google.com/?cloudshell=true) (no
local `gcloud` install needed). Replace `YOUR_PROJECT_ID` throughout — for this project that's
`word-hunting-game`.

```bash
PROJECT_ID=YOUR_PROJECT_ID
REGION=us-central1

gcloud config set project "$PROJECT_ID"

# 1. Enable the required APIs
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  iam.googleapis.com cloudresourcemanager.googleapis.com

# 2. Artifact Registry repo to hold the built images
gcloud artifacts repositories create word-hunt-backend \
  --repository-format=docker --location="$REGION" \
  --description="Word Hunting backend images"

# 3. Runtime service account — what Cloud Run runs AS. Needs Firebase Admin
#    SDK access (Firestore, Auth, Messaging) and nothing else.
gcloud iam service-accounts create word-hunt-backend-runtime \
  --display-name="Word Hunting backend runtime"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:word-hunt-backend-runtime@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/firebase.admin"

# 4. Deployer service account — what GitHub Actions authenticates AS to push
#    images and deploy. Least-privilege: can push to Artifact Registry,
#    deploy Cloud Run services, and "act as" the runtime SA above.
gcloud iam service-accounts create word-hunt-backend-deployer \
  --display-name="Word Hunting backend GitHub Actions deployer"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:word-hunt-backend-deployer@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/run.admin"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:word-hunt-backend-deployer@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"
gcloud iam service-accounts add-iam-policy-binding \
  "word-hunt-backend-runtime@${PROJECT_ID}.iam.gserviceaccount.com" \
  --member="serviceAccount:word-hunt-backend-deployer@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"

# 5. Key for the deployer SA — this is what goes into the GitHub secret below.
gcloud iam service-accounts keys create deployer-key.json \
  --iam-account="word-hunt-backend-deployer@${PROJECT_ID}.iam.gserviceaccount.com"
cat deployer-key.json   # copy this whole JSON output for the GCP_SA_KEY secret below
```

Then, in the GitHub repo → **Settings → Secrets and variables → Actions**, add:

| Secret | Value |
|---|---|
| `GCP_PROJECT_ID` | `word-hunting-game` |
| `GCP_SA_KEY` | the full JSON printed by the last command above |

Delete `deployer-key.json` locally once it's pasted into the secret — it's a long-lived
credential and shouldn't sit on disk longer than necessary.

Push to `main` and the workflow deploys automatically. The deployed URL is printed at the end
of the run (Actions tab → latest run → "Print service URL" step) — that's what the Flutter app's
`API_BASE_URL` should point to.

## A more secure alternative (optional)

The setup above uses a downloadable JSON key for the deployer service account, which is simple
but is a long-lived secret. [Workload Identity Federation](https://github.com/google-github-actions/auth#setting-up-workload-identity-federation)
lets GitHub Actions authenticate without any stored key at all — worth switching to later if
this becomes more than a side project.
