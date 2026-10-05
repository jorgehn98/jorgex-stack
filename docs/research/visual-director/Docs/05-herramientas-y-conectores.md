# 05 — Herramientas externas y conectores

> Investigación y propuesta. 2026-10-02. Define cómo se introduce una herramienta externa en la futura skill: 1–2 frases con función, disponibilidad previa y setup condicional oficial. No instala ni conecta en esta fase. Fuentes en [fuentes.md](fuentes.md) (T01–T08).
>
> **Aviso de autoridad (2026-10-03).** Este capítulo se redactó bajo la arquitectura abierta del 2 de octubre. La **arquitectura mínima cerrada** del primer borrador vive en [`00-encargo-y-arquitectura.md`](00-encargo-y-arquitectura.md) (especialmente §8 referencias de herramientas y §9 propiedad/fronteras); la disciplina de "no instalar ni gastar sin permiso" se mantiene como en este capítulo, alineada con `00`.

## 1. Regla general

Una herramienta externa entra en la futura skill como **referencia breve**: una o dos frases con función, disponibilidad y setup condicional. El núcleo de la skill no absorbe manuales; el detalle vive en la documentación oficial y en la nota del usuario. La regla se inspira en la disciplina de referencias progresivas de la especificación de skills, no en una norma externa copiada.

**No son requisitos universales** Remotion, HyperFrames ni los MCPs. Se mencionan cuando el caso lo pide; se omiten cuando no.

## 2. Revisión local antes de cualquier acción

Antes de invocar, instalar o conectar, la skill revisa:

- **Dependencias locales del proyecto**: `package.json`, `requirements.txt`, `go.mod`, `pyproject`, `Cargo.toml`, etc., según el stack.
- **Binarios del sistema**: `command -v` y `--version` para los ejecutables candidatos; nunca se asume presencia.
- **Conectores disponibles**: MCP servers, wrappers, daemons.
- **Capacidades**: lo que la herramienta declara hacer hoy, no lo que hizo ayer.
- **Autenticación**: variables de entorno, claves, OAuth. **No se imprimen secretos, tokens, claves ni valores de log sensibles**. La skill verifica que existen; no las muestra.

## 3. Si falta la herramienta: justificar y pedir autorización

Cuando una herramienta candidata no está disponible, la skill:

1. Documenta la ausencia con el comando de comprobación usado y la salida obtenida.
2. Justifica por qué la pide, con referencia al caso (pipeline, patrón, demo).
3. Pide autorización con un **comando vigente acorde al sistema operativo y al package manager**: `npm i -g`, `pnpm add`, `brew install`, `apt install`, `docker run`, etc.
4. No instala nada por su cuenta en esta fase.

## 4. Plataforma generativa o MCP: preguntar antes de asumir

Cuando la pieza pide una plataforma generativa (imagen, vídeo, voz, música) o un conector (MCP) que el usuario no ha declarado, la skill **pregunta al usuario qué plataforma o cliente usa** y si quiere conectarla en esta sesión. No hay lista corta de proveedores predefinida por la skill: la elección la hace el usuario, no la herramienta.

Cuando el usuario declara una plataforma o ya la tiene conectada, la skill verifica lo declarado — `connected`, capacidades reales, `auth`, `scope` de uso y créditos — antes de invocarla. Si la conexión es remota con OAuth, normalmente **no requiere instalar un runtime local**; basta con añadir la URL/endpoint del MCP o el cliente oficial en el entorno del usuario, siguiendo el setup oficial del proveedor o servicio. Si falta, la skill pide al usuario la plataforma, su cliente o servicio preferido, y el setup oficial; no inventa comandos ni asume instalación local cuando la documentación indica lo contrario.

La investigación (T01–T08 en [fuentes.md](fuentes.md)) documenta ejemplos estudiados a fecha 2026-10-02 (Remotion, HyperFrames, OpenDesign, plataformas con MCP) como **evidencia fechada**, no como shortlist recomendada ni como requisito. La skill no asume que una plataforma concreta esté en uso solo porque figure en la investigación.

## 5. Ejemplos de referencia futura (no borrador de SKILL)

Estos ejemplos muestran el patrón. No son una lista corta de "lo que la skill recomienda": la elección final la hace el usuario.

- **Remotion** — vídeo programático en React. Si la pieza pide vídeo seekable, declarativo o por código y el proyecto usa React/frame, verificar `remotion` y `@remotion/cli` en el proyecto (`package.json`, lockfile, versiones compatibles). Si falta y el usuario autoriza, `npx create-video@latest` scaffoldea un proyecto nuevo o `npm install remotion @remotion/cli` con el PM y las versiones correctas en app existente (T01, T02). No tratar `npx create-video@latest` como "añadir deps a la app": scaffoldea.
- **HyperFrames** — vídeo HTML+JS seekable. Si la pieza encaja, verificar CLI/prereq (Node ≥ 22, FFmpeg). Si falta y el usuario autoriza, `npm install -g hyperframes` con permiso explícito; **separar deps, skills globales y proyecto**, ya que `init` actualiza skills globales además de scaffold (T03, T04). Existe flag `HYPERFRAMES_SKIP_SKILLS=1` documentado para CI/tests; no es receta universal.
- **OpenDesign** — opcional. Documentar requisitos desde snapshot (Node ~24, pnpm 10.33.x) sin tratarlos como eternos; elegir ruta de instalación (fuente o Docker) según entorno y permiso; no `sudo` ni `npm install -g opendesign` por defecto (T07, T08). El binario `od` en Unix puede ser la utilidad `octal-dump`; verificar antes de invocar.
- **Plataforma generativa o MCP (genérico)** — imagen, vídeo, voz, música, código, agentes. Cuando el usuario declara una, la skill comprueba `connected`, `caps`, `auth` y `scope`; si falta, pregunta al usuario qué plataforma usa, qué cliente o servicio, y pide permiso para seguir el setup oficial del proveedor. Cuando la conexión es remota con OAuth (MCP oficial), normalmente no requiere instalar un runtime local: se añade la URL o endpoint en el cliente que el usuario indique, y se autentica por OAuth. Los ejemplos de proveedores estudiados a 2026-10-02 (T05, T06) viven en [fuentes.md](fuentes.md) como evidencia fechada, no como shortlist.

## 6. Lo que instalar o conectar NO autoriza

- No autoriza **gasto**, **subida de material del proyecto**, **publicación** ni **lanzamiento de otro agente** desde la skill.
- `npx` puede **descargar y ejecutar** un paquete; no es una comprobación inocua. La skill lee lo que el paquete declara antes de invocar `npx`.
- Conectar un MCP no significa que la skill pueda gastar créditos del usuario en su nombre.
- **Autonomía dentro de un lote preacordado**: si el usuario ya autorizó un lote con presupuesto y permisos (por ejemplo, "genera hasta 50 imágenes de referencia usando la cuenta X, scope Y"), la skill actúa con autonomía mientras no se exceda el lote ni aparezcan condiciones no previstas. Pide reconfirmación cuando: (a) se excede el tope del lote, (b) aparecen datos sensibles nuevos no cubiertos por el scope, (c) aparece un proveedor o cuenta no previstos, o (d) se requieren permisos nuevos (otra cuenta, otro plan, gasto nuevo, subida de material, publicación, delegación a otro agente).
- Una herramienta ya instalada con uso y créditos previamente autorizados **no necesita nuevo permiso** para acciones dentro de ese scope. El permiso se pide cuando la acción sale del scope o se dan las condiciones (a)–(d) de arriba.

## 7. Lo que el núcleo no absorbe

- Manuales de uso, tutoriales paso a paso, comparativas de funciones.
- Catálogo de proveedores más allá de la referencia breve del caso.
- Procedimientos de recuperación ante fallos específicos de una plataforma.
- Un script genérico de preflight universal. La verificación se hace caso a caso cuando hace falta (comando, `--version`, OAuth presente, etc.); no se introduce un tooling de copia/preflight como parte de la skill, porque el usuario quiere referencias breves, no un nuevo tooling.

La investigación (incluida esta fase) puede documentar más detalle; la skill activa no. La profundidad vive en `Docs/`, en la documentación oficial y en la nota del proyecto.

## 8. Pendientes

- Confirmar el inventario de MCP servers disponibles en el entorno del usuario.
- Confirmar la política de gasto y subida de material por proyecto.
- Comprobar la presencia y versión de cada herramienta en el entorno concreto (con utilidades ya disponibles en el sistema); no se introduce un script externo obligatorio ni un prescript universal.
