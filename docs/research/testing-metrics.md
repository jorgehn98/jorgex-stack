# Métricas y testing para agentes

> **Aviso:** Investigación abierta; este documento no constituye una política vinculante ni autoriza ninguna implementación.

## Principio

Las métricas son señales para decidir dónde mirar, no sustitutos del juicio técnico. Una métrica solo merece entrar en JorgeX Stack si produce una acción:

- escribir o mejorar un test,
- reducir complejidad,
- revisar un límite,
- aislar un módulo,
- activar una verificación más fuerte,
- o aceptar explícitamente un riesgo residual.

## Coverage

Coverage responde principalmente a una pregunta: qué parte del código fue ejecutada por una suite concreta.

Tipos habituales:

- line/statement coverage,
- branch coverage,
- function/method coverage,
- condition/path coverage, cuando la herramienta lo soporta.

### Qué aporta

- Detecta código que ningún test ejecuta.
- Ayuda a localizar huecos en un cambio.
- Permite priorizar nuevas pruebas.
- Hace visible si una refactorización ha perdido protección.
- Puede alimentar otras métricas como CRAP.

### Qué no aporta

Coverage no prueba que el assert sea correcto ni que una entrada límite esté protegida. Una línea puede ejecutarse y el test puede no comprobar nada relevante.

Fuentes:

- [Google Testing Blog: Code Coverage Best Practices](https://testing.googleblog.com/2020/08/code-coverage-best-practices.html).
- [Martin Fowler: Test Coverage](https://martinfowler.com/bliki/TestCoverage.html).
- [Microsoft: unit testing best practices](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-best-practices).

### Política propuesta

No usar un único umbral global como definición de calidad. Usar:

1. coverage de los archivos o funciones cambiadas;
2. delta contra la base cuando sea estable y barato;
3. branch coverage en reglas con decisiones;
4. tendencia histórica para detectar degradación;
5. una explicación cuando el código quede sin cobertura y el riesgo sea aceptado.

Un 100% puede ser correcto en un módulo pequeño y crítico, pero no es una regla universal. El valor de la señal depende del tipo de código, del seam y de la calidad de las aserciones.

## CRAP

CRAP combina complejidad ciclomática y coverage de un método:

CRAP(m) = CC(m)^2 × (1 - cov(m))^3 + CC(m)

Donde:

- CC es la complejidad ciclomática;
- cov es la cobertura como fracción entre 0 y 1.

Propiedades útiles:

- con 100% de coverage, CRAP se reduce a CC;
- con 0% de coverage, CRAP se reduce a CC² + CC;
- la función castiga especialmente el caso complejo y poco probado.

Ejemplos aproximados:

| Complejidad | Coverage | CRAP | Lectura |
|---:|---:|---:|---|
| 5 | 0% | 30 | frontera; no supera el criterio histórico `> 30` |
| 5 | 80% | 5,20 | la cobertura reduce el riesgo medido |
| 10 | 0% | 110 | complejo y sin protección |
| 10 | 80% | 10,80 | sigue quedando complejidad estructural |

30 es la frontera: el criterio histórico de alerta es CRAP > 30, pero no debe tratarse como una ley natural. En el workflow específico de SwarmForge, el prompt del rol Cleaner fijado al commit `7d903e0d67c35a82167eb14d1b8a1905249d1db4` usa una disciplina más estricta, CRAP <= 6; no es un criterio general. La adaptación segura para JorgeX es usar CRAP para ordenar trabajo:

- informar primero de las funciones cambiadas con CRAP alto;
- bloquear solo si el perfil de riesgo lo exige;
- no penalizar automáticamente todo el legacy;
- preferir reducir complejidad, aumentar protección o ambas;
- conservar baseline y medir tendencia.

Fuentes:

- [Google Testing Blog: This Code is CRAP](https://testing.googleblog.com/2011/02/this-code-is-crap.html).
- [SwarmForge Cleaner prompt (commit 7d903e0d67c35a82167eb14d1b8a1905249d1db4)](https://raw.githubusercontent.com/unclebob/swarm-forge/7d903e0d67c35a82167eb14d1b8a1905249d1db4/swarmforge/roles/cleaner.prompt): regla específica de ese workflow, no criterio general.
- [CRAP formula and examples](https://github.com/breezy-bays-labs/crap-rs).

Nota: crap-rs no es un repositorio de Uncle Bob. Es una referencia técnica adicional y ofrece un adaptador para TypeScript/JavaScript; debe evaluarse antes de usarlo y no se incorpora automáticamente.

## Mutation testing

Mutation testing crea versiones deliberadamente defectuosas del código o de la especificación y ejecuta los tests:

| Resultado | Interpretación y tratamiento |
|---|---|
| `killed` | Un test detecta la mutación; evidencia de que la suite protege ese cambio. |
| `survived` | Los tests pasan pese al defecto simulado; requiere triage y normalmente una protección o justificación. |
| `no coverage` | Ningún test alcanza el punto mutado; es un hueco de cobertura, no un survivor. |
| `timeout` | La ejecución excede el límite; puede revelar un bucle introducido, pero exige triage y no se cuenta como verde sin resolver. |
| `memory error` | Error de infraestructura o de recursos; el resultado queda `incomplete`, nunca verde. |
| `run error` | Error al ejecutar la mutación o la suite; el resultado queda `incomplete`, nunca verde. |
| `non-viable` | La herramienta descarta la mutación por no ser ejecutable o útil; no demuestra que un test la mate. |
| `equivalent` | Conclusión de análisis humano de que la mutación no cambia el comportamiento; no es un estado PIT ni debe atribuirse automáticamente a PIT. |

Los errores de infraestructura (`memory error` y `run error`) hacen que el resultado sea incompleto/no verde. Un `timeout` puede ser una señal útil de un bucle, pero hasta completar el triage tampoco debe convertirse en pass ni clasificarse automáticamente como `survived`.

El objetivo no es tener muchos mutants, sino encontrar supervivientes accionables. Un survivor puede indicar:

- falta un caso límite;
- el assert es demasiado débil;
- el test verifica implementación en lugar de comportamiento;
- hay código muerto o un contrato mal especificado.

Fuentes:

- [PIT: mutation testing](https://pitest.org/?lang=en).
- [PIT: resultados y estados de mutación](https://pitest.org/quickstart/basic_concepts/).
- [Does mutation testing improve testing practices?](https://homes.cs.washington.edu/~rjust/publ/mutation_testing_practices_icse_2021.pdf).

### Dos mutaciones distintas

1. Mutación de código: cambia operadores, condiciones, retornos o llamadas para comprobar la suite de implementación.
2. Mutación de aceptación: cambia valores de ejemplos en la especificación o IR para comprobar que el acceptance test está conectado al sistema.

La segunda no es mutation testing del código fuente. [Acceptance Pipeline Specification](https://github.com/unclebob/Acceptance-Pipeline-Specification) separa explícitamente ambas ideas.

### Política propuesta

No ejecutar mutation completo en cada commit:

- por defecto: no;
- cambio de regla crítica: mutación diferencial de archivos o funciones cambiadas;
- módulo de seguridad, parser, permisos, billing o persistencia: mutation selectivo y property tests;
- release: suite más amplia si el tiempo y el toolchain lo permiten;
- guardar survivors con archivo, mutación, test que faltó y decisión.

Los límites deben incluir tiempo, workers, memoria y número de mutants. Un resultado incompleto debe ser failure explícito, no verde ambiguo.

## Property testing

Property testing genera muchos inputs para validar invariantes, no solo ejemplos elegidos a mano.

Propiedades candidatas en JorgeX:

- instalar dos veces produce cero cambios;
- unmerge conserva exactamente el contenido no gestionado;
- parsear y serializar preserva el significado;
- un manifest no puede escapar del HOME;
- la lectura externa puede permitirse según el runtime/perfil, pero write/edit/delete/execute fuera de las roots autorizadas se rechaza;
- un upsert conserva comentarios y secciones ajenas;
- un plan fallido no limpia huérfanos;
- una mutación de una preferencia corrupta falla antes de escribir.

Usarlo cuando la propiedad cubre una familia real de entradas. No sustituye los ejemplos de comportamiento que explican el producto.

## Perfil de calidad por riesgo

| Perfil | Señales mínimas | Señales adicionales |
|---|---|---|
| Routine | test/lint/typecheck/build relevantes | ninguna obligatoria |
| Elevated | testing decision + coverage del cambio si existe | CRAP informativo y revisión de seams |
| High | tests de contrato/integración + property si hay invariantes | CRAP, mutation diferencial, seguridad |
| Release/critical | suite completa aplicable + evidencia de criterios | mutation/acceptance/UI/adversarial según superficie |

La decisión del perfil debe quedar en la tarea y explicar por qué una señal cara no se ejecuta.

## Recomendación para JorgeX Stack

No añadir todavía un paquete de métricas universal. Primero documentar un contrato de salida para una futura skill de quality hardening:

- herramienta detectada o ausente;
- alcance analizado;
- baseline;
- métricas obtenidas;
- top riesgos;
- acciones sugeridas;
- límites y tiempo;
- resultado: pass, fail, incomplete o not-applicable.

La skill debe consumir herramientas nativas del proyecto y no instalar dependencias sin consentimiento explícito.
