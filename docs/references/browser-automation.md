# Browser automation

JorgeX Stack reemplaza la antigua skill `agent-browser` por dos integraciones **opt-in y explícitas**, sin mermar la política de cero secretos ni la regla "pnpm siempre". Este documento describe el comportamiento real de la versión publicada: instalación, lifecycle, coste contextual, seguridad y troubleshooting.

> **TL;DR**
>
> - **Recomendado**: Playwright CLI (`@playwright/cli@0.1.17`) + skill `playwright-cli` vendorizada. Cero schemas MCP permanentes, coste contextual casi nulo para sesiones que no navegan.
> - **Avanzado opt-in**: Chrome DevTools MCP en modo **full** (~29 tools, ~5,8–7,7k tokens de schemas). Default-off, selección por runtime, paquete fijado, telemetría deshabilitada, perfil dedicado en Chrome instalado.
> - **Excluidos por diseño**: Playwright MCP y Chrome DevTools MCP en modo `--slim` (duplican peor lo que Playwright CLI ya hace).

---

## 1. Por qué se cambió

`agent-browser` se distribuía sin instalar, versionar ni diagnosticar su CLI ni sus navegadores: una capacidad aparentemente disponible pero no operativa, con desalineación entre skill y binario y problemas abiertos en Windows/PowerShell/CDP/perfiles. El reemplazo decide **un** camino recomendado (Playwright CLI) y reserva Chrome DevTools MCP como diagnóstico avanzado, sin obligar a nadie a pagar el coste contextual de ~29 tools.

---

## 2. Playwright CLI (recomendado)

### 2.1 Qué se instala

| Pieza | Origen | Versión / pin |
|---|---|---|
| Skill `playwright-cli` | vendorizada en `stack/skills/playwright-cli/` | pinneada al commit `793cfb32572733cbcb401e6f28d05a7a914ce408` de `microsoft/playwright-cli` |
| Paquete `@playwright/cli` | npm (gestión global con pnpm) | pinneada a `0.1.17` en `upstreams.json` |
| Binarios del navegador | caché de Playwright (`%LOCALAPPDATA%\ms-playwright`, `~/Library/Caches/ms-playwright`, `~/.cache/ms-playwright`) | versión correspondiente al CLI |

El stack trata **skill + paquete como un bundle versionado**: una skill de `main` no se combina con un paquete npm antiguo. La skill se copia desde `stack/`; el paquete se instala con `pnpm add --global` y el navegador con `pnpm dlx <pinned>` (sin interpolación de shell, argv fijo).

> **Por qué no `playwright-cli install --skills`**: las escrituras directas del upstream saltarían el plan, los backups, el manifest y la reconciliación idempotente del stack. La skill se vendoriza deliberadamente.

### 2.2 Instalación explícita

La instalación global del paquete y la descarga del navegador son **siempre explícitas**. Ni `sync`, ni `--target-dir`, ni `--yes` las disparan por su cuenta.

```powershell
# Interactivo (TTY): pregunta consentimiento con recomendación activa.
pnpm dlx jorgex-stack install

# No interactivo / agente: --playwright autoriza la instalación global.
pnpm dlx jorgex-stack install --yes --playwright
```

Bajo el capó, `--playwright` ejecuta **dos** planes pnpm consecutivos como argv directo (`execFileSync`, sin shell):

```powershell
pnpm add --global @playwright/cli@0.1.17        # instala el paquete global
pnpm dlx @playwright/cli@0.1.17 install-browser # descarga los binarios del navegador
```

`pnpm add --global` registra el binario en el `PATH` global del usuario. `pnpm dlx <pinned> install-browser` usa la versión pinneada aunque haya otra distinta instalada (es un `dlx`, no un wrapper del binario global).

Ambos respetan la regla #1 del repo (**pnpm siempre, nunca npm**). Si `pnpm` no se resuelve (`lookPath("pnpm")` falla), el plan entero aborta con código no-cero y la preferencia no se persiste.

### 2.3 Uso desde los agentes

La skill `playwright-cli` (vendorizada) define el contrato completo (`open`, `goto`, `click`, `snapshot`, `eval`, `dialog-accept`, `press`, etc.). Los agentes invocan el binario global:

```powershell
playwright-cli open https://example.com
playwright-cli snapshot
playwright-cli click e15
playwright-cli close
```

No hay fallback automático a `pnpm dlx` desde los subagentes: el binario se espera instalado globalmente. Si no está, la invocación falla con `command not found` y `doctor` lo reporta como `missing:package`. La propia skill vendorizada incluye una nota `## Installation` con `pnpm dlx @playwright/cli@0.1.17 --version` para **verificar manualmente** la versión pinneada, no como canal operativo.

### 2.4 Lifecycle — `sync`, `doctor`, `update`, `uninstall`

| Comando | Comportamiento respecto a Playwright CLI |
|---|---|
| `sync` | Reaplica config y skills. **No instala** paquetes globales ni descarga navegadores. Si la preferencia dice "habilitado" pero falta binario o navegador, `sync` avisa y sugiere `install --playwright`. |
| `doctor` | Reporta el estado como `disabled` (sin preferencia), `healthy` (CLI + navegador listos), `missing:package` / `missing:browser` (preferencia activa pero algo falta), `broken` (binario no responde) u `outdated` (versión distinta del pin). No abre sitios ni repara estado. |
| `update --check` | Solo inspecciona Playwright CLI si la preferencia está `enabled` (un binario casual en `PATH` no es consentimiento). Compara la versión detectada contra el pin `0.1.17`; **no** consulta `npm latest` y **no** requiere `sync` después. |
| `update` interactivo | El multiselect incluye `playwright-cli` cuando la versión detectada no coincide con el pin; aplica `pnpm add --global @playwright/cli@0.1.17` con argv directo y una segunda confirmación explícita. No exige `sync` posterior (`resolveUpdateSyncRequired` solo dispara para cambios en `stack` o `skill:*`). |
| `uninstall` | Conserva el paquete global y los datos del navegador por defecto. `--remove-playwright` ejecuta `pnpm remove --global @playwright/cli` (sin sufijo de versión). |

### 2.5 Datos del navegador — el stack **nunca** los toca

El stack **nunca** borra ni modifica:

- La caché de binarios del navegador (`ms-playwright/`, `~/.cache/ms-playwright/`, `%LOCALAPPDATA%\ms-playwright\`, `~/Library/Caches/ms-playwright/`). Contiene subcarpetas `chromium-…` y `chromium_headless_shell-…`, **no** perfiles de usuario.
- Cookies, `localStorage`, `sessionStorage`, storage states (`storage-state.json`), vídeos, traces y screenshots que Playwright genere **fuera** de la caché.
- Perfiles persistidos por sesión vía `playwright-cli state-save` / `state-load` (esos archivos los crea el usuario donde quiera).

`uninstall --remove-playwright` solo retira el paquete npm global; no borra la caché ni nada que el usuario haya escrito fuera de ella. Para limpieza manual, ejecuta `playwright-cli close`, cierra el navegador y luego borra el directorio de caché si quieres empezar de cero.

### 2.6 Comportamiento bajo `--target-dir`

`--target-dir` es **solo** un modo de pruebas con un runtime específico. **Nunca** dispara instalaciones globales: ni del paquete, ni del navegador, ni de Chrome. Los planes `install`/`install-browser` se omiten aunque la preferencia esté activa.

---

## 3. Chrome DevTools MCP (opt-in avanzado)

Diagnóstico profundo de Chrome (red, consola, memoria, Lighthouse, performance traces). **No** es una segunda vía de navegación: para eso está Playwright CLI.

### 3.1 Coste contextual esperado

| Modo | Tools | Tokens de schemas | Decisión |
|---|---|---|---|
| `--slim` | ~3 | ~300 | **Excluido** — duplica peor Playwright CLI |
| `full` (default del paquete) | ~29 | ~5,800–7,700 | **Seleccionado** — diagnóstico real |

Las cifras vienen del `tools/list` publicado por el paquete; pueden variar entre versiones. La selección en el instalador muestra el disclosure para que el usuario decida informado.

### 3.2 Activación

Por defecto **desactivado** en los tres runtimes. Se activa por runtime y persiste en `~/.jorgex-stack/devtools-mcp.json`.

```powershell
# Interactivo (TTY, install): multiselect por runtime con disclosure del coste.
pnpm dlx jorgex-stack install

# Explícito en cualquier modo:
pnpm dlx jorgex-stack install --devtools       # activa en los runtimes destino
pnpm dlx jorgex-stack install --no-devtools    # desactiva
pnpm dlx jorgex-stack sync --devtools          # activa vía sync
pnpm dlx jorgex-stack sync --no-devtools       # desactiva vía sync
```

`--devtools` + `--no-devtools` juntos falla con mensaje claro. La selección queda guardada por runtime y sobrevive a `sync`/`uninstall`.

### 3.3 Comando y argumentos

El stack lanza siempre el mismo argv (versión pinneada, telemetría deshabilitada):

```powershell
pnpm dlx chrome-devtools-mcp@1.6.0 --no-usage-statistics
```

Sin keys, sin capabilities experimentales (`memory`, `vision`, `screencast`, `extensions`, `third-party`, `WebMCP`) habilitadas por defecto.

### 3.4 Chrome y perfil dedicado

El MCP **no** necesita un Chrome abierto. Por defecto:

- Usa el Chrome instalado del sistema (estable o Chrome for Testing).
- Lanza un **perfil dedicado**, separado de tu Chrome personal (no contamina cookies, extensiones ni sesiones).
- Conexión a un Chrome existente vía remote debugging es un modo avanzado opcional del upstream; el stack **no** lo automatiza ni lo activa por defecto.

Si Chrome no está instalado en la máquina, DevTools MCP falla con un mensaje claro al invocarse; el stack **no** descarga Chrome por ti.

### 3.5 Reconciliación quirúrgica

DevTools MCP se reconcilia como cualquier servidor opcional del manifiesto `stack/mcp/servers.json`:

- **enable**: añade la entrada gestionada a la config del runtime. Claude Code usa `~/.claude.json` (sibling del configDir, **no** `settings.json` — ese solo guarda hooks y permisos); Codex usa `~/.codex/config.toml`; OpenCode usa `~/.config/opencode/opencode.json`.
- **disable**: elimina la entrada gestionada; preserva cualquier entrada `chrome-devtools` escrita a mano (mismo nombre, sin marca de origen stack).
- **idempotencia**: `enable` repetido = cero cambios. `disable` sin haber habilitado = cero cambios.
- **`uninstall`**: retira solo entradas con marca de origen stack (ownership persistido en `~/.jorgex-stack/devtools-mcp.json`); nunca borra entradas manuales.

`~/.claude.json` es el archivo de estado del CLI de Claude (onboarding, proyectos): aunque quede vacío tras un unmerge, **jamás** se borra — se deja con `{}`.

---

## 4. Migración desde `agent-browser`

La retirada de `agent-browser` es **ownership-safe** y se basa **solo en el manifest** (`~/.jorgex-stack/manifest.json`):

- Se elimina únicamente el contenido declarado stack-owned por el manifest de una instalación previa. Un checksum no demuestra ownership — solo el manifest.
- Un `~/.agents/skills/agent-browser/SKILL.md` (u otro archivo del skill) que **no** esté en el manifest se conserva tal cual. La conservación es silenciosa: no se emite warning por residuo unowned.
- Si necesitas retirarlo a mano, hazlo directamente: `rm -rf ~/.agents/skills/agent-browser`.
- Si necesitas recuperarlo, usa `pnpm dlx jorgex-stack restore --list` y restaura el backup anterior (`~/.jorgex-stack/backups/`).
- La skill `playwright-cli` vendorizada no contiene el contrato legacy de `agent-browser`; la migración exige releer los flujos.

---

## 5. Seguridad y privacidad

- **Cero secretos**: el stack no inyecta keys en DevTools MCP. `chrome-devtools-mcp` y su launcher no aceptan keys; la regla "cero secretos en el repo" se mantiene.
- **Telemetría deshabilitada por stack**: el flag `--no-usage-statistics` está fijo en el argv. Cambiarlo requiere editar `stack/mcp/servers.json` y mergear.
- **Perfiles aislados**: DevTools MCP usa un perfil dedicado por defecto; no comparte estado con tu Chrome personal.
- **Sin conexión automática a tu Chrome personal**: el modo "conectar a Chrome existente vía remote debugging" es avanzado y opcional en el upstream; el stack no lo automatiza.
- **Comandos sin shell**: todas las invocaciones se planifican como argv directo (`execFileSync`); los shims `.cmd`/`.bat` de pnpm se validan antes de invocarse en Windows.
- **Sin cloud browser / stealth / CAPTCHA bypass**: Playwright CLI y DevTools MCP operan sobre el navegador local. El stack no añade proxies, rotación de identidad ni automatización anti-bot.

---

## 6. Troubleshooting

| Síntoma | Causa probable | Solución |
|---|---|---|
| `install` no pregunta por Playwright | Falta TTY o está `--yes` sin `--playwright` | Ejecuta sin `--yes` con TTY, o añade `--playwright` para autorizar. |
| `doctor` dice `Playwright CLI: deshabilitado (opcional)` | Nunca se ha confirmado la preferencia | Ejecuta `install --playwright` o confirma la opción en la próxima install interactiva. |
| `doctor` dice `Playwright CLI: … falta el navegador` | Paquete global presente, navegador no descargado | Ejecuta `install --playwright` (repite el plan `install-browser`). |
| `doctor` dice `versión distinta del pin aprobado` | `@playwright/cli` no coincide con `0.1.17` | `update` interactivo (TTY) lo alinea, o `install --playwright` para reescribir. |
| `playwright-cli: command not found` desde un subagente | Binario no en `PATH` global | El stack no fallback automático: `pnpm add --global @playwright/cli@0.1.17` para registrarlo. Para verificar manualmente: `pnpm dlx @playwright/cli@0.1.17 --version` (solo info, no operativo). |
| DevTools MCP no aparece en un runtime | No se activó por runtime o falta `sync` | Re-ejecuta `install --devtools` (o multiselect interactivo) y luego `sync`. |
| DevTools MCP falla con `Chrome not found` | Chrome no está instalado en la máquina | Instala Chrome (estable o Chrome for Testing) y reintenta. El stack no lo descarga. |
| `uninstall` retiró Playwright sin haberlo pedido | No es lo que ocurre por defecto | El paquete y los datos se conservan siempre que no se pase `--remove-playwright`. Si fue un error, restaura con `restore --list`. |
| `agent-browser` viejo en `~/.agents/skills/` | Migración ownership-safe (solo manifest) | Si está en el manifest, desapareció; si no, sigue intacto. Verifica con el manifest en `~/.jorgex-stack/manifest.json`. No hay warning automático para residuo unowned. |
| Claude Code no arranca DevTools MCP aunque `~/.claude.json` lo liste | El plugin oficial de Engram ya provee el MCP — `engram` se retira del `~/.claude.json` para no duplicar tools; pero DevTools MCP no tiene esa duplicación. Comprueba que la entrada `mcpServers.chrome-devtools` existe y que Chrome está instalado. |

---

## 7. Fuera de scope por diseño

Constan aquí para que nadie intente reintroducirlos:

- **Playwright MCP** (`@playwright/mcp`): aporta schemas MCP permanentes para lo mismo que ya cubre la CLI; el coste contextual no se justifica.
- **Chrome DevTools MCP `--slim`**: ~3 tools básicos que duplican peor Playwright CLI; pierde el valor diferencial del modo full.
- **Browser Use / Stagehand / Skyvern / Firecrawl** y proveedores cloud: orquestan navegadores remotos o agénticos; no se alinean con el modelo local-only del stack.
- **Conexión automática al Chrome personal del usuario**: deliberadamente no soportada por el stack. Si la necesitas, es un modo avanzado opcional del upstream que aquí se documenta pero no se automatiza.
- **Instalar Chrome** automáticamente: fuera de scope. El stack respeta la decisión del usuario sobre qué navegador instalar.
- **Borrar perfiles, cookies, storage state, traces, vídeos, capturas**: nunca. Ni en `uninstall`, ni en `update`, ni en `sync`. Limpieza manual si la quieres.

---

## 8. Referencias

- Skill vendorizada: `stack/skills/playwright-cli/SKILL.md` (referencias de `snapshot`, `test-generation`, `tracing`, `video-recording`, `storage-state`, `session-management`, `request-mocking`, `element-attributes`, `running-code`, `playwright-tests`).
- Pin canónico: `upstreams.json` → `skills.playwright-cli`.
- Manifiesto MCP: `stack/mcp/servers.json` → `servers.chrome-devtools`.
- Preferencias: `~/.jorgex-stack/playwright-cli.json` y `~/.jorgex-stack/devtools-mcp.json`.
- Contratos RED/GREEN cubiertos en `tests/external-tools.test.ts`, `tests/playwright-lifecycle.test.ts` y `tests/devtools-mcp.test.ts`.
- Migración ownership-safe cubierta en `tests/target-inventory-regressions.test.ts` ("preserva agent-browser modificado sin ownership y lo retira solo cuando un manifest válido lo declara").