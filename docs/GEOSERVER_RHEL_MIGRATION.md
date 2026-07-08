# GeoServer RHEL Migration Runbook

This is based on the live GeoServer audit from 2026-07-06.

## Current GeoServer Baseline

- Host alias checked: `geoserver`
- OS: Ubuntu 22.04.1 LTS
- Java: OpenJDK 17
- Runtime: Tomcat 9 with `geoserver.service`
- GeoServer WAR: `/var/lib/tomcat9/webapps/geoserver.war`
- GeoServer data directory: `/opt/geoserver/data_dir`
- Data directory size: about `2.9G`
- Published layers: `550`
- Store configs: `71`
- SLD styles: `64`
- GWC cache: almost all of the `2.9G`; `gwc-layers` is about `2.2M`

## Important Finding

The PostGIS stores are configured as `PostGIS (JNDI)`, not direct host/user/password stores. The GeoServer catalog points to:

```text
java:comp/env/jdbc/geoserver
```

So copying only `/opt/geoserver/data_dir` is not enough. The new RHEL server must also have the Tomcat context resource:

```text
/etc/tomcat9/Catalina/localhost/geoserver.xml
```

On RHEL the restore script installs this under:

```text
/var/lib/tomcat/conf/Catalina/localhost/geoserver.xml
```

The audited JNDI URL currently points to:

```text
jdbc:postgresql://27.100.38.132:6432/nv_allnndb_geoserver
```

If the database also moves, override `DB_JDBC_URL`, `DB_USERNAME`, and `DB_PASSWORD` during restore.

## Recommended Migration Flow

1. On the current GeoServer host, create the bundle:

```bash
sudo bash scripts/geoserver-backup-for-rhel.sh
```

By default this includes the GeoWebCache cache. To make a smaller bundle and let RHEL regenerate tiles:

```bash
sudo INCLUDE_GWC_CACHE=0 bash scripts/geoserver-backup-for-rhel.sh
```

2. Copy the resulting tarball and `scripts/geoserver-restore-on-rhel.sh` to the new RHEL server.

3. On the RHEL server, restore it:

```bash
sudo PROXY_BASE_URL='https://NEW_DOMAIN_OR_IP/geoserver' \
  DB_JDBC_URL='jdbc:postgresql://DB_HOST:6432/nv_allnndb_geoserver' \
  DB_USERNAME='DB_USER' \
  DB_PASSWORD='DB_PASSWORD' \
  bash scripts/geoserver-restore-on-rhel.sh /path/to/urida-geoserver-rhel-YYYYmmdd-HHMMSS.tar.gz
```

4. Verify GeoServer:

```bash
systemctl status geoserver.service --no-pager
curl -I http://127.0.0.1:8080/geoserver/web/
curl 'http://127.0.0.1:8080/geoserver/ows?service=WMS&version=1.1.1&request=GetCapabilities' -o /tmp/geoserver-wms.xml
```

5. Verify app-facing layers after the app points to the new server:

```bash
node scripts/test-geoserver-layers.mjs
```

## What Must Move

- GeoServer `data_dir`: catalog, workspaces, layers, styles, security, GWC metadata/cache.
- GeoServer WAR matching the current deployment.
- Tomcat JNDI context for `jdbc/geoserver`.
- Systemd service settings, especially `GEOSERVER_DATA_DIR`, heap size, and `PROXY_BASE_URL`.
- PostgreSQL/PostGIS database if the database host is changing.
- App server `.env` values, especially `GEOSERVER_PROXY_TARGET`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASS`, `JWT_SECRET`, and `CORS_ORIGINS`.
- Nginx reverse proxy/SSL config if the RHEL server is also becoming the public app server.

## Caches

GeoServer GWC cache can be copied for faster cold start, but it is not authoritative data. The Node app also has runtime caches under `server/tile-cache`, `server/boundary-cache`, and `server/wfs-cache`; these can be regenerated and are not required for correctness.

## RHEL Notes

- Ubuntu paths use `tomcat9`; RHEL paths usually use `tomcat`.
- RHEL package names and service layout differ, so the restore script writes a fresh `/etc/systemd/system/geoserver.service` instead of blindly copying the Ubuntu unit.
- Keep the restore bundle permissions tight. It contains GeoServer security files and may contain the DB password in the Tomcat context XML.
