// PM2 process manifest for the URIDA Geo Portal backend.
//
// Usage on the production app server (27.100.38.131):
//   pm2 start deploy/ecosystem.config.js
//   pm2 save
//
// Notes:
//   - cwd is the deploy target. Adjust if you deploy somewhere other than /srv/urida/current.
//   - Real secrets (DB_PASS, JWT_SECRET, GEOSERVER_PROXY_TARGET, etc.) live in
//     server/.env on the production server, NOT in this file.

module.exports = {
  apps: [
    {
      name: "urida-backend",
      script: "./server/src/server.js",
      cwd: "/srv/urida/current",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: 8060
      }
    }
  ]
};
