# Category: security

Security tools — voters, firewalls, authenticators, JWT, OAuth, CSRF, access control, secrets vault, encryption.

[Back to Architecture Documentation](../../ARCHITECTURE.md) | [All Categories](tool-categories.md)

## Tools

### security-voters

**Source:** `src/tools/security-voters.ts`
**Functions:** `list_voters`, `get_voter_stats`

All classes implementing `VoterInterface` or extending `Voter<TAttribute, TSubject>`:
supported attributes, subject type, return value analysis of `voteOnAttribute`. Detects
`ACCESS_ABSTAIN` vs `ACCESS_DENIED` patterns and voters that always abstain (possible
misconfiguration). Warns on voters returning true for all attributes (overly permissive).

---

### symfony-security-custom-voter

**Source:** `src/tools/symfony-security-custom-voter.ts`
**Functions:** (custom voter analysis)

Detects `Voter` subclasses; warns on `supportsAttribute()` always returning `true` (all
attributes allowed — likely wrong), `voteOnAttribute()` missing the subject null check,
`AccessDecisionManager` strategy mismatch.

---

### security-scanner

**Source:** `src/tools/security-scanner.ts`
**Functions:** `scan_security`, `get_security_stats`

Full security audit: SQL injection (Doctrine DBAL raw query `$conn->query(...)` with
concatenated input), XSS (echo of `$_GET`/`$_POST`/`$_REQUEST` in PHP, Twig `{{ var|raw }}`),
CSRF (non-GET routes without `_token` field or `#[IsCsrfTokenValid]`), open redirects
(redirect to `$request->get('url')`), hardcoded secrets (`$secret = 'hardcoded'`).
Severity-labeled findings.

---

### security-firewalls

**Source:** `src/tools/security-firewalls.ts`
**Functions:** `list_firewalls`, `get_firewall_stats`

Reads `security.yaml` firewalls: pattern, authenticators, providers, stateless flag, entry
point, access tokens. Flags: authenticated firewall without entry point, production firewall
with `security: false`, multiple firewalls with overlapping patterns.

---

### symfony-security-passport-badges

**Source:** `src/tools/symfony-security-passport-badges.ts`
**Functions:** `list_passport_badges`, `get_passport_badge_stats`

Reads `Passport` creations in authenticators: `CsrfTokenBadge`, `RememberMeBadge`,
`PasswordUpgradeBadge`, `PreAuthenticatedUserBadge`. Flags: missing CSRF badge on form login,
`RememberMeBadge` without `RememberMeHandler`.

---

### symfony-security-access-control

**Source:** `src/tools/symfony-security-access-control.ts`
**Functions:** `list_access_control_rules`, `get_access_control_stats`

Reads `security.yaml` `access_control` rules: path, roles, ips, methods, host. Detects rules
shadowed by earlier rules (unreachable), `PUBLIC_ACCESS` mixed with role-protected paths,
missing `^/` prefix (pattern never matches), `ROLE_` prefix on custom roles.

---

### symfony-security-access-decision

**Source:** `src/tools/symfony-security-access-decision.ts`
**Functions:** `list_access_decision`, `get_access_decision_stats`

Reads `security.yaml` `access_decision_manager` strategy (affirmative/consensus/unanimous/
priority); warns on `unanimous` without at least 2 voters, `affirmative` with voters that
may conflict.

---

### controller-security

**Source:** `src/tools/controller-security.ts`
**Functions:** `list_controller_security`, `get_controller_security_stats`

Scans all controller classes for `#[IsGranted]`/`$this->denyAccessUnlessGranted()` usage per
action, `#[Security]` expressions, and missing security on non-public routes. Reads
`config/packages/security.yaml` `access_control` for declarative coverage and compares
against discovered routes. Flags actions with no apparent security.

---

### symfony-access-token

**Source:** `src/tools/symfony-access-token.ts`
**Functions:** `list_access_token_config`, `get_access_token_stats`

Symfony 6.2+ API token security: `security.yaml` `access_token:` extractor (header/query/cookie),
token handler service; warns on token in query string (log leakage), missing custom token
handler, no firewall stateless mode with access token.

---

### symfony-security-oidc

**Source:** `src/tools/symfony-security-oidc.ts`
**Functions:** `list_symfony_security_oidc`, `get_symfony_security_oidc_stats`

Symfony 6.3+ OIDC integration: `security.yaml` `oidc:` config, JWK set URL, `claim_matchers`;
warns on `oidc_user_info` without TLS, missing audience validation, insecure key algorithm.

---

### symfony-security-user-providers

**Source:** `src/tools/symfony-security-user-providers.ts`
**Functions:** `list_user_providers`, `get_user_provider_stats`

Reads `security.yaml` `providers:` section: type (entity/memory/ldap/chain/custom), entity
class, property. Scans `src/` for `UserProviderInterface` implementations. Flags: chain
provider with only one sub-provider, entity provider with non-existent class, custom provider
missing `refreshUser()`.

---

### symfony-security-user-checker

**Source:** `src/tools/symfony-security-user-checker.ts`
**Functions:** `list_user_checkers`, `get_user_checker_stats`

Detects `UserCheckerInterface` implementations; warns on user checker not configured in
`security.yaml`, checker allowing banned/deleted users (missing check).

---

### symfony-security-custom-authenticators

**Source:** `src/tools/symfony-security-custom-authenticators.ts`
**Functions:** `list_custom_authenticators`, `get_custom_authenticator_stats`

Reads `security.yaml` custom authenticators. Scans classes implementing
`AuthenticatorInterface` or extending `AbstractAuthenticator`. Reports: `supports()`,
`authenticate()`, `onAuthenticationSuccess()`, `onAuthenticationFailure()`. Warns on
authenticators without failure handler and authenticators missing the `getUser()` step.

---

### symfony-json-login

**Source:** `src/tools/symfony-json-login.ts`
**Functions:** `list_json_login`, `get_json_login_stats`

Reads `security.yaml` `json_login` config: check path, username/password path, success/failure
handlers; warns on missing CSRF protection with JSON login, hardcoded success handler service,
no rate limiter on login endpoint.

---

### symfony-security-login-throttle

**Source:** `src/tools/symfony-security-login-throttle.ts`
**Functions:** `list_login_throttle`, `get_login_throttle_stats`

Reads `security.yaml` `login_throttling` (limiter policy, max\_attempts, interval). Cross-checks
`rate_limiter.yaml` for login-named limiters. Warns on firewall without throttling, interval
under 1 minute, max\_attempts > 10.

---

### symfony-security-ip-access

**Source:** `src/tools/symfony-security-ip-access.ts`
**Functions:** `list_ip_access_rules`, `get_ip_access_stats`

Reads `security.yaml` `access_control` `ips:` lists; warns on private ranges in production
IP allow-list (misconfiguration), `0.0.0.0/0` allow without role restriction, missing
`trusted_proxies` (IP bypass).

---

### symfony-security-brute-force

**Source:** `src/tools/symfony-security-brute-force.ts`
**Functions:** `list_symfony_security_brute_force`, `get_symfony_security_brute_force_stats`

Brute-force protection: `login_throttling` in `security.yaml`, rate limiter on login route,
`MaxLoginAttempts` voter, Symfony Shield bundle; warns on no protection on login endpoint.

---

### symfony-security-impersonation

**Source:** `src/tools/symfony-security-impersonation.ts`
**Functions:** `list_impersonation_config`, `get_impersonation_stats`

Reads `security.yaml` `switch_user:` config: role, parameter; warns on `ROLE_ALLOWED_TO_SWITCH`
granted to too broad a role, switch-user firewall without audit log listener, missing exit
button in impersonation context.

---

### symfony-security-remember-me

**Source:** `src/tools/symfony-security-remember-me.ts`
**Functions:** `list_remember_me_config`, `get_remember_me_stats`

Reads `security.yaml` `remember_me:` (secret, token\_provider, lifetime, `secure`, `httponly`,
`samesite`); warns on secret from insecure source, token stored in cookie only (no DB
provider), lifetime > 30 days.

---

### symfony-security-login-link

**Source:** `src/tools/symfony-security-login-link.ts`
**Functions:** `list_login_link_config`, `get_login_link_stats`

Reads `security.yaml` `login_link:` config: lifetime, max\_uses, signature properties; warns on
missing `max_uses` (link reusable indefinitely), very long lifetime, signature on mutable
properties.

---

### symfony-security-password-upgrade

**Source:** `src/tools/symfony-security-password-upgrade.ts`
**Functions:** `list_password_upgrade`, `get_password_upgrade_stats`

Detects `PasswordAuthenticatedUserInterface` + `PasswordUpgraderInterface` pair; reads
`PasswordUpgradeBadge` in authenticator; warns on missing `PasswordUpgradeBadge`, user entity
not implementing `PasswordUpgraderInterface`.

---

### symfony-security-session-strategy

**Source:** `src/tools/symfony-security-session-strategy.ts`
**Functions:** `list_session_strategy`, `get_session_strategy_stats`

Reads `security.yaml` `session_fixation_strategy`: `migrate` (recommended) vs `invalidate` vs
`none`; warns on `none` (session fixation risk), strategy not explicitly configured.

---

### symfony-session-security

**Source:** `src/tools/symfony-session-security.ts`
**Functions:** `list_session_security`, `get_session_security_stats`

Reads `framework.session`: `cookie_secure`, `cookie_httponly`, `cookie_samesite`, session name;
warns on missing `__Host-` prefix for session cookie, `cookie_samesite: none` without `secure`.

---

### password-hashers

**Source:** `src/tools/password-hashers.ts`
**Functions:** `list_password_hashers`, `get_password_hasher_stats`

Reads `security.yaml` `password_hashers:` for all user classes. Reports algorithm,
`migrate_from` chain, memory cost and time cost for `sodium`/`bcrypt`/`argon2i`/`argon2id`.
Warns on MD5/SHA1/SHA256/plaintext hashers, missing `migrate_from` when upgrading, custom
hasher without correct `NeedsRehashPasswordHasherInterface`.

---

### symfony-password-migrator

**Source:** `src/tools/symfony-password-migrator.ts`
**Functions:** `list_password_migrator`, `get_password_migrator_stats`

Reads `security.yaml` `password_hashers[*].migrate_from`; warns on incomplete migration chain,
deprecated hasher still listed without transition plan.

---

### symfony-password-strength

**Source:** `src/tools/symfony-password-strength.ts`
**Functions:** `list_password_strength`, `get_password_strength_stats`

Reads `#[Assert\PasswordStrength]` usage; detects `zxcvbn` integration; warns on missing
strength check on registration/password-change forms, low `minScore`.

---

### symfony-trusted-proxies

**Source:** `src/tools/symfony-trusted-proxies.ts`
**Functions:** `list_trusted_proxies`, `get_trusted_proxy_stats`

Reads `framework.yaml` `trusted_proxies` and `trusted_headers`; warns on `*` wildcard
(all IPs trusted — IP spoofing), `X-Forwarded-For` trusted without proxy validation,
missing `REMOTE_ADDR` in trusted header list for load-balanced setup.

---

### symfony-security-scanner

**Source:** `src/tools/symfony-security-scanner.ts`
**Functions:** `scan_security`, `get_security_scan_stats`

Advanced security pattern scanner: checks for SQL injection patterns in Doctrine DQL/native
queries, open redirect via `$request->get()`, TOCTOU file access, hardcoded credentials,
`eval()` usage, `unserialize()` on user input, `preg_replace('/e')` modifier (RCE).

---

### symfony-openssl-patterns

**Source:** `src/tools/symfony-openssl-patterns.ts`
**Functions:** `list_openssl_patterns`, `get_openssl_pattern_stats`

Scans `openssl_*` function calls; warns on `openssl_encrypt` without AEAD mode, ECB mode,
key not from env, IV not random, result not authenticated (MAC).

---

### symfony-sodium-crypto

**Source:** `src/tools/symfony-sodium-crypto.ts`
**Functions:** `list_sodium_crypto`, `get_sodium_crypto_stats`

Detects `sodium_crypto_*` usage: `secretbox`, `aead_chacha20poly1305`, `box`; warns on
`sodium_crypto_secretbox` without unique nonce, key hardcoded.

---

### symfony-pcre-security

**Source:** `src/tools/symfony-pcre-security.ts`
**Functions:** `list_pcre_security`, `get_pcre_security_stats`

Scans `preg_match`/`preg_replace` calls; warns on `/e` modifier (RCE), unanchored pattern
with `*` (ReDoS candidate), user-controlled pattern (ReDoS / RCE via injection).

---

### symfony-random-security

**Source:** `src/tools/symfony-random-security.ts`
**Functions:** `list_random_security`, `get_random_security_stats`

Detects `rand()`/`mt_rand()`/`uniqid()` usage in security contexts (token generation, CSRF,
nonces); warns on weak randomness, `uniqid()` without `more_entropy`, missing
`random_bytes()`/`random_int()` replacement.

---

### symfony-hash-algorithm-security

**Source:** `src/tools/symfony-hash-algorithm-security.ts`
**Functions:** (hash algorithm audit)

Detects `hash()` calls with insecure algorithms (`md5`, `sha1`, `crc32`); warns when used
for password hashing, token generation, or integrity checks; flags `hash_equals()` not used
for comparison (timing attack).

---

### symfony-csrf

**Source:** `src/tools/symfony-csrf.ts`
**Functions:** `list_csrf_config`, `get_csrf_stats`

Reads `framework.csrf_protection` status. Scans forms for `_token` field absence and
`#[IsCsrfTokenValid]` attribute on action methods. Detects stateless API firewalls that may
still have CSRF enabled. Reports controllers using `isCsrfTokenValid()` manually.

---

### cookie-security

**Source:** `src/tools/cookie-security.ts`
**Functions:** `list_cookie_config`, `get_cookie_security_stats`

Scans `Response::headers->setCookie()` calls; reports cookie `Secure`, `HttpOnly`,
`SameSite`, `Domain`, `Path`, `Expires` values. Flags: missing `Secure`, missing `HttpOnly`,
`SameSite=None` without `Secure`, wildcard `Domain` (e.g. `.example.com`).

---

### http-security-headers

**Source:** `src/tools/http-security-headers.ts`
**Functions:** `list_security_headers`, `get_security_header_stats`

Detects `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`
headers in nginx config, Symfony `NelmioSecurityBundle`, or Symfony Kernel event listeners.

---

### csp-config

**Source:** `src/tools/csp-config.ts`
**Functions:** `list_csp_config`, `get_csp_stats`

Reads `nelmio_security.yaml` `csp:` block (report-only vs enforce, enabled directives,
nonce/hash usage). Scans `Response` objects for manual `Content-Security-Policy` headers.
Flags: missing `default-src`, `unsafe-inline` in `script-src`, `unsafe-eval` in `script-src`,
wildcard `*` in any directive, missing `report-uri`/`report-to`.

---

### permissions-policy

**Source:** `src/tools/permissions-policy.ts`
**Functions:** `list_permissions_policy`, `get_permissions_policy_stats`

Detects `Permissions-Policy` header configuration in nginx/NelmioSecurityBundle; warns on
`camera=*`, `microphone=*`, `geolocation=*` allowed without explicit need, `payment=*`
wildcard.

---

### symfony-n-plus-1-queries

**Source:** `src/tools/symfony-n-plus-1-queries.ts`
**Functions:** `list_n_plus_1_queries`, `get_n_plus_1_query_stats`

Detects N+1 query patterns: `LAZY` association fetched inside loop, missing `fetch: 'EAGER'`
or `JOIN FETCH` in collection query, `forEach` over collection with sub-query per item.

---

### symfony-security-firewalls

**Source:** `src/tools/symfony-security-firewalls.ts`
**Functions:** `list_firewalls`, `get_firewall_stats`

Deep firewall inspection beyond `security-firewalls.ts`: `access_denied_handler`,
`switch_user`, `logout` path and invalidate session, cookie clearing.

---

### symfony-api-security-audit

**Source:** `src/tools/symfony-api-security-audit.ts`
**Functions:** `list_api_security_audit`, `get_api_security_audit_stats`

Reads `security.yaml` firewalls and `access_control`; warns on API paths without rate
limiting, API without CORS policy, public write endpoints, missing JWT validation chain.

---

### symfony-file-upload-validation

**Source:** `src/tools/symfony-file-upload-validation.ts`
**Functions:** (file upload security analysis)

Detects file upload handling: `UploadedFile::getClientMimeType()` used for validation (bypass
risk — use `getMimeType()` with magic bytes), missing `#[Assert\File(maxSize:...)]` constraint,
upload stored in publicly accessible directory, no filename sanitization before storage.

---

### symfony-null-byte-injection

**Source:** `src/tools/symfony-null-byte-injection.ts`
**Functions:** (null byte injection audit)

Detects null byte injection risk: `strstr($input, "\0")` not called before filesystem
operations, `str_contains($path, "\x00")` missing, user input used in `file_get_contents()`/
`fopen()` without sanitization.

---

### symfony-template-injection

**Source:** `src/tools/symfony-template-injection.ts`
**Functions:** (template injection audit)

Detects server-side template injection risks: `$twig->render($userInput)` (template name from
user), `$twig->createTemplate($userInput)` (template content from user); warns on any dynamic
template name derived from request parameters.

---

### symfony-object-injection

**Source:** `src/tools/symfony-object-injection.ts`
**Functions:** (object injection audit)

Detects PHP object injection risks: `unserialize()` on untrusted input without allowlisted
classes, `allowed_classes` set to `true` or `false` (all/no), user-controlled data in
`unserialize()`. Suggests `JsonSerializable` or `symfony/serializer` as alternatives.

---

### symfony-deserialization-gadget

**Source:** `src/tools/symfony-deserialization-gadget.ts`
**Functions:** (deserialization gadget audit)

Detects gadget chain risks: classes with `__wakeup()` or `__unserialize()` that invoke
dangerous operations (file write, shell execution, URL fetch); warns when such classes exist
alongside `unserialize()` usage anywhere in the codebase.

---

### symfony-command-injection

**Source:** `src/tools/symfony-command-injection.ts`
**Functions:** (command injection audit)

Detects command injection risks: `exec()`/`shell_exec()`/`system()`/`passthru()` with
user-controlled arguments, `Process::fromShellCommandline()` (shell injection via arguments),
backtick operator `` ` `` with variables. Warns on missing `escapeshellarg()`.

---

### symfony-ssrf-patterns

**Source:** `src/tools/symfony-ssrf-patterns.ts`
**Functions:** (SSRF vulnerability audit)

Detects SSRF vulnerability patterns: `HttpClient::request()` with URL from user input without
host allowlist, `file_get_contents()` with user-controlled URL, redirect to user-supplied URL
without origin validation.

---

### symfony-open-redirect

**Source:** `src/tools/symfony-open-redirect.ts`
**Functions:** (open redirect audit)

Detects open redirect patterns: `return new RedirectResponse($request->get('redirect'))`,
`$this->redirect($request->query->get('next'))`, redirect URL not validated against allowlist
or same-origin check.

---

### symfony-xss-patterns

**Source:** `src/tools/symfony-xss-patterns.ts`
**Functions:** (XSS vulnerability audit)

Detects XSS patterns: `{{ variable|raw }}` in Twig templates, `echo $request->get(...)` in PHP,
`innerHTML` with server-side data in JS; warns on `raw` filter on user-controlled variables.

---

### symfony-timing-attack

**Source:** `src/tools/symfony-timing-attack.ts`
**Functions:** (timing attack audit)

Detects timing attack vulnerabilities: `==` comparison on secrets/tokens/hashes instead of
`hash_equals()`, `strcmp()` for token comparison, early return on password comparison.

---

### symfony-security-audit-log

**Source:** `src/tools/symfony-security-audit-log.ts`
**Functions:** `list_symfony_security_audit_log`, `get_symfony_security_audit_log_stats`

Reads Monolog `security` channel config, `AuthenticationEvents::AUTHENTICATION_SUCCESS`/
`FAILURE` listener, `SwitchUserEvent` listener; warns on no security channel configured,
failed auth not logged, impersonation without audit.

---

### symfony-api-key-rotation

**Source:** `src/tools/symfony-api-key-rotation.ts`
**Functions:** `list_symfony_api_key_rotation`, `get_symfony_api_key_rotation_stats`

Detects API key rotation patterns: multiple `*_KEY` env vars with version suffix (`API_KEY_V2`),
key rotation event listener, `secrets:set` rotation schedule in Makefile/CI; warns on single
API key without rotation policy.

---

### symfony-jwt-auth

**Source:** `src/tools/symfony-jwt-auth.ts`
**Functions:** `list_jwt_config`, `get_jwt_stats`

Reads `lexik_jwt_authentication.yaml`: `secret_key`, `public_key`, `pass_phrase` (presence
only), `token_ttl`, `clock_skew`; detects `JWTTokenManagerInterface` usage; warns when TTL
exceeds 1 hour, RS256 not used, secret key committed.

---

### symfony-security-two-factor

**Source:** `src/tools/symfony-security-two-factor.ts`
**Functions:** `list_two_factor_config`, `get_two_factor_stats`

Reads `scheb/2fa-bundle` configuration: `google`, `email`, `totp` authenticator, trusted
device TTL, backup codes provider, IP whitelist. Scans `src/Security/` for
`TwoFactorInterface`/`BackupCodeInterface`. Flags missing backup codes and trusted IP bypass.

---

### symfony-security-ip-whitelist

**Source:** `src/tools/symfony-security-ip-whitelist.ts`
**Functions:** `list_ip_whitelist`, `get_ip_whitelist_stats`

Reads `access_control` rules with `ips:` and `ROLE_` combination; warns on private subnet
in production IP allow-list, missing `X-Forwarded-For` trusted proxy config.

---

### symfony-output-buffering

**Source:** `src/tools/symfony-output-buffering.ts`
**Functions:** (output buffering audit)

Detects `ob_start()`/`ob_end_clean()`/`ob_get_contents()` usage in controllers; warns on
output buffering used to capture response (use `StreamedResponse` instead), nested buffering
without cleanup, buffering inside listeners.

---

### symfony-file-inclusion-security

**Source:** `src/tools/symfony-file-inclusion-security.ts`
**Functions:** (file inclusion security audit)

Detects LFI/RFI risks: `require`/`include`/`require_once`/`include_once` with variable paths
not resolved through a static mapping, user input in path components without real-path
canonicalization and allowlist check.

---

### symfony-integer-overflow

**Source:** `src/tools/symfony-integer-overflow.ts`
**Functions:** (integer overflow audit)

Detects integer overflow risks in PHP: arithmetic on user-supplied integers without bounds
check, `pack()`/`unpack()` on untrusted data without size validation, array offset from
user input without `is_int()` and range check.

---

### nelmio-security-bundle

**Source:** `src/tools/nelmio-security-bundle.ts`
**Functions:** `list_nelmio_security_config`, `get_nelmio_security_stats`

Full `nelmio_security.yaml` audit: CSP (report-only, directives), `forced_ssl`, `content_type`
nosniff, `clickjacking` (X-Frame-Options), `referrer_policy`, `csp_report_endpoint`.

---

### symfony-expression-language-security

**Source:** `src/tools/symfony-expression-language-security.ts`
**Functions:** (expression language security audit)

Detects expression language security risks: `ExpressionLanguage::evaluate()` with user-supplied
expression string (arbitrary code evaluation), missing allowlist of allowed names/functions.

---

### symfony-resource-leaks

**Source:** `src/tools/symfony-resource-leaks.ts`
**Functions:** (resource leak audit)

Detects PHP resource leaks: `fopen()`/`openssl_pkey_new()`/`curl_init()` without matching
close/free call, stream resources not closed in exception path, `imagecreate()` without
`imagedestroy()`.

---

### symfony-security-voter-workflow

**Source:** `src/tools/symfony-security-voter-workflow.ts`
**Functions:** `list_workflow_guards`, `get_workflow_guard_stats`

Reads `framework.workflows[*].transitions[*].guard` expressions; scans `WorkflowGuardEvent`
listeners; warns on workflow transitions without guard expression, transitions guarded by
`is_granted()` without a voter.

---

### symfony-maintenance-mode

**Source:** `src/tools/symfony-maintenance-mode.ts`
**Functions:** `list_maintenance_mode`, `get_maintenance_mode_stats`

Detects maintenance mode implementation returning `503`; warns on missing `Retry-After` header,
maintenance lock file accessible from web root, maintenance bypassing authenticated users.
