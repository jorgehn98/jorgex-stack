# Contrato de calidad y `jorgex.quality.receipt`

Esta es la referencia canónica del contrato de calidad agéntica del Stack. Describe la policy, el runner local, sus estados, el receipt v1 y la frontera con Pi. No convierte una ejecución local en un gate de CI ni añade thresholds que la policy no declare.

La CLI y el runner documentados aquí son locales y deliberadamente limitados: ejecutan un plan explícito, producen un receipt local y devuelven un código de proceso, pero no son un sandbox ni una autoridad de enforcement.

## 1. Runner local: `jorgex-stack quality`

### Uso

```text
jorgex-stack quality <plan.json> [--receipt <path>]
```

El comando acepta exactamente un plan JSON posicional y, opcionalmente, `--receipt <path>` (también `--receipt=<path>`). No acepta los flags de instalación, `--target-dir`, `--dry-run` ni `--yes`. Sin `--receipt`, escribe el receipt JSON canónico en stdout y añade una línea final; con `--receipt`, crea o reemplaza el archivo indicado.

El runner valida el plan completo antes de lanzar el primer proceso. Después ejecuta los comandos declarados en orden, de forma secuencial y sin fail-fast: un comando que falla no impide intentar los siguientes. Si el plan es ilegible, no es JSON válido o no cumple la forma mínima, la CLI informa el error por stderr, no produce un receipt y termina con código `1`.

### Acceptance black-box

La reproducción del oráculo de acceptance se hace desde la raíz del worktree con:

```powershell
pnpm exec vitest run tests/quality-cli-acceptance.test.ts
```

La suite no prueba imports ni un `dist` posiblemente obsoleto: su `beforeAll` resuelve Corepack y ejecuta el `pnpm build` real, con el worktree como `cwd`, antes de cualquier caso, con un timeout de build de 30 s. Después cada caso inicia Node contra `dist/cli.js`; para depurar por separado se puede ejecutar primero `pnpm build` y repetir el comando de Vitest. No se debe sustituir este flujo por un stub del CLI.

Cada caso crea un root con `fs.mkdtempSync` bajo `os.tmpdir()` y lo elimina en `afterEach`. El layout relevante es:

```text
<temp-root>/
  cwd with spaces/
  input/plan with spaces.json
  output/receipt with spaces.json
  markers/grandchild-marker.txt
  target dir/
  home/
  user-profile/
  app-data/
  local-app-data/
  codex-home/
  opencode-config/
  xdg-config/
  temp/
  tmp/
  tmpdir/
```

El harness externo espera como máximo 5 s por proceso de la CLI; si vence, intenta terminar su árbol (`kill-tree`) de forma best-effort.

El proceso real de la CLI se lanza con `cwd=<temp-root>/cwd with spaces`, `shell: false`, stdout/stderr capturados y este entorno explícitamente aislado:

| Variable | Root temporal asignado |
| --- | --- |
| `HOME` | `home/` |
| `USERPROFILE` | `user-profile/` |
| `APPDATA` | `app-data/` |
| `LOCALAPPDATA` | `local-app-data/` |
| `CODEX_HOME` | `codex-home/` |
| `OPENCODE_CONFIG_DIR` | `opencode-config/` |
| `XDG_CONFIG_HOME` | `xdg-config/` |
| `TEMP` | `temp/` |
| `TMP` | `tmp/` |
| `TMPDIR` | `tmpdir/` |

El plan siempre vive en `input/plan with spaces.json`. El receipt solo se espera en `output/receipt with spaces.json` cuando se pasa `--receipt`; sin ese flag el resultado se lee de stdout. Así se prueban rutas con espacios sin tocar la configuración real del usuario ni depender del `cwd` del proceso que ejecuta Vitest.

El caso de aislamiento toma snapshots recursivos pre/post de `cwd`, `input`, `output`, `markers`, `target-dir` y de los diez roots de entorno. El snapshot conserva entradas ordenadas, contenido de archivos, destinos de symlinks y el estado `missing`. El caso de rechazo añade sentinels `managed-sentinel-*` en esos roots y un receipt sentinel preexistente; el caso de timeout usa `grandchild-marker.txt` como marcador de proceso descendiente. Las aserciones exigen que los snapshots y sentinels observados queden exactamente como antes cuando no debe haber escritura; `afterEach` elimina todo el root temporal.

`quality` no gestiona runtimes ni sus configuraciones, por lo que rechaza `--target-dir`; el aislamiento de este comando no se obtiene con ese flag. La prueba de rechazo sí inicia el proceso real de la CLI, pero verifica que el comando declarado por el plan no llegue a hacer `spawn` ni escritura: el plan intentaría crear el marcador, mientras que stdout queda vacío, stderr menciona `--target-dir`, el exit code es `1`, el receipt sentinel no cambia y el snapshot post coincide con el pre. El `--target-dir` real pertenece a `install`/`sync`; aquí los roots temporales son la frontera observable.

#### Oráculo de los ocho casos

1. **Pass y entorno:** el CLI compilado real devuelve `0`, emite un receipt local por stdout, usa el `cwd` temporal, recibe la variable explícita y no hereda una variable ambiental del padre; no crea receipt en disco ni altera el snapshot.
2. **Receipt y reemplazo final:** `--receipt` reemplaza el receipt sentinel por un JSON válido, no escribe stdout y no deja temporales junto al destino. Este caso demuestra el reemplazo final, la validez del JSON, la sustitución del sentinel y la ausencia de temporales; no demuestra atomicidad ante un crash o interrupción ni observación concurrente.
3. **Fallo nonzero:** un proceso que termina con código `7` conserva `exitCode: 7`, proyecta el control a `fail` con `nonzero-exit` y la CLI devuelve `1`.
4. **Timeout de árbol:** con `timeoutMs: 250` en el comando interno y un grandchild que intentaría escribir tras `1000 ms`, un root que deja un grandchild termina como `incomplete` con razón `timeout`, conserva su excerpt y no permite que el grandchild escriba `grandchild-marker.txt` tras la espera acotada.
5. **Ejecutable ausente:** un ejecutable inexistente produce `unavailable`/`incomplete`, `spawn-error`, `exitCode: -1` y salida de CLI `1`.
6. **Límite de salida:** al alcanzar exactamente `maxOutputBytes`, el excerpt conserva exactamente esos bytes y el control queda `incomplete` con razón `output-limit`.
7. **Redacción y entorno:** argv y output no exponen los sentinels secretos; token, authorization, password y el campo JSON conocido se redactan, el entorno ambiental no se hereda y el receipt no contiene `environment`, `stdout` ni `stderr` completos.
8. **Rechazo de `--target-dir`:** el flag se rechaza antes de ejecutar el comando del plan; no hay escritura ni reemplazo del receipt, los sentinels y el snapshot gestionado permanecen intactos.

Este oráculo observa únicamente los paths temporales, los sentinels y la evidencia emitida por la CLI. No demuestra un sandbox del sistema operativo, no valida un guardian o hook, y no establece un bloqueo universal de egress/red. Tampoco prueba ausencia de escrituras fuera de los roots observados ni convierte un pass local en enforcement externo; esas garantías requieren controles distintos.

### Shape mínimo del plan

El plan de entrada tiene cuatro campos de nivel superior:

| Campo | Contrato mínimo |
| --- | --- |
| `identity` | Objeto con `baseSha` y `headSha`, ambos commits de 40 caracteres hexadecimales. |
| `profile` | Uno de `routine`, `elevated`, `high` o `release`. Es obligatorio en el plan. |
| `controls` | Array de controles con `id` no vacío y `requirement` igual a `required` u `optional`; los ids no se pueden repetir. `notApplicable`, si aparece, debe ser booleano. |
| `commands` | Array de comandos. Cada comando referencia un `controlId` existente y distinto, tiene `commandId` y `executable` no vacíos, `argv` como array denso de strings y `timeoutMs` como entero seguro no negativo. `env` y `maxOutputBytes` son opcionales; sus valores deben ser, respectivamente, strings y un entero seguro no negativo. |

Un control puede tener como máximo un comando en el plan. Un `required` sin comando no se considera superado: genera un resultado `incomplete`. Un plan sin ningún `required` también queda `incomplete` según la policy.

Ejemplo mínimo, sin credenciales ni valores sensibles:

```json
{
  "identity": {
    "baseSha": "0123456789abcdef0123456789abcdef01234567",
    "headSha": "fedcba9876543210fedcba9876543210fedcba98"
  },
  "profile": "routine",
  "controls": [
    { "id": "smoke", "requirement": "required" }
  ],
  "commands": [
    {
      "controlId": "smoke",
      "commandId": "smoke-node",
      "executable": "/usr/bin/node",
      "argv": ["-e", "process.stdout.write('quality ok\\n')"],
      "env": { "QUALITY_MODE": "check" },
      "timeoutMs": 2000,
      "maxOutputBytes": 65536
    }
  ]
}
```

Los SHA del ejemplo son marcadores con forma válida: deben sustituirse por el rango real. La ruta de `executable` también debe adaptarse al sistema; para evitar depender de un PATH implícito, es preferible usar una ruta absoluta. Si se usa un ejecutable resoluble por PATH, ese PATH debe declararse en `env`.

### `argv`, entorno y límites de ejecución

- `executable` y `argv` se pasan como argumentos separados a `child_process.spawn` con `shell: false`; una cadena como `test && deploy` no se interpreta como una línea de shell. No se interpolan variables ni se hereda el entorno del proceso de la CLI: si `env` se omite, el proceso hijo recibe un objeto de entorno vacío; si se proporciona, recibe únicamente esa copia explícita.
- En Windows, los shims `.cmd` y `.bat` requieren una ruta de compatibilidad por `cmd.exe`. El runner valida antes las partes contra metacaracteres de `cmd` y devuelve `error` con razón `unsafe-command` si encuentra alguno; no debe usarse esa excepción para construir comandos concatenados.
- `timeoutMs` es obligatorio por comando y está expresado en milisegundos. Al vencer, el runner intenta terminar el árbol del proceso: `taskkill /t /f` en Windows y el grupo de procesos en POSIX, con fallback al hijo raíz.
- `maxOutputBytes`, si se configura, limita conjuntamente los bytes capturados de stdout y stderr. Al alcanzar el límite, el runner conserva como máximo ese presupuesto, intenta terminar el árbol y devuelve `error` con razón `output-limit`. Si se omite, la captura no tiene ese límite y puede crecer con la salida del comando.

El receipt no conserva el entorno ni stdout/stderr completos. Conserva el `argv` saneado, un excerpt de la salida y el digest descritos en la sección del receipt. La redacción cubre patrones conocidos, no todos los secretos posibles; no pongas credenciales en el plan, el entorno, los argumentos ni la salida.

### Estados de comando y evaluación

El estado interno de cada comando y su proyección al resultado de control son distintos:

| Estado del comando | Cuándo aparece | Resultado del control / agregado |
| --- | --- | --- |
| `pass` | El proceso termina con código `0`. | `pass`, siempre que la policy aporte la evidencia requerida. |
| `fail` | El proceso termina con un código distinto de `0`. | `fail`; no se convierte en `pass`. |
| `timeout` | Se supera `timeoutMs`. | `incomplete`, con razón `timeout`. |
| `unavailable` | El proceso no se puede iniciar, por ejemplo por ejecutable ausente o sin permisos (`ENOENT`/`EACCES`). | `incomplete`, con razón `spawn-error`. |
| `error` | Se rechaza el comando por seguridad en un shim Windows o se alcanza `maxOutputBytes`. | `incomplete`, con razón `unsafe-command` u `output-limit`. |

La policy agrega los controles con precedencia `fail > incomplete > pass`. El runner siempre crea un receipt `authority: "local"` cuando el plan es válido, incluso si la evaluación termina en `fail` o `incomplete`; la CLI lo emite/escribe y después devuelve código `1`. El agregado no se serializa como un campo `status` propio del receipt: el código de proceso es la señal de la CLI y los resultados detallados quedan en `results`.

### Receipt y códigos de salida

El runner produce un receipt `jorgex.quality.receipt` v1 con `authority: "local"`. Su `identity` combina el perfil y los dos SHA del plan con `policyDigest`, calculado sobre la policy efectiva (`profile` + `controls`) en JSON canónico. El runner no puede producir `authority: "enforced"` ni añade `provenance`; un `pass` local no es un Quality Gate remoto.

La tabla de salida de la CLI es:

| Código | Significado |
| --- | --- |
| `0` | La policy agregada es `pass` y el receipt se pudo serializar y emitir/escribir. |
| `1` | La policy es `fail` o `incomplete`, o hubo un error de argumentos, lectura/parseo del plan, validación, serialización o escritura del receipt. No hay códigos distintos por timeout, unavailable o output-limit. |

Cuando la policy es `fail` o `incomplete`, el receipt normalmente sí se escribe antes de devolver `1`. Los errores que ocurren antes de construirlo —por ejemplo JSON inválido o un plan con ids duplicados— pueden no dejar ningún receipt.

`--receipt` usa escritura atómica: crea los directorios padre, escribe primero un temporal en el mismo directorio y lo mueve sobre el destino con `rename`. Si el movimiento falla, elimina el temporal y propaga el error. Esto protege frente a un archivo objetivo parcialmente escrito por esta operación; no es un mecanismo de locking entre escritores ni una garantía de durabilidad `fsync`. La salida por stdout no tiene esa garantía de reemplazo atómico.

### Límites: qué no garantiza

El runner es un orquestador local de procesos, no una frontera de seguridad:

- **No es un sandbox:** los comandos corren con la cuenta y los permisos del usuario y pueden leer/escribir archivos, ejecutar otros programas o modificar el sistema al que esa cuenta tenga acceso.
- **No controla egress:** no aplica una política universal de red, DNS o sockets. Un comando puede comunicarse con la red si el sistema lo permite.
- **No protege secretos de forma universal:** el entorno explícito evita heredar accidentalmente variables ambientales, pero el comando recibe exactamente lo que el plan le declara y puede leer otros secretos accesibles por el sistema. La redacción del receipt es una minimización heurística de patrones conocidos, no un detector ni un borrado retroactivo.
- **No contiene daemons ni procesos detached de forma universal:** `detached: true` se usa para facilitar la terminación del árbol en timeout/output-limit; no garantiza que un proceso que se desacople, se reparenta o se convierta en daemon termine, ni que no queden procesos en segundo plano.
- **No impone `authority: "enforced"`:** ni el código `0` ni el receipt local prueban autenticidad, enforcement de CI, merge o release. La autoridad `enforced` requiere un verificador externo que autentique el emisor y compruebe la evidencia; la forma del receipt por sí sola no lo hace.

## 2. Perfiles y selección de policy

Los perfiles válidos son:

| Perfil | Uso orientativo | Qué no implica |
| --- | --- | --- |
| `routine` | Cambio ordinario; es el valor por defecto. | No activa una lista universal de checks. |
| `elevated` | Cambio con riesgo o coordinación adicional. | No define por sí solo qué controles son obligatorios. |
| `high` | Cambio de alto impacto o sensibilidad. | No sustituye una policy explícita. |
| `release` | Candidato de release o publicación. | No prueba que exista un gate externo. |

La policy recibe un perfil y una lista explícita de controles. Si no se proporciona perfil, se usa `routine`. Un perfil desconocido es un error; no se degrada silenciosamente a `routine`. El perfil efectivo forma parte de `identity` y la policy efectiva queda vinculada mediante `policyDigest`.

Los nombres de perfil son una clasificación y un punto de selección. Los controles reales, sus requisitos y sus excepciones deben estar declarados por la policy de esa ejecución.

## 3. Controles, `required`/`optional` y estados

`required` y `optional` pertenecen a la definición de la policy, no al wire format de cada resultado:

| Requisito | Regla |
| --- | --- |
| `required` | Debe tener resultado. Un resultado `pass` necesita evidencia no vacía. `not-applicable` nunca es válido para un required. |
| `optional` | Puede no tener resultado sin bloquear por sí solo. Si se informa, `fail` o `incomplete` sí afectan al agregado. |
| N/A predeclarado | Solo un optional con `notApplicable: true` puede devolver `not-applicable`, y debe aportar un `reason` no vacío. |

La policy no acepta una ejecución sin ningún required: incluso si todos los controles son optional y N/A, el agregado es `incomplete`. También producen `incomplete` los controles desconocidos, duplicados o mal declarados, los resultados duplicados, un required ausente y un `pass` sin evidencia. La ausencia, el timeout, el error o la indisponibilidad de un required no se tratan como pass.

### Estados de resultado

Cada elemento de `results` usa uno de estos estados:

| Estado | Significado |
| --- | --- |
| `pass` | El control terminó correctamente y contiene `evidence` no vacía. |
| `fail` | El control terminó y falló. |
| `incomplete` | No hay evidencia suficiente para cerrar el control: falta, expiró, hizo timeout, falló la ejecución o quedó indisponible. |
| `not-applicable` | Excepción explícita y justificada para un optional permitido por la policy. |

`not-applicable` es un estado de control, no un estado agregado de policy. El resultado agregado solo puede ser `pass`, `incomplete` o `fail`.

### Precedencia

La agregación es fail-closed y aplica esta precedencia:

```text
fail > incomplete > pass
```

Por tanto, un solo `fail` domina a cualquier `incomplete` o `pass`; sin `fail`, cualquier `incomplete` domina a `pass`. Una entrada no declarada o inválida no se convierte en fallo de control automáticamente, pero hace que la evaluación sea `incomplete`.

## 4. Receipt `jorgex.quality.receipt` v1

El receipt es un registro de evidencia de una ejecución de quality policy. Su contrato canónico está en [`stack/contracts/quality-receipt.v1.schema.json`](../../stack/contracts/quality-receipt.v1.schema.json), JSON Schema draft 2020-12.

La raíz es cerrada (`additionalProperties: false`) y exige:

```text
namespace, version, authority, identity, commands, results
```

`provenance` es opcional para `local` y obligatorio para `enforced`.

### Identidad

`identity` es un objeto cerrado con los cuatro campos siguientes:

| Campo | Contrato |
| --- | --- |
| `profile` | `routine`, `elevated`, `high` o `release`. |
| `baseSha` | Commit base de la ejecución; 40 caracteres hexadecimales. |
| `headSha` | Commit evaluado; 40 caracteres hexadecimales. |
| `policyDigest` | SHA-256 de la policy efectiva en JSON canónico; 64 caracteres hexadecimales. |

El productor calcula el digest de la policy antes de crear el receipt. La API final separa la serialización de la comprobación contra una identidad esperada:

- `validateQualityReceipt(value, expectedIdentity?)` es la única función que acepta una identidad esperada. Si se proporciona y cualquiera de sus cuatro campos difiere, el receipt se rechaza para evitar mezclar evidencia de otro rango, perfil o policy.
- `serializeQualityReceipt(receipt)` recibe solo el receipt. No acepta `expectedIdentity`; aunque revalida la forma del receipt antes de serializarlo, no lo vincula a una identidad esperada.

`createQualityReceipt` construye y valida el receipt, pero la comprobación contra una identidad externa esperada corresponde a `validateQualityReceipt`.

### Comandos y resultados

Cada entrada de `commands` es cerrada y contiene `commandId`, `executable`, `argv`, `exitCode`, `durationMs`, `excerpt` y `outputDigest`:

- `commandId` y `executable` no pueden estar vacíos.
- `argv` es una lista de strings ya saneada.
- `exitCode` es entero; `durationMs` es un número finito no negativo.
- `excerpt` tiene como máximo 512 puntos de código Unicode; no se mide en unidades UTF-16 ni se corta un par surrogate.
- `outputDigest` es un SHA-256 del output saneado, no del excerpt truncado.

Cada entrada de `results` es cerrada, exige `controlId` y `status`, y permite `evidence` y `reason`. Si `status` es `pass`, `evidence` es obligatoria y no puede ser solo espacios.

La schema no exige que `commands` o `results` tengan elementos: que una policy esté completa es responsabilidad de la evaluación de controles, no de la forma del array.

### `authority`: local frente a enforced

| Authority | Semántica |
| --- | --- |
| `local` | Evidencia producida en el entorno local. Puede carecer de provenance y no garantiza enforcement de merge, release o CI. |
| `enforced` | Declaración no autenticada de que una autoridad externa respalda la evidencia. Exige provenance estructural; no autentica al emisor por sí sola. |

Un receipt local puede ser útil para diagnóstico, revisión o preparación, pero un `pass` local no equivale a un Quality Gate remoto. `authority: "enforced"` tampoco convierte por sí solo los campos de `provenance` en una atestación confiable: la schema y la API solo validan forma, identidad y presencia de provenance, no la autenticidad del issuer ni el contenido del locator.

Un consumidor solo puede tratar `enforced` como enforcement real si un verificador externo autentica al emisor y comprueba la evidencia. Como mínimo debe usar una allowlist explícita de issuers y verificar de forma independiente la ejecución, el locator y el digest; la alternativa es una firma criptográfica verificable sobre el receipt o la evidencia. El verificador externo y la opción de firma quedan para PR04; hasta entonces, `enforced` es únicamente una declaración estructural y no debe bloquear merge, release o CI por sí sola.

Para `enforced`, `provenance` es un objeto cerrado con:

| Campo | Contrato |
| --- | --- |
| `issuer` | Identificador no vacío de la autoridad que emitió la evidencia. |
| `executionId` | Identificador no vacío de la ejecución externa. |
| `evidenceLocator` | URL `http` o `https` de la evidencia externa. La schema declara además `format: "uri"` y el patrón `^https?://\\S+$`. |
| `evidenceDigest` | SHA-256 de esa evidencia; 64 caracteres hexadecimales. |

La validación no hace fetch del locator ni comprueba que su contenido siga disponible. El runtime también parsea la URL y rechaza protocolos distintos de HTTP(S) o espacios; `format: "uri"` es parte de la declaración de la schema y no sustituye esa verificación de runtime.

## 5. Canonicalización, identidad y redacción

La serialización del receipt usa JSON canónico: las claves de cada objeto se ordenan recursivamente, los arrays conservan su orden y no se añaden espacios ni una línea final. Así, `policyDigest` y los digests de output son reproducibles cuando se parte de la misma entrada.

`serializeQualityReceipt` vuelve a ejecutar la validación del receipt. Por eso, tanto `validateQualityReceipt` como `serializeQualityReceipt` rechazan una mutación que viole el contrato, por ejemplo un secreto sin redactar en `argv` o `excerpt`, un `excerpt` ausente o no textual, o un `outputDigest` inválido. Esto es validación estructural y de redacción, no una prueba criptográfica de que ningún campo semánticamente válido haya sido mutado: para fijar una identidad concreta hay que llamar a `validateQualityReceipt` con `expectedIdentity`, y la autenticidad de `enforced` requiere el verificador externo indicado arriba.

La normalización de comandos aplica estas reglas:

- No conserva `environment`, `stdout` ni `stderr` completos en el receipt.
- Redacta valores asociados a flags sensibles (`token`, `secret`, `password`, `api-key`, `authorization`, credenciales y equivalentes), asignaciones sensibles y tokens Bearer en el output.
- Redacta también valores de campos estructurados conocidos en texto tipo JSON, como `_authToken`, `AWS_SECRET_ACCESS_KEY` y `PRIVATE_KEY`, conservando la clave y sustituyendo el valor entre comillas por `[REDACTED]`. Es una lista de patrones conocidos, no un detector universal de secretos.
- Guarda solo un `excerpt` saneado de hasta 512 puntos de código Unicode; usa puntos de código, no unidades UTF-16, y no corta un par surrogate.
- Calcula `outputDigest` sobre `{ stdout, stderr }` después de redacción y antes del truncado del excerpt.

La redacción es una defensa de minimización, no una frontera de seguridad ni una garantía de detección de todos los secretos. `evidence`, `reason`, `issuer`, `executionId` y `evidenceLocator` se copian como metadatos del contrato: el productor debe evitar secretos, PII innecesaria y credenciales también en esos campos. Los digests no sustituyen controles de acceso.

### Retención y evidencia caducada

El contrato v1 no prescribe almacenamiento, subida, TTL, borrado ni retención central. Un receipt local puede conservarse solo durante la revisión o como artefacto local; un receipt enforced debe retenerse junto con la ejecución externa según la política de ese sistema. La retención no debe convertir automáticamente excerpts o locators en un archivo permanente.

Que `evidenceLocator` sea sintácticamente válido no prueba que siga accesible. Si la evidencia expira, no es localizable o ya no se puede comparar con `evidenceDigest`, el receipt puede seguir siendo JSON válido, pero la afirmación externa deja de estar verificable y el control dependiente debe quedar `incomplete` o ser rechazado por la policy de enforcement. No se debe presentar como pass por el mero hecho de que el receipt parsea.

## 6. Frontera con Pi y paridad

Pi **no es un adapter de Stack**. Claude Code, Codex CLI y OpenCode tienen adapters que proyectan componentes del Stack; Pi mantiene su package/projection lifecycle nativo. Pi no entra en el manifest de componentes ni en el model map del Stack.

La schema común nace en Stack:

```text
Stack: stack/contracts/quality-receipt.v1.schema.json
Pi:    contract/schemas/quality-receipt.v1.schema.json
```

La proyección Pi se registra en `contract/parity.v2.json`. Su `source.commit` identifica el commit de Stack desde el que se generó la copia. El objeto `parity.qualityReceipt` debe conservar la identidad de namespace/version, las rutas source/target y los SHA-256 de los bytes de origen y destino. El digest de destino debe corresponder a los bytes de la schema proyectada; no basta con declarar que los archivos son equivalentes.

`source.commit` es provenance de la proyección y no sustituye `identity.baseSha`, `identity.headSha` o `identity.policyDigest` de un quality receipt. Durante una review paralela puede apuntar al candidate revisado; antes de publicar o cerrar la integración debe regenerarse con el commit de Stack realmente mergeado.

Pi no duplica la fuente ni inventa otro wire format de calidad. Su contrato de paridad demuestra qué snapshot de Stack se proyectó; la schema de Stack sigue siendo la autoridad canónica.

### Receipts que no deben mezclarse

Los receipts de instalación y lifecycle de Pi quedan separados del quality receipt:

- `~/.jorgex-stack/pi-receipt.json` registra el hand-off y la integridad del paquete Pi gestionado.
- `~/.jorgex-stack/pi-projection-receipt.json` registra ownership, scope y estado de la proyección compartida.
- `jorgex.quality.receipt` registra evidencia de una policy de calidad.

Los dos primeros no son resultados de calidad, no deben adoptar el namespace `jorgex.quality.receipt` y no deben usarse para decidir `pass`/`fail` de una policy. Del mismo modo, un quality receipt no concede ownership ni autoriza la limpieza del paquete, de la proyección o de Engram.

## 7. Casos límite

| Caso | Tratamiento |
| --- | --- |
| Runtime o comando no disponible | El control requerido queda `incomplete`; no se convierte en pass. |
| Cero controles required | Evaluación `incomplete`, aunque los optional sean N/A válido. |
| N/A de required u optional no predeclarado | `incomplete`. |
| Receipt local sin provenance | Válido estructuralmente; no es enforcement externo. |
| Receipt enforced sin provenance completa | Inválido. |
| Locator externo caducado | La evidencia deja de ser verificable; no se presenta como pass. |
| Receipt de instalación/lifecycle de Pi | Contrato distinto; no se valida como `jorgex.quality.receipt`. |

## Verificación de esta referencia

La documentación se contrasta con la implementación `src/lib/quality-receipt.ts`, `tests/quality-policy.test.ts`, `tests/quality-receipt.test.ts` y la schema canónica enlazada arriba. La decisión para esta tarea es **no añadir tests**: no se introduce comportamiento, solo se documenta el contrato que ya cubren esos seams.
