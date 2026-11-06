# Automatic Chrome Web Store publishing

Pushing a stable `vX.Y.Z` tag runs `.github/workflows/release.yml`:

1. Verify the tag and extension versions, run lint and all tests, build the ZIP.
2. Attach the ZIP to the GitHub Release and retain a workflow artifact.
3. If configured below, upload that same ZIP through Chrome Web Store API v2,
   wait for processing, and submit with `DEFAULT_PUBLISH`.
4. Google reviews the submission and publishes it after approval. A green
   workflow means the submission was accepted, not that review has finished.

Store listing, privacy declarations and visibility must already be configured in
the Developer Dashboard. The API preserves the dashboard's visibility and rollout
settings. A failed upload never triggers a publish request. Submission errors fail
the Web Store job; the GitHub Release and its ZIP remain available.

## One-time account setup

Authentication uses GitHub OIDC and a Google Cloud service account through
Workload Identity Federation. No JSON private key or refresh token is stored in
GitHub. Use a Google Cloud project you control and an account allowed to configure
IAM. Replace `YOUR_PROJECT_ID` below. The remaining commands target this repository.

```sh
export CWS_PROJECT_ID='YOUR_PROJECT_ID'
export CWS_REPOSITORY='battlecook/omni-viewer-chrome'
export CWS_SERVICE_ACCOUNT="chrome-webstore-publisher@${CWS_PROJECT_ID}.iam.gserviceaccount.com"

gcloud services enable chromewebstore.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  --project="$CWS_PROJECT_ID"

gcloud iam service-accounts create chrome-webstore-publisher \
  --project="$CWS_PROJECT_ID" --display-name='Chrome Web Store publisher'

gcloud iam workload-identity-pools create chrome-webstore-github \
  --project="$CWS_PROJECT_ID" --location=global --display-name='Chrome Web Store GitHub'

gcloud iam workload-identity-pools providers create-oidc github \
  --project="$CWS_PROJECT_ID" --location=global \
  --workload-identity-pool=chrome-webstore-github \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping='google.subject=assertion.sub,attribute.repository=assertion.repository' \
  --attribute-condition="assertion.repository == '${CWS_REPOSITORY}' && (assertion.ref.startsWith('refs/tags/v') || assertion.ref == 'refs/heads/main')"

export CWS_POOL_NAME="$(gcloud iam workload-identity-pools describe chrome-webstore-github \
  --project="$CWS_PROJECT_ID" --location=global --format='value(name)')"

gcloud iam service-accounts add-iam-policy-binding "$CWS_SERVICE_ACCOUNT" \
  --project="$CWS_PROJECT_ID" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/${CWS_POOL_NAME}/attribute.repository/${CWS_REPOSITORY}"

export CWS_PROVIDER_NAME="$(gcloud iam workload-identity-pools providers describe github \
  --project="$CWS_PROJECT_ID" --location=global \
  --workload-identity-pool=chrome-webstore-github --format='value(name)')"
```

In the Chrome Web Store Developer Dashboard, select the publisher that owns Omni
Viewer and add the service account email under **Publisher → Settings → Service
account** (older dashboard versions call this Account). The dashboard allows
one service account per publisher; check an existing association before replacing
it. This grants the account permission to manage the publisher's extensions.

The **Publisher ID** from **Publisher → Settings** is
`c8024f02-85df-4419-bf6e-730a78625160`. It is separate from the extension ID in
the public store URL, `mbhllahknhjahklfinmbnmdlpeommegd`.

## Repository variables

Under GitHub **Settings → Secrets and variables → Actions → Variables**, set:

| Variable | Value |
| --- | --- |
| `CWS_EXTENSION_ID` | `mbhllahknhjahklfinmbnmdlpeommegd` |
| `CWS_PUBLISHER_ID` | `c8024f02-85df-4419-bf6e-730a78625160` |
| `CWS_SERVICE_ACCOUNT` | Service account email registered in the dashboard |
| `CWS_WORKLOAD_IDENTITY_PROVIDER` | `projects/NUMBER/locations/global/workloadIdentityPools/chrome-webstore-github/providers/github` |
| `CWS_PUBLISH_ENABLED` | `true`, after the account and federation are ready |

You can register the federation values from the same shell:

```sh
gh variable set CWS_SERVICE_ACCOUNT --body "$CWS_SERVICE_ACCOUNT" --repo "$CWS_REPOSITORY"
gh variable set CWS_WORKLOAD_IDENTITY_PROVIDER --body "$CWS_PROVIDER_NAME" --repo "$CWS_REPOSITORY"
```

Until `CWS_PUBLISH_ENABLED=true`, tag pushes still create the ZIP and GitHub
Release, with an explicit workflow summary explaining that store submission is
disabled. When enabled, any missing configuration fails the Web Store job.

## Releases and retries

For each release, update `CHANGELOG.md`, `package.json`, `package-lock.json` and
`manifest.json`, commit, push main, and push the matching `vX.Y.Z` tag. Tags must
include this workflow change for automatic store submission.

To submit an existing tag, or retry after fixing setup, select **Actions → Release
Chrome Extension → Run workflow**, use branch `main`, and enter the existing tag.
This rebuilds and tests that tag; publisher code comes from the workflow's commit
so tags created before the automation can also be submitted. It requires no new
version bump solely for retrying a failed submission. Do not rerun a version
already published or under review: first check its dashboard status. Do not move
or recreate existing release tags.

Only one upload/submission runs at a time. Avoid queuing multiple releases while
one is pending: GitHub concurrency retains only one pending job. For listing or
visibility changes that require dashboard action, resolve them there before
retrying.

Publisher tests run without credentials or network access:

```sh
node --test scripts/__tests__/publish-webstore.test.mjs
```

References: [Chrome Web Store API](https://developer.chrome.com/docs/webstore/using-api),
[service accounts](https://developer.chrome.com/docs/webstore/service-accounts),
[publish API](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish),
[GitHub authentication action](https://github.com/google-github-actions/auth).
