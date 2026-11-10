# Modo HTTPS local (pruebas desde la red)

YEBO identifica el panel del staff, el hub de cuentas y cada empresa por el **nombre del host**, y sus cookies son `__Host-` con `Secure`, así que solo funcionan por HTTPS. Este modo levanta toda la aplicación en HTTPS sobre la IP del servidor para probarla desde cualquier equipo o móvil de la red local.

| Pieza | Cómo |
|---|---|
| Nombres | [sslip.io](https://sslip.io): `<nombre>.<ip-con-guiones>.sslip.io` resuelve a esa IP. Con la IP `192.168.1.94`: `admin.192-168-1-94.sslip.io`. No hay que tocar `/etc/hosts`, y cada empresa nueva resuelve sola. Decisión del responsable del 2026-11-10 |
| Certificados | OpenSSL (`scripts/dev/https-certs.sh`): una **CA local** (EC P-256, 5 años) y un certificado comodín `*.<ip>.sslip.io` + la IP (397 días) firmado por ella |
| Proxy TLS | Nginx `1.28.3-alpine3.23` (imagen oficial) en Docker, perfil `https` del compose de desarrollo. Publica `<IP>:443` y reenvía a las apps por `host.docker.internal` |
| Apps | API (4100), worker (4101), web (3100) y panel (3101) en modo producción, escuchando solo en `127.0.0.1` |

## Uso

```bash
pnpm infra:up          # PostgreSQL y Redis
pnpm https:up          # certificados (si faltan), compilación, apps y Nginx
pnpm https:down        # detiene Nginx y las apps
pnpm https:certs       # solo los certificados (--force regenera también la CA)
```

`https:up` detecta la IP de la interfaz con la ruta por defecto; para otra, usa `YEBO_HTTPS_IP=10.0.0.5 pnpm https:up`. Al terminar imprime las URL:

- Panel del staff: `https://admin.<ip>.sslip.io`
- Cuentas YEBO: `https://cuentas.<ip>.sslip.io`
- Empresas: `https://<subdominio>.<ip>.sslip.io`

### Configuración del backend y del frontend

`apps/api/.env` **no se modifica**: `https-up.sh` exporta antes de arrancar, y las variables del entorno tienen prioridad sobre el archivo:

| Variable | Valor |
|---|---|
| `TENANT_BASE_DOMAIN` | `<ip>.sslip.io` |
| `AUTH_HUB_HOST` | `cuentas.<ip>.sslip.io` |
| `PLATFORM_ADMIN_HOST` | `admin.<ip>.sslip.io` |
| `TRUST_PROXY` | `loopback` (las conexiones de Nginx llegan desde loopback) |
| `API_HOST`, `WORKER_HEALTH_HOST` | `127.0.0.1` |
| `NODE_ENV` / `LOG_PRETTY` | `production` / `false` |
| `API_INTERNAL_URL` (web y panel) | `http://127.0.0.1:4100` |

La base de datos es la de `apps/api/.env` (`yebo_dev`), salvo que se defina `PG_DATABASE`. Nginx enruta `/api/` a la API y el resto a la web o al panel según el host (mismo origen, como en producción). La IP sola y los nombres desconocidos responden 404.

Registros y PID en `.run/https/` (ignorado por git).

## Instalar la CA local en los equipos de prueba

El archivo es `infrastructure/docker/https/certs/yebo-dev-ca.crt` (público). Se instala **una vez** por navegador o equipo. Al regenerar solo el certificado del servidor (por ejemplo, si cambia la IP), no hay que reinstalarla.

| Dónde | Cómo |
|---|---|
| Chrome / Edge (Linux) | Configuración → Privacidad y seguridad → Seguridad → Gestionar certificados → Autoridades → Importar → marcar «Confiar en este certificado para identificar sitios web» |
| Firefox | Ajustes → Privacidad y seguridad → Certificados → Ver certificados → Autoridades → Importar → marcar «Confiar en esta CA para identificar sitios web» |
| Windows | Doble clic en el `.crt` → Instalar certificado → Equipo local → «Entidades de certificación raíz de confianza» |
| macOS | Acceso a Llaveros → Sistema → importar → abrir el certificado → Confiar → «Confiar siempre» |
| Android | Ajustes → Seguridad → Cifrado y credenciales → Instalar certificado → Certificado de CA |
| iOS | Abrir el `.crt` (por AirDrop o correo) → instalar el perfil → Ajustes → General → Información → Ajustes de confianza de certificados → activar la CA |

**La clave privada de la CA** (`yebo-dev-ca.key`) nunca sale de este servidor: con ella se podrían firmar certificados en los que confiarían esos equipos. Si se filtra, hay que regenerarla (`pnpm https:certs --force`), retirar la CA anterior de los equipos e instalar la nueva.

## Primer acceso al panel

`yebo_dev` empieza sin staff. El primer superadmin se crea en **tu propia terminal**, para que la contraseña no quede en ningún registro:

```bash
cd apps/api && node dist/modules/platform-admin/cli/bootstrap.js --email tu.nombre@yebo.pe --name "Tu Nombre"
```

Después: `https://admin.<ip>.sslip.io` → contraseña → activar la verificación en dos pasos con la clave que muestra la pantalla (todavía sin código QR).

Sin app de autenticación en el móvil (solo para cuentas de prueba): `node scripts/dev/totp-code.mjs --watch` pide la clave sin mostrarla e imprime el código vigente cada 30 s (TOTP, RFC 6238). Con la clave y la contraseña en el mismo equipo no hay segundo factor real: no usarlo con cuentas reales.

## Limitaciones

- **IP del cliente.** Con Docker Desktop, Nginx ve la IP de la pasarela de Docker, no la del equipo que prueba. Los límites de intentos por IP se comparten entre todos los equipos de prueba.
- **Puerto 80.** Lo ocupa Apache en este servidor, así que no hay redirección de HTTP a HTTPS: hay que escribir `https://`.
- **Dependencia externa.** sslip.io es un DNS público: sin Internet, los nombres no resuelven. Los nombres revelan la IP privada, nada más.
- **Cortafuegos.** Si el servidor filtra puertos, hay que permitir la entrada TCP 443 desde la red local.
- **Solo desarrollo y pruebas.** Producción usa certificados públicos y el despliegue de la Fase 15.
