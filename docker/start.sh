#!/bin/sh
set -eu

node src/index.js &
WEB_PID=$!

node src/mqtt.js \
  --protobufs-path /opt/protobufs \
  --mqtt-broker-url mqtt://mqtt.meshtastic.org \
  --mqtt-username meshdev \
  --mqtt-password large4cats \
  --mqtt-client-id graham-county-mesh-map \
  --mqtt-topic msh/# \
  --collect-positions \
  --collect-waypoints \
  --collect-neighbour-info \
  --collect-map-reports \
  --drop-packets-not-ok-to-mqtt \
  --old-firmware-position-precision 4 \
  --forget-outdated-node-positions-after-seconds 1209600 \
  --purge-interval-seconds 3600 \
  --purge-device-metrics-after-seconds 604800 \
  --purge-environment-metrics-after-seconds 604800 \
  --purge-power-metrics-after-seconds 604800 \
  --purge-map-reports-after-seconds 604800 \
  --purge-neighbour-infos-after-seconds 604800 \
  --purge-nodes-unheard-for-seconds 2592000 \
  --purge-positions-after-seconds 2592000 \
  --purge-service-envelopes-after-seconds 259200 \
  --purge-traceroutes-after-seconds 604800 \
  --purge-waypoints-after-seconds 604800 &
MQTT_PID=$!

trap 'kill "$WEB_PID" "$MQTT_PID" 2>/dev/null || true' INT TERM EXIT

wait "$WEB_PID" "$MQTT_PID"
