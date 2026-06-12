# Total Diagnostic Audit: PWA Estimate Submission Workflow

## 1. Request Lifecycle Verification Checklist

To pinpoint the exact point of interception where the PWA's fetch request fails to reach the Cloud Function, we must trace the request path systematically:

- [ ] **PWA / Browser Level (Pre-Flight & Service Worker):**
  - Is the Angular Service Worker (`ngsw-worker.js`) attempting to serve the POST request from a stale cache, or mistakenly blocking it due to its configuration? (Note: `ngsw-config.json` has a `lookup-tables-freshness` data group capturing `https://*.cloudfunctions.net/**`).
  - Is the browser blocking the request before it leaves the client due to CORS policies?
  - Does the Network tab show the request status as `(blocked:other)` or `(failed)` without a corresponding HTTP status code?

- [ ] **Network / Routing Level (Direct vs. Proxy):**
  - The request is currently targeting the Cloud Function directly (e.g., `https://us-central1-trm-mobile-7aa17.cloudfunctions.net/apiV2/estimate/submit`).
  - Does this direct invocation trigger an OPTIONS pre-flight request? If so, does the Cloud Function respond successfully to the OPTIONS request?
  - Is Firebase Hosting's rewriting mechanism bypassed entirely because the PWA is not sending the request to the origin host (`web.app` / `firebaseapp.com` with a `/api/...` path)?

- [ ] **Cloud Function Level (Middleware & Express):**
  - Once the request actually reaches the Cloud Function platform, does it hit the `app.use((req, res, next) => { ... })` DEBUG-REQUEST middleware?
  - Are there any middleware configurations (e.g., `express.json({ limit: '50mb' })`) that might throw an unhandled exception before the request reaches the endpoint route handlers if the payload is malformed or exceeds the limit?

## 2. Endpoint Validation Findings

The root cause of the missing logs and request failure lies in a mismatch between how the environment targets the backend and how Firebase Hosting is configured to route traffic.

- **Current PWA Target:** In `src/environments/environment.prod.ts`, `apiUrl` is hardcoded to `https://us-central1-trm-mobile-7aa17.cloudfunctions.net/apiV2`.
- **Firebase Hosting Configuration:** The `firebase.json` defines rewrites for `source: "/api/**"` to `function: "apiV2"`.
- **The Issue:** Because the PWA hardcodes the direct `.cloudfunctions.net` URL, it completely bypasses the Firebase Hosting proxy (which handles custom domains, CORS simplifications, and rewrites).
- **Endpoint Structure:** Furthermore, inside `functions/index.js`, the Express app maps `app.post('/api/estimate/submit', ...)`. When the PWA sends a request to `.../apiV2/estimate/submit`, the Express router might not match the path correctly depending on how the `apiV2` function strips prefixes, leading to a 404 or unhandled route, which is why the endpoint logic is never triggered.

## 3. Payload Audit & Atomic Transaction Restructuring

Upon verifying that the request reaches the function (after routing fixes), we observed the current architecture for handling the estimate submission:

- **Current Architecture (`/api/estimate/submit`):**
  1. The endpoint instantly returns a `202 Accepted` response.
  2. It triggers `generateAndSendEmail(submissionData)` via an un-awaited background Promise.

- **The Problem:** This design violates the principle of an Atomic Transaction. The database writes (Quickbase mutations) and PDF generation/email dispatch occur completely independently and entirely disconnected from the original HTTP request lifecycle. If Quickbase writes fail or Quickbase rate limits the request, the user has already received a success message, leading to a 'partial success' state where the frontend believes the submission worked, but no data was saved.

- **Restructuring Strategy (The Atomic Transaction):**
  To prevent partial success states, the execution flow must be restructured:
  1. **Synchronous Validation & Database Writes:** The endpoint (`handleSubmitEstimateData` or similar logic) must first `await` all Quickbase database mutations (Service Orders, Line Items, Roofs).
  2. **Database Failure Handling:** If *any* database write fails, the function must catch the error and immediately return a `500` or `502` error to the PWA *before* initiating PDF generation.
  3. **Asynchronous Background Tasks:** Only *after* all Quickbase writes are confirmed successful should the function return a `200 OK` to the PWA. The PDF generation and Email dispatch can then be spawned as un-awaited background tasks (`generateAndDispatchPDF`), ensuring the frontend doesn't timeout waiting for Puppeteer, but guaranteeing that emails are only sent for successfully recorded transactions.

  *(Note: The current `handleSubmitEstimateData` in `index.js` already attempts this atomic pattern, but the PWA is targeting a duplicate wrapper `/api/estimate/submit` that implements the flawed 202-first pattern. Both endpoints need consolidation.)*
