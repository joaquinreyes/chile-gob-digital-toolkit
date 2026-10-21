import { ClaveUnicaClient, claveUnicaEndpoints } from "../../packages/clave-unica/src/index.js";
import { createApp } from "./app.js";

/**
 * Configure with environment variables (never commit them):
 *   CLAVEUNICA_CLIENT_ID, CLAVEUNICA_CLIENT_SECRET, CLAVEUNICA_REDIRECT_URI
 * Optional:
 *   CLAVEUNICA_LOGOUT_REDIRECT  registered Logout URI
 *   CLAVEUNICA_BASE_URL         other host with the same paths (e.g. the local mock provider)
 *   CLAVEUNICA_SCOPE            default "openid run name"
 *   PORT                        default 3000
 */
function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Falta la variable de entorno ${name}. Ver examples/clave-unica-express/.env.example`);
    process.exit(1);
  }
  return v;
}

const redirectUri = required("CLAVEUNICA_REDIRECT_URI");
const client = new ClaveUnicaClient({
  clientId: required("CLAVEUNICA_CLIENT_ID"),
  clientSecret: required("CLAVEUNICA_CLIENT_SECRET"),
  redirectUri,
  scope: process.env.CLAVEUNICA_SCOPE || undefined,
  endpoints: process.env.CLAVEUNICA_BASE_URL ? claveUnicaEndpoints(process.env.CLAVEUNICA_BASE_URL) : undefined,
});

const port = Number(process.env.PORT ?? 3000);
createApp({
  client,
  logoutRedirect: process.env.CLAVEUNICA_LOGOUT_REDIRECT || undefined,
  secureCookie: redirectUri.startsWith("https://"),
}).listen(port, () => {
  console.log(`Demo ClaveÚnica escuchando en http://localhost:${port} (callback: ${redirectUri})`);
});
