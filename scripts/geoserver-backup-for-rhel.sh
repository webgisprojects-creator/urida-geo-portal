#!/usr/bin/env bash
set -euo pipefail

# Build a portable GeoServer migration bundle from the current production host.
# Run as root, or with sudo, on the existing GeoServer server.

STAMP="${STAMP:-$(date +%Y%m%d-%H%M%S)}"
OUT_DIR="${OUT_DIR:-/root/urida-geoserver-migration}"
GEOSERVER_DATA_DIR="${GEOSERVER_DATA_DIR:-/opt/geoserver/data_dir}"
GEOSERVER_WAR="${GEOSERVER_WAR:-/var/lib/tomcat9/webapps/geoserver.war}"
GEOSERVER_SERVICE="${GEOSERVER_SERVICE:-/etc/systemd/system/geoserver.service}"
TOMCAT_CONTEXT="${TOMCAT_CONTEXT:-/etc/tomcat9/Catalina/localhost/geoserver.xml}"
INCLUDE_GWC_CACHE="${INCLUDE_GWC_CACHE:-1}"

mkdir -p "$OUT_DIR"
BUNDLE="$OUT_DIR/urida-geoserver-rhel-$STAMP.tar.gz"
MANIFEST="$OUT_DIR/manifest-$STAMP.txt"

if [[ ! -d "$GEOSERVER_DATA_DIR" ]]; then
  echo "Missing GEOSERVER_DATA_DIR: $GEOSERVER_DATA_DIR" >&2
  exit 1
fi

tar_excludes=()
if [[ "$INCLUDE_GWC_CACHE" != "1" ]]; then
  tar_excludes+=(
    "--exclude=./opt/geoserver/data_dir/gwc"
    "--exclude=./opt/geoserver/data_dir/gwc-layers"
  )
fi

{
  echo "created_at=$STAMP"
  echo "hostname=$(hostname -f 2>/dev/null || hostname)"
  echo "geoserver_data_dir=$GEOSERVER_DATA_DIR"
  echo "geoserver_data_dir_size=$(du -sh "$GEOSERVER_DATA_DIR" 2>/dev/null | awk '{print $1}')"
  echo "include_gwc_cache=$INCLUDE_GWC_CACHE"
  echo "layer_count=$(find "$GEOSERVER_DATA_DIR/workspaces" -name layer.xml 2>/dev/null | wc -l)"
  echo "store_count=$(find "$GEOSERVER_DATA_DIR/workspaces" \( -name datastore.xml -o -name wmsstore.xml -o -name coveragestore.xml \) 2>/dev/null | wc -l)"
  echo "style_count=$(find "$GEOSERVER_DATA_DIR/styles" "$GEOSERVER_DATA_DIR/workspaces" -name '*.sld' 2>/dev/null | wc -l)"
  java -version 2>&1 | sed 's/^/java=/'
} > "$MANIFEST"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/payload"/{opt/geoserver,etc/systemd/system,etc/tomcat9/Catalina/localhost,var/lib/tomcat9/webapps}

cp "$MANIFEST" "$tmp/payload/manifest.txt"
cp -a "$GEOSERVER_DATA_DIR" "$tmp/payload/opt/geoserver/data_dir"

if [[ -f "$GEOSERVER_WAR" ]]; then
  cp -a "$GEOSERVER_WAR" "$tmp/payload/var/lib/tomcat9/webapps/geoserver.war"
fi
if [[ -f "$GEOSERVER_SERVICE" ]]; then
  cp -a "$GEOSERVER_SERVICE" "$tmp/payload/etc/systemd/system/geoserver.service.source"
fi
if [[ -f "$TOMCAT_CONTEXT" ]]; then
  cp -a "$TOMCAT_CONTEXT" "$tmp/payload/etc/tomcat9/Catalina/localhost/geoserver.xml"
fi

tar -C "$tmp/payload" "${tar_excludes[@]}" -czf "$BUNDLE" .
chmod 600 "$BUNDLE"

echo "Created: $BUNDLE"
echo "Manifest: $MANIFEST"
echo
echo "Copy this bundle and scripts/geoserver-restore-on-rhel.sh to the new RHEL server."
