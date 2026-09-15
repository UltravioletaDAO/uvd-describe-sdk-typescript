# Handoff — uvd-describe-sdk (TypeScript) tipa `caveats_not_computed`, `ratings[].author_class` y `requireFullCaveats()` (2026-09-15)

> Worker `dn-sdk-caveats-ts` (task `task_8fb9d10c6d7f`, dispatch `ctx_961ca77ed9e2`), despachado por
> c0der (master-4). Mac mini, sin credenciales de AWS. Rama `0xultravioleta/dn-sdk-caveats-ts` desde
> `origin/main` `a7105c6` (verificado igual a origin tras `git fetch`).
> **Sin tag y sin publish**: la versión queda en `0.4.0` en `main` tras el merge; el tag `v0.4.0` lo
> hace c0der. Mitad TypeScript; la mitad Python es `dn-sdk-caveats-py` (commit `edca736`, `0.6.0`).

## La fila, re-verificada antes de tocar nada

- `describe-net/docs/BACKLOG.md:19` (`origin/main` `01f6c4a`): abierta, desbloqueada 2026-09-14.
- `git grep -n -E 'caveats_not_computed|author_class|require_full_caveats|facilitator-authored' origin/main -- src`
  en este repo: **vacío** (exit 1). Sin PR abiertos (`gh pr list --state all`: sólo #1, MERGED
  2026-09-10). `package.json` en `0.3.0`.
- En vivo, 2026-09-15T03:51:52Z: `GET /wallets/{wallet}/chains` trae `caveats_not_computed` con 7 codes
  (wallet `0x715dc…4e6d` y `0xdeadbeef…`), y `/openapi.json` declara `Rating.author_class` requerido con
  enum `facilitator-authored | rater-authored` y `WalletChains.caveats_not_computed` requerido.

## Qué quedó hecho

| Pedido del encargo | Qué hay | Dónde |
|---|---|---|
| (1) `caveats_not_computed` como `string[] \| null`, `null` ≠ `[]` | `WalletReputation.caveatsNotComputed: CaveatCode[] \| null`. `null` = nada legible declarado: servidor anterior al 2026-09-14, payload guardado, o algo que no es una lista de strings no vacíos (parser «entero o null», igual que Python) | `src/types.ts:226`, `src/parse.ts` (`parseNotComputed`, `:388`) |
| (2) `author_class` literal en cada `Rating`, tolerante | `Rating.authorClass: AuthorClass \| null`; `AuthorClass = KnownAuthorClass \| (string & {})`. Desconocido: llega tal cual (ni throw ni null). No-string o vacío: `null`. Ausente: `null`, nunca `rater-authored` | `src/types.ts:432`, `src/parse.ts:309`, `src/caveats.ts` |
| (3) code `facilitator-authored` | En `CAVEAT_CODES` (9 codes) | `src/caveats.ts:100` |
| (4) helper `require_full_caveats` con error tipado | `requireFullCaveats(rep: WalletReputation)`: `[]` pasa; lista **y `null`** lanzan `CaveatsNotComputedError` (`.wallet`, `.notComputed`, `.recovery`); lo que no es un `WalletReputation` es `TypeError` | `src/caveats.ts:194`, `:318`; exportado en `src/index.ts:126,130` |
| (5) fixtures de la API viva y de `/openapi.json` | Dos respuestas vivas byte a byte (`WALLET_DECLARES_NOT_COMPUTED`, `WALLET_UNRATED_DECLARES_NOT_COMPUTED`); `schema/openapi.snapshot.json` refrescado (2.0.0, 22 paths). El payload de agente (`AGENT_WITH_AUTHOR_CLASSES`) es **forma del esquema, no captura** — la ruta es paga y ningún test gasta USDC; lo dice su docstring | `src/__fixtures__/live.ts`, `schema/` |
| (6) tests `null` vs `[]` y el helper en los dos estados | 18 tests nuevos en `caveats.test.ts` + 3 en `types.schema.test.ts` (cobertura de `Rating`, enum de clases pineado contra el snapshot, campo requerido) | `src/caveats.test.ts`, `src/types.schema.test.ts` |
| (7) bump minor + CHANGELOG | `0.3.0 → 0.4.0` (`package.json`, `SDK_VERSION`); `CHANGELOG.md` nuevo, incluido en `files` del paquete | `package.json`, `src/config.ts`, `CHANGELOG.md` |

Además: `scripts/refresh-schema.mjs` vigila `Rating` (no lo hacía, y por eso el refresh reportó
`caveats_not_computed` pero **no** `author_class` requerido); README (sección del gate y de
`authorClass`); CLAUDE.md (dueños de módulo, invariante 12, conteo de tests, convención de CHANGELOG).

## Decisiones, con su fuente

### `requireFullCaveats` con la declaración ausente (`null`) → LANZA

- `describe-net/docs/BACKLOG.md:221` (fila del 2026-08-31): *«Posición vigente respondida en canal: la
  línea gratis/pago es regla de costo y el scope es la señal; el SDK puede ganar
  `require_full_caveats()`»*. Esa fila es la de un gate que pasa en verde sin saber qué no se calculó;
  un `null` que pasa es ese gate de vuelta.
- Esquema vivo, `WalletChains.caveats_not_computed`: *«A quality gate built on this route must treat
  every code listed here as unverified, not as passed.»*
- `describenet/caveats.py:493-494`: el servidor le asigna el helper al SDK.
- `describenet/mcp_server.py:896-901`: el MCP del servicio mantiene `None` y no `[]` porque *«una API
  vieja no declaró nada, y `[]` afirmaría que lo calculó todo»*.
- `docs/handoffs/2026-09-14-dn-reputacion-chicas.md` (describe-net): la lista y no el conteo; A2A
  declara 8 porque no evalúa `thin-chain`.

Consecuencia medida: **hoy lanza para todo `wallet()`** (7 codes declarados). Es el gate funcionando:
una decisión que necesita los cortes de calidad compra `walletBreakdown()` o usa el riel de partner.

### `CaveatsNotComputedError` NO es `DescribeError`

Un consumidor envuelve el SDK en `catch (e) { if (e instanceof DescribeError) return null; }`. Si el
rechazo fuera un `DescribeError`, ese `catch` lo leería como «describe está caído» y un gate tolerante a
caídas dejaría pasar al sujeto. El primer borrador de este worker lo hizo `DescribeError` con un
`kind` nuevo; el argumento es del worker de Python y TS convergió (además, un `kind` nuevo rompía en
compilación todo `switch` exhaustivo). `DescribeErrorKind`, `RECOVERY` y `errors.ts` quedan intactos.

### `thin-chain` falta, en los DOS SDK, a propósito

El servicio sirve 10 codes (`describenet/caveats.py:177-192`); los dos SDK quedan en 9. Agregarlo en uno
solo rompe la paridad de un set que los dos publican, y el encargo nombraba sólo `facilitator-authored`.
**Fila sugerida**: `thin-chain` en los dos SDK a la vez (en Python además `FREE_GATE_CAVEAT_CODES` y
`CAVEAT_CODES_MEASURED_AT`).

## Paridad con `uvd-describe-sdk-python` (`dn-sdk-caveats-py`, `edca736`)

| Qué | TypeScript (este PR) | Python |
|---|---|---|
| campo gratis | `WalletReputation.caveatsNotComputed: CaveatCode[] \| null` | `WalletReputation.caveats_not_computed: Optional[List[str]]` |
| campo del rating | `Rating.authorClass: AuthorClass \| null` | `Rating.author_class: Optional[str]` |
| codes | `CAVEAT_CODES`, 9, con `'facilitator-authored'` | `KNOWN_CAVEAT_CODES`, 9, con `CaveatCode.FACILITATOR_AUTHORED` |
| clases de autor | `AUTHOR_CLASSES`, `KnownAuthorClass`, `AuthorClass`, `isKnownAuthorClass()` | `KNOWN_AUTHOR_CLASSES`, `KnownAuthorClass`, `AuthorClass`, `is_known_author_class()` |
| gate | `requireFullCaveats(rep)` | `require_full_caveats(result)` |
| error | `CaveatsNotComputedError extends Error` — `.wallet`, `.notComputed`, `.recovery` (estático e instancia) | `CaveatsNotComputedError(Exception)` — `.wallet`, `.not_computed`, `.recovery` (de clase) |
| `[]` / lista / `null` / otro tipo | pasa / lanza / lanza / `TypeError` | igual |
| `[7]`, `[null]`, `['x', '']` | `null` | `None` |

Cómo se llegó: los dos workers corrieron en paralelo sin CLI de Orca y se leyeron por archivos sin
trackear en el worktree del otro. Python commiteó primero con otro diseño y TS convergió a él; Python lo
confirmó en `PARIDAD-PY-c0der.md` (~04:20Z, leído y borrado como pedía).

**Única diferencia, declarada en los dos lados:** el texto de `recovery` del error. Python nombra
`wallet_breakdown()`, `payer=`, `partner=`, `fallback_reader` (grafías de Python, atadas a su
`test_recovery.py`); TS nombra `GET /reputation/wallet/{wallet}`, x402 y el riel de partner. No es una
entrada de `RECOVERY` (no es un `kind`), así que la regla de texto idéntico del README no lo alcanza.

## Verificación

### Los tests nuevos contra el `src` de `origin/main`

`caveats.test.ts`, `types.schema.test.ts`, `recovery.test.ts` + fixtures + snapshot nuevos, copiados
sobre `git archive origin/main`: **22 rojos, 38 verdes** (los verdes son los tests preexistentes de esos
tres archivos, más el nuevo que sólo lee el snapshot). Con el cambio: 60/60. Suite completa: 206 en
`origin/main`, 227 con el cambio.

### Mutaciones (una por copia descartable en el scratchpad; el worktree no se tocó)

| # | Mutación | Rojos |
|---|---|---|
| M1 | `parseNotComputed(...) ?? []` | 4 |
| M2 | lista filtrada (`continue`) en vez de `null` ante una entrada ilegible | 1 |
| M3 | el gate devuelve `result` cuando no hay declaración | 3 |
| M4 | el gate rechaza `[]` (sin el `return` temprano) | 1 |
| M5 | sin el chequeo de forma (`if (false)`) | 1 |
| M6 | `CaveatsNotComputedError extends DescribeUnparseable` | 1 |
| M7 | el `recovery` de la instancia interpola la wallet | 1 |
| M8 | `authorClass` cerrado: desconocido → `null` | 1 |
| M9 | `authorClass` cerrado: desconocido → throw | 2 |
| M10 | ausente → `'rater-authored'` | 2 |
| M11 | el parser pierde `authorClass` | 6 |
| M12 | el parser pierde `caveatsNotComputed` | 8 |
| M13 | `CAVEAT_CODES` sin `facilitator-authored` | 2 |

### Pre-CI local (comandos literales de `.github/workflows/ci.yml`, CI apagado)

Directorio nuevo con `git archive 30074ee` (sin `node_modules` ni `dist`), caché de npm vacía
(`npm_config_cache` nuevo, 35 MB descargados), **Node 20.20.2** (el del workflow; vía
`npx -p node@20`, sin instalar nada en el sistema), npm 11.7.0.

| Job | Comando | Resultado |
|---|---|---|
| validate | `npm ci` | exit 0 — 209 paquetes |
| validate | `npm run typecheck` | exit 0 |
| validate | `npm test` | exit 0 — **227 passed (227)**, 14 archivos |
| validate | `npm run lint` | exit 0 |
| validate | `npm run build` | exit 0 — cjs + esm + dts |
| validate | `npm pack --dry-run` | exit 0 — 40 archivos (incluye `CHANGELOG.md`) |
| validate | «Each built entry imports exactly what it is allowed to» (el `node -e` del workflow) | exit 0 — `OK: every entry imports exactly its declared set` |
| (extra, CLAUDE.md) | `npx tsc --noEmit -p tsconfig.eslint.json` | exit 0 |
| schema-drift | `npm run schema:check` | exit 0 — `OK: the live schema still matches the snapshot (22 paths, v2.0.0)` |

El commit de este handoff sólo agrega este archivo; el pre-CI se re-corrió sobre la cabeza que se
pushea y el resultado está en el PR.

### Los cuatro símbolos en `src` (sobre `30074ee`, sin tests)

```
src/caveats.ts:100:  'facilitator-authored',
src/caveats.ts:194:export class CaveatsNotComputedError extends Error {
src/caveats.ts:318:export function requireFullCaveats(result: WalletReputation): WalletReputation {
src/index.ts:126:  CaveatsNotComputedError,
src/index.ts:130:  requireFullCaveats,
src/parse.ts:309:        typeof r.author_class === 'string' && r.author_class !== '' ? r.author_class : null,
src/parse.ts:388:    caveatsNotComputed: parseNotComputed(payload.caveats_not_computed),
src/types.ts:226:  caveatsNotComputed: CaveatCode[] | null;
src/types.ts:432:  authorClass: AuthorClass | null;
```

(`require_full_caveats` es la grafía Python; en TS el símbolo es `requireFullCaveats`.)

## Lo que NO cambió, a propósito

- Ningún método cambió su tipo de retorno; nada lanza donde antes no lanzaba. El cliente nunca llama al
  gate; `failOpen` y `onFailure` quedan como en 0.3.0.
- `errors.ts`, `recovery.ts`, `DescribeErrorKind`: intactos (el diff contra `origin/main` no los toca).
- Cero dependencias de runtime nuevas; los tres entries importan exactamente su set declarado.
- Consumidores (EM, KK, MeshRelay, karma-hello): **no se tocaron** (upstream-first).
- `package-lock.json`: su versión raíz sigue en `0.1.0` desde 0.1.0; no se tocó (a `npm ci` no le
  importa).

## Para c0der

**Qué quedó:** PR contra `main` con un solo push (dos commits: el código `30074ee` y este handoff), sin
merge y sin tag. `PREGUNTA-c0der.md` queda sin trackear en la raíz del worktree de la Mac con los
mismos puntos que este handoff.

**Qué tiene que aplicar c0der, en orden:**

1. Revisar y mergear este PR **y** el de Python (`dn-sdk-caveats-py`) juntos: los dos publican el
   mismo contrato y la paridad de arriba sólo vale si salen los dos.
2. Tag `v0.4.0` sobre el merge (dispara `publish.yml`, que publica con `NPM_TOKEN`). Ojo: la cabecera
   de `publish.yml` todavía dice que nada está publicado, y npm ya tiene `0.3.0` (dato del encargo):
   ese comentario quedó viejo y este PR no lo toca.
3. Recién después del publish: despachar la adopción en EM, KK, MeshRelay y karma-hello, y la fila
   conjunta de `thin-chain` para los dos SDK.

**Cómo verificarlo en vivo (sin credenciales, gratis):**

```bash
# 1. El campo sigue en la API (esperado: la lista de 7 codes, ordenada)
curl -s https://api.describe.net/wallets/0x715dc035ffb97dd7bb4095c6670138ba05bb4e6d/chains \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).caveats_not_computed))"

# 2. El esquema vivo sigue siendo el del snapshot (esperado: OK, 22 paths, v2.0.0)
npm run schema:check

# 3. Tras el publish: el paquete publicado lanza el gate contra la API viva
#    (esperado: "CaveatsNotComputedError 7 false")
mkdir -p /tmp/dn-verify && cd /tmp/dn-verify && npm init -y >/dev/null && npm i uvd-describe-sdk@0.4.0 >/dev/null
node -e "
const { DescribeClient, requireFullCaveats, DescribeError } = require('uvd-describe-sdk');
(async () => {
  const rep = await new DescribeClient({ product: 'c0der-verify' })
    .wallet('0x715dc035ffb97dd7bb4095c6670138ba05bb4e6d');
  try { requireFullCaveats(rep); console.log('PASSED — wrong'); }
  catch (e) { console.log(e.name, e.notComputed.length, e instanceof DescribeError); }
})();"
```

**Lo que c0der tiene que saber del entorno:** la CLI de Orca no corre en esta Mac para ningún worker
(`/usr/local/bin/orca` es un symlink `root:wheel` con modo `0700` → *«Unable to determine Orca.app path
from symlink»*): no salieron heartbeats ni `worker_done`. El cierre está en este archivo y en el PR.
