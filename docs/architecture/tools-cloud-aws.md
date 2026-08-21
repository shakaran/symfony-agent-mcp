# Category: cloud-aws

AWS cloud integrations — S3, SES, Cognito, ECS, Lambda/Bref, Parameter Store, Secrets Manager, CloudFront.

[Back to Architecture Documentation](../../ARCHITECTURE.md) | [All Categories](tool-categories.md)

## Tools

### aws-s3-integration

**Source:** `src/tools/aws-s3-integration.ts`
**Functions:** `list_aws_s3_integration`, `get_aws_s3_integration_stats`

AWS S3/compatible object storage integration: `aws/aws-sdk-php`, `league/flysystem-aws-s3-v3`,
`S3Client`; flags public-read ACL, no server-side encryption, presigned URL without expiry.

---

### aws-ses-integration

**Source:** `src/tools/aws-ses-integration.ts`
**Functions:** `list_aws_ses_integration`, `get_aws_ses_integration_stats`

AWS SES integration: `ses+smtp://`/`ses+api://` DSN detection (credentials masked), `AWS_SES_*`
env vars, `SesClient`/`SesV2Client` usage; flags missing bounce/complaint handler, `ses+smtp`
over preferred `ses+api`, hardcoded AWS credentials in PHP.

---

### aws-ecs-config

**Source:** `src/tools/aws-ecs-config.ts`
**Functions:** `list_aws_ecs_config`, `get_aws_ecs_config_stats`

AWS ECS/Fargate task definition analysis: `*task-definition*.json` / `taskdef.json`; container
definitions, cpu/memory; flags hardcoded secrets in `environment[]` instead of `secrets[]` from
SSM, no `healthCheck`, `privileged: true`.

---

### aws-lambda-bref

**Source:** `src/tools/aws-lambda-bref.ts`
**Functions:** `list_aws_lambda_bref`, `get_aws_lambda_bref_stats`

Analyzes AWS Lambda/Bref serverless configuration: bref runtimes, timeout/memory, filesystem
safety (non-writable `/tmp` ephemeral storage), SQS Messenger integration, cold-start
optimizations, missing `serverless.yml` or `template.yaml`.

---

### aws-cognito-integration

**Source:** `src/tools/aws-cognito-integration.ts`
**Functions:** `list_aws_cognito_integration`, `get_aws_cognito_integration_stats`

Detects AWS Cognito user pool integration: JWT token validation missing signature verification
(only decoding claims), `UserPoolId`/`ClientId` in client-side code, missing
`FORCE_CHANGE_PASSWORD` status handling, Cognito User Pool without MFA enforcement for admin
users.

---

### aws-cloudfront-config

**Source:** `src/tools/aws-cloudfront-config.ts`
**Functions:** `list_aws_cloudfront_config`, `get_aws_cloudfront_config_stats`

Detects AWS CloudFront distribution configuration: missing `ViewerCertificate` HTTPS
enforcement, `DefaultCacheBehavior.ViewerProtocolPolicy: allow-all` (serves HTTP), origin
`S3OriginConfig` without Origin Access Identity (bucket publicly readable), missing
`compress: true` for text-based content types.

---

### aws-parameter-store

**Source:** `src/tools/aws-parameter-store.ts`
**Functions:** `list_aws_parameter_store`, `get_aws_parameter_store_stats`

Scans `src/**/*.php`, `config/**/*.yaml`, `.env*` for: `GetParameter` with
`WithDecryption: false` on SecureString; hardcoded parameter names; missing custom KMS key;
path not following `/app/env/param` convention; N individual `GetParameter` calls (use batch);
AWS credentials masked in output.

---

### aws-secrets-manager

**Source:** `src/tools/aws-secrets-manager.ts`
**Functions:** `list_aws_secrets_manager`, `get_aws_secrets_manager_stats`

Scans `src/**/*.php`, `config/**/*.yaml`, `.env*` for: rotation not enabled; `GetSecretValue`
without `VersionStage`; missing `SecretCache`/`SecretsManagerCache` (re-fetches each request);
hardcoded secret ARN; JSON parse without try/catch; AWS credentials masked.
