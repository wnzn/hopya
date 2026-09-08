# OpenID Connect SSO

Hopya can connect to a compatible identity provider through OpenID Connect (OIDC). The provider authenticates the user; Hopya keeps its own account, session, workspace membership and role boundaries. SAML is not required when the provider supports OIDC.

Provider behavior and defaults vary. Test the exact provider version, client configuration and HTTPS topology used by the deployment.

## Provider Requirements

The provider must supply standards-compliant OIDC discovery and support:

- Authorization Code flow with ID tokens.
- PKCE using `S256`.
- Confidential-client authentication using `client_secret_post`.
- The `openid`, `profile` and `email` scopes.
- Stable `iss` and `sub` claims. Hopya binds identities using the exact `(issuer, subject)` pair.
- A valid email and boolean `email_verified: true` claim when just-in-time provisioning is enabled. The `name` claim is optional.

Production deployments require HTTPS for Hopya, the issuer and every discovered provider endpoint. Keep a tested local Hopya administrator account for recovery.

## Register Hopya

1. Create a confidential OIDC client named `Hopya` in the provider.
2. Set the exact callback URL to:

   ```text
   https://tasks.example.com/api/v1/auth/sso/callback
   ```

3. Enable Authorization Code flow, PKCE S256, and the `openid profile email` scopes.
4. Restrict client access at the provider to the users or groups intended to use Hopya. Prefer an allowlisted group over unrestricted access when the provider supports it.
5. Save the client ID and client secret as operator secrets.

Set `OIDC_ISSUER` to the exact `issuer` value returned by `<issuer>/.well-known/openid-configuration`, not to the discovery-document URL itself. Preserve paths, case and trailing slashes exactly.

## Configure Hopya

Export the provider values before creating or recreating the deployment:

```sh
export APP_URL=https://tasks.example.com
export OIDC_ISSUER=https://id.example.com
export OIDC_CLIENT_ID=<oidc-client-id>
export OIDC_CLIENT_SECRET=<oidc-client-secret>
export OIDC_AUTO_PROVISION=true
export OIDC_ALLOW_INSECURE_HTTP=false
docker compose up -d --build --force-recreate
```

The main Compose file passes these variables only to the API container. Never expose `OIDC_CLIENT_SECRET` through a browser-visible `PUBLIC_*` variable.

Open Hopya's `/login` page and choose **Continue with single sign-on**. A successful first login creates a non-administrator Hopya account only when the provider returns a valid verified email and no Hopya account already has that email. Repeat logins use the stable `(issuer, sub)` binding, not email.

## Grant Access

For a controlled existing user set:

1. Restrict the OIDC client to the intended users or provider group.
2. Enable `OIDC_AUTO_PROVISION=true` and have each user sign in once.
3. Add each resulting Hopya account to the intended workspace and assign its role in Hopya workspace settings.
4. Optionally return `OIDC_AUTO_PROVISION=false` and recreate the API after enrollment. Existing identity bindings continue to work.

Automatic provisioning grants a Hopya account, not membership in an existing workspace and never site-administrator access. Shared workspace access always follows Hopya's membership rules.

If a local Hopya account already has the same email, Hopya rejects automatic linking. In `/admin`, use **OIDC identities** to explicitly bind that account to an independently verified provider issuer and subject. Email alone is not sufficient proof of identity.

## Provider Notes

- Pocket ID is an OIDC provider. Create an OIDC client and configure its **Allowed User Groups**; Pocket ID documents that a new client initially allows no groups. Its issuer is normally its public base URL.
- For identity suites with separate login and authorization services, use the issuer advertised by OIDC discovery, not the account-management URL.
- Other providers should work when their discovery metadata, client authentication, claims and HTTPS behavior meet the requirements above. This is not blanket certification of every provider or configuration.

## Lifecycle Limits

OIDC handles authentication, not directory synchronization. Creating or deleting a provider user does not immediately create, disable or remove the corresponding Hopya account. Hopya does not currently expose a SCIM endpoint.

Removing upstream access blocks future OIDC authorization but does not revoke an already-issued Hopya session. For immediate removal, also remove Hopya workspace memberships or disable the Hopya account. Local logout does not promise provider-wide logout.

Sources:

- [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html)
- [OAuth 2.0 PKCE](https://www.rfc-editor.org/rfc/rfc7636)
- [Pocket ID OIDC client authentication](https://pocket-id.org/docs/guides/oidc-client-authentication)
- [Pocket ID allowed user groups](https://pocket-id.org/docs/configuration/allowed-groups)
