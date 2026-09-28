# FG-DN-03 — `sdk-map` verificado, `WATCHED_SCHEMAS` derivado del mapa, `schema:check` en verde

Milestone 3 del piloto de Forge (decisión 119 del dueño). Rama `devin/FG-DN-03-sdk-map`
desde `main@69bcb5e`.

## Estado

- **Hecho.** `schema/openapi.json` + `schema/sdk.overlay.yaml` vendoreados byte a byte de
  describe-net `434e01c6` con su sha256 en `schema/SOURCE` (reemplazan
  `schema/openapi.snapshot.json`). `schema/sdk-map.json`: 5 operaciones en `mapeadas`, 17 en
  `fuera`, 11 ocultas por el overlay (33 en total). `src/sdk-map.test.ts` corre cada método
  público contra un `fetch` que graba `(método, ruta)`. `scripts/refresh-schema.mjs` deriva
  los schemas vigilados del mapa (ya no hay lista a mano) e ignora lo que el overlay oculta.
  `schema:refresh` re-vendorea desde un checkout de describe-net. Comentario falso de
  `ci.yml` borrado.
- **Falta.** Revisión y merge por c0der. Implementar `/names/*` en TS (DUP-01) no es parte de
  esta tarea.
- **Próximo paso.** Cuando describe-net cambie `openapi/`, correr
  `DESCRIBE_NET_DIR=<checkout> npm run schema:refresh` y luego `npx vitest run`.

## Cómo se verifica

```sh
npm ci
unshare -rn npx vitest run      # red cerrada
npm run schema:check            # un GET al spec vivo
git grep -c "const WATCHED_SCHEMAS = \["   # sin salida, exit 1
```

Medido el 2026-09-28, Node v24.19.0:

- `unshare -rn npx vitest run` → `Test Files 15 passed (15)`, `Tests 248 passed (248)`
  (eran 231 en `main`; los 17 nuevos son de `src/sdk-map.test.ts`).
- `npm run schema:check` → `OK: the live schema still matches schema/openapi.json (33
  operations, 11 hidden by the overlay, 21 watched schemas, v2.0.0).` exit 0. En `main` daba
  exit 1 con 11 cambios.
- `DESCRIBE_NET_REF=434e01c6 npm run schema:refresh` reproduce los mismos bytes (mismos sha256).

## Mutaciones (en una copia, ninguna commiteada)

| Mutación | Qué cae |
|---|---|
| Operación inventada `GET /inventada` en `schema/openapi.json` | `maps or excuses every operation…`, `the overlay classifies every operation…`, `every file listed in SOURCE matches its sha256`, `is describe.net 2.0.0 with 32 paths` (5 failed) |
| `health()` llama a `/healthz` | `health() calls only the operation mapped to it` (+10 de `client.test.ts`/`partner.test.ts`) |
| Borrar `GET /names/resolve` de `fuera` | `maps or excuses…`, `/names/resolve and /names/reverse wait for…` |
| `GET /me` (oculta) en `mapeadas` | `maps or excuses…` |
| Target huérfano en el overlay | `the overlay classifies…`, `SOURCE sha256`, `maps or excuses…` (5 failed) |
| Método público `async pricing()` nuevo sin mapear | `every public async method of DescribeClient is in INVOKE` |
| `schema:check` con `ChainScore.required` mutado en el spec vendoreado | `ChainScore: required field REMOVED "forge_probe"`, exit 1 (`ChainScore` no estaba en la lista a mano) |

## Decisiones que conviene revisar

- **El test de `types.schema.test.ts` que fija la cantidad de paths** pasó de 22 a 32: el
  spec de referencia cambió (el vendoreado agrega la web app y `/names/*`). La corrección
  queda escrita en el test, como en el refresh del 2026-09-15.
- **`mapeadas` exige que el método se llame como dice el overlay** (`x-fern-sdk-method-name`).
  Hoy coinciden los 5.
- **Los 15 motivos de `fuera` que no son `/names/*`** dicen «sin método en este SDK»;
  `/badge/{wallet}.svg` dice que `badgeUrl()` sólo arma la URL, y un test comprueba que esa
  URL cae en esa operación.
- **El overlay se lee con un parser estricto y sin dependencias** (`scripts/sdk-map.mjs`):
  acepta sólo `- target: "$.paths['<ruta>'].<método>"` + `update: {…}` y falla con cualquier
  otra línea. Si describe-net escribe el overlay de otra forma, este parser se pone rojo antes
  de ignorar algo.
- **Se editó `.github/workflows/ci.yml`** porque el punto 5 del encargo lo pide: se borró el
  comentario falso y se renombraron el job y el paso de `schema-drift`, que nombraban el
  `openapi.snapshot.json` borrado.
