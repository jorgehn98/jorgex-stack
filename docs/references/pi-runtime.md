# Pi runtime

JorgeX Stack integra Pi mediante dos capas coordinadas: el paquete Pi-native exacto y una proyección de recursos compartidos propiedad de Stack. Pi no se traduce a través del manifest de componentes ni del model map de Stack.

Esta referencia conserva la introducción histórica de `jorgex-pi@0.8.0` y las adopciones anteriores. El checkout fija el pin publicado `jorgex-pi@0.8.6`; `package.json` identifica la versión de Stack. La publicación de Stack usa el auto-bump existente al mergear y selecciona el patch disponible; el número final debe resolverse y confirmarse en el registro, no suponerse ni prepararse manualmente.

## Paquete e integridad

El artefacto histórico de referencia es el [tarball `jorgex-pi@0.8.0` publicado en npm](https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-0.8.0.tgz), con `89128340` bytes. El [tarball `jorgex-pi@0.8.6` publicado en npm](https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-0.8.6.tgz) es el pin adoptado por este checkout, con `89140981` bytes. La URL pública y los hashes exactos se contrastan con `src/lib/pi-runtime.ts` y `tests/fixtures/pi-runtime.ts`, que son las autoridades del pin en este checkout; esta referencia no fija un número futuro para la publicación de Stack. La URL se deriva de la versión.

La verificación del tarball sigue siendo obligatoria antes de cualquier operación gestionada. La entrada del paquete queda normalizada al objeto exacto:

```json
{ "source": "npm:jorgex-pi@0.8.6", "skills": [], "prompts": [] }
```

Los filtros `skills: []` y `prompts: []` se aplican únicamente después de que la proyección compartida haya terminado. Así el paquete no carga una segunda copia de los recursos comunes.

El gestor de paquetes interno de Pi es la única excepción npm del lifecycle: Stack usa pnpm para desarrollo, dependencias y herramientas globales, y nunca lanza npm directamente. El paquete registra un receipt separado en `~/.jorgex-stack/pi-receipt.json` únicamente después de que su runner confirme una instalación sana. Ese receipt es el hand-off del binario Engram verificado; no transfiere su propiedad a Pi ni a Stack.

## Procedencia, attestation y paridad

Estos identificadores describen objetos distintos y no deben intercambiarse:

- **Productor del tarball `0.8.6`**: `ad17c32d98dae15f14c6505152ca916f550a0c24`.
- **Fuente Stack de la paridad `0.8.6`**: `1510655a280a45af5c14f32cb87ce126dbee8edd`. Es el `parity.source.commit` de la snapshot compartida proyectada por Pi, no el commit productor de Pi.
- La identificación histórica de `0.8.0` se conserva en la sección de inventario; no debe reutilizarse para el pin actual.
- El metadata de registry no aporta `gitHead`; no se debe inventar uno.

La procedencia documentada se limita al checkout productor y al `parity.source.commit` confirmados por el release publicado. La verificación local vincula el tarball al tamaño y a los SHA-256/SHA-512 fijados en `src/lib/pi-runtime.ts`; son comprobaciones del mismo checkout, no raíces de confianza independientes. La attestation de provenance de npm es externa al runtime de Stack: `provenance.commit` es informativo salvo que se verifique expresamente esa attestation fuera de Stack.

## Inventario y contrato 0.8.0 (histórico)

La snapshot validada declara:

| Campo | Valor |
| --- | --- |
| `testedVersions` | `[0.84.2]` |
| `schemaVersion` | `1` |
| Runner | `jorgex-pi`, comandos `status`, `doctor`, `models`, `sync` y `cleanup`, contrato `v1` |
| `maxStdoutBytes` | `65536` |
| Escrituras externas gestionadas | `settings.json`, `models.json`, `jorgex-pi/sol-lifecycle.v1.json` |
| Snapshot canónica | 15 agentes, 18 árboles de skill y 97 archivos de skill |
| Allowlist activa | 14 agentes runtime, 17 skills activas y el orchestrator primary durmiente |
| `parity.source.commit` | `11e7666ea4e40bde1de8bc434610747eb797ab9c` |
| Inventario del artefacto | `13403` entradas |

Las 14 capabilities del contrato son `foundation-contract-v1`, `stack-snapshot-v2`, `runtime-agents-v1`, `permission-gated-tools-v1`, `structured-questions-v1`, `web-access-v1`, `goal-continuation-v1`, `mcp-adapter-v1`, `engram-runtime-tools-v1`, `runner-json-v1`, `tui-branding-v1`, `managed-primary-model-v1`, `quality-receipt-contract-v1` y `quality-capabilities-contract-v1`.

Respecto al pin anterior `0.7.0`, se mantienen las 14 capabilities y el mismo runtime, la clausura de dependencias empaquetadas y las tres escrituras externas gestionadas. `0.8.0` añade `work-audit` a la snapshot, que pasa de **17 a 18 skills** y de 96 a 97 archivos, y a la allowlist activa, que pasa de **16 a 17 skills**; el inventario del artefacto pasa de `13402` a `13403` entradas. `playwright-cli` permanece en la snapshot, pero fuera de la allowlist activa por ser opt-in. El delta documenta la capacidad empaquetada y no crea una migración in-place.

## Proyección compartida de Stack

La proyección se ejecuta después de la instalación del paquete y se registra en `~/.jorgex-stack/pi-projection-receipt.json`:

| Recurso | Destino | Propiedad |
| --- | --- | --- |
| System prompt | `~/.pi/agent/AGENTS.md` | Stack, en secciones marcadas `jorgex:system-prompt` y `jorgex:engram-protocol` |
| Skills compartidas | `~/.agents/skills` | Stack; se conservan si también las usa otro runtime |
| Prompt | `~/.pi/agent/prompts/lean-audit.md` | Stack |

La proyección usa las mismas copias canónicas de `stack/` que los demás runtimes. El contenido del usuario fuera de las secciones marcadas se conserva. Cuando la preferencia gestionada de Playwright está activa, añade o retira dinámicamente la sección marcada `jorgex:browser` en `AGENTS.md`. `install --agents pi --playwright` instala y persiste Playwright con el mismo flujo opt-in que los demás harnesses. Chrome DevTools MCP y Context7 siguen fuera de este scope.

En el rollout histórico de `work-audit`, Stack `1.9.2` adoptó Pi `0.8.0`; la versión publicada `1.9.3` conserva ese pin saliente. La publicación de Stack fue aceptada por npm y el readback confirmó metadata y tarball públicos; la madurez gestionada de 24 horas se mantiene separada de esas dos evidencias.

## Pin Pi 0.8.6 adoptado por Stack

El [tarball `jorgex-pi@0.8.6` publicado en npm](https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-0.8.6.tgz) tiene `89140981` bytes, SHA-256 `ad757f0ce1a6fb311239e5797a0823ebbfaeb6856d80275b6490b7176df6207e` y SHA-512 `5388aa38fdd2a4aa61f5ae2ee68de4863252a2954d682f9aba20ab7e06b5f72123b9bae4cc4193ec3de90e472ce2c1761a3ec70975629ef599fcd5600b271de6`. Su productor es `ad17c32d98dae15f14c6505152ca916f550a0c24` y su `parity.source.commit` de Stack es `1510655a280a45af5c14f32cb87ce126dbee8edd`. El tarball contiene `13405` entradas; la snapshot contiene `99` archivos; el paquete declara `17` skills activas y `18` árboles de skill.

El contrato del checkout usa `npm:jorgex-pi@0.8.6` y conserva las capacidades, el runner, las escrituras gestionadas y la política de modelo declaradas por la fuente ejecutable. La madurez gestionada de 24 horas afecta al consumo real del paquete Pi; no bloquea validación, merge ni releases. Al mergear, el auto-bump existente determina el patch disponible. La nueva versión de Stack sólo debe consumirse después de confirmar en el registro su versión exacta y que su pin reconoce `0.8.6`.

## Histórico: candidato Stack 1.9.6 / Pi 0.8.4

El release publicado histórico fijaba `npm:jorgex-pi@0.8.4`. La fuente ejecutable fijaba `89133070` bytes, SHA-256 `e30cbc0595bfbaa35b37f97096b77d46749315e3cf6ab13f830fe84432798b10` y SHA-512 `39255e7ccf7aad2cbe1069e2dbeb3335dc59f28ad1f0f32b677889e39e167e5fd39b546da9f448c33fad4581f0b4a8f1dda95a2f1b1bce010cc031b188ffc292`. Su `provenance.commit` era `2b5cf37d9bfdb0c574e66712000ecc432eca8a69`; el `parity.source.commit` comprobado en el artefacto era `5e89b970e72cfac0003b11e054c861bed6d44884`. Esta transición histórica quedó superseded por la adopción publicada de Stack `1.9.7` / Pi `0.8.4`.

Stack `1.9.5`, `1.9.6` y `1.9.7` son referencias históricas. La madurez gestionada de 24 horas se aplica al consumo real del paquete Pi nuevo, no a la validación, merge ni release de Stack.

## Lifecycle y seguridad

- `install` verifica el tarball, hace backup y ejecuta primero el paquete y después la proyección.
- `sync` repara drift del paquete o de la proyección sin duplicar recursos; dos pasadas consecutivas son idempotentes.
- `doctor` comprueba package receipt, projection receipt, entradas exactas, rutas y drift, pero no repara.
- `uninstall` hace backup antes de retirar, elimina únicamente lo declarado por los receipts y conserva archivos compartidos que sigan siendo propiedad de otro runtime.
- Si un receipt es ilegible, de otro scope, parcial o de historial desconocido, la operación destructiva falla cerrada; no se adopta ni se elimina estado manual silenciosamente.
- El binario y la base de datos/memorias de Engram son siempre del usuario. La instalación interactiva puede ofrecer el canal nativo con confirmación explícita; la base de datos y las memorias nunca se actualizan ni eliminan, y `uninstall` nunca borra el binario.

Las operaciones con `--target-dir` aíslan home, `PI_CODING_AGENT_DIR`, estado, backups y receipt dentro del target, sin consultar la configuración real de Pi o Engram.

## Receipt exacto y rollback

La transición adyacente es de `npm:jorgex-pi@0.8.5` a `npm:jorgex-pi@0.8.6`: Stack `1.9.17` reconoce el receipt de `0.8.5`; la nueva release de Stack, una vez publicada y confirmada en el registro, debe reconocer el de `0.8.6`. Antes de consumir una versión de Stack, resuelve su número exacto en el registro y comprueba que su pin reconoce el receipt presente; nunca uses `latest` ni una versión aproximada. No se borran `HOME` ni receipts. Si el receipt no es reconocido o la limpieza no puede verificar ownership, la operación se detiene; no se editan receipts ni hashes, no se borra `HOME`, Engram o la proyección de otro runtime.

Upgrade `0.8.5` → `0.8.6`, en este orden: (1) comprueba en el registro `jorgex-stack@1.9.17` y su reconocimiento del receipt `0.8.5`; (2) ejecuta con esa versión `uninstall --agents pi`; (3) resuelve en el registro la versión exacta de la nueva release y confirma que su pin reconoce `0.8.6`; (4) ejecuta con esa versión `install --agents pi`.

Rollback `0.8.6` → `0.8.5`, en este orden: (1) resuelve en el registro la versión exacta de la release que reconoce `0.8.6`; (2) ejecuta con esa versión `uninstall --agents pi`; (3) confirma en el registro `jorgex-stack@1.9.17` y su reconocimiento del receipt `0.8.5`; (4) ejecuta con `1.9.17` `install --agents pi`. No conviertas estos pasos en comandos con un identificador supuesto: cada versión debe salir del registro y del pin verificado.

Las parejas históricas se conservan como referencia y cada paso usa la versión de Stack que reconoce el receipt presente. No se editan receipts ni se borra estado manualmente:

```bash
# Receipt Pi 0.7.0 → 0.8.0
pnpm dlx jorgex-stack@1.9.0 uninstall --agents pi
pnpm dlx jorgex-stack@1.9.2 install --agents pi

# Rollback desde receipt Pi 0.8.0 → 0.7.0
pnpm dlx jorgex-stack@1.9.2 uninstall --agents pi
pnpm dlx jorgex-stack@1.9.0 install --agents pi

# Transición histórica Stack 1.9.6 / Pi 0.8.4
pnpm dlx jorgex-stack@1.9.5 uninstall --agents pi
pnpm dlx jorgex-stack@1.9.6 install --agents pi

# Rollback histórico Pi 0.8.4 → 0.8.3, usando primero la versión que reconoce cada receipt
pnpm dlx jorgex-stack@1.9.6 uninstall --agents pi
pnpm dlx jorgex-stack@1.9.5 install --agents pi
```

La regla de madurez gestionada de 24 horas de npm afecta únicamente a la instalación o consumo real del paquete Pi nuevo; no bloquea validación, merge ni release. Una instalación real antes de esa ventana requiere la excepción explícita de Jorge.

## Engram

Engram es obligatorio para el paquete gestionado, pero queda fuera de ownership. Si ya existe un binario válido, se conserva. Una instalación interactiva puede ofrecer el canal nativo con confirmación explícita por defecto negativa; `--yes` y los procesos sin TTY fallan con un remedio si falta Engram. La base de datos y las memorias nunca se actualizan ni eliminan, y `uninstall` nunca borra el binario. La ruta verificada se conserva en el package receipt como hand-off para el runtime.

## Comandos

| Comando Stack | Comportamiento Pi |
| --- | --- |
| `install --agents pi` | Verifica el tarball, instala y normaliza el paquete, proyecta recursos y escribe ambos receipts. |
| `sync --agents pi` | Reconcilia paquete y proyección; no instala recursos globales ni duplica skills/prompts. |
| `models --agents pi` | Devuelve routing heredado de la sesión; no escribe model map de Stack. |
| `doctor --agents pi` | Comprueba package/projection receipts, scope, entradas y drift. |
| `update --check --agents pi` | Ejecuta la comprobación Pi en modo lectura; no entra en el updater global. |
| `uninstall --agents pi` | Hace backup, limpia solo ownership verificable y conserva Engram y estado ajeno. |

`--dry-run` no ejecuta Pi ni escribe receipts.

## Modelo principal

El release publicado independientemente `jorgex-pi@0.8.6` gestiona su propia proyección primaria: `openai-codex/gpt-5.6-sol` y `contextWindow: 872000` para ese modelo. Pi registra ownership por campo y elimina únicamente valores canónicos que aún posea. 872K es metadata local solicitada, no una garantía del límite de contexto aceptado por el backend OAuth.

## Troubleshooting

| Resultado | Remedio |
| --- | --- |
| `tarball-integrity` | No omitas la verificación; reintenta desde un registro/red de confianza. |
| `unsupported-pi-version` | Usa la versión de Pi declarada por el release congelado. |
| `engram-required` / `engram-missing-target` | Configura Engram explícitamente; en target añade el binario dentro de `<target>/bin/engram`. |
| `manual-existing` | El paquete existe sin package receipt; consérvalo o retíralo explícitamente antes de pedir ownership gestionado. |
| `duplicate-package` / `source-divergent` | Conserva una única entrada exacta con `skills: []` y `prompts: []`, y vuelve a ejecutar `sync`. |
| `receipt-corrupt` / `receipt-untrusted` / `partial-state` | No borres el receipt a ciegas; inspecciona settings, proyección y scope, y usa el Stack publicado que reconoce ese pin para el rollback o la limpieza. |
| `projection-cleanup-failed` | Corrige el estado o restaura el backup y reintenta `uninstall`; no fuerces la eliminación. |
| `runner-output` / `runner-unhealthy` | Comprueba integridad, Engram y receipts antes de reinstalar. |

La evidencia autoritativa del paquete es el release congelado en `src/lib/pi-runtime.ts`; la de la proyección es `src/lib/pi-projection-lifecycle.ts` junto con `src/adapters/pi.ts` y los componentes compartidos que proyecta.
