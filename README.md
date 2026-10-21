# chile-gob-digital-toolkit

[![CI](https://github.com/joaquinreyes/chile-gob-digital-toolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/joaquinreyes/chile-gob-digital-toolkit/actions/workflows/ci.yml)
[![Licencia: MIT](https://img.shields.io/badge/licencia-MIT-blue.svg)](LICENSE)

Clientes en TypeScript (Node 20+) para servicios de identidad digital y firma electrónica del
Estado de Chile:

- **`packages/clave-unica`**: cliente OpenID Connect para **ClaveÚnica** (URL de autorización con
  `state`/`nonce`, canje del `code`, `userinfo`, logout) y utilidades de **RUN** (dígito verificador).
- **`packages/firmagob`**: cliente para la API de **FirmaGob** (Firma Electrónica Avanzada del
  Estado): JWT HS256, firma atendida (OTP) y desatendida, PDF, XML, JSON y hash.
- **`packages/pisee`**: cliente pequeño para el **Nodo PISEE 2** local y validación de su `config.json`.

Proyecto propio de código abierto, sin mandante, desarrollado por **Plataforma Mozzo SpA** (Chile).
Licencia MIT. No es un producto oficial ni está afiliado a la Secretaría de Gobierno Digital (SGD).

## Estado (qué está probado y qué no)

| Componente | Probado contra | Resultado |
|---|---|---|
| ClaveÚnica (`clave-unica`) | Pruebas unitarias con HTTP simulado + flujo completo por HTTP real contra un proveedor simulado local con las mismas rutas y respuestas de la guía oficial | Pasa en CI |
| ClaveÚnica contra `accounts.claveunica.gob.cl` | **No probado.** Requiere credenciales sandbox emitidas por la SGD a una institución, y una Redirect URI registrada (no se permite `localhost`) | Pendiente |
| FirmaGob (`firmagob`) | Pruebas unitarias con HTTP simulado. El JWT generado es **idéntico byte a byte** al token de ejemplo del manual | Pasa en CI |
| FirmaGob, ambiente TEST oficial (`api.firma.cert.digital.gob.cl`) | Firma desatendida real de un PDF con los datos de prueba genéricos publicados en el manual. Devuelve `FIRMADO` y un PDF con firma PKCS#7 (`/ByteRange`) | Pasa (21-10-2026). Job semanal/manual en CI |
| FirmaGob firma atendida (OTP) | Solo HTTP simulado. El OTP de prueba se genera con una semilla QR del manual que no se incluye aquí | Parcial |
| FirmaGob producción | **No probado.** No hay credenciales de producción | — |
| PISEE 2 (`pisee`) | Solo HTTP simulado. Cubre la parte pública documentada (llamar al Nodo local, `config.json`, ID de transacción). El Nodo y el protocolo entre Nodos son de la SGD | Esqueleto funcional |

Ningún componente se ha usado con credenciales de producción ni con datos de personas reales.

## Requisitos

- Node.js 20 o superior.
- Credenciales emitidas por la SGD para cada servicio (ver más abajo). Sin ellas solo funcionan las
  pruebas, el proveedor simulado y el ambiente TEST de FirmaGob.

```bash
git clone https://github.com/joaquinreyes/chile-gob-digital-toolkit.git
cd chile-gob-digital-toolkit
npm ci
npm test              # pruebas con HTTP simulado
npm run lint && npm run typecheck && npm run build
```

## ClaveÚnica

Fuente: *Guía técnica de integración a ClaveÚnica* y *Manual de integración ClaveÚnica*
(wikiguias.digital.gob.cl).

| Paso | Endpoint | Método |
|---|---|---|
| Autorización | `https://accounts.claveunica.gob.cl/openid/authorize/` | GET (navegador) |
| Token | `https://accounts.claveunica.gob.cl/openid/token/` | POST `x-www-form-urlencoded` |
| Datos del usuario | `https://accounts.claveunica.gob.cl/openid/userinfo/` | POST con `Bearer` |
| Logout | `https://accounts.claveunica.gob.cl/api/v1/accounts/app/logout?redirect=...` | GET (redirección completa, no popup ni iframe) |

Scope por defecto: `openid run name` (la certificación de producción exige ese scope). El
identificador de la persona es `RolUnico.numero` + `RolUnico.DV`, no `sub`.

```ts
import { ClaveUnicaClient, createRandomToken, formatRun } from "@chile-gob-toolkit/clave-unica";

const cu = new ClaveUnicaClient({
  clientId: process.env.CLAVEUNICA_CLIENT_ID!,
  clientSecret: process.env.CLAVEUNICA_CLIENT_SECRET!,
  redirectUri: process.env.CLAVEUNICA_REDIRECT_URI!,
});

// /login
const state = createRandomToken();            // guardar en la sesión
const url = cu.authorizationUrl({ state });

// /callback
const tokens = await cu.handleCallback(req.query, { state: session.state }); // valida state, canjea code
const perfil = await cu.userInfo(tokens.access_token);                       // valida RUN y DV
formatRun(perfil.run);                                                       // "44.444.444-4"

// /logout
res.redirect(cu.logoutUrl("https://mi-app.ejemplo.gob.cl/salir"));
```

### App de ejemplo (Express)

`examples/clave-unica-express`: login → callback → perfil → logout.

```bash
cp examples/clave-unica-express/.env.example .env   # completar con las credenciales de la SGD
set -a; source .env; set +a
npm run example:clave-unica
```

La Redirect URI debe ser HTTPS, sin query string y **no puede ser `localhost`** (regla de
ClaveÚnica). Para probar en un equipo local use un dominio propio o un túnel HTTPS y registre esa
URI en la solicitud de credenciales.

Sin credenciales, el ejemplo funciona contra el **proveedor simulado** local (no es ClaveÚnica):

```bash
npm run example:clave-unica:mock      # terminal 1, puerto 4000
CLAVEUNICA_BASE_URL=http://localhost:4000 CLAVEUNICA_CLIENT_ID=mock-client \
CLAVEUNICA_CLIENT_SECRET=mock-secret CLAVEUNICA_REDIRECT_URI=http://localhost:3000/callback \
npm run example:clave-unica           # terminal 2, abrir http://localhost:3000
```

### Cómo obtener credenciales

1. La institución pública solicita la integración en el portal de la SGD (trámite de credenciales
   ClaveÚnica), con Redirect URI de testing, QA y producción, y Logout URI si se usa `redirect`.
2. La SGD envía tres pares `client_id`/`client_secret`: sandbox, QA y producción. Sandbox y QA
   funcionan de inmediato y solo con los RUN de prueba de la guía (por ejemplo `44.444.444-4`).
3. Producción queda bloqueada hasta la certificación: `state` dinámico, scope `openid run name`,
   y llamadas a `token/` y `userinfo/` desde el backend.

## FirmaGob

Fuente: *Manual de integración | Protocolo de conexión a repositorio de firmas* (wikiguias.digital.gob.cl).

| Ambiente | URL (`POST`) |
|---|---|
| Producción | `https://api.firma.digital.gob.cl/firma/v2/files/tickets` |
| TEST (firmas no válidas) | `https://api.firma.cert.digital.gob.cl/firma/v2/files/tickets` |

Cuerpo: `api_token_key`, `token` (JWT HS256 con `entity`, `run` sin DV, `expiration` en hora de
Chile `YYYY-MM-DDTHH:MM:SS` a 30 minutos como máximo, `purpose`) y `files`. Cabecera `OTP` solo en
firma atendida. Límite de 5 MB por solicitud.

```ts
import { FirmaGobClient, FIRMAGOB_URLS, pdfFile, PURPOSE_UNATTENDED } from "@chile-gob-toolkit/firmagob";

const firma = new FirmaGobClient({
  apiTokenKey: process.env.FIRMAGOB_API_TOKEN_KEY!,
  secret: process.env.FIRMAGOB_SECRET!,
  entity: "Nombre de la institución tal como aparece en la RA",
  url: FIRMAGOB_URLS.test,                  // omitir para producción
});

const r = await firma.sign({
  run: "22.222.222-2",                      // se envía como "22222222"
  purpose: PURPOSE_UNATTENDED,              // "Propósito General" + otp para firma atendida
  files: [pdfFile(pdfBuffer, "Resolución exenta N° 123")],
});
r.files[0].ok;                               // status "OK"
r.files[0].content;                          // PDF firmado en base64
```

Incluye `xmlFile` (con `references` y `xmlObjects`), `jsonFile`, `hashFile` (respuesta p7s para
insertar en el PDF) y `buildLayoutXml` (imagen de firma visible, Anexo B del manual).

Firma real en el ambiente TEST con los datos genéricos del manual:

```bash
npm run example:firmagob-sandbox -- firmado.pdf
```

Para producción, la institución registra su aplicación en *Solicitud de Registros FirmaGob*
(opción registro de aplicación) y recibe `api_token_key` y `secret`. Cada funcionario debe tener
su certificado emitido y, para firma desatendida, la aplicación habilitada.

## PISEE 2

Fuente: *Manual de configuración del Nodo v2* y *Modelo de interoperabilidad* (wikiguias.digital.gob.cl).

En PISEE 2 cada institución instala el Nodo de la SGD. El Nodo hace mTLS, firma, cifrado,
autorización y trazabilidad. Las aplicaciones llaman al Nodo local por HTTP (puerto 8084, nunca
expuesto a internet). Este paquete cubre ese lado:

```ts
import { NodoClient, consumidorEntry, proveedorEntry, parseTransactionId } from "@chile-gob-toolkit/pisee";

const nodo = new NodoClient({ baseUrl: "http://nodo.interno:8084" });
await nodo.detalleOrganismo("PE-SUB-00053");                   // prueba de conectividad del manual
await nodo.call("/algo/miServicio", { body: { rut: "..." } }); // "rutaLocal" del config.json

consumidorEntry({ nombre: "NombreEnCatalogo", rutaLocal: "/algo/miServicio" });
proveedorEntry({ nombre: "ConsultaPermiso", rutaLocalServicio: "http://10.0.0.5/api", rutaExterna: "/inst/permiso", tps: 10 });
parseTransactionId("6.01GK313E4VSGGB69DKNPTFAM6K");            // organismo + ULID + fecha
```

No implementa el Nodo ni el protocolo entre Nodos. El catálogo de servicios y los permisos los
gestiona el equipo de interoperabilidad de la SGD.

## Seguridad

- No suba credenciales al repositorio. Use variables de entorno o un gestor de secretos.
  `.env` está en `.gitignore`.
- `client_secret` de ClaveÚnica y `secret` de FirmaGob solo se usan en el backend. El canje de
  `code` y la llamada a `userinfo` siempre van desde el servidor.
- `state` se genera al azar por intento, se compara en tiempo constante y se usa una sola vez.
- Use la sesión de ClaveÚnica solo para identificar. Cierre también la sesión de ClaveÚnica al
  cerrar la propia (lo pide la guía).
- El JWT de FirmaGob dura 5 minutos por defecto (máximo 30). La librería rechaza OTP en firma
  desatendida y lo exige en la atendida.
- FirmaGob no guarda los documentos firmados ni entrega código de verificación: la institución
  debe almacenarlos y publicar su propio mecanismo de verificación.
- El proveedor simulado y los datos de prueba (`sandbox`, RUN `11111111`, `22222222`,
  `44.444.444-4`) son públicos y solo sirven para pruebas.
- El `id_token` de ClaveÚnica se decodifica solo para revisar `nonce`. Su firma no se verifica:
  la identidad se toma de `userinfo`, como indica la guía.

## English summary

TypeScript (Node 20+) clients for Chilean government digital services: ClaveÚnica (national
OpenID Connect login, plus RUN check-digit helpers), FirmaGob (government advanced e-signature API:
HS256 JWT, attended/unattended signing of PDF/XML/JSON/hash) and a small helper for the PISEE 2
interoperability Node. Endpoints and formats follow the public SGD guides on
wikiguias.digital.gob.cl.

Status: all flows are covered by tests with mocked HTTP. FirmaGob unattended PDF signing was
verified against the official TEST environment using the public test data from the manual.
ClaveÚnica was tested only against a local mock provider; it needs SGD-issued credentials for a
real test. No production credentials were used. Independent open-source project, not affiliated
with the Chilean government. MIT license.
