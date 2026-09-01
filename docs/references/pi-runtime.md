# Pi runtime

JorgeX Stack integra Pi mediante dos capas coordinadas: el paquete Pi-native exacto y una proyección de recursos compartidos propiedad de Stack. Pi no se traduce a través del manifest de componentes ni del model map de Stack.

Esta referencia documenta la adopción del artefacto publicado exacto `jorgex-pi@0.8.0`, cuya entrada gestionada es `npm:jorgex-pi@0.8.0`. La versión de Stack que adopte este candidato debe fijar esa identidad en `src/lib/pi-runtime.ts`; esta documentación no afirma que una instalación concreta del usuario ni que `main` ya lo hayan consumido.

## Paquete e integridad

El artefacto de referencia es el [tarball `jorgex-pi@0.8.0` publicado en npm](https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-0.8.0.tgz), con `89128340` bytes. `src/lib/pi-runtime.ts` es la fuente autoritativa de los valores de integridad: tamaño, SHA-256 y SHA-512; la URL se deriva de la versión. No se duplican todos esos hashes aquí para evitar dos fuentes que puedan divergir.

La verificación del tarball sigue siendo obligatoria antes de cualquier operación gestionada. La entrada del paquete queda normalizada al objeto exacto:

```json
{ "source": "npm:jorgex-pi@0.8.0", "skills": [], "prompts": [] }
```

Los filtros `skills: []` y `prompts: []` se aplican únicamente después de que la proyección compartida haya terminado. Así el paquete no carga una segunda copia de los recursos comunes.

El gestor de paquetes interno de Pi es la única excepción npm del lifecycle: Stack usa pnpm para desarrollo, dependencias y herramientas globales, y nunca lanza npm directamente. El paquete registra un receipt separado en `~/.jorgex-stack/pi-receipt.json` únicamente después de que su runner confirme una instalación sana. Ese receipt es el hand-off del binario Engram verificado; no transfiere su propiedad a Pi ni a Stack.

## Procedencia, attestation y paridad

Estos identificadores describen objetos distintos y no deben intercambiarse:

- **Release checkout y productor del tarball**: `9f999747df3e335947a61d38e581555367973b09` (`main`, release de `0.8.0`). El checkout de release coincide byte a byte con el contrato raíz del tarball.
- **Fuente Stack de la paridad**: `11e7666ea4e40bde1de8bc434610747eb797ab9c`. Es el `parity.source.commit` de la snapshot compartida proyectada por Pi, no el commit productor de Pi.
- El metadata de registry no aporta `gitHead`; no se debe inventar uno.

La procedencia documentada se limita al checkout productor y al `parity.source.commit` confirmados por el candidato. La verificación de instalación vincula el tarball al tamaño y a los SHA-256/SHA-512 fijados en `src/lib/pi-runtime.ts`; no se inventa una identidad Git, una attestation o una firma adicional que no aporte el registry o el candidato.

## Inventario y contrato 0.8.0

La snapshot validada declara:

| Campo | Valor |
| --- | --- |
| `testedVersions` | `[0.84.2]` |
| `schemaVersion` | `1` |
| Runner | `jorgex-pi`, comandos `status`, `doctor`, `models`, `sync` y `cleanup`, contrato `v1` |
| `maxStdoutBytes` | `65536` |
| Escrituras externas gestionadas | `settings.json`, `models.json`, `jorgex-pi/sol-lifecycle.v1.json` |
| Paridad Stack | 15 agentes, 18 skills y 97 archivos de skill |
| Proyección Pi | 14 agentes runtime, 17 skills activas y el orchestrator primary durmiente |
| `parity.source.commit` | `11e7666ea4e40bde1de8bc434610747eb797ab9c` |
| Inventario del artefacto | `13403` entradas |

Las 14 capabilities del contrato son `foundation-contract-v1`, `stack-snapshot-v2`, `runtime-agents-v1`, `permission-gated-tools-v1`, `structured-questions-v1`, `web-access-v1`, `goal-continuation-v1`, `mcp-adapter-v1`, `engram-runtime-tools-v1`, `runner-json-v1`, `tui-branding-v1`, `managed-primary-model-v1`, `quality-receipt-contract-v1` y `quality-capabilities-contract-v1`.

Respecto al pin anterior `0.7.0`, se mantienen las 14 capabilities y el mismo runtime, la clausura de dependencias empaquetadas y las tres escrituras externas gestionadas. `0.8.0` añade `work-audit` a la snapshot y a la allowlist activa, pasando de 17 a 18 skills y de 96 a 97 archivos; el inventario del artefacto pasa de `13402` a `13403` entradas. El delta documenta la capacidad empaquetada y no crea una migración in-place.

## Proyección compartida de Stack

La proyección se ejecuta después de la instalación del paquete y se registra en `~/.jorgex-stack/pi-projection-receipt.json`:

| Recurso | Destino | Propiedad |
| --- | --- | --- |
| System prompt | `~/.pi/agent/AGENTS.md` | Stack, en secciones marcadas `jorgex:system-prompt` y `jorgex:engram-protocol` |
| Skills compartidas | `~/.agents/skills` | Stack; se conservan si también las usa otro runtime |
| Prompt | `~/.pi/agent/prompts/lean-audit.md` | Stack |

La proyección usa las mismas copias canónicas de `stack/` que los demás runtimes. El contenido del usuario fuera de las secciones marcadas se conserva. Cuando la preferencia gestionada de Playwright está activa, añade o retira dinámicamente la sección marcada `jorgex:browser` en `AGENTS.md`. `install --agents pi --playwright` instala y persiste Playwright con el mismo flujo opt-in que los demás harnesses. Chrome DevTools MCP y Context7 siguen fuera de este scope.

En el rollout de `work-audit`, el Stack publicado `1.9.0` sigue reconociendo y fijando Pi `0.7.0`. Este PR03 no cambia `package.json`; después del merge, el workflow publicará el primer patch libre de la línea `1.9.x`, esperado `1.9.1`, que deberá verificarse en T15 antes de tratarlo como el release que reconoce `npm:jorgex-pi@0.8.0`. Son canales secuenciales y con ownership separado; la adopción de este candidato no convierte la fallback del paquete en una segunda fuente de verdad.

## Lifecycle y seguridad

- `install` verifica el tarball, hace backup y ejecuta primero el paquete y después la proyección.
- `sync` repara drift del paquete o de la proyección sin duplicar recursos; dos pasadas consecutivas son idempotentes.
- `doctor` comprueba package receipt, projection receipt, entradas exactas, rutas y drift, pero no repara.
- `uninstall` hace backup antes de retirar, elimina únicamente lo declarado por los receipts y conserva archivos compartidos que sigan siendo propiedad de otro runtime.
- Si un receipt es ilegible, de otro scope, parcial o de historial desconocido, la operación destructiva falla cerrada; no se adopta ni se elimina estado manual silenciosamente.
- El binario y la base de datos/memorias de Engram son siempre del usuario. La instalación interactiva puede ofrecer el canal nativo con confirmación explícita; la base de datos y las memorias nunca se actualizan ni eliminan, y `uninstall` nunca borra el binario.

Las operaciones con `--target-dir` aíslan home, `PI_CODING_AGENT_DIR`, estado, backups y receipt dentro del target, sin consultar la configuración real de Pi o Engram.

## Transición 0.7.0 → 0.8.0 y rollback

La transición entre los pins `0.7.0` y `0.8.0` **no es in-place**. Cada release de Stack reconoce únicamente el receipt y el candidato que tiene fijados. Una versión que fija `0.8.0` rechaza un package receipt de `npm:jorgex-pi@0.7.0`; no reescribe el receipt, no cambia hashes y no borra el estado para forzar la confianza.

El Stack publicado `jorgex-stack@1.9.0` es la versión exacta corroborada que reconoce el pin `npm:jorgex-pi@0.7.0`. Este PR03 no cambia `package.json`; tras el merge, el workflow publicará el primer patch libre de `1.9.x`, esperado `1.9.1`. T15 debe verificar la versión finalmente publicada y su reconocimiento de `npm:jorgex-pi@0.8.0` antes de usarla en una instalación real. Si el usuario ya actualizó el binario de Stack, debe invocar la versión exacta que conoce el receipt, nunca `latest`. Los ejemplos siguientes son guía documental; no se ejecutan como parte de esta adopción:

```bash
# De un receipt Pi 0.7.0 a la versión que fije 0.8.0, después de T15:
pnpm dlx jorgex-stack@1.9.0 uninstall --agents pi
pnpm dlx jorgex-stack@<primer-patch-libre-1.9.x> install --agents pi
```

El rollback es simétrico y también exige la versión que conoce el receipt presente:

```bash
# De un receipt Pi 0.8.0 a la versión publicada que reconoce 0.7.0:
pnpm dlx jorgex-stack@<primer-patch-libre-1.9.x> uninstall --agents pi
pnpm dlx jorgex-stack@1.9.0 install --agents pi
```

En ambos sentidos, una operación debe detenerse si el receipt no es reconocido o la limpieza no puede verificar ownership. No se editan manualmente receipts ni hashes, no se borra `HOME`, Engram o la proyección de otro runtime, y no se usa una versión aproximada para saltarse el control.

Los antecedentes `0.6.1`/`jorgex-stack@1.7.5` y `0.4.0`/`jorgex-stack@1.7.1` se conservan solo como contexto histórico de transiciones anteriores; no son rutas válidas para esta adopción.

La regla de madurez de 24 horas de npm afecta únicamente a la instalación o consumo gestionado real del paquete Pi nuevo. La validación, el merge y la publicación de Stack pueden avanzar contra el artefacto exacto ya verificado; una instalación real antes de esa ventana requiere la excepción explícita de Jorge.

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

`jorgex-pi@0.8.0` gestiona su propia proyección primaria: `openai-codex/gpt-5.6-sol` y `contextWindow: 872000` para ese modelo. Pi registra ownership por campo y elimina únicamente valores canónicos que aún posea. 872K es metadata local solicitada, no una garantía del límite de contexto aceptado por el backend OAuth.

## Troubleshooting

| Resultado | Remedio |
| --- | --- |
| `tarball-integrity` | No omitas la verificación; reintenta desde un registro/red de confianza. |
| `unsupported-pi-version` | Usa la versión de Pi declarada por el candidato congelado. |
| `engram-required` / `engram-missing-target` | Configura Engram explícitamente; en target añade el binario dentro de `<target>/bin/engram`. |
| `manual-existing` | El paquete existe sin package receipt; consérvalo o retíralo explícitamente antes de pedir ownership gestionado. |
| `duplicate-package` / `source-divergent` | Conserva una única entrada exacta con `skills: []` y `prompts: []`, y vuelve a ejecutar `sync`. |
| `receipt-corrupt` / `receipt-untrusted` / `partial-state` | No borres el receipt a ciegas; inspecciona settings, proyección y scope, y usa el Stack publicado que reconoce ese pin para el rollback o la limpieza. |
| `projection-cleanup-failed` | Corrige el estado o restaura el backup y reintenta `uninstall`; no fuerces la eliminación. |
| `runner-output` / `runner-unhealthy` | Comprueba integridad, Engram y receipts antes de reinstalar. |

La evidencia autoritativa del paquete es el candidato congelado en `src/lib/pi-runtime.ts`; la de la proyección es `src/lib/pi-projection-lifecycle.ts` junto con `src/adapters/pi.ts` y los componentes compartidos que proyecta.
