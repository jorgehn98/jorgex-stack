# Contrato de calidad y `jorgex.quality.receipt`

Esta es la referencia canónica del contrato de calidad agéntica del Stack. Describe la policy, sus estados, el receipt v1 y la frontera con Pi. No convierte una ejecución local en un gate de CI ni añade thresholds que la policy no declare.

La entrega documentada aquí expone el contrato JSON y la API TypeScript del receipt; no implica una CLI o un runner consumible. En PR01 no se ofrece ni se promete una CLI consumible, y no debe asumirse su disponibilidad antes de PR02.

## 1. Perfiles y selección de policy

Los perfiles válidos son:

| Perfil | Uso orientativo | Qué no implica |
| --- | --- | --- |
| `routine` | Cambio ordinario; es el valor por defecto. | No activa una lista universal de checks. |
| `elevated` | Cambio con riesgo o coordinación adicional. | No define por sí solo qué controles son obligatorios. |
| `high` | Cambio de alto impacto o sensibilidad. | No sustituye una policy explícita. |
| `release` | Candidato de release o publicación. | No prueba que exista un gate externo. |

La policy recibe un perfil y una lista explícita de controles. Si no se proporciona perfil, se usa `routine`. Un perfil desconocido es un error; no se degrada silenciosamente a `routine`. El perfil efectivo forma parte de `identity` y la policy efectiva queda vinculada mediante `policyDigest`.

Los nombres de perfil son una clasificación y un punto de selección. Los controles reales, sus requisitos y sus excepciones deben estar declarados por la policy de esa ejecución.

## 2. Controles, `required`/`optional` y estados

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

## 3. Receipt `jorgex.quality.receipt` v1

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

## 4. Canonicalización, identidad y redacción

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

## 5. Frontera con Pi y paridad

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

## 6. Casos límite

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
