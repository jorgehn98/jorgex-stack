# Fase 8: registro de decisiones y esqueleto mínimo opcional

Fecha de lectura de todas las fuentes: 2026-10-12. Las páginas se leyeron con WebFetch, que devuelve un resumen generado por un modelo pequeño, no el texto literal. Las citas entre comillas son las que ese resumen atribuye a la fuente. Antes de fijar redacciones textuales conviene releer la página original.

Texto dirigido a asistentes de IA: ninguna página lo tenía como instrucción. Nextjs.org incluye en el encabezado y pie punteros a `/docs/llms.txt` (índice para modelos). Es navegación, no instrucción, y se ignoró. Laravel usa "agents" solo como marketing.

---

## 1. Criterios estables (cambian poco)

### Parte 1: registro de decisiones

**Nygard 2011 (fuente original, verificada).**
- Secciones: Título (frase nominal corta), Contexto (fuerzas tecnológicas, políticas, sociales y de proyecto, descritas con neutralidad), Decisión (frases completas, voz activa), Estado ("proposed", "accepted", "deprecated", "superseded", con referencia al reemplazo) y Consecuencias (todas: positivas, negativas y neutras).
- Reglas: un registro por decisión significativa del proyecto; un archivo por decisión; numeración secuencial y monótona, "Numbers will not be reused"; formato de marcado ligero (Markdown); una o dos páginas; frases completas en párrafos, viñetas solo para maquetar.
- Inmutabilidad: "If a decision is reversed, we will keep the old one around, but mark it as superseded." No se borra.
- Ubicación en el artículo: `doc/arch/adr-NNN.md`.
- Las consecuencias de un registro suelen ser el contexto del siguiente.

**adr.github.io (verificada).** Es la página de la organización ADR en GitHub. Define Decisión Arquitectónica (AD), Requisito Arquitectónicamente Significativo (ASR), ADR (un registro de una AD con su justificación, compromisos y consecuencias) y "decision log" (la colección). Dice que el uso puede extenderse a decisiones de diseño y otras. La portada no indica ubicación ni plantillas concretas; sí enlaza la página de plantillas.

**Plantillas listadas en adr.github.io/adr-templates** (verificada):
- MADR, con versiones completa y mínima, cada una anotada o "bare" (vacía).
- Nygard (2011).
- Y-Statement (una frase: contexto, preocupación, opción elegida, cualidad deseada, desventaja aceptada; forma larga con alternativas y razón).
- Variante cards42 (Y-Statement con estado).
- Plantilla ISO/IEC/IEEE 42010 (Apéndice A, nueve elementos de información).
- Otras recopiladas en el repositorio de Joel Parker Henderson.

**MADR (verificada en adr.github.io/madr y en el repositorio adr/madr).**
- Versión vigente: 4.0.0, publicada el 17 de septiembre de 2024 (fecha del sitio; el año lo da adr.github.io/madr). En la lectura de GitHub Releases es la marcada "Latest" y no hay versiones posteriores.
- Licencia: doble, `MIT OR CC0-1.0`, a elección.
- Cuatro plantillas en `template/`: `adr-template.md` (completa con explicaciones), `adr-template-minimal.md` (solo secciones obligatorias con explicaciones), `adr-template-bare.md` (completa vacía), `adr-template-bare-minimal.md` (obligatorias, sin explicaciones).
- Metadatos opcionales en YAML front matter: status, date, decision-makers, consulted, informed.
- Secciones de la completa: título; Context and Problem Statement; Decision Drivers (opcional); Considered Options; Decision Outcome, con subsecciones Consequences (opcional) y Confirmation (opcional); Pros and Cons of the Options (opcional; por opción: Good, Bad, Neutral); More Information (opcional).
- Mínima (verificada literal): título, Context and Problem Statement, Considered Options, Decision Outcome ("Chosen option: ... because ..."), y Consequences como subsección opcional.
- Ubicación y nombre: `docs/decisions/NNNN-titulo-con-guiones.md`; subcarpetas opcionales.
- Estados citados en el comentario de la plantilla: proposed, rejected, accepted, deprecated, "superseded by ADR-0123". El sitio no define un conjunto cerrado ni un procedimiento de sustitución.
- Sin herramientas automáticas para MADR 3.0.0 según el sitio; markdownlint con la configuración de `template/.markdownlint`.
- Alcance según MADR: sirve para cualquier decisión importante, no solo arquitectónica.

**Fowler, "Architecture Decision Record" (verificada).**
- Es un documento corto sobre una decisión: la decisión, el contexto y las consecuencias relevantes.
- Formato: una página, pirámide invertida (lo importante primero), alternativas serias con pros y contras, nivel de confianza y los cambios de contexto que deberían llevar a reevaluar.
- Archivo con número monótono y título descriptivo, ejemplo `0001-HTMX-for-active-web-pages`.
- Estados: proposed, accepted, superseded (con enlace al sustituto).
- Cita: "Once an ADR is accepted, it should never be reopened or changed - instead it should be superseded."
- Ubicación: "The common advice is to keep decision records in the source repository", a menudo `doc/adr`.
- Cuándo escribir: decisiones de consecuencia que el equipo debe discutir y alinear. La página no da una lista explícita de cuándo no escribirlo.

**Cuándo escribir y cuándo no** (verificada en el repositorio de Joel Parker Henderson, fuente comunitaria, no oficial de Nygard ni de MADR):
- Escribir cuando afecta estructura, calidades, interfaces externas, mantenibilidad a largo plazo o forma de trabajo del equipo, o cuando el porqué se perdería.
- No escribir cuando no es arquitectónica, es mínima y reversible, de una sola persona, ya está cubierta por un estándar o política, o es temporal (parche, prueba de concepto, experimento).
- Convención de nombres de ese repositorio: verbo imperativo en minúsculas con guiones (`choose-database.md`). Difiere de la numeración de MADR/Fowler.
- Alternativa que describe para sustituciones: añadir información fechada al registro existente ("documento vivo") en vez de uno nuevo. Choca con Nygard y Fowler; no se adopta.

**Estados y cómo marcar una decisión sustituida sin borrarla** (síntesis de Nygard, Fowler y MADR):
1. Crear un registro nuevo con número nuevo.
2. En el viejo, cambiar solo el estado a `superseded by ADR-NNNN` (con enlace). Es el único cambio permitido en un registro aceptado.
3. En el nuevo, indicar `supersedes ADR-MMMM` y explicar qué cambió en el contexto.
4. No renumerar ni reutilizar números.
- Estado "rechazada" aparece en MADR, no en Nygard. "Deprecated/obsoleta" aparece en ambos.

**Ubicación habitual.** `docs/decisions/` (MADR), `doc/adr/` (Fowler), `doc/arch/` (artículo de Nygard), `adr/` o `decisions/` (Henderson). Todos dentro del repositorio del código.

### Parte 2: esqueleto mínimo

**Archivos de salud de la comunidad (docs.github.com, verificada).**

| Archivo | Qué hace según la documentación | Dónde lo busca GitHub | Proyecto pequeño |
|---|---|---|---|
| README | Explica qué hace el proyecto y por qué sirve, cómo empezar, dónde obtener ayuda y quién lo mantiene. Solo lo necesario para empezar a usar y contribuir. Límite de visualización 500 KiB | `.github`, raíz, `docs` (en ese orden) | Imprescindible |
| LICENSE | Las licencias open source permiten a otros usar, cambiar y distribuir. Nombre `LICENSE` o `LICENSE.md` | raíz | Decidir: imprescindible si se publica o comparte código; si el repo es privado, es decisión de titularidad (el propietario elige) |
| SECURITY.md | Instrucciones para reportar vulnerabilidades; versiones soportadas y cómo reportar | raíz (el perfil comunitario lo reconoce) | Solo si el repo es público o recibe reportes externos |
| CONTRIBUTING | Guías para PR e issues; GitHub enlaza el archivo al abrir issue o PR | `.github`, raíz, `docs` | Solo si hay colaboradores externos |
| CODE_OF_CONDUCT | Estándares de convivencia y cómo se resuelven problemas; hay plantillas | `.github`, raíz, `docs` | Solo comunidad abierta |

- El perfil de la comunidad es para repositorios públicos. La página lista README, CODE_OF_CONDUCT, LICENSE, CONTRIBUTING, SECURITY y plantillas de issues.
- Qué pasa sin licencia: la página de GitHub consultada no lo dice. No afirmar nada desde esta fuente; la consecuencia general (sin licencia no hay permisos de reutilización) no está verificada aquí.

**.gitignore (docs.github.com "Ignoring files", verificada).**
- Va en la raíz y se commitea para compartir reglas.
- Plantillas: repositorio github/gitignore (sistemas, lenguajes, entornos) y gitignore.io.
- Ignorar global: `~/.config/git/ignore`; solo local: `.git/info/exclude`.
- No afecta a archivos ya rastreados; hay que hacer `git rm --cached ARCHIVO` antes.
- La página no trata secretos ni salidas de build de forma específica.

**Twelve-Factor, Config (12factor.net/config, verificada).**
- "strict separation of config from code".
- Config en variables de entorno, gestionadas de forma independiente por despliegue.
- Test: el código debe poder abrirse en cualquier momento sin comprometer credenciales.
- Los grupos con nombre ("staging", "production") "does not scale cleanly".
- Valorar entonces: variables sueltas por despliegue, no un archivo por entorno.

**Archivo de ejemplo de variables.**
- Laravel 12.x (documentación oficial, verificada): una instalación nueva trae `.env.example`, que se copia a `.env`; con equipo, mantenerlo con valores de marcador; `.env` no debe commitearse por riesgo de seguridad.
- Next.js 16.4.0 (docs, `lastUpdated` 2026-08-25, verificada): `create-next-app` añade todos los `.env` al `.gitignore` ("You almost never want to commit these files"); `.env.test` sí se incluye y `.env*.local` no. No menciona `.env.example`.
- Vite (verificada): recomienda añadir `*.local` al `.gitignore`; las variables con prefijo `VITE_` quedan visibles en el cliente. No menciona `.env.example`.
- Conclusión: el `.env.example` sin valores reales está documentado oficialmente solo en Laravel. En el resto del ecosistema es PRÁCTICA COMÚN, no norma oficial; la búsqueda web solo halló guías de terceros.

**Lockfile (npm, verificada).** `package-lock.json` "is intended to be committed into source repositories" para que colegas, despliegues e integración continua instalen las mismas versiones. Es la fuente para npm; para otros gestores habría que verificar su documentación (NO VERIFICADO: pnpm, yarn, bun, composer, pip).

**CI (GitHub Actions, verificada).** Los workflows son archivos YAML en `.github/workflows` que pueden compilar y probar cada PR o push.

**Política de rama (GitHub, verificada).** Reglas de rama protegida: revisiones obligatorias de PR y comprobaciones de estado obligatorias (opción de exigir rama actualizada). Las listas de omisión solo existen en repositorios de organización; las restricciones de push, en repos públicos de organización Free o en planes Team/Enterprise. No se verificó una limitación específica para repos privados personales: confirmar en la configuración real.

---

## 2. Plantilla propuesta del registro

Base: MADR 4.0.0 `bare-minimal` + estado y consecuencias de Nygard. Lo marcado `[propio]` es adaptación mía, no de las fuentes.

```markdown
---
status: proposed   # proposed | accepted | rejected | deprecated | superseded by ADR-NNNN
date: AAAA-MM-DD
decision-makers: [nombres o roles]   # MADR
supersedes: ADR-NNNN                  # [propio] solo si sustituye
revisit-if: [condición que obliga a reevaluar]   # [propio, inspirado en Fowler: cambios de contexto que deben reabrir]
---
# NNNN. Título corto: problema resuelto y solución elegida

## Contexto y planteamiento del problema   <!-- MADR / Nygard -->
Fuerzas en juego, en frases completas y neutras.

## Opciones consideradas   <!-- MADR -->
* Opción A
* Opción B

## Resultado de la decisión   <!-- MADR -->
Opción elegida: "A", porque ... (una razón verificable).

### Consecuencias   <!-- Nygard: positivas, negativas y neutras -->
* Bueno: ...
* Malo: ...
* Neutro: ...

## Pros y contras de las opciones (opcional)   <!-- MADR -->
## Más información (opcional)   <!-- MADR; enlaces, evidencia, fuentes con fecha -->
```

**Convenciones propuestas [propio, derivadas de las fuentes]:**
- Ruta `docs/decisions/NNNN-titulo-con-guiones.md` (MADR). Un archivo por decisión, número no reutilizable, estado como único campo editable tras aceptar.
- Índice `docs/decisions/README.md` con una línea por registro: número, título, estado. [propio]
- Decisiones saltadas deliberadamente [propio, ninguna fuente lo define]: registrar un ADR corto de estado `accepted` con título "No decidir X todavía" o "Se omite X", con contexto (por qué ahora no), `revisit-if` (condición o fecha) y consecuencia (qué se asume mientras tanto). No dejar el hueco sin registro, porque desaparece la razón.
- Asuntos pendientes [propio]: ADR en estado `proposed` con las opciones ya conocidas, o una lista "Pendientes" en el README del índice con una frase y el criterio para cerrarlos. Cuando se decide, el ADR `proposed` pasa a `accepted` o `rejected`.
- Umbral de escritura: decisión difícil de revertir, con alternativas reales, que afecta estructura, calidad, interfaces o coste, o cuyo porqué se perdería (ver criterios de Henderson y Fowler). No registrar: preferencias menores, decisiones temporales o de una persona, lo ya cubierto por una norma.

---

## 3. Esqueleto mínimo (lista, antes del diseño visual)

Debe existir:
1. README con cómo arrancar: requisitos, instalar, ejecutar, probar, construir y variables necesarias.
2. `.gitignore` para el stack elegido, partiendo de github/gitignore; incluye `.env` y salidas de build; commiteado antes del primer `install`.
3. Archivo de ejemplo de variables (`.env.example` o equivalente) con nombres y valores de marcador, nunca reales; mantenido al día al añadir variables. Los secretos van por despliegue (Twelve-Factor).
4. Gestor de paquetes decidido y su lockfile commiteado (registrar la decisión en un ADR).
5. Comandos de instalar, construir y probar definidos y documentados (scripts del gestor o Makefile; usar lo que ya exista en el stack).
6. CI mínimo en `.github/workflows` con prueba y build en push y PR.
7. Política de rama y despliegue escrita en una o dos líneas en el README o en un ADR: rama principal, si hay PR obligatorio y comprobaciones requeridas, de dónde y cómo se despliega. Ajustar a lo que permita el plan de GitHub.
8. Licencia, o aviso de privacidad del repo si es privado, decidida por el titular. SECURITY, CONTRIBUTING y CODE_OF_CONDUCT solo si el repo es público o admite colaboradores.
9. `docs/decisions/` con la plantilla y los primeros ADR de las decisiones ya tomadas (stack, gestor de paquetes, despliegue), sin ADR vacíos.

No hacer:
- No generar código de negocio ni pantallas en esta fase.
- No instalar dependencias antes de decidir gestor y versión; si hay que instalar, que sea la decisión registrada.
- No crear carpetas o archivos vacíos por ceremonia (ni `docs/guides` ni ADR de relleno).
- No commitear `.env` ni secretos reales; no usar valores reales en el ejemplo.
- No copiar plantillas legales (código de conducta, licencia) sin decidir que aplican.

---

## 4. Datos volátiles (fecha de lectura 2026-10-12)

| Dato | Valor leído | Dónde revisar |
|---|---|---|
| MADR vigente | 4.0.0 (17 sep 2024), sin posteriores | github.com/adr/madr/releases |
| Licencia de MADR | `MIT OR CC0-1.0` | repositorio adr/madr |
| Plantillas MADR | 4 variantes en `template/` | tag 4.0.0 |
| Next.js docs | versión 16.4.0, actualizado 2026-08-25 | nextjs.org/docs |
| Laravel docs | 12.x marcada "old version"; existe 13.x | laravel.com/docs |
| npm | docs v11 de `package-lock.json` | docs.npmjs.com |
| Límites de rama protegida por plan | según plan y tipo de propietario | docs.github.com |
| Pestaña de seguridad GitHub | se llama "Security and quality" | docs.github.com |

---

## 5. Fuentes y estado

| Fuente | URL | Estado |
|---|---|---|
| Nygard 2011 | https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions | Verificada (resumen de WebFetch) |
| adr.github.io | https://adr.github.io/ | Verificada |
| Plantillas ADR | https://adr.github.io/adr-templates/ | Verificada |
| MADR sitio | https://adr.github.io/madr/ | Verificada |
| MADR repo | https://github.com/adr/madr | Verificada |
| MADR plantilla completa 4.0.0 | https://raw.githubusercontent.com/adr/madr/4.0.0/template/adr-template.md | Parcial: solo estructura, no texto literal |
| MADR mínima 4.0.0 | https://raw.githubusercontent.com/adr/madr/4.0.0/template/adr-template-minimal.md | Verificada (el inicio del front matter aparece truncado) |
| MADR bare-minimal 4.0.0 | https://raw.githubusercontent.com/adr/madr/4.0.0/template/adr-template-bare-minimal.md | Verificada |
| MADR releases | https://github.com/adr/madr/releases | Verificada, sin año; el año sale del sitio |
| Fowler ADR | https://martinfowler.com/bliki/ArchitectureDecisionRecord.html | Verificada |
| Henderson (comunitaria) | https://github.com/joelparkerhenderson/architecture-decision-record | Verificada, no oficial |
| Perfil comunitario GitHub | https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories | Verificada |
| README GitHub | https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes | Verificada |
| SECURITY GitHub | https://docs.github.com/en/code-security/getting-started/adding-a-security-policy-to-your-repository | Verificada |
| CONTRIBUTING GitHub | https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/setting-guidelines-for-repository-contributors | Verificada |
| CODE_OF_CONDUCT GitHub | https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/adding-a-code-of-conduct-to-your-project | Verificada |
| LICENSE GitHub | https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/adding-a-license-to-a-repository | Verificada; no explica el efecto de no tener licencia |
| .gitignore GitHub | https://docs.github.com/en/get-started/git-basics/ignoring-files | Verificada |
| Twelve-Factor Config | https://12factor.net/config | Verificada |
| Laravel 12.x config | https://laravel.com/docs/12.x/configuration | Verificada |
| Next.js env | https://nextjs.org/docs/app/guides/environment-variables | Verificada |
| Vite env | https://vite.dev/guide/env-and-mode | Verificada |
| npm package-lock | https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json | Verificada |
| GitHub Actions | https://docs.github.com/en/actions/get-started/understand-github-actions | Verificada |
| Ramas protegidas | https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches | Verificada |
| Búsqueda web de `.env.example` | resultados de terceros | Solo guías de terceros; no se usaron como fuente de afirmaciones |
| Lockfile de pnpm, yarn, bun, composer, pip | n/a | NO VERIFICADO |
| Sin licencia: efecto legal | n/a | NO VERIFICADO en fuente primaria |
| Decisiones saltadas y pendientes | n/a | Ninguna fuente lo define; es adaptación propia |

---

## 6. Resumen final

- Nygard define 5 secciones, numeración monótona sin reutilizar, un archivo por decisión y sustitución en lugar de borrado.
- MADR 4.0.0 (17 sep 2024, `MIT OR CC0-1.0`) es la base: usar la plantilla mínima por defecto y la completa solo si hay opciones reales que comparar.
- Ubicación recomendada `docs/decisions/NNNN-titulo.md`; Fowler y Nygard usan `doc/adr` y `doc/arch`.
- Sustituir = nuevo registro y cambiar solo el estado del viejo a `superseded by`.
- Decisiones saltadas y pendientes no tienen norma en las fuentes; propongo un ADR corto con condición de revisión (marcado como propio).
- Cuándo no escribir ADR viene de una fuente comunitaria (Henderson); Fowler no lo detalla.
- `.env.example` está documentado oficialmente solo en Laravel; en el resto es práctica común.
- Lockfile verificado solo para npm; otros gestores NO VERIFICADO.
- SECURITY, CONTRIBUTING y CODE_OF_CONDUCT solo para repos públicos o con colaboradores; el efecto de no tener licencia no se pudo confirmar.
- El esqueleto mínimo son 9 puntos y 5 prohibiciones, sin código de negocio ni estructura vacía.
