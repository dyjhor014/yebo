#!/usr/bin/env bash
# Valores comunes del modo HTTPS local (docs/development/https-local.md). Se carga con `source`.
# IP del servidor en la red local: YEBO_HTTPS_IP, o la de la interfaz con la ruta por defecto.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HTTPS_DIR="$ROOT/infrastructure/docker/https"
CERT_DIR="$HTTPS_DIR/certs"
RUN_DIR="$ROOT/.run/https"
YEBO_HTTPS_IP="${YEBO_HTTPS_IP:-$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") print $(i + 1)}')}"
if [[ ! "$YEBO_HTTPS_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo "No se pudo detectar la IP del servidor; define YEBO_HTTPS_IP (por ejemplo 192.168.1.94)." >&2
  exit 1
fi
# sslip.io: <cualquier-nombre>.<ip-con-guiones>.sslip.io resuelve a esa IP (DNS público, sin configurar equipos).
YEBO_BASE_DOMAIN="${YEBO_HTTPS_IP//./-}.sslip.io"
export YEBO_HTTPS_IP YEBO_BASE_DOMAIN
