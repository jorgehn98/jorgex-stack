# Pagos, correo transaccional y mensajería: criterios de decisión para la skill

Fase "identidad y servicios", tema B. Fecha de consulta: 2026-10-12. Sin análisis legal. Ningún proveedor preferido.

Convención: ESTABLE = criterio que no depende de una versión ni de un precio. VOLÁTIL = verificar siempre en la fuente el día de la decisión. NO VERIFICADO = no pude abrir la fuente o no aparece en ella.

---

## 1. Criterios estables

### 1.1 Pagos

**Procesador/pasarela frente a merchant of record (MoR).** Es la decisión central y condiciona todo lo demás.
- Con un procesador (PSP), el vendedor legal es el negocio del cliente. Los impuestos sobre ventas (IVA, sales tax), la facturación, la atención de contracargos y el cumplimiento del cobro recaen en ese negocio. El procesador mueve el dinero.
- Con un MoR, el MoR es el vendedor legal frente al comprador. Según la documentación de Paddle, el MoR asume la recaudación de impuestos, el alcance PCI, los reembolsos y los contracargos, además de filtrar fraude y atender soporte de facturación. El extracto bancario del comprador muestra el nombre del vendedor junto al del MoR.
- Stripe confirma que el concepto no es exclusivo de un proveedor: su producto "Managed Payments" es "la solución de merchant of record de Stripe". Cubre impuestos (más de 80 países), recibos y facturas, soporte de transacción, fraude y disputas. En los países que no cubre, el vendedor sigue siendo responsable de los impuestos.
- Qué asume cada modelo, según la documentación consultada:
  - MoR: el vendedor deja de registrarse para IVA/GST/sales tax en cada país y de gestionar disputas. A cambio cede control de la relación de cobro: recibos y correos de suscripción salen de la marca del MoR. En Stripe Managed Payments no se admiten dominios personalizados en el checkout, y Stripe puede reembolsar sin aprobación del vendedor si este no responde en 48 horas. Cualquier MoR impone sus propias condiciones, así que hay que leerlas.
  - Procesador: más control y más obligaciones fiscales y de disputas propias. Algunos procesadores ofrecen cálculo de impuestos como módulo aparte, pero calcular no equivale a declarar y remitir.
- Alcance del MoR: el de Paddle declara estar orientado a SaaS y productos digitales, no a bienes físicos. El de Stripe lo describe para SaaS, software y contenido digital. Para productos físicos o servicios presenciales, el MoR suele no encajar (NO VERIFICADO para otros MoR).
- Lo que ninguna página dice (NO VERIFICADO): la propiedad de los datos del cliente en un MoR, los plazos de pago al vendedor y qué pasa con los clientes si el vendedor cambia de MoR. Hay que preguntarlo al proveedor antes de comprometerse.

**Checkout alojado frente a integrado.**
- Stripe ofrece tres niveles: página completa (alojada en Stripe o incrustada), formulario integrado (marcado en public preview en la fecha) y componentes (Elements) con personalización total. Su propia tabla lo resume así: a más personalización, más mantenimiento y complejidad.
- Criterio estable: el checkout alojado reduce el alcance de seguridad de pago y el mantenimiento, y el integrado compra control de marca y de conversión a cambio de más código a mantener. Por defecto, alojado; integrado solo si se justifica la conversión o la marca con datos.
- Nunca guardar ni procesar datos de tarjeta en el servidor propio.

**Pago único frente a suscripción.**
- La suscripción añade ciclo de vida: prueba, renovación, impago, reintentos, cancelación, cambio de plan, prorrateos y avisos. La documentación de Stripe Billing lista estados (`trialing`, `active`, `past_due`, `unpaid`, `canceled`, `paused`, entre otros) y eventos para cada transición.
- El acceso al producto se otorga y se revoca según eventos del proveedor, no según la redirección del navegador tras pagar. Stripe indica revocar acceso en `canceled` o `unpaid` y avisar al cliente en `past_due`.
- Criterio: si el modelo de negocio es de pago único, no introducir suscripciones "por si acaso".

**Webhooks y conciliación** (Stripe, doc oficial).
- Verificar la firma de cada evento (`Stripe-Signature`) con el cuerpo sin procesar.
- Responder `2xx` rápido, antes de la lógica pesada.
- No hay garantía de orden de entrega: no depender de la secuencia ni de la marca `created`. Se puede recuperar el objeto por API si falta.
- Puede haber duplicados: registrar los IDs de evento ya procesados y descartar repetidos.
- Reintentos automáticos hasta 3 días con retroceso exponencial en modo activo (VOLÁTIL como cifra). Si el endpoint falla en facturas de suscripción, la finalización de facturas se puede retrasar hasta 72 h.
- Idempotencia de peticiones: las peticiones POST aceptan una clave de idempotencia (hasta 255 caracteres, purgada pasadas al menos 24 h, VOLÁTIL como cifra). Útil para reintentos propios.
- Conciliación: contrastar periódicamente el registro propio con los informes del proveedor, porque el webhook puede perderse. Stripe ofrece informes de conciliación de pagos; en Managed Payments los informes separan impuesto retenido y comisión.
- Seguir también eventos de reembolso, disputa y aviso de fraude, no solo los de pago correcto.

**Qué guardar (modelo propio).**
- Guardar: ID de cliente interno vinculado al ID del proveedor, ID de transacción/factura del proveedor, importe, divisa, estado, fechas, producto/plan comprado, estado de suscripción y derecho de acceso derivado, ID de eventos procesados.
- No guardar: número de tarjeta, CVV ni datos que el proveedor custodia. Tampoco copiar más datos personales de los necesarios.
- Un MoR puede borrar datos del comprador a petición del cliente (Stripe Managed Payments lo describe), así que el registro propio no debe depender de poder reconstruir datos personales desde el proveedor.

### 1.2 Correo

**Transaccional frente a marketing.**
- Transaccional: respuesta a una acción del usuario (restablecer contraseña, confirmación, recibo). Marketing/promocional: difusión y boletines.
- Google exime a los mensajes transaccionales de la baja con un clic; esa exigencia solo aplica a marketing y suscripciones. La baja visible en el cuerpo del mensaje sigue siendo requisito para los mensajes de marketing de remitentes masivos.
- Mezclar ambos tipos en el mismo flujo pone en riesgo la entregabilidad de los correos críticos (restablecimiento, verificación) cuando una campaña genera quejas.

**Dominios y reputación.**
- La reputación se asocia al dominio y a la IP de envío. Las quejas de spam de marketing dañan lo que comparten.
- Patrón recomendado: separar flujos por subdominio (por ejemplo, uno para transaccional y otro para marketing), cada uno con su propia autenticación y reputación.
- Cautela verificada: Google cuenta los subdominios bajo el dominio principal para el umbral de remitente masivo (su FAQ pone el ejemplo de 2.500 + 2.500 mensajes entre dominio y subdominio). El subdominio separa reputación operativa, pero no evita pasar al régimen de remitente masivo.
- Una vez clasificado como remitente masivo, Google dice que la clasificación es permanente.
- Usar un dominio con identidad reconocible en el From; el From debe alinearse con el dominio autenticado.

**SPF, DKIM, DMARC.**
- SPF: lista en DNS los servidores autorizados a enviar por el dominio. DKIM: firma criptográfica del mensaje, verificable por DNS. DMARC: política publicada en DNS que dice qué hacer cuando un mensaje no pasa ni se alinea, y pide informes.
- DMARC pasa si SPF o DKIM pasan y se alinean con el dominio del From (Google). Políticas: `none` (solo informes), `quarantine`, `reject`.
- Despliegue gradual recomendado por dmarc.org y Google: SPF y DKIM primero, publicar `p=none` y revisar informes, corregir los orígenes de envío y subir a quarantine y después reject.
- Si se usa un proveedor de envío de terceros, hay que configurar SPF/DKIM con su dominio de forma que se alineen con el dominio propio.

**Requisitos oficiales de Google y Yahoo** (resumen, con fecha; los valores numéricos son VOLÁTILES, ver sección 3).
- Todos los remitentes: SPF o DKIM, DNS directo e inverso válido (PTR), TLS (Google), formato RFC 5322, tasa de spam baja.
- Remitentes masivos: SPF y DKIM, DMARC publicado (con `p=none` como mínimo; Yahoo exige que pase), alineación del From, baja con un clic en marketing y suscripciones (cabeceras `List-Unsubscribe` y `List-Unsubscribe-Post`) y enlace visible en el cuerpo.
- Nota de Google: un DMARC ausente o solo en `p=none` puede dejar sin soporte de entrega o mitigaciones.

**Criterios para elegir proveedor de envío** (sin recomendar ninguno):
- Autenticación con dominio propio (DKIM y Return-Path personalizados), no el dominio del proveedor.
- Separación de flujos (subdominios, flujos o IPs distintos) y modelo de IP (compartida o dedicada) con su coste y el calentamiento que exige.
- Gestión de rebotes, quejas y supresión; webhooks de eventos de entrega.
- Soporte de las cabeceras de baja con un clic.
- Región y ubicación de datos, límites de tasa y política de cuenta (suspensiones).
- Exportación de listas y de histórico de eventos.
- Precio por volumen (VOLÁTIL).
- Soporte SMTP estándar y API: reduce el coste de cambiar.

### 1.3 Notificaciones y otros canales

Criterio común: cada canal añade coste por mensaje, requisitos de alta o aprobación y exigencias de consentimiento. Todos requieren una base legal para contactar al usuario; no se analiza aquí.

- **Correo**: canal por defecto para casi todo. Bajo coste, sin app, sirve de respaldo.
- **Push web/móvil**: vale la pena si hay uso recurrente y contenido sensible al tiempo (avisos, mensajes). La Push API web exige service worker y que el usuario acepte (opt-in). MDN indica que los navegadores gestionan límites de recursos de forma distinta (Firefox limita; Chrome no) y que las suscripciones deben protegerse contra CSRF. En móvil nativo depende de las plataformas de cada sistema (NO VERIFICADO aquí). Poca utilidad en landings sin cuenta.
- **SMS**: alcance universal sin app, útil para códigos de verificación y avisos urgentes. Tiene fricción regulatoria y de operadores. Ejemplo verificado: en EE. UU. el tráfico de aplicación por números de 10 dígitos exige registro de marca y campaña (A2P 10DLC) y el tráfico sin registrar se filtra más y paga cargos adicionales (documentación de Twilio). Otros países tienen sus propias reglas (NO VERIFICADO). El SMS para códigos de acceso se considera además débil como segundo factor; ver tema de identidad.
- **WhatsApp Business**: útil donde es el canal dominante del cliente y la conversación bidireccional aporta valor. Fuera de la ventana de 24 h desde el último mensaje del usuario solo se pueden enviar plantillas aprobadas, clasificadas en autenticación, utilidad y marketing (la categoría condiciona el coste y la aprobación, y Meta decide la categoría). Requiere aprobación de Meta y cuenta de empresa (documentación de Twilio; el proveedor de acceso es intermediario).
- **Mensajería interna/in-app y avisos en pantalla**: sin coste por mensaje ni consentimiento adicional de canal; suficiente cuando el usuario ya está dentro del producto.
- Regla: no abrir un canal "por si acaso". Un canal se justifica cuando hay un caso de uso medido que el correo no cubre, y el usuario puede elegir y retirar su consentimiento por canal y por tipo de aviso.

### 1.4 Construir o integrar

Regla general: integrar en los tres ámbitos, salvo que haya una razón concreta para construir.

| Ámbito | Integrar si | Construir (parcialmente) solo si |
|---|---|---|
| Pagos | Casi siempre. Procesar tarjetas, impuestos multipaís, disputas y cumplimiento no es el negocio. | Nunca construir el procesamiento de tarjetas. Sí construir el registro propio de transacciones y la lógica de acceso. |
| Correo | Siempre para el envío (entregabilidad, reputación de IP y autenticación son especialidad ajena). | Plantillas, cola, reintentos, registro de envíos y preferencias de usuario son capa propia delgada. Operar un MTA propio solo con volumen y equipo que lo justifiquen. |
| Mensajería | Siempre para SMS y WhatsApp (acceso a operadores y a Meta no es construible). | La abstracción de "enviar aviso a usuario por canal X según preferencias" es propia y pequeña. |

Criterios para decidir:
- Coste de equivocarse (fiscal, reputacional, seguridad) frente al coste de integrar.
- Volumen: a muy bajo volumen, integrar con el nivel gratuito o el más simple; a muy alto, revisar precios y alternativas.
- Facilidad de salida: preferir interfaces estándar (SMTP, webhooks documentados, exportación).
- Capacidad del equipo para mantener lo construido.
- Aplicar KISS/YAGNI: integrar lo mínimo y poner detrás de una interfaz propia solo lo que tenga un segundo candidato real.

### 1.5 Riesgos de dependencia

- **Caída del proveedor**: pagos, correo y mensajería deben fallar sin romper el producto. Definir qué pasa si el webhook no llega o el envío falla: cola con reintentos, aviso al usuario y conciliación periódica. Para correo crítico (restablecimiento de contraseña) valorar un segundo proveedor solo si el impacto lo justifica. Para pagos, no hay respaldo simple: es riesgo aceptado y se documenta.
- **Límites de tasa**: todas las APIs los tienen (Google habla de errores 4.7.28 por cuota y de detener el envío al menos 10 min; VOLÁTIL como cifra). Diseñar con colas y retroceso exponencial, no con envíos síncronos en la petición del usuario.
- **Cambios de precio y de condiciones**: VOLÁTILES. Evitar acoplarse al plan de un proveedor. En un MoR, la comisión suele cubrir impuestos y disputas, así que cambiar de modelo implica reasumir esas obligaciones.
- **Exportación de datos**: antes de elegir, confirmar qué se puede exportar (clientes, suscripciones, historial de transacciones, listas de correo, histórico de eventos) y en qué formato. Migrar suscripciones activas entre procesadores es el punto más delicado y depende de la exportación de métodos de pago, que es acuerdo entre proveedores (NO VERIFICADO para cada caso; preguntar al proveedor).
- **Qué mantener propio**:
  - Modelo de datos del cliente (ID interno estable, correo, preferencias y consentimientos por canal, estado de la cuenta). Los IDs del proveedor son atributos, no la clave.
  - Registro de transacciones propio (alimentado por webhooks verificados, conciliado con los informes del proveedor).
  - Derechos de acceso derivados de la suscripción.
  - Registro de envíos y de bajas/supresiones (la lista de bajas debe poder llevarse a otro proveedor).
  - Registro de consentimiento (qué se aceptó, cuándo y por qué canal).
  - Plantillas de mensajes en formato portable.
  - Configuración DNS (SPF/DKIM/DMARC) bajo control del dominio propio, no del proveedor.

---

## 2. Tabla de decisión

| Necesidad | Enfoque | Motivo | Contraindicación |
|---|---|---|---|
| Vender producto digital/SaaS a clientes de varios países con equipo pequeño | MoR con checkout alojado | El MoR asume impuestos multipaís, disputas y soporte de facturación | Necesitas control total de recibos, dominio propio en el checkout o relación directa de cobro; ventas de bienes físicos |
| Vender con entidad fiscal propia y volumen que justifica gestionar impuestos | Procesador con checkout alojado | Más control; el vendedor ya cumple las obligaciones fiscales | No tienes capacidad fiscal ni de gestionar contracargos |
| Checkout con experiencia de marca muy específica | Checkout integrado o componentes | Control de conversión y diseño | Equipo pequeño: más mantenimiento y alcance de seguridad |
| Cobro único (producto, evento) | Pago único alojado | Sin ciclo de vida de suscripción | Si ya sabes que habrá recurrencia, diseña el modelo de datos para ella |
| Cobro recurrente | Suscripciones del proveedor + webhooks + estado propio | El proveedor gestiona reintentos y renovaciones | Los casos con facturación a medida o por uso exigen validar que el proveedor lo soporte (NO VERIFICADO) |
| Confirmar un pago y dar acceso | Webhook verificado e idempotente, no la redirección del navegador | La redirección puede no ocurrir y los eventos pueden duplicarse o desordenarse | Ninguna razonable |
| Correo de sistema (verificación, restablecimiento, recibos) | Proveedor de envío transaccional en subdominio propio con SPF/DKIM/DMARC | Aísla reputación de los correos críticos | Volumen minúsculo: un SMTP del hosting con autenticación puede bastar, si cumple SPF/DKIM |
| Boletines y campañas | Herramienta de marketing en otro subdominio, con baja con un clic y gestión de consentimiento | Las quejas de marketing no contaminan el transaccional | Sin base de consentimiento válida para contactar |
| Avisos en tiempo real a usuarios con app/PWA | Push | Coste muy bajo; requiere opt-in | Sitios sin cuenta ni recurrencia; usuarios que rechazan permisos |
| Códigos de verificación o avisos urgentes a quien no tiene app | SMS | Alcance universal | Registro obligatorio en algunos países, coste por mensaje, cobertura desigual; mala opción como único segundo factor |
| Atención conversacional donde WhatsApp domina | WhatsApp Business vía proveedor | Canal preferido del cliente | Aprobación de Meta, plantillas fuera de la ventana de 24 h y categorías con coste; no es canal para difusión masiva sin opt-in |
| Avisos solo con usuario dentro del producto | In-app | Sin coste ni consentimiento de canal añadido | Usuario inactivo |
| Cualquier proveedor externo | Interfaz propia delgada + registro propio + exportación probada | Reduce coste de salida y de caída | No abstraer sin segundo candidato real (YAGNI) |

---

## 3. Datos volátiles (consulta 2026-10-12)

No se copian precios ni comisiones. Verificar siempre en la página oficial del proveedor el día de decidir.

| Dato | Estado | Observación |
|---|---|---|
| Precios y comisiones de Stripe, de MoR (Paddle y otros), de proveedores de correo, SMS, WhatsApp y push | VOLÁTIL, no consultado | No se capturaron a propósito. En Stripe Managed Payments, las comisiones de disputa y de prevención de disputas figuran en su página de precios (enlace en la doc). |
| Coste por mensaje SMS (por país y operador) y cargos de operadores | VOLÁTIL, no consultado | Twilio indica que el tráfico sin registrar en EE. UU. incurre en cargos adicionales; la cuantía no se capturó. |
| Precio de WhatsApp por categoría (autenticación, utilidad, marketing) | VOLÁTIL, no consultado | Las categorías y la ventana de 24 h vienen de Twilio (2026-10-12); los precios y las reglas de Meta cambian con frecuencia. |
| Umbral de remitente masivo de Google | VOLÁTIL, verificado: "cerca de 5.000 mensajes o más" a cuentas personales de Gmail en 24 h, por dominio principal, clasificación permanente | support.google.com/a/answer/14229414 |
| Umbral de remitente masivo de Yahoo | NO VERIFICADO: la página de Yahoo no define "masivo" ni da cifra | senders.yahooinc.com/best-practices |
| Tasa de spam | VOLÁTIL, verificado: Google exige por debajo de 0,3 % (recomienda por debajo de 0,10 %); Yahoo exige por debajo de 0,3 % | Los métodos de cálculo difieren: Yahoo la calcula sobre correo entregado en bandeja de entrada |
| Baja con un clic | VOLÁTIL, verificado: Google exige cabeceras `List-Unsubscribe` y `List-Unsubscribe-Post: List-Unsubscribe=One-Click` en marketing y suscripciones de remitentes masivos; Yahoo recomienda RFC 8058 y acepta mailto; Yahoo exige atender bajas en 2 días | |
| DMARC | VOLÁTIL, verificado: remitentes masivos deben publicar DMARC; `p=none` basta de mínimo, aunque Google avisa de que sin política o solo `p=none` puede no recibir mitigaciones de entrega | |
| Calendario de aplicación de Google | VOLÁTIL, verificado: aplicación gradual; desde noviembre de 2025 se intensifica con rechazos temporales (4.7.x) y permanentes (5.7.x); más rápida para dominios nuevos | |
| Longitud de clave DKIM | VOLÁTIL, verificado: Google pide 1024 bits o más y recomienda 2048 | |
| Reintentos de webhooks de Stripe | VOLÁTIL, verificado: hasta 3 días con retroceso exponencial en modo activo; 3 veces en unas horas en pruebas | docs.stripe.com/webhooks |
| Retención de claves de idempotencia de Stripe | VOLÁTIL, verificado: purga tras al menos 24 h; clave de hasta 255 caracteres | Vía Context7 (/websites/stripe) |
| Países cubiertos por Managed Payments de Stripe, métodos de pago admitidos y estado de funciones (por ejemplo, formulario integrado en "public preview") | VOLÁTIL, verificado: más de 80 países para impuestos; ver las tablas en la doc | docs.stripe.com/payments/managed-payments/how-it-works |
| Plazo de reembolso asistido en Managed Payments | VOLÁTIL, verificado: 60 días en ciertos casos; 48 h de respuesta del vendedor antes de posible reembolso sin su aprobación | |
| Mercados y monedas de Paddle ("30+ divisas, 200 mercados") | VOLÁTIL, solo vía resultado de búsqueda, no página abierta | Marketing del proveedor; no usar como criterio sin verificar |
| Reglas de registro de SMS por país (EE. UU. A2P 10DLC y otros) | VOLÁTIL, verificado solo EE. UU. | Otros países NO VERIFICADO |
| Soporte y límites de Push en navegadores | VOLÁTIL, verificado: Baseline "ampliamente disponible" desde marzo de 2023; Firefox limita cuota, Chrome no | Soporte en iOS/Safari y push móvil nativo NO VERIFICADO |

---

## 4. Fuentes y estado

| Fuente | Estado | Uso |
|---|---|---|
| https://support.google.com/a/answer/81126 (requisitos de remitentes de Gmail) | Verificado 2026-10-12 | Requisitos todos/masivos, umbrales |
| https://support.google.com/a/answer/14229414 (FAQ de remitentes de Gmail) | Verificado 2026-10-12 | Definición de remitente masivo, subdominios, transaccional, aplicación, DMARC |
| https://support.google.com/a/answer/10032169 | Redirigía; no se usó | Se obtuvo antes una redirección a knowledge.workspace.google.com; sustituido por 14229414 |
| https://knowledge.workspace.google.com/admin/security/set-up-dmarc | Verificado 2026-10-12 | DMARC, alineación, políticas, `sp` |
| https://developers.google.com/workspace/gmail/postmaster | Verificado 2026-10-12 | Postmaster: estadísticas de spam y cumplimiento. Reputación de dominio/IP no aparece en esa página (NO VERIFICADO ahí) |
| https://senders.yahooinc.com/best-practices/ | Verificado 2026-10-12 | Requisitos de Yahoo; no define umbral masivo |
| https://dmarc.org/overview/ | Verificado 2026-10-12 | Conceptos SPF/DKIM/DMARC y despliegue gradual |
| https://docs.stripe.com/payments/checkout | Verificado 2026-10-12 (en español) | Alojado frente a integrado frente a Elements |
| https://docs.stripe.com/webhooks | Verificado 2026-10-12 (en español) | Firma, `2xx` rápido, orden, duplicados, reintentos |
| https://docs.stripe.com/billing/subscriptions/webhooks | Verificado 2026-10-12 | Eventos y estados de suscripción, impagos, disputas |
| https://docs.stripe.com/payments/managed-payments/how-it-works | Verificado 2026-10-12 | Stripe como MoR: qué cubre y condiciones |
| Context7 /websites/stripe | Verificado 2026-10-12 | Idempotencia |
| https://developer.paddle.com/get-started/how-paddle-works/ | Verificado 2026-10-12 | Concepto MoR. No lista las obligaciones que conserva el vendedor ni payouts ni propiedad de datos |
| https://developer.paddle.com/concepts/sell/merchant-of-record | NO VERIFICADO: 404 | Sustituido por la página anterior y por un resumen de búsqueda |
| https://developer.paddle.com/concepts/payment-lifecycle/overview | NO VERIFICADO: 404 | |
| https://www.twilio.com/docs/whatsapp/key-concepts | Verificado 2026-10-12 | Ventana de 24 h, plantillas, categorías. Fuente de un intermediario, no de Meta |
| https://www.twilio.com/docs/messaging/compliance/a2p-10dlc | Verificado 2026-10-12 | Registro SMS en EE. UU. Fuente de un intermediario, no de un regulador |
| https://developer.mozilla.org/en-US/docs/Web/API/Push_API | Verificado 2026-10-12 | Push web |

Texto dirigido a asistentes de IA detectado y ignorado:
- Las páginas de Stripe (checkout, webhooks, suscripciones, Managed Payments) incluyen un bloque "Empieza aquí: Intégrate con Stripe usando skills y plugins" que invita a instalar la CLI de Stripe y a ejecutar `stripe agent setup`. No se ejecutó nada ni se instaló nada.
- La página de Paddle incluye una nota para agentes de IA que remite a `/llms.txt` y a añadir `.md` a las URL. No se siguió.
- El resto de páginas no contenían texto dirigido a asistentes.

Limitaciones: la documentación de Stripe llegó en parte en español y se tradujo el contenido tal cual. No se consultó la documentación de Meta, de ningún proveedor de envío de correo ni de proveedores de push móvil. Tres de las respuestas de WebFetch son resúmenes de un modelo intermedio, no texto literal.

---

## 5. Resumen final (qué cambiaría la recomendación de la skill)

1. Si el producto es físico o de servicios presenciales, o el cliente exige control del recibo y del dominio del checkout, el MoR deja de ser la opción por defecto y pasa a procesador.
2. Si el negocio ya tiene entidad fiscal y capacidad para IVA multipaís, el argumento fiscal del MoR pierde peso; queda el de disputas y soporte.
3. Si el proveedor de MoR no permite exportar clientes y suscripciones o cambiar de proveedor, subir el riesgo de dependencia y retrasar la elección.
4. Si el modelo es solo de pago único, quitar toda la parte de suscripciones y estados.
5. Si el volumen a Gmail se acerca a 5.000 mensajes diarios (contando subdominios), activar el requisito de DMARC, baja con un clic y tasa de spam por debajo de 0,3 % aunque sean pocos correos de marketing.
6. Si Google o Yahoo cambian umbrales, cabeceras o calendario de aplicación, revisar la sección de correo; estas cifras caducan.
7. Si solo hay correo de sistema y volumen mínimo, el subdominio y el proveedor aparte pueden ser excesivos: bastaría un envío autenticado con SPF/DKIM/DMARC.
8. Si el público usa WhatsApp como canal principal, o el producto necesita códigos por SMS, abrir ese canal con base legal y registro previo; si no hay caso medido, quedarse con correo e in-app.
9. Si el proveedor de SMS o WhatsApp cambia categorías, plantillas o precios por mensaje, recalcular el coste antes de recomendar el canal.
10. Si el equipo no puede mantener webhooks idempotentes, conciliación y registro propio, preferir el checkout alojado más simple y menos integraciones.
11. Si el mercado está fuera de los países cubiertos por el MoR elegido, el vendedor sigue asumiendo los impuestos allí: revisar la cobertura.
12. Pendiente de verificar antes de fijar la skill: condiciones concretas de cada MoR (propiedad de datos, payouts), precios reales y reglas de SMS fuera de EE. UU.
