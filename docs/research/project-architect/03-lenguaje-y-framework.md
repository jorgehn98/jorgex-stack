# 03-lenguaje-y-framework — borrador

Fuentes: informes/arq-lenguajes.md, informes/arq-frameworks.md (investigación propia con documentación oficial; sin material de terceros adaptado). Estado: borrador pendiente de revisión.
Reglas de la fase: decidir por criterios y por categoría, no por ranking ni por popularidad; los ejemplos solo ilustran. Versiones, ventanas de soporte, licencias y avisos son volátiles: se consultan en la fuente oficial el día de la decisión y se anotan con fecha; no se escriben en la skill.

## Entrada
Brief (01) y decisiones de 02 (plataforma, renderizado por zona, estilo de arquitectura). Si el proyecto ya tiene stack, se reutiliza salvo que el objetivo lo impida; esta fase entonces se reduce a comprobar su salud (ver "Señales de salud") y a decidir qué falta.

## Decisión A: lenguaje
Filtros duros primero, decisión después:
1. **Ciclo de vida de soporte** (eliminatorio): no se parte de una versión sin soporte. Se lee el calendario oficial del lenguaje o runtime y el del proveedor de despliegue (si el proveedor retira un runtime antes que el lenguaje, manda el proveedor). Sin copiar fechas a la skill.
2. **Modelo de despliegue**: qué runtimes acepta el hosting o la plataforma elegida en 02, tamaño y arranque, si el artefacto es un binario o un runtime que hay que parchear.
Decidir con, en este orden de peso:
3. **Conocimiento y mantenimiento del equipo** ("¿quién lo mantiene dentro de 2 años y qué sabe hoy?"). Anula casi cualquier ventaja técnica salvo un requisito duro. Si es una sola persona, cuenta ella.
4. **Ecosistema**: listar las 5-10 capacidades que necesita el proyecto (auth, pagos, PDF, ORM, colas, SDK de un proveedor) y comprobar librerías mantenidas, con releases recientes y sin depender de un solo mantenedor. Una librería clave ausente pesa más que un benchmark.
5. **Madurez** (años en producción, gobernanza, política de compatibilidad) y **contratación/continuidad** (si solo una persona lo domina, es un punto único de fallo).
Consultar solo si el dominio lo exige:
6. **Rendimiento y concurrencia**: solo con un requisito numérico y una medición (latencia p95, peticiones/s, coste por petición). Sin cifra no es criterio; suele ser la base de datos o la red, no el lenguaje.
7. **Tipado y seguridad de memoria**: el tipado estático ayuda con equipos que crecen, refactorizaciones frecuentes y contratos entre módulos, y sobra en prototipos de vida corta, scripts de una persona o landings sin lógica. Los tipos de TypeScript y las anotaciones de Python no se aplican en ejecución: siempre validar entrada externa. La seguridad de memoria pesa con código nativo y entrada hostil (parsers, motores, componentes de bajo nivel); para webs y SaaS en lenguajes con recolector de memoria, ninguna fuente abierta consultada justifica cambiar de lenguaje por eso (conclusión de la investigación, no cifra citada).
8. **Coste de cambiar luego**: el lenguaje es barato de cambiar con contratos claros (HTTP, esquemas, colas) y caro en un monolito sin fronteras: preferir fronteras explícitas a acertar a la primera.

**Tecnología aburrida** (McKinley, 2015): tratar lenguaje, framework, base de datos y modelo de despliegue como candidatos a gastar "tokens de innovación"; gastar uno solo cuando la novedad resuelve un problema real que la opción aburrida no resuelve, y dejarlo por escrito. Es una disciplina, no una cifra: el autor mismo llama "purely fictional" al modelo de los tres tokens. "Aburrido" es relativo al equipo: una tecnología nueva pero dominada cuesta menos que una popular que nadie conoce; y no justifica quedarse en una versión sin soporte.
Se permite un lenguaje distinto por capa (p. ej. frontend y backend) solo si hay motivo; un solo lenguaje reduce coste de contratación y de contexto.

## Decisión B: framework
Elegir primero la **categoría** (según el modo de renderizado de 02) y solo después un ejemplo concreto, validado con las señales de salud.

Frontend:
- **Contenido / islas**: landings, webs corporativas, blogs, catálogos con poca interactividad. No para estado de cliente denso compartido entre vistas.
- **Full-stack con renderizado en servidor** (meta-framework): producto con SEO y partes dinámicas, equipo pequeño. No si ya hay un backend maduro y solo hace falta UI estática, o si no se quiere operar un runtime de servidor.
- **Librería de UI para SPA**: aplicación tras login sin SEO. No para sitios públicos que viven de SEO sin añadir SSR.
- **Framework opinado para aplicaciones grandes**: muchos desarrolladores rotando, vida de años. No para prototipos, landings ni equipos de 1-2 personas.
- **Generador estático**: documentación, blogs, contenido que cambia con despliegues.
- **Sin framework**: landing de una o pocas páginas; con más páginas o estado, acaba reinventando uno.
Las categorías se solapan: muchos frameworks cubren varias según el modo. Elegir por el modo de renderizado que necesita el proyecto, no por la etiqueta.

Backend:
- **Minimalista**: API pequeña o servicio acotado con equipo que sabe qué piezas quiere. En un proyecto grande sin convenciones cada equipo reinventa auth, validación y migraciones.
- **Con baterías (MVC)**: SaaS o aplicación con base relacional, CRUD abundante, plazo corto, equipo pequeño. No para un servicio mínimo.
- **API de alto rendimiento / orientada a esquemas**: API pura para SPA, móvil o terceros con contrato OpenAPI. No si habrá vistas HTML y admin.
- **Backend como servicio (BaaS)**: MVP o equipo sin backend dedicado, reglas de acceso simples. No con lógica compleja, portabilidad o residencia de datos estrictas. Sin ejemplos verificados: se evalúa con las señales de salud más portabilidad de datos y precio/SLA del proveedor.

Atajos por tipo: landing de una página -> sin framework o generador estático; web con varias páginas, blog y SEO -> contenido/islas o generador; SaaS con parte pública y panel -> full-stack con renderizado en servidor; panel interno -> SPA; aplicación grande de larga vida -> framework opinado; API pura -> orientado a esquemas; aplicación de gestión con base relacional -> con baterías; microservicio pequeño -> minimalista; MVP sin backend -> BaaS.
Regla: lenguaje y experiencia del equipo primero, modo de renderizado después, categoría y ejemplo al final.

## Señales de salud (para cualquier framework o dependencia, y para auditar un stack existente)
Ninguna señal decide sola; combinar y anotar fecha. Checklist mínimo:
1. Abrir la política de soporte oficial y anotar la fecha de fin de la versión que se usaría; compararla con la vida esperada del proyecto (si la vida supera la ventana, el coste de migración entra en la decisión). Sin política publicada o versión 0.x: riesgo medio, fijar versiones y tener pruebas.
2. Revisar avisos de seguridad (GitHub Advisory Database, pestaña Security del repositorio): que existan indica proceso sano; cero avisos no prueba seguridad; mirar el tiempo entre aviso y corrección.
3. Consultar OpenSSF Scorecard: son heurísticas con falsos positivos y negativos; un -1 significa "no evaluable", no cero.
4. Leer licencia (a mano si la API de GitHub devuelve `NOASSERTION`) y gobernanza (fundación, empresa única, GOVERNANCE.md). Depender de una sola empresa es riesgo de rumbo o licencia, no un defecto en sí.
5. Localizar la guía de migración de la última mayor y si hay automatización (codemods, comandos de actualización).
6. Mirar cadencia de versiones, número de mantenedores y estado del repositorio (archivado, último push).
Las encuestas de la industria (Stack Overflow, State of JS, JetBrains) solo indican uso, con año y sesgo de muestra; nunca son criterio de selección.

## Entregable
Sección del registro de decisiones: lenguaje(s) y por qué, categoría y framework por capa, tokens de innovación gastados y su justificación, resultado del checklist de salud con fecha, versión elegida y fin de soporte, alternativas descartadas y "señales que harían revisar la decisión". `[NEED: …]` donde falte una respuesta del equipo.

## Verificación
- Cada elección enlaza con un requisito del brief o de 02; lo que no se justifique sobra.
- La versión elegida tiene soporte activo según la página oficial abierta ese día.
- Las librerías clave existen y están mantenidas (comprobado, no supuesto).
- Si el equipo no domina el lenguaje candidato, está dicho y se ha decidido conscientemente.

## Auditoría (modo revisar)
Comprobar: versión sin soporte o cerca del fin (bloqueante si ya no recibe parches de seguridad); dependencias clave abandonadas o con avisos sin corregir; framework de aplicación grande en un proyecto pequeño o a la inversa; varios lenguajes sin motivo; tecnología novedosa elegida sin justificar el gasto de innovación; versiones sin fijar con proyectos 0.x; migraciones mayores pendientes; dependencia de un único mantenedor. Severidad bloqueante para soporte terminado con exposición pública; alta para dependencias críticas sin mantenimiento; media o baja el resto.

## Puerta
No se pasa a 04 sin: lenguaje(s) y framework(s) elegidos con justificación enlazada al brief, versión con soporte activo verificada con fecha, librerías clave comprobadas, gasto de innovación declarado y checklist de salud hecho o marcado como no hecho.

## No verificado / pendiente
- Política de soporte oficial no visible: Nuxt, SvelteKit, Hono, NestJS, Phoenix, React Router; React y BaaS concretos no abiertos; Vue no define ventanas de soporte; FastAPI avisa de que versiones por debajo de 1.0.0 pueden romper.
- Java: la página de Oracle devolvió 403; ningún dato de LTS de Java pasa a la skill. TypeScript no publica política de soporte (solo cadencia de 3-4 meses en el anuncio de TypeScript 7.0). Rust solo soporta la última estable.
- Cifras de seguridad de memoria: solo la entrada de CISA (2023); la guía de la NSA no se pudo abrir.
- Encuestas: State of JS sin cifras citables; Stack Overflow y JetBrains solo parcialmente.
- Context7 puede ir por detrás de la documentación oficial (caso observado con Astro): la versión vigente se confirma en la web oficial.
- Citas literales y fechas de los informes salen de resúmenes automáticos de la herramienta de lectura: reabrir la URL antes de entrecomillar o fijar un dato.

## Enlaces oficiales a incluir (verificar al redactar)
Calendarios de soporte de Node.js, Python, .NET, PHP, Ruby, Go, Rust, OpenJDK; "Choose Boring Technology" (mcfunley.com); políticas de soporte del framework elegido; GitHub Advisory Database y docs de security advisories; scorecard.dev; CISA (memory safety); documentación de TypeScript y de typing de Python.
