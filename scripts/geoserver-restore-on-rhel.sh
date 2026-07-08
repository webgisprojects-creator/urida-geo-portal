#!/usr/bin/env bash
set -euo pipefail

# Restore a URIDA GeoServer migration bundle onto a RHEL-compatible server.
# Run as root on the new production server.
#
# Required:
#   ./geoserver-restore-on-rhel.sh /path/to/urida-geoserver-rhel-YYYYmmdd-HHMMSS.tar.gz
#
# Optional overrides:
#   DB_JDBC_URL='jdbc:postgresql://host:6432/nv_allnndb_geoserver'
#   DB_USERNAME='postgres'
#   DB_PASSWORD='secret'
#   PROXY_BASE_URL='https://new-domain.example/geoserver'
#   JAVA_XMS='1g'
#   JAVA_XMX='3g'

BUNDLE="${1:-}"
if [[ -z "$BUNDLE" || ! -f "$BUNDLE" ]]; then
  echo "Usage: $0 /path/to/urida-geoserver-rhel-YYYYmmdd-HHMMSS.tar.gz" >&2
  exit 1
fi

GEOSERVER_HOME="${GEOSERVER_HOME:-/opt/geoserver}"
GEOSERVER_DATA_DIR="${GEOSERVER_DATA_DIR:-$GEOSERVER_HOME/data_dir}"
CATALINA_BASE="${CATALINA_BASE:-/var/lib/tomcat}"
CATALINA_HOME="${CATALINA_HOME:-/usr/share/tomcat}"
TOMCAT_USER="${TOMCAT_USER:-tomcat}"
TOMCAT_GROUP="${TOMCAT_GROUP:-tomcat}"
JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/jre-17-openjdk}"
JAVA_XMS="${JAVA_XMS:-1g}"
JAVA_XMX="${JAVA_XMX:-3g}"
PROXY_BASE_URL="${PROXY_BASE_URL:-https://REPLACE_ME/geoserver}"

escape_sed_replacement() {
  printf '%s' "$1" | sed -e 's/[\/&]/\\&/g'
}

if ! command -v dnf >/dev/null 2>&1; then
  echo "This restore script expects RHEL/Rocky/Alma with dnf." >&2
  exit 1
fi

dnf install -y java-17-openjdk-headless tomcat unzip tar postgresql-jdbc

if [[ ! -x "$JAVA_HOME/bin/java" ]]; then
  JAVA_BIN="$(command -v java)"
  JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$JAVA_BIN")")")"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
tar -xzf "$BUNDLE" -C "$tmp"

if [[ ! -d "$tmp/opt/geoserver/data_dir" ]]; then
  echo "Bundle does not contain opt/geoserver/data_dir" >&2
  exit 1
fi

systemctl stop geoserver.service 2>/dev/null || true
systemctl stop tomcat.service 2>/dev/null || true

install -d -o "$TOMCAT_USER" -g "$TOMCAT_GROUP" "$GEOSERVER_HOME"
if [[ -d "$GEOSERVER_DATA_DIR" ]]; then
  mv "$GEOSERVER_DATA_DIR" "$GEOSERVER_DATA_DIR.before-restore-$(date +%Y%m%d-%H%M%S)"
fi
cp -a "$tmp/opt/geoserver/data_dir" "$GEOSERVER_DATA_DIR"
chown -R "$TOMCAT_USER:$TOMCAT_GROUP" "$GEOSERVER_HOME"

install -d -o "$TOMCAT_USER" -g "$TOMCAT_GROUP" "$CATALINA_BASE/webapps"
install -d -o "$TOMCAT_USER" -g "$TOMCAT_GROUP" "$CATALINA_BASE/lib"
JDBC_JAR="$(find /usr/share/java -maxdepth 1 \( -name 'postgresql*.jar' -o -name 'postgresql-jdbc*.jar' \) | head -1 || true)"
if [[ -n "$JDBC_JAR" ]]; then
  ln -sf "$JDBC_JAR" "$CATALINA_BASE/lib/postgresql-jdbc.jar"
fi
if [[ -f "$tmp/var/lib/tomcat9/webapps/geoserver.war" ]]; then
  install -o "$TOMCAT_USER" -g "$TOMCAT_GROUP" -m 0640 "$tmp/var/lib/tomcat9/webapps/geoserver.war" "$CATALINA_BASE/webapps/geoserver.war"
else
  echo "Warning: bundle has no geoserver.war; install the matching GeoServer WAR manually." >&2
fi

install -d -o "$TOMCAT_USER" -g "$TOMCAT_GROUP" "$CATALINA_BASE/conf/Catalina/localhost"
if [[ -f "$tmp/etc/tomcat9/Catalina/localhost/geoserver.xml" ]]; then
  install -o "$TOMCAT_USER" -g "$TOMCAT_GROUP" -m 0640 "$tmp/etc/tomcat9/Catalina/localhost/geoserver.xml" "$CATALINA_BASE/conf/Catalina/localhost/geoserver.xml"
else
  cat > "$CATALINA_BASE/conf/Catalina/localhost/geoserver.xml" <<XML
<Context>
  <Resource name="jdbc/geoserver" auth="Container" type="javax.sql.DataSource"
    factory="org.apache.tomcat.jdbc.pool.DataSourceFactory"
    driverClassName="org.postgresql.Driver"
    url="${DB_JDBC_URL:-jdbc:postgresql://REPLACE_DB_HOST:6432/nv_allnndb_geoserver}"
    username="${DB_USERNAME:-REPLACE_DB_USER}"
    password="${DB_PASSWORD:-REPLACE_DB_PASSWORD}"
    initialSize="2" minIdle="2" maxIdle="10" maxActive="30" maxWait="30000"
    testOnBorrow="true" validationQuery="SELECT 1"
    removeAbandonedOnBorrow="true" removeAbandonedTimeout="120"
    maxTotal="20" maxWaitMillis="30000" testWhileIdle="true"
    timeBetweenEvictionRunsMillis="30000" minEvictableIdleTimeMillis="600000" />
</Context>
XML
  chown "$TOMCAT_USER:$TOMCAT_GROUP" "$CATALINA_BASE/conf/Catalina/localhost/geoserver.xml"
  chmod 0640 "$CATALINA_BASE/conf/Catalina/localhost/geoserver.xml"
fi

if [[ -n "${DB_JDBC_URL:-}" ]]; then
  safe_value="$(escape_sed_replacement "$DB_JDBC_URL")"
  sed -i -E "s#url=\"[^\"]+\"#url=\"$safe_value\"#" "$CATALINA_BASE/conf/Catalina/localhost/geoserver.xml"
fi
if [[ -n "${DB_USERNAME:-}" ]]; then
  safe_value="$(escape_sed_replacement "$DB_USERNAME")"
  sed -i -E "s#username=\"[^\"]+\"#username=\"$safe_value\"#" "$CATALINA_BASE/conf/Catalina/localhost/geoserver.xml"
fi
if [[ -n "${DB_PASSWORD:-}" ]]; then
  safe_value="$(escape_sed_replacement "$DB_PASSWORD")"
  sed -i -E "s#password=\"[^\"]+\"#password=\"$safe_value\"#" "$CATALINA_BASE/conf/Catalina/localhost/geoserver.xml"
fi

cat > /etc/systemd/system/geoserver.service <<SERVICE
[Unit]
Description=GeoServer WAR on Tomcat
After=network.target

[Service]
Type=simple
User=$TOMCAT_USER
Group=$TOMCAT_GROUP
Environment="JAVA_HOME=$JAVA_HOME"
Environment="CATALINA_BASE=$CATALINA_BASE"
Environment="CATALINA_HOME=$CATALINA_HOME"
Environment="CATALINA_TMPDIR=/tmp"
Environment="GEOSERVER_DATA_DIR=$GEOSERVER_DATA_DIR"
Environment="JAVA_OPTS=-Djava.awt.headless=true -DGEOSERVER_DATA_DIR=$GEOSERVER_DATA_DIR -DPROXY_BASE_URL=$PROXY_BASE_URL -Xms$JAVA_XMS -Xmx$JAVA_XMX -XX:+UseStringDeduplication -XX:MaxGCPauseMillis=200 -XX:+UseG1GC"
ExecStart=$JAVA_HOME/bin/java \\
  \$JAVA_OPTS \\
  -Djava.util.logging.config.file=$CATALINA_BASE/conf/logging.properties \\
  -Djava.util.logging.manager=org.apache.juli.ClassLoaderLogManager \\
  -Djdk.tls.ephemeralDHKeySize=2048 \\
  -Djava.protocol.handler.pkgs=org.apache.catalina.webresources \\
  -Dorg.apache.catalina.security.SecurityListener.UMASK=0027 \\
  -Dignore.endorsed.dirs= \\
  -classpath $CATALINA_HOME/bin/bootstrap.jar:$CATALINA_HOME/bin/tomcat-juli.jar \\
  -Dcatalina.base=$CATALINA_BASE \\
  -Dcatalina.home=$CATALINA_HOME \\
  -Djava.io.tmpdir=/tmp \\
  org.apache.catalina.startup.Bootstrap start
ExecStop=$JAVA_HOME/bin/java \\
  -classpath $CATALINA_HOME/bin/bootstrap.jar:$CATALINA_HOME/bin/tomcat-juli.jar \\
  -Dcatalina.base=$CATALINA_BASE \\
  -Dcatalina.home=$CATALINA_HOME \\
  org.apache.catalina.startup.Bootstrap stop
Restart=on-failure
RestartSec=10
SuccessExitStatus=143
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable --now geoserver.service

echo "GeoServer restore complete."
echo "Check status: systemctl status geoserver.service --no-pager"
echo "Check HTTP:   curl -I http://127.0.0.1:8080/geoserver/web/"
echo "Check WMS:    curl 'http://127.0.0.1:8080/geoserver/ows?service=WMS&version=1.1.1&request=GetCapabilities' -o /tmp/geoserver-wms.xml"
