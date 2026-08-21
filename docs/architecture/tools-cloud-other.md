# Category: cloud-other

Non-AWS cloud platforms — Azure Blob/Pipelines, Google Cloud Run/Storage, Firebase, DigitalOcean, Consul, and deployment platforms.

[Back to Architecture Documentation](../../ARCHITECTURE.md) | [All Categories](tool-categories.md)

## Tools

### azure-pipelines-config

**Source:** `src/tools/azure-pipelines-config.ts`
**Functions:** `list_azure_pipelines_config`, `get_azure_pipelines_config_stats`

Azure DevOps pipeline YAML: `azure-pipelines.yml` / `.azure/pipelines.yml`; trigger, pool,
stages/jobs/steps; flags no trigger branch filter, secrets in variables, no `timeoutInMinutes`.

---

### azure-blob-storage

**Source:** `src/tools/azure-blob-storage.ts`
**Functions:** `list_azure_blob_storage`, `get_azure_blob_storage_stats`

Scans `src/**/*.php`, `composer.json`, `.env*` for: `azure/storage-blob` package detection;
SAS token without expiry; container `PublicAccessType` set to container/blob; connection string
with `AccountKey` (masked); missing retry policy; blob upload without `Content-Type`.

---

### google-cloud-run-config

**Source:** `src/tools/google-cloud-run-config.ts`
**Functions:** `list_google_cloud_run_config`, `get_google_cloud_run_config_stats`

Google Cloud Run YAML service configuration: container image, resources, scaling settings,
env vars, secrets; flags hardcoded secrets in env instead of `secretKeyRef`, missing resource
limits, unauthenticated ingress.

---

### google-cloud-storage

**Source:** `src/tools/google-cloud-storage.ts`
**Functions:** `list_google_cloud_storage`, `get_google_cloud_storage_stats`

Scans `src/**/*.php`, `composer.json` for: `google/cloud-storage` package detection; bucket
`allUsers`/`allAuthenticatedUsers` ACL (public); signed URL TTL exceeding 7 days; HMAC key
without rotation policy; `StorageClient` with hardcoded `keyFilePath`; credentials masked.

---

### firebase-integration

**Source:** `src/tools/firebase-integration.ts`
**Functions:** `list_firebase_integration`, `get_firebase_integration_stats`

Firebase integration patterns: FCM push notifications, Auth, Realtime Database, Firestore,
Storage, service account config; flags hardcoded service account keys, missing token
verification, insecure Firestore/Storage rules patterns.

---

### digitalocean-app-platform

**Source:** `src/tools/digitalocean-app-platform.ts`
**Functions:** `list_digitalocean_app_platform`, `get_digitalocean_app_platform_stats`

DigitalOcean App Platform spec file (`.do/app.yaml`): web/worker/job/static service definitions,
instance size, health checks, routes; flags hardcoded secrets in `envs[]` instead of
scope-bound `SECRET` references, missing health check endpoints.

---

### consul-service-discovery

**Source:** `src/tools/consul-service-discovery.ts`
**Functions:** `list_consul_service_discovery`, `get_consul_service_discovery_stats`

Scans `consul.json`, `consul.hcl`, `docker-compose.yml` for: service registration without
health check; missing `deregister_critical_service_after`; no ACL token; `native_integration`
without sidecar proxy; port `0` without service discovery handling; missing environment `tags:`.

---

### fly-io-config

**Source:** `src/tools/fly-io-config.ts`
**Functions:** `list_fly_io_config`, `get_fly_io_config_stats`

Fly.io deployment configuration: `fly.toml` parsing; app/region/build/http_service/vm sections;
flags missing health checks, no `auto_stop_machines`, hardcoded secrets in `[env]`.

---

### heroku-config

**Source:** `src/tools/heroku-config.ts`
**Functions:** `list_heroku_config`, `get_heroku_config_stats`

Heroku configuration: `Procfile` and `app.json` parsing; web/worker/release dyno types,
buildpacks, env vars; flags no worker for Messenger, missing release phase, addons without plan.

---

### render-deploy-config

**Source:** `src/tools/render-deploy-config.ts`
**Functions:** `list_render_deploy_config`, `get_render_deploy_config_stats`

Render deployment configuration (`render.yaml`): web/worker/cron service types, build/start
commands, health check paths, disk mounts; flags hardcoded credentials in `envVars`, missing
health check path for web services.

---

### netlify-deploy-config

**Source:** `src/tools/netlify-deploy-config.ts`
**Functions:** `list_netlify_deploy_config`, `get_netlify_deploy_config_stats`

Netlify deployment configuration (`netlify.toml`): build command/publish, redirects, security
headers, functions, context-specific env; flags hardcoded secrets in environment sections,
missing security headers (X-Frame-Options, X-Content-Type-Options, CSP, Permissions-Policy),
missing SPA fallback redirect, `force = false` on security paths.

---

### vercel-deploy-config

**Source:** `src/tools/vercel-deploy-config.ts`
**Functions:** `list_vercel_deploy_config`, `get_vercel_deploy_config_stats`

Vercel deployment configuration (`vercel.json`): routes/rewrites/redirects, function timeout and
memory, security headers, env vars; flags hardcoded values in `env`/`build.env` (use
`@variable-name` references instead), missing security headers on wildcard sources, PHP runtime
without version pin.

---

### bitbucket-pipelines-config

**Source:** `src/tools/bitbucket-pipelines-config.ts`
**Functions:** `list_bitbucket_pipelines_config`, `get_bitbucket_pipelines_config_stats`

Bitbucket Pipelines YAML analysis: default/branch/PR pipeline steps classified as
build/test/deploy/security; flags privileged containers, plain-text secrets in scripts, missing
vendor/node caches, missing test step before deploy.

---

### cloudflare-config

**Source:** `src/tools/cloudflare-config.ts`
**Functions:** `list_cloudflare_config`, `get_cloudflare_config_stats`

Cloudflare Workers/Pages configuration: `wrangler.toml` / `wrangler.json`; routes, KV
namespaces, `compatibility_date`; flags outdated `compatibility_date`, secrets in `[vars]`
instead of `wrangler secret`.
