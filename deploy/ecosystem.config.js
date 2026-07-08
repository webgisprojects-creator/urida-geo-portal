// PM2 process manifest for the URIDA Geo Portal backend.
//
// Usage on the production app server (APP_SERVER_IP):
//   pm2 start deploy/ecosystem.config.js
//   pm2 save
//
// Notes:
//   - cwd is the deploy target. Adjust if you deploy somewhere other than /srv/urida/current.
//   - Real secrets (DB_PASS, JWT_SECRET, GEOSERVER_PROXY_TARGET, etc.) live in
//     server/.env on the production server, NOT in this file.
//   - Cluster mode ("max" = one worker per CPU core, confirmed 8 vCPUs on
//     the production app server) replaces the single-process setup after a
//     200-concurrent-user load test showed event-loop lag climbing to
//     ~180ms under load with only 1 process — 7 of 8 cores sat unused the
//     whole time. server/src/app.js and server/src/utils/concurrencyLimiter.js
//     both read PM2's per-worker env vars (NODE_APP_INSTANCE, instances) to
//     keep the cache warmer/eviction sweep running in exactly one worker
//     and to divide the GeoServer/basemap concurrency caps across however
//     many workers PM2 actually starts — confirmed locally against a real
//     PM2 cluster before this went in, not assumed.

module.exports = {
  apps: [
    {
      name: "urida-backend",
      script: "./server/src/server.js",
      cwd: "/srv/urida/current",
      instances: "max",
      exec_mode: "cluster",
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: 8060,
        HOST: "127.0.0.1"
      }
    }
  ]
};
