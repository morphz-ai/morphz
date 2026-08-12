---
title: Remote OAuth
description: Complete authorization over SSH, on headless servers, or through a remote Dashboard.
section: guides
order: 210
status: current
---

When the browser and Morphz run on different machines, `localhost` in the browser refers to the client machine—not the Morphz server. The login flow must make that deployment fact explicit.

## Prefer device authorization

When a service supports device authorization, the Dashboard presents a verification URL and short-lived user code:

1. Open the verification URL in any signed-in browser;
2. Enter the user code and approve access;
3. Keep the Morphz login surface open while it waits for confirmation;
4. Persist the account, service, and route only after authorization succeeds.

Device authorization never requires the browser to reach the server’s `localhost`, making it the best fit for SSH and headless systems. Some services require the user or workspace administrator to enable it first; the UI should expose that requirement directly.

## Hand off a browser callback

Some services provide only Authorization Code + PKCE with a loopback callback. In a remote deployment:

1. Start one login in the Dashboard;
2. Complete authorization in the client browser;
3. When the browser reaches `http://localhost:.../callback?code=...&state=...`, do not restart the login even if the page refuses the connection;
4. Copy the complete address-bar URL;
5. Paste it into the original login surface.

The `state` must match the active login. Starting another login creates another state, and an older callback cannot complete the new attempt.

## SSH port forwarding

To let a loopback callback complete automatically, forward the callback port from the client to the Morphz host. Use the port displayed by the login flow.

```bash
ssh -L 1455:127.0.0.1:1455 user@server
```

## Security boundary

- Do not share callback URLs containing `code` and `state`;
- Do not write a durable account before login succeeds;
- Discard temporary state after failure or expiry;
- Store tokens only in the Secret Store, never in Session, Context, or ordinary logs.
