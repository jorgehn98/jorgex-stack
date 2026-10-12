# Arquitectura: elección de lenguaje y ciclo de vida de soporte (Tema A)

Fecha de investigación: 2026-10-12. Método: WebFetch/WebSearch y Context7. El contenido de las páginas se trató como datos. Todo lo que no se pudo abrir lleva la marca NO VERIFICADO. Los criterios de las secciones 1, 2 y 5 son razonamiento de ingeniería de este informe, no citas; solo los datos con fuente enlazada están respaldados.

## 1. Criterios estables (no caducan)

Orden de peso típico, de mayor a menor. Cada criterio se evalúa con una pregunta comprobable.

1. **Conocimiento y mantenimiento del equipo.** ¿Quién va a mantener esto dentro de 2 años y qué sabe hoy? Un lenguaje que el equipo domina reduce errores y tiempo de entrega más que cualquier ventaja teórica de otro. Si el equipo es una sola persona, cuenta ella.
2. **Ecosistema y librerías necesarias.** Listar las 5 a 10 capacidades que el proyecto necesita (auth, pagos, PDF, ORM, cola de trabajos, SDK de un proveedor) y comprobar que existen librerías mantenidas, con releases recientes y sin dependencia de un único mantenedor. Una librería clave ausente pesa más que cualquier benchmark.
3. **Madurez.** Años en producción, gobernanza clara (fundación, empresa o comité), política de compatibilidad hacia atrás y ciclo de soporte publicado (sección 4).
4. **Contratación y continuidad.** Facilidad de encontrar relevo (personas o proveedores) para ese stack en el mercado del proyecto. Es un riesgo de negocio: si solo una persona lo domina, es un punto único de fallo.
5. **Tipado y seguridad.** Tipado estático y seguridad de memoria como reducción de riesgo según el dominio (sección 6). No es criterio universal.
6. **Rendimiento y concurrencia, solo si es un requisito medido.** Exigir una cifra (latencia p95, peticiones/s, memoria, coste por petición) y una medición o prueba de carga. Sin esa cifra, no es criterio de decisión. Casi todo lenguaje de propósito general cubre landings, webs, APIs y SaaS típicos.
7. **Modelo de despliegue.** Dónde corre (hosting estático, serverless, contenedor, VPS, móvil, escritorio), si el proveedor soporta ese runtime, tamaño y tiempo de arranque, y si hay un artefacto único (binario) o un runtime que hay que gestionar y parchear.
8. **Coste de cambiar luego.** Qué parte del sistema es difícil de reemplazar: el lenguaje es barato de cambiar si hay contratos claros (HTTP, esquemas, colas) entre módulos, y caro si el código es un monolito sin fronteras. Preferir fronteras explícitas a acertar con el lenguaje a la primera.
9. **Ciclo de vida de soporte.** Ver sección 4. Es un filtro eliminatorio: no se parte de una versión sin soporte.

Regla de uso: filtrar primero con 9 y 7 (descartes duros), decidir con 1 a 4, y consultar 5 y 6 solo cuando el dominio lo exige.

## 2. Tecnología aburrida e innovation tokens

- Fuente primaria: Dan McKinley, "Choose Boring Technology", 30 de marzo de 2015, https://mcfunley.com/choose-boring-technology (verificado: fecha y cita). Dice que cada empresa tiene "about three innovation tokens", y que elegir algo como NodeJS o MongoDB gasta uno; la oferta es fija durante un tiempo largo.
- Charla complementaria: https://boringtechnology.club/ (verificado). Cita: "Let's say that we all get a limited number of innovation tokens to spend", que representan "our limited capacity to do something creative, or weird, or hard"; "Early on in a company's life, we get like maybe three." La propia página llama al modelo "purely fictional": el número tres es una heurística del autor, no un dato medido. Esa página no muestra fecha.
- Aplicación a la skill (interpretación de este informe, no cita): tratar el lenguaje, el framework, la base de datos y el modelo de despliegue como candidatos a gastar tokens. Gastar un token solo cuando la novedad resuelve un problema del negocio que la opción aburrida no resuelve, y decirlo por escrito. Lo aburrido tiene modos de fallo conocidos, no menos fallos.
- Matiz crítico: "aburrido" es relativo al equipo y al contexto. Una tecnología nueva en el mercado pero dominada por el equipo cuesta menos que una popular que nadie conoce. Y el criterio no justifica quedarse en una versión sin soporte.

## 3. Tabla de decisión

| Situación | Criterio que pesa más | Motivo | Contraindicación |
|---|---|---|---|
| Landing o web de contenido, equipo pequeño | Conocimiento del equipo y modelo de despliegue | El valor está en publicar y mantener barato; hay poca lógica que proteger | No elegir un stack de aplicación completo si basta contenido estático |
| MVP/SaaS con un solo desarrollador | Conocimiento del equipo y ecosistema | La velocidad de entrega y las librerías ya hechas (auth, pagos) dominan | No gastar tokens en lenguaje y base de datos novedosos a la vez |
| API o SaaS con equipo creciente, vida larga | Tipado, contratación y continuidad | Más gente tocando código: los tipos documentan contratos y detectan roturas al refactorizar | No exigir tipado estricto en el día 1 de un prototipo desechable |
| Requisito de latencia/throughput medido y no cumplido | Rendimiento medido | Solo con cifra y medición se justifica cambiar de lenguaje o runtime | Optimizar sin perfil previo; suele ser la base de datos o la red, no el lenguaje |
| Software que procesa entrada no confiable en código nativo (parsers, motores, componentes de bajo nivel) | Seguridad de memoria | Los fallos de memoria son una clase de vulnerabilidad documentada por CISA, Microsoft y Google (sección 6) | No reescribir código estable existente solo por moda; priorizar código nuevo y de mayor exposición |
| Despliegue serverless o hosting con runtimes fijos | Modelo de despliegue y ciclo de vida | El proveedor define qué runtimes y versiones acepta, y cuándo las retira | Asumir que cualquier versión disponible hoy seguirá disponible; comprobar el calendario del proveedor además del del lenguaje |
| Se necesita una librería/SDK concreta | Ecosistema | Si el SDK oficial o la librería madura solo existe en un lenguaje, ese lenguaje parte con ventaja | Elegir por el SDK y olvidar el resto de requisitos |
| Proyecto heredado con equipo asentado | Coste de cambiar | Reescribir tiene riesgo alto y beneficio incierto | Mantener una versión sin soporte; actualizar dentro del mismo lenguaje es la primera opción |
| Equipo sin experiencia, quiere "el más moderno" | Contratación y continuidad, conocimiento | Un token mal gastado frena todo; el relevo es difícil | Rechazar toda novedad: si hay un requisito real que solo lo cubre, se paga el token con conciencia |
| Herramienta interna de corta vida | Conocimiento del equipo | El coste de mantenimiento es bajo y el riesgo, acotado | Olvidar que "temporal" suele durar años; fijar fecha de revisión |

## 4. Ciclo de vida de soporte: URLs oficiales y estado

Regla general de la skill: usar una versión con soporte activo (corrección de errores y seguridad), planificar la actualización antes de la fecha de fin de soporte y volver a consultar el calendario oficial en cada proyecto; las versiones y fechas cambian y no se deben copiar en la skill. Los modelos de soporte difieren y hay que leerlos en su página: LTS por números pares (Node.js, .NET), ventana fija de años por rama (Python, PHP), dos versiones mayores recientes (Go), solo la última estable (Rust), LTS elegidas por el proveedor (Java). Para TypeScript no se encontró política de soporte publicada (ver tabla).

| Lenguaje/runtime | URL oficial | Estado |
|---|---|---|
| Node.js | https://nodejs.org/en/about/previous-releases | Verificado 2026-10-12. Dice que producción debe usar solo Active LTS o Maintenance LTS |
| Python | https://devguide.python.org/versions/ | Verificado 2026-10-12 |
| Java (OpenJDK) | https://openjdk.org/projects/jdk/ | Verificado 2026-10-12 para el calendario semestral; la página no habla de LTS |
| Java (Oracle, LTS y fechas de soporte) | https://www.oracle.com/java/technologies/java-se-support-roadmap.html | NO VERIFICADO: la página devolvió HTTP 403. Solo hay un resumen de buscador sin abrir la fuente (ver sección 5) |
| .NET | https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core | Verificado 2026-10-12 |
| PHP | https://www.php.net/supported-versions.php | Verificado 2026-10-12 |
| Ruby | https://www.ruby-lang.org/en/downloads/branches/ | Verificado 2026-10-12 (lista de ramas, sin fechas) |
| Go | https://go.dev/doc/devel/release | Verificado 2026-10-12 |
| Rust | Política: https://doc.rust-lang.org/book/appendix-07-nightly-rust.html ; proceso interno: https://forge.rust-lang.org/release/process.html | Verificado el libro; la página de forge no explica política de soporte de versiones antiguas |
| TypeScript | https://devblogs.microsoft.com/typescript/ y https://www.typescriptlang.org/download/ | Verificado que no declara política de soporte ni fechas de fin; la página TypeScript Roadmap de GitHub está desactualizada (última edición 2023). Política de soporte: NO VERIFICADO / no publicada |

Reglas por runtime (leídas en las páginas anteriores, texto no volátil):

- Node.js: "LTS" suele garantizar correcciones críticas durante 30 meses en total; las versiones pasan por Current, Active LTS, Maintenance LTS y EOL. Las impares (hasta Node 26) dejan de tener soporte a los seis meses. La propia página anuncia que a partir de Node 27 el ciclo pasa a ser anual y toda versión mayor llegará a LTS. Es un cambio de política que la skill debe releer.
- Python: cada rama tiene fases (feature, prerelease, bugfix, security, EOL); soporte total de cinco años desde el lanzamiento; las fechas en cursiva de la tabla son programadas y pueden ajustarse.
- Java: OpenJDK publica una versión de característica cada seis meses con modelo "strict, time-based". Qué versiones son LTS y cuánto dura su soporte depende del proveedor (Oracle, Eclipse Temurin, Amazon, etc.); hay que mirar la página del proveedor que se vaya a usar.
- .NET: LTS (pares) tres años, STS (impares) dos años; hay que estar en el último parche para tener soporte.
- PHP: cada rama tiene dos años de soporte activo y dos más de solo seguridad crítica, cuatro en total.
- Ruby: la página agrupa ramas en mantenimiento normal, mantenimiento de seguridad y EOL; fechas no figuran en la página abierta.
- Go: "Each major Go release is supported until there are two newer major releases" (cita literal); se corrigen problemas críticos con revisiones menores.
- Rust: "The Rust project supports the most recent stable version. When a new stable version is released, the old version reaches its end of life" (cita literal del libro). No hay LTS en esa fuente; ciclo de seis semanas. Implica actualizar de forma regular (compatibilidad hacia atrás del lenguaje, no verificada aquí).
- TypeScript: el compilador es una herramienta de build fijada por proyecto (devDependency + lockfile, según la página de descarga). Cadencia de 3 a 4 meses esperada según el blog de la versión 7.0. Sin política de soporte publicada.

Comprobación práctica para la skill: (1) ¿la versión está en una fase con correcciones de seguridad? (2) ¿cuánto falta para su fin de soporte frente a la vida prevista del proyecto? (3) ¿el proveedor de despliegue soporta esa versión y hasta cuándo? (4) ¿hay política de LTS o de ventana fija, y la última lectura de la página tiene fecha?

## 5. Datos volátiles (verificados el 2026-10-12; no copiar a la skill)

No son recomendaciones. Sirven solo para comprobar que el método funciona hoy; releer las páginas antes de usarlos.

- Node.js (nodejs.org, previous-releases): v26 "Current" (primera versión 2026-05-05); v24 (Krypton) y v22 (Jod) figuran "LTS" sin distinguir Active/Maintenance en el texto leído; v25 y v20 figuran EOL. La página muestra "Latest LTS" v24.21.0 y "Latest Release" v26.11.1.
- Python (devguide): 3.15 en fase bugfix desde 2026-10-09; 3.14 bugfix; 3.13, 3.12 y 3.11 en seguridad. Fin de vida programado: 3.11 en 2027-10, 3.12 en 2028-10, 3.13 en 2029-10, 3.14 en 2030-10, 3.15 en 2031-10.
- Java (openjdk.org): última GA, JDK 27 el 2026-09-15; JDK 26 el 2026-03-17; JDK 25 el 2025-09-16; JDK 28 en desarrollo. Oracle: NO VERIFICADO directamente (HTTP 403). Un resumen de buscador, no la página, indicó LTS 8, 11, 17, 21 y 25, LTS cada dos años con 29 prevista para septiembre de 2027, y Premier Support de JDK 17 hasta septiembre de 2026 y de JDK 21 hasta septiembre de 2028 (Extended hasta 2029 y 2031 respectivamente). Tratar todo esto como NO VERIFICADO hasta abrir la página oficial.
- .NET (página actualizada 2026-09-08 según su propio texto): .NET 10 LTS, fin de soporte 2028-11-14; .NET 9 (STS) y .NET 8 (LTS) con fin de soporte el 2026-11-10; .NET 11 RC1 publicado el 2026-09-08.
- PHP (página fechada 2026-10-12): 8.2 solo seguridad hasta 2026-12-31; 8.3 soporte activo hasta 2025-12-31 y seguridad hasta 2027-12-31; 8.4 activo hasta 2026-12-31 y seguridad hasta 2028-12-31; 8.5 activo hasta 2027-12-31 y seguridad hasta 2029-12-31. La tabla abierta solo lista de 8.2 a 8.5, así que "las ramas anteriores están en EOL" es una deducción y no consta en el texto leído.
- Ruby: mantenimiento normal en 4.0 y 3.4; mantenimiento de seguridad en 3.3; EOL de 3.2 hacia atrás.
- Go: versión mayor más reciente go1.27.0 (2026-08-19); por la regla de dos versiones, 1.27 y 1.26 tienen soporte y 1.25 ya no (aplicación de la regla hecha por la herramienta de lectura; coherente con la cita, no verificada una a una).
- Rust: ciclo de seis semanas; no se extrajo número de versión actual.
- TypeScript: la página de descarga indica "currently 7.0"; el blog de lanzamiento tiene fecha 2026-07-08. El registro de Context7 lista también 6.0.2 y 7.0.2.

## 6. Tipado estático y seguridad de memoria: cuándo reducen riesgo y cuándo sobran

Hechos verificados:

- TypeScript es un superset tipado de JavaScript, comprueba antes de ejecutar (por ejemplo, propiedades mal escritas) y luego borra los tipos: "the type system itself has no bearing on how your program works when it runs" y nunca cambia el comportamiento en ejecución. Fuente: https://www.typescriptlang.org/docs/handbook/typescript-from-scratch.html (verificado). Consecuencia: no sustituye la validación de datos externos en tiempo de ejecución.
- Python: "The Python runtime does not enforce function and variable type annotations", solo las usan verificadores externos y editores. Fuente: https://docs.python.org/3/library/typing.html (verificado). El tipado en Python es opcional y depende de ejecutar un verificador en CI.
- TypeScript permite activar la rigurosidad por partes: la opción `strict` agrupa comprobaciones y se pueden desactivar individualmente (Context7, documentación de TypeScript 2.3, `/websites/typescriptlang`). Sirve para adopción gradual. Para librerías, la guía de opciones recomienda `strict: true`.
- Seguridad de memoria. CISA (Bob Lord, publicado el 2023-09-20, revisado el 2023-12-06, https://www.cisa.gov/news-events/news/urgent-need-memory-safety-software-products, verificado) cita: Microsoft, "~70% of the vulnerabilities Microsoft assigns a CVE ... each year continue to be memory safety issues"; Chromium, "around 70% of our serious security bugs are memory safety problems"; Mozilla, 32 de 34 vulnerabilidades críticas o altas relacionadas con memoria en el análisis que cita; Project Zero, 39 de 58 zero-days del año (67%) fueron de corrupción de memoria. Recomienda hoja de ruta de seguridad de memoria, lenguajes seguros para código nuevo (menciona Rust) y mitigaciones de hardware. La cifra del ~70% de Microsoft viene del blog del MSRC de julio de 2019; un buscador la devolvió con enlace, pero el original redirigió y no se leyó directamente (cifra verificada solo a través de CISA).
- CISA, "The Case for Memory Safe Roadmaps" (publicado 2023-12-06, https://www.cisa.gov/resources-tools/resources/case-memory-safe-roadmaps, verificado): pide a fabricantes publicar hojas de ruta para pasar a lenguajes seguros de memoria. La página no incluye porcentajes.
- NSA, guía de seguridad de memoria (CSI de noviembre de 2022): NO VERIFICADO (el PDF en media.defense.gov y la nota de prensa devolvieron HTTP 403). No citar su contenido.

Interpretación para la skill (razonamiento, no cita):

- Reduce riesgo de forma clara: código nuevo que corre en un entorno hostil y se escribe en C/C++ o equivalentes (parsers, navegadores, agentes, firmware, componentes de rendimiento crítico). Los datos anteriores son de grandes bases de código nativas.
- Aplica poco a landings, webs de contenido, SaaS y APIs típicas escritas en lenguajes con recolector de memoria (JavaScript, Python, Java, C#, Go, PHP, Ruby): ya están en lenguajes con gestión de memoria automática, y sus riesgos habituales (inyección, autenticación, configuración, dependencias) son de otro tipo. Esta afirmación es una conclusión de este informe; ninguna fuente abierta cuantifica esos riesgos para webs.
- El tipado estático ayuda en bases de código grandes, equipos que crecen, refactorizaciones frecuentes y contratos entre módulos. Es sobreingeniería en prototipos de vida corta, scripts de una sola persona o landings sin lógica, y no sustituye pruebas ni validación en los límites del sistema.
- Cambiar de lenguaje solo para ganar seguridad de memoria en un proyecto web típico no está respaldado por las fuentes abiertas.

## 7. Fuentes con estado

| Fuente | URL | Estado |
|---|---|---|
| McKinley, Choose Boring Technology (2015-03-30) | https://mcfunley.com/choose-boring-technology | Verificado |
| McKinley, boringtechnology.club (charla) | https://boringtechnology.club/ | Verificado, sin fecha en la página |
| Node.js releases | https://nodejs.org/en/about/previous-releases | Verificado |
| Python devguide versions | https://devguide.python.org/versions/ | Verificado |
| OpenJDK JDK project | https://openjdk.org/projects/jdk/ | Verificado |
| Oracle Java SE Support Roadmap | https://www.oracle.com/java/technologies/java-se-support-roadmap.html | NO VERIFICADO (403). Solo resumen de buscador |
| .NET support policy | https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core | Verificado |
| PHP supported versions | https://www.php.net/supported-versions.php | Verificado |
| Ruby branches | https://www.ruby-lang.org/en/downloads/branches/ | Verificado |
| Go release policy | https://go.dev/doc/devel/release | Verificado |
| The Rust Book, appendix on releases | https://doc.rust-lang.org/book/appendix-07-nightly-rust.html | Verificado |
| Rust forge release process | https://forge.rust-lang.org/release/process.html | Verificado; sin política de soporte |
| TypeScript download page | https://www.typescriptlang.org/download/ | Verificado |
| TypeScript 7.0 announcement | https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ | Verificado |
| TypeScript Roadmap (GitHub wiki) | https://github.com/microsoft/TypeScript/wiki/Roadmap | Verificado pero desactualizado (2023); no usar |
| TypeScript handbook, from scratch | https://www.typescriptlang.org/docs/handbook/typescript-from-scratch.html | Verificado |
| Python typing docs | https://docs.python.org/3/library/typing.html | Verificado (primeros 100 000 caracteres de 176 063) |
| Context7 TypeScript docs | /websites/typescriptlang, /microsoft/typescript | Verificado (resultado de consulta) |
| CISA, The Urgent Need for Memory Safety | https://www.cisa.gov/news-events/news/urgent-need-memory-safety-software-products | Verificado |
| CISA, Case for Memory Safe Roadmaps | https://www.cisa.gov/resources-tools/resources/case-memory-safe-roadmaps | Verificado |
| MSRC, A proactive approach to more secure code (2019) | https://msrc.microsoft.com/blog/2019/07/a-proactive-approach-to-more-secure-code/ | NO VERIFICADO directamente (redirigió a la portada del blog); cifra confirmada vía CISA |
| NSA, Software Memory Safety CSI (2022) | https://media.defense.gov/2022/Nov/10/2003112742/-1/-1/0/CSI_SOFTWARE_MEMORY_SAFETY.PDF | NO VERIFICADO (403) |
| NSA, nota de prensa de la guía | https://www.nsa.gov/Press-Room/Press-Releases-Statements/Press-Release-View/Article/3608324/nsa-releases-guidance-on-how-to-protect-against-software-memory-safety-issues/ | NO VERIFICADO (403) |

Limitación: las páginas se leyeron con un modelo de resumen intermedio de WebFetch, no en bruto; las citas literales vienen de su salida y los datos críticos deben releerse en la fuente antes de fijarlos.

## 8. Resumen final (qué cambiaría la recomendación de la skill)

1. La skill debe decidir por criterios y no por ranking; los pesos varían con el proyecto y el equipo.
2. El primer filtro es el ciclo de vida: usar versiones con soporte y leer el calendario oficial en cada proyecto, sin copiar fechas.
3. Si cambia el modelo de soporte de un runtime, la regla cambia: Node.js ya anuncia ciclo anual con LTS para todas las mayores desde la 27; releer la página.
4. Si el proveedor de despliegue retira un runtime antes que el lenguaje, manda el proveedor.
5. Java: elegir proveedor y mirar su política; la página de Oracle no se pudo verificar (NO VERIFICADO).
6. Rust solo soporta la última estable: exige actualizaciones regulares y cambia el coste de mantenimiento.
7. La heurística de los tres innovation tokens es del autor, no un dato; usarla como disciplina, no como cifra.
8. El rendimiento solo entra como criterio con una medición y un requisito numérico.
9. La seguridad de memoria pesa con código nativo y entrada hostil; en webs/SaaS típicos no hay fuente abierta que justifique cambiar de lenguaje por eso.
10. Los tipos de TypeScript y las anotaciones de Python no se aplican en ejecución; siempre validar entrada externa.
11. Si se consigue abrir la página de Oracle o la guía de la NSA, revisar las secciones 4 a 6.
12. Si el equipo no domina el lenguaje candidato, el criterio 1 anula casi cualquier ventaja técnica salvo un requisito duro.
