#!/usr/bin/env bash
# Certificados del modo HTTPS local con OpenSSL:
#   1) una autoridad local (CA) propia, que se instala UNA vez en cada navegador o equipo de prueba;
#   2) un certificado comodín *.<ip>.sslip.io (+ la IP) firmado por esa CA, para Nginx.
# La CA se reutiliza si ya existe (no hay que volver a instalarla); el certificado del servidor se regenera si cambia
# la IP o le quedan menos de 30 días. --force regenera también la CA.
# Las claves privadas quedan en infrastructure/docker/https/certs/ (ignorado por git, permisos 600).
set -euo pipefail
source "$(dirname "$0")/https-common.sh"
mkdir -p "$CERT_DIR"
chmod 700 "$CERT_DIR"
CA_KEY="$CERT_DIR/yebo-dev-ca.key"
CA_CRT="$CERT_DIR/yebo-dev-ca.crt"
KEY="$CERT_DIR/server.key"
CRT="$CERT_DIR/server.crt"

if [[ "${1:-}" == "--force" ]]; then rm -f "$CA_KEY" "$CA_CRT" "$KEY" "$CRT"; fi

if [[ ! -f "$CA_KEY" || ! -f "$CA_CRT" ]]; then
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$CA_KEY" 2>/dev/null
  openssl req -x509 -new -key "$CA_KEY" -sha256 -days 1825 -subj "/O=YEBO desarrollo/CN=YEBO CA local de desarrollo ($(hostname))" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash" \
    -out "$CA_CRT"
  echo "Creada la CA local: $CA_CRT (instálala en los navegadores de prueba; ver docs/development/https-local.md)."
fi

needs_server=1
if [[ -f "$CRT" && -f "$KEY" ]] &&
  openssl x509 -in "$CRT" -noout -checkend $((30 * 86400)) >/dev/null &&
  openssl x509 -in "$CRT" -noout -ext subjectAltName 2>/dev/null | grep -q "DNS:\*\.$YEBO_BASE_DOMAIN" &&
  openssl verify -CAfile "$CA_CRT" "$CRT" >/dev/null 2>&1; then
  needs_server=0
fi

if [[ $needs_server -eq 1 ]]; then
  CSR="$(mktemp)"
  EXT="$(mktemp)"
  trap 'rm -f "$CSR" "$EXT"' EXIT
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$KEY" 2>/dev/null
  openssl req -new -key "$KEY" -subj "/O=YEBO desarrollo/CN=*.$YEBO_BASE_DOMAIN" -out "$CSR"
  cat > "$EXT" <<EXT
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=DNS:*.$YEBO_BASE_DOMAIN,DNS:$YEBO_BASE_DOMAIN,IP:$YEBO_HTTPS_IP
authorityKeyIdentifier=keyid
subjectKeyIdentifier=hash
EXT
  # 397 días: el máximo que aceptan los navegadores para un certificado de servidor.
  openssl x509 -req -in "$CSR" -CA "$CA_CRT" -CAkey "$CA_KEY" -CAcreateserial -days 397 -sha256 -extfile "$EXT" -out "$CRT" 2>/dev/null
  echo "Creado el certificado de *.$YEBO_BASE_DOMAIN e IP $YEBO_HTTPS_IP."
else
  echo "El certificado de *.$YEBO_BASE_DOMAIN sigue válido."
fi
# Claves solo para el propietario (el maestro de Nginx las lee como root dentro del contenedor).
chmod 600 "$CA_KEY" "$KEY"
chmod 644 "$CRT" "$CA_CRT"
openssl x509 -in "$CRT" -noout -subject -enddate -ext subjectAltName | sed 's/^/  /'
