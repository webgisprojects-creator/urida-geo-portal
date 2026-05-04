# What fixed the recurring public tunnel outage

## Problem summary

The PM2 process for the public tunnel was showing as running, but the public URL was intermittently returning:

```textp
503 Service Unavailable
x-localtunnel-status: Tunnel Unavailable
```

This means the tunnel process existed, but the tunnel provider was not actually carrying traffic.

## Root cause

The main cause was that the project was relying on `localtunnel`, which is an external public tunnel service and was failing upstream.

Evidence collected from the machine:

```text
Error: connection refused: localtunnel.me:19017 (check your firewall settings)
Error: connection refused: localtunnel.me:15985 (check your firewall settings)
Error: connection refused: localtunnel.me:32789 (check your firewall settings)
Error: connection refused: localtunnel.me:8655 (check your firewall settings)
Error: connection refused: localtunnel.me:8023 (check your firewall settings)
Error: connection refused: localtunnel.me:24897 (check your firewall settings)
Error: connection refused: localtunnel.me:25335 (check your firewall settings)
Error: connection refused: localtunnel.me:30537 (check your firewall settings)
Error: connection refused: localtunnel.me:25109 (check your firewall settings)
```

At the same time, the app itself was healthy locally:

```text
curl -I http://127.0.0.1:8060
HTTP/1.1 200 OK
```

But the public tunnel URL was not healthy:

```text
curl -I https://prod-uridageo-rsac.loca.lt
HTTP/1.1 503 Service Unavailable
x-localtunnel-status: Tunnel Unavailable
```

This proves the issue was not the app. The issue was the tunnel layer.

## Secondary weakness found

The old PM2 tunnel config was tunneling to port `80`:

```javascript
{
  name: "urida-localtunnel",
  script: "/usr/bin/lt",
  args: "--port 80 --subdomain prod-uridageo-rsac"
}
```

That added unnecessary dependency on nginx and redirect behavior. Since the Node app already serves the built client directly on `8060`, tunneling directly to `8060` is more stable and removes one extra moving part.

## What I changed

I updated [ecosystem.config.js](file:///var/www/urida_prod/ecosystem.config.js) so that:

1. The PM2 tunnel now targets port `8060` directly.
2. The PM2 tunnel prefers `ngrok` if `NGROK_AUTHTOKEN` is available.
3. If ngrok is not configured yet, it falls back to `localtunnel`.
4. The tunnel settings are now controlled through PM2 environment variables.

New behavior:

```javascript
{
  name: "urida-localtunnel",
  script: "/bin/bash",
  args: [
    "-lc",
    "if [ -n \"$NGROK_AUTHTOKEN\" ]; then /usr/local/bin/ngrok config add-authtoken \"$NGROK_AUTHTOKEN\" >/dev/null 2>&1 || true; if [ -n \"$NGROK_DOMAIN\" ]; then exec /usr/local/bin/ngrok http --domain \"$NGROK_DOMAIN\" \"$TUNNEL_PORT\"; else exec /usr/local/bin/ngrok http \"$TUNNEL_PORT\"; fi; else exec /usr/bin/lt --port \"$TUNNEL_PORT\" --subdomain \"$TUNNEL_SUBDOMAIN\"; fi"
  ],
  env: {
    TUNNEL_PORT: 8060,
    TUNNEL_SUBDOMAIN: "prod-uridageo-rsac",
    NGROK_AUTHTOKEN: "",
    NGROK_DOMAIN: ""
  }
}
```

## Why this helps

- Direct tunnel to `8060` removes nginx as a dependency for the public tunnel.
- PM2 is now ready to use `ngrok`, which is more reliable than `localtunnel`.
- The recurring outage itself was caused by `localtunnel.me` refusing tunnel connections, so moving away from localtunnel is the real long-term fix.

## Important finding about ngrok on this machine

`ngrok` is already installed:

```text
ngrok version 3.36.1
```

But it is not configured with an authtoken yet:

```text
ERROR: authentication failed: Usage of ngrok requires a verified account and authtoken.
ERROR: ERR_NGROK_4018
```

So the permanent fix is:

1. Add the ngrok authtoken.
2. Restart the PM2 tunnel process.

## Permanent fix steps

If you have an ngrok account token:

```bash
export NGROK_AUTHTOKEN="your_token_here"
pm2 startOrRestart /var/www/urida_prod/ecosystem.config.js --only urida-localtunnel --update-env
pm2 logs urida-localtunnel --lines 30
```

If you also have a reserved ngrok domain:

```bash
export NGROK_AUTHTOKEN="your_token_here"
export NGROK_DOMAIN="your-domain.ngrok-free.app"
pm2 startOrRestart /var/www/urida_prod/ecosystem.config.js --only urida-localtunnel --update-env
```

If `NGROK_DOMAIN` is not provided, ngrok will still work with a random public URL after the authtoken is set.

## Verification performed

### 1. Confirmed the PM2 tunnel process exists

Checked `pm2 list` and `pm2 logs urida-localtunnel`.

### 2. Confirmed local app is healthy

```bash
curl -I http://127.0.0.1:8060
```

Result:

```text
HTTP/1.1 200 OK
```

### 3. Confirmed public localtunnel URL is unhealthy

```bash
curl -I https://prod-uridageo-rsac.loca.lt
```

Result:

```text
HTTP/1.1 503 Service Unavailable
x-localtunnel-status: Tunnel Unavailable
```

### 4. Confirmed ngrok is installed but not authenticated

```bash
ngrok version
ngrok config check
```

Result:

```text
ngrok version 3.36.1
ERROR: authentication failed
ERROR: ERR_NGROK_4018
```

## Final conclusion

The recurring outage is not a PM2 failure and not an application failure.

The recurring outage is caused by dependence on `localtunnel`, whose upstream service is intermittently unavailable from this machine.

The configuration is now improved so the tunnel goes directly to port `8060` and is ready to switch to `ngrok`, which is the proper long-term fix for preventing this from repeating.

## Immediate stable access available now

The application itself is already reachable directly on the server without using localtunnel:

```bash
curl -kI https://162.245.218.6
```

Result:

```text
HTTP/1.1 200 OK
```

And the login endpoint is reachable directly too:

```bash
curl -k -X POST -H 'Content-Type: application/json' \
  -d '{"username":"x","password":"y"}' \
  https://162.245.218.6/api/auth/login
```

Result:

```text
{"success":false,"message":"Invalid credentials"}
```

That confirms the stable part of the system is the server itself, not the tunnel.

## Recommended usage

- Do not rely on `https://prod-uridageo-rsac.loca.lt` for production or regular public access.
- Use direct server access until proper DNS and SSL are finalized.
- Best permanent setup is:
  - map a real DNS name to `162.245.218.6`
  - install a valid SSL certificate for that DNS name
  - stop using `localtunnel` entirely

## Login issue on direct IP over HTTPS

When the site is opened as:

```text
https://162.245.218.6
```

the homepage may load after a browser warning, but login can still show:

```text
⚠️ Server not reachable.
```

Reason:

- the server certificate is self-signed / not valid for this IP
- direct HTTPS requests to the IP fail certificate validation
- that causes browser-side `fetch('/api/auth/login')` to fail as a network error

Evidence:

```bash
curl -I https://162.245.218.6
```

Result:

```text
curl: (60) SSL certificate problem: self-signed certificate
```

## Working direct URL

The backend is publicly reachable on plain HTTP port `8060` and the login API works there:

```bash
curl -I http://162.245.218.6:8060
curl -X POST -H 'Content-Type: application/json' \
  -d '{"username":"x","password":"y"}' \
  http://162.245.218.6:8060/api/auth/login
```

Result:

```text
HTTP/1.1 200 OK
{"success":false,"message":"Invalid credentials"}
```

That proves the login route is reachable. The failure is the HTTPS certificate on IP access, not the login backend itself.

## Use this URL now

Use:

```text
http://162.245.218.6:8060
```

Do not use:

```text
https://162.245.218.6
```

unless a valid certificate is installed for a real DNS hostname.
