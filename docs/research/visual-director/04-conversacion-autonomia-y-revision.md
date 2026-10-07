# 04 — Conversación, autonomía y revisión

> Investigación del 2026-10-02, por lectura de fuentes; nada se instaló ni ejecutó.
>
> Redactado antes del cierre de arquitectura del 2026-10-03: si algo choca con [00](00-encargo-y-arquitectura.md) §4 (fases) y §9 (propiedad y fronteras), manda 00.

## 1. Descubrimiento conversacional: profundo pero proporcional

El agente debe sacar la visión del usuario sin convertir cada encargo en una entrevista. La profundidad es proporcional a la incertidumbre real.

- **Si la idea está definida**: clarificar qué importa, qué se preserva, qué se interpreta y qué queda fuera. Detectar contradicciones internas antes de aceptar la dirección como aprobada.
- **Si la idea está abierta**: imaginar dos o tres direcciones concretas, justificadas frente al brief y acompañadas de muestras pequeñas cuando el caso lo pida. No delegar toda la creatividad al usuario; cada dirección debe defender por qué encaja.
- **En ambos casos**: **rondas compactas sucesivas** cuando falta intención o hay contradicciones materiales. Cada ronda resume y confirma lo entendido, mantiene el registro actualizado y solo pregunta lo que cambia decisiones materiales; el resto se asume y se declara. La conversación no se cierra hasta que la intención queda clara, pero tampoco se fuerza omnisciencia: se documenta lo que queda abierto.

## 2. Una fuente vigente de brief, dirección y decisiones

Ni el plan de tareas ni el PRD deben absorber la conversación creativa. Se mantiene una **fuente única viva** que sigue al dueño existente del proyecto.

### 2.1 Quién es dueño de qué

- **PRD**: objetivos, alcance, restricciones del producto y criterios de éxito del negocio. No se convierte en brief visual completo ni se duplica como guía creativa. Si el proyecto no tiene PRD, basta con el archivo de plan visual.
- **Registro de diseño (`DESIGN.md` o equivalente del proyecto)**: intentos visuales, decisiones aprobadas, razones y referencias. Aquí viven los estados `observado / declarado / propuesto / aprobado`.
- **Plan de tareas**: estados, dependencias, dueños y gates. Aquí no viven decisiones creativas que el usuario no haya aprobado.

### 2.2 Cómo se mantiene

- **Dueño habitual**: `DESIGN.md` cuando existe; el archivo de plan visual cuando el proyecto lo mantiene; el registro de la respuesta para una exploración puntual.
- **Tipos de registro y su función**:
  - **Work owner plan** (plan de trabajo, estados, dependencias, gates): vive en el plan de tareas; no contiene decisiones creativas que el usuario no haya aprobado.
  - **Visual decision record** (intención visual, decisiones aprobadas, razones, referencias): vive en el `DESIGN.md` del proyecto; es la fuente que el brand kit referencia (ver [09-brand-kit-evolutivo.md](09-brand-kit-evolutivo.md) §2).
  - **Evidence checkpoint** (renders inspeccionados, audio escuchado, página cargada, capturas de QA): vive en el registro del proyecto o en el handover; cada checkpoint cita la fuente inspeccionada y la fecha.
  - **Chat efímero** (intercambios one-off de exploración): no se replica como docs nuevos por ceremonia. La conversación útil se destila en el visual decision record; el chat se descarta.
- **Separación de responsabilidades**: el plan de tareas tiene estados y dependencias; el visual decision record tiene decisiones, razones y referencias; el evidence checkpoint tiene pruebas con fecha. No se mezclan.
- **Estados** para cada ítem en el visual decision record:
  - **Observado**: leído de un token, stylesheet, asset aprobado o render inspeccionado. Se nombra la fuente.
  - **Declarado**: dicho por el usuario. Se preserva literal cuando importa, no por defecto.
  - **Propuesto**: decisión pendiente de validar. Se marca hasta que se apruebe.
  - **Aprobado**: el usuario dio el visto bueno o delegó esa decisión de forma explícita.
- **Quién verifica**: el **dueño de la verificación** es quien se compromete a inspeccionar la prueba con su nombre/rol. Una **decisión puede estar aprobada mientras su verificación técnica o audiovisual sigue pendiente**: se conserva el estado de la decisión (aprobada) y se registra por separado qué comprobación falta y quién la realizará. La ausencia de un dueño de verificación no convierte una decisión aprobada en `propuesta` por defecto: la decisión sigue aprobada y la verificación queda como `pendiente` con su dueño o, en su defecto, pendiente de asignar. La verificación humana no es eliminada por la autonomía; la disciplina no la sustituye. Los dueños existentes del plan de trabajo, del visual decision record y del evidence checkpoint se conservan; no se introduce un esquema adicional obligatorio para esta distinción.
- **Lo que se conserva**: la decisión, la razón específica del brief que la justifica, la referencia (archivo, render, cita corta) y los cambios posteriores — qué cambió, cuándo y a qué versión anterior sustituye.
- **Lo que no se conserva por defecto**: secretos, tokens, claves; transcripciones literales de toda la conversación; copias del PRD, plan o `DESIGN.md`. Se referencian, no se duplican.
- **Preferencias personales del usuario** (una plataforma concreta, un estilo favorito, una restricción de stack) se registran como `declarado` y no se promueven a política global de la skill. La skill pregunta antes de asumir.

## 3. Readiness, no omnisciencia

Antes de producir, el agente declara lo que sabe y lo que asume. La propuesta no es alcanzar el detalle absoluto, sino cubrir los ejes que cambian el resultado.

- **Objetivo**: qué debe conseguir la pieza.
- **Medio**: web, audiovisual o gráfica.
- **Mensaje**: lo único que debe recordarse.
- **No negociables**: lo que no se rompe aunque cambien otras cosas.
- **Criterios de éxito**: cómo se sabrá que está bien. Incluyen al menos un criterio creativo y un criterio técnico.
- **Supuestos visibles**: lo que se decidió sin pregunta y por qué.
- **Capacidades, gasto y permisos**: qué se puede ejecutar, qué cuesta y qué necesita aprobación. Si falta, se pregunta; no se asume.

Este readiness se documenta en el registro del proyecto, no en la respuesta efímera del chat.

## 4. Autonomía dentro del alcance aprobado

El agente decide sin pedir permiso en lo que el usuario ya le delegó. Pide confirmación cuando la decisión cambia materialmente el resultado o el coste.

- **Dentro del alcance aprobado**: ajustar tipografía, jerarquía, sistema visual, detalles de motion, acabados de exportación, distribución de piezas — todo lo que el brief y la dirección ya permiten.
- **Fuera del alcance aprobado**: cambiar el mensaje, sustituir el medio, asumir gasto o publicar. Eso requiere una confirmación nueva, sin ceremonia innecesaria pero sí explícita.
- **No se inventa una "aprobación ceremonial"** para decisiones que el usuario ya ha delegado al decir "hazlo" o al aprobar la dirección.
- **Si una herramienta ya está instalada con uso y créditos previamente autorizados**, las acciones dentro de ese scope no piden nuevo permiso. El permiso se pide cuando la acción sale del scope (otra cuenta, otro plan, gasto nuevo, subida de material, publicación o delegación a otro agente).

## 5. Bucle de revisión: dos ejes, no autoelogio

El ciclo es producir, no declarar. Cada pasada produce algo que se puede ver, oír o leer, se inspecciona de verdad y se evalúa contra el brief.

```text
producir
   ↓
render / inspección real (no descrita, no asumida)
   ↓
evaluar contra brief y dirección
   ↓
priorizar lo que más afecta al resultado
   ↓
corregir la causa, no el síntoma
   ↓
revisar las áreas afectadas por el cambio
   ↓
guardar progreso en la fuente de verdad
```

- **Eje técnico**: viabilidad, rendimiento, accesibilidad, compatibilidad, exportación, gasto.
- **Eje artístico**: dirección, coherencia, jerarquía, ritmo, legibilidad, emoción.
- Los dos ejes se revisan. Una pieza puede pasar el técnico y fallar el artístico, o al revés.
- El agente no se felicita a sí mismo. Reporta pruebas, no opiniones sobre su propio trabajo.

## 6. Paradas obligatorias

La autonomía tiene topes. El agente se detiene y pregunta (o entrega) cuando toca:

- **Calidad suficiente** para el alcance pedido. No se pule de más.
- **Sin avance real** entre iteraciones. Si la causa es estructural, se reabre el criterio, no se reintenta lo mismo.
- **Bloqueo**: falta información, falta un activo, falta un permiso, falta un pago, falta una decisión del usuario.
- **Cambio material**: el brief, el mensaje, el medio o el presupuesto cambió. Se confirma el nuevo alcance antes de seguir.
- **Criterio o presupuesto no autorizado**: el usuario debe decidir antes de gastar o de aceptar un criterio nuevo.

Los topes de gasto, tiempo y reintentos se acuerdan por encargo. Aquí se describe la disciplina, no un número universal.

## 7. Resultado entregado y respuesta a feedback

### 7.1 Qué incluye la entrega

- Lo que se ha producido, con pruebas reales de haberlo producido.
- Lo que se ha verificado y cómo (render inspeccionado, audio escuchado, página cargada).
- Lo que no se ha verificado: registrado como **pendiente**, nunca como **superado**. Comprobaciones no realizadas se registran pendientes; no se presentan como superadas. Se conserva por separado cualquier aprobación editorial o decisión del usuario.
- Compromisos conocidos: simplificaciones, sustituciones, lo que se hubiera querido hacer y no se hizo.

### 7.2 Cómo se trata el feedback

- Se traduce a acciones concretas sobre el alcance afectado.
- Se ajusta solo lo afectado, no se reinicia el trabajo entero.
- Si el feedback contradice una decisión ya aprobada, se reabre esa decisión concreta, no todo el brief.

## 8. Pendiente nunca vacío, nunca aprobado

Cuando algo no se puede inspeccionar — render no disponible, audio sin previsualizar, página sin cargar — se registra como **pendiente** con la causa. No se rellena el hueco con un "OK" ni con un "según lo previsto". El pendiente es una afirmación explícita de lo que falta.

## 9. Riesgos y puntos pendientes

- **Propuesta**: este capítulo describe el comportamiento deseado, no un comportamiento observado.
- **La fuente única de decisiones** depende de que el proyecto tenga un dueño claro para el registro. Cuando no exista, hay que decidir caso a caso; este dossier no lo fuerza.
