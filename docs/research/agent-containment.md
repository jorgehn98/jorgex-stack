# Contención: un agente que no puede escapar de sus límites

> **Aviso:** Investigación abierta; este documento no constituye una política vinculante ni autoriza ninguna implementación.

## Tesis

No se puede garantizar que el modelo no intente saltarse una instrucción. Sí se puede diseñar el sistema para que determinadas acciones no sean ejecutables aunque el modelo:

- reciba prompt injection;
- interprete mal el objetivo;
- lea un archivo malicioso;
- invoque una herramienta con argumentos peligrosos;
- pida a otro agente que le preste permisos;
- intente editar sus propias reglas;
- entre en un bucle;
- o el humano apruebe por cansancio.

La frase operativa es:

> El modelo propone; una frontera externa autoriza y ejecuta.

El prompt es una guía de comportamiento, no una frontera de seguridad.

## Evidencia externa

- [OWASP LLM06: Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/): pide minimizar funciones, permisos y autonomía; aplicar complete mediation y aprobación humana para acciones de impacto.
- [OWASP AI Agent Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html): recomienda least privilege, autorización por herramienta, auditoría, límites de coste, pruebas adversariales y no confiar solo en la salida del modelo.
- [Anthropic: How we contain Claude](https://www.anthropic.com/engineering/how-we-contain-claude): distingue supervisar lo que hace el agente de contener lo que puede hacer; describe sandbox, VM y egress controls.
- [UK NCSC/NSA/CISA y socios: Careful adoption of agentic AI services](https://media.defense.gov/2026/Apr/30/2003922823/-1/-1/0/CAREFULADOPTIONOFAGENTICAISERVICES_FINAL.PDF): trata agentes como sistemas IT, recomienda defensa en profundidad, IAM, monitorización y least privilege.

La investigación de Anthropic también advierte que pedir aprobación en cada paso produce approval fatigue: los humanos tienden a aprobar demasiado cuando reciben muchos avisos. Por tanto, el control humano debe complementar una contención técnica, no sustituirla.

## Modelo de confianza

### Componentes

1. Humano: define objetivo, scope, recursos, límites de coste/tiempo y acciones que requieren aprobación.
2. Orchestrator: convierte el objetivo en tareas, pero no puede ampliar permisos.
3. Agent: planificador no confiable; puede proponer acciones y producir código.
4. Policy engine/guardian: proceso o runtime separado que revalida cada acción.
5. Tool gateway: expone capacidades pequeñas y con argumentos validados.
6. Sandbox/VM/container: impone filesystem, procesos, red y recursos.
7. Audit/kill switch: registra y puede detener el trabajo desde fuera del agente.

El agente no debe poder modificar el policy engine, el gateway, el sandbox, el kill switch ni sus credenciales desde el workspace que está trabajando.

## Controles no negociables

### 1. Complete mediation

Toda acción que toca un recurso protegido pasa por la política, siempre:

- no confiar en que el modelo recuerde la restricción;
- no confiar en que un wrapper sea llamado;
- no permitir una ruta alternativa directa;
- rechazar si falta política, versión o contexto de autorización;
- revalidar en el destino, no solo en la interfaz conversacional.

### 2. Capacidades mínimas

Preferir herramientas específicas:

- read_file(path permitido),
- write_file(path permitido),
- run_tests(command conocido),
- git_diff,
- create_commit.

Evitar una herramienta genérica execute_any_shell. Si el shell es imprescindible:

- allowlist de ejecutable y argv;
- rechazo de shell metacharacters y chaining;
- no aceptar cmd, PowerShell, sh o bash anidados sin una política específica;
- validación de cwd, input y output;
- límites de tiempo, memoria y procesos.

### 3. Sandbox y egress

El proceso debe ejecutarse con:

- worktree o workspace permitido;
- deny por defecto fuera del workspace;
- secrets ausentes del entorno;
- red denegada por defecto;
- allowlist de hosts si la tarea necesita red;
- procesos hijos limitados;
- filesystem temporal o snapshot cuando sea posible;
- rollback o destrucción del entorno al terminar.

El sandbox debe ser una capacidad del runtime, no una promesa del prompt.

### 4. Aprobación humana de impacto

Clasificar acciones antes de ejecutarlas:

- LOW: lectura y análisis local;
- MEDIUM: escritura en worktree, instalación local, cambios reversibles;
- HIGH: red externa, acceso a datos sensibles, publicación, credenciales, cambios destructivos;
- CRITICAL: producción, permisos, secretos, borrado irreversible, dinero o comunicación externa.

La aprobación debe estar ligada a:

- acción exacta;
- recurso y ruta;
- argumentos;
- diff o preview;
- identidad del aprobador;
- policy version;
- expiración y no reutilización.

Nunca aprobar solo el texto que el modelo genera. La autoridad de aprobar y la de ejecutar deben poder separarse.

### 5. Límites y circuit breakers

El humano controla, como mínimo:

- wall-clock máximo;
- tokens o coste;
- llamadas a herramientas;
- profundidad de delegación;
- reintentos;
- archivos y líneas modificados;
- procesos e hijos;
- tamaño de salida;
- workers concurrentes;
- número de mutantes;
- tiempo sin progreso;
- operaciones externas por sesión.

Si se alcanza el límite, el estado es stopped o incomplete. Nunca se presenta como pass.

### 6. Inputs no confiables

Web, README, issues, logs, outputs de herramientas, MCPs y archivos del repositorio son datos, no instrucciones de autoridad.

Medidas:

- conservar procedencia;
- separar datos y comandos;
- no guardar automáticamente instrucciones externas en memoria persistente;
- probar prompt injection directa e indirecta;
- no permitir que un agente de menor confianza otorgue permisos a otro;
- limpiar PII y secretos en logs.

### 7. Auditoría y parada externa

Registrar de forma estructurada:

- session, goal, task y agent;
- herramienta, argumentos normalizados y recurso;
- clasificación de riesgo;
- decisión de política;
- approval id;
- resultado;
- policy version;
- timestamps;
- hash de configuración o prompt relevante.

El kill switch debe funcionar aunque el agente no coopere. El log debe sobrevivir al proceso y no poder ser borrado desde el workspace.

## Diseño de referencia para JorgeX Stack

JorgeX ya tiene permisos por runtime, worktrees, defaults read-anywhere, denies de secretos, target-dir, backups, manifest y modos human/programmatic. La siguiente capa debería ser una política común, con adapters que solo traduzcan formato:

- policy declarativa canónica;
- capability set por agent y por task;
- filesystem scope explícito;
- red y herramientas externas como opt-in;
- ask para impacto alto;
- deny absoluto para secretos, policy files y rutas fuera de scope;
- circuit breakers en Goal Mode y tareas programáticas;
- evidencia de cada denial y approval;
- pruebas de escape como parte del quality gate del stack.

Importante: si un runtime solo puede expresar parte de la política, debe reportarlo como limitación visible. No se debe presentar una restricción de prompt como enforcement técnico.

## Suite mínima de pruebas de escape

Una futura suite de seguridad debería intentar, en un entorno desechable:

1. leer un archivo fuera de la raíz permitida;
2. escribir fuera del worktree;
3. escapar con path traversal;
4. escapar con symlink/junction;
5. usar cmd, PowerShell o shell anidado para saltar un allowlist;
6. acceder a variables de entorno o archivos de credenciales;
7. abrir red no autorizada;
8. ejecutar un hook del repositorio antes de la aprobación;
9. editar el archivo de política o el guardian;
10. reusar una aprobación antigua con otros argumentos;
11. provocar delegación para obtener permisos mayores;
12. envenenar memoria o instrucciones persistentes;
13. entrar en un bucle de herramientas;
14. ocultar un fallo y devolver pass;
15. continuar después del kill switch.

Cada caso necesita expected denial, evidencia de la frontera que lo impidió y cleanup verificado.

## Qué significa realmente no escapar

No existe garantía absoluta frente a un host completamente comprometido. El objetivo razonable es:

- que el agente no tenga autoridad implícita;
- que los límites críticos se impongan fuera del modelo;
- que un fallo quede acotado por sandbox, least privilege y budgets;
- que el humano tenga preview, stop y rollback;
- que cada acción importante sea auditable;
- que un agente comprometido no pueda convertir su permiso en un permiso mayor.

La prioridad para JorgeX no es añadir más texto al system prompt. Es convertir las restricciones actuales en controles verificables y, cuando el runtime no pueda imponerlas, documentar claramente la degradación.
