# 07-captacion — extractos

Fuentes: Marketing Skills (Corey Haines, MIT), skill cro/references/form.md, signup, popups, lead-magnets, revops/inbound-routing (filtrado) + búsqueda web (antispam, autenticación de email, RGPD en formularios). Estado: borrador completo de la fase. Descartado: free-tools, plantillas de agent skills como lead magnet, benchmarks por formato, enriquecimiento con proveedores de pago.

## Formularios
- **Cada campo cuesta**: 3 campos = base; 4-6 = -10 a -25%; 7+ = -25 a -50% o más (orientativo del origen). Para cada campo: ¿imprescindible antes de ayudarle?, ¿se obtiene de otra forma?, ¿se puede pedir después? Preguntar solo lo que se usa en el seguimiento.
- Campos: email único sin confirmación y con validación en línea (+ sugerencia de typo); nombre en un campo salvo que haya que personalizar; teléfono opcional (si es obligatorio, explicar por qué); mensaje libre opcional; empresa se infiere o enriquece tras el envío.
- Orden: lo fácil primero, lo sensible (teléfono, tamaño de empresa) al final; una columna.
- Etiquetas siempre visibles (no solo placeholder, que desaparece); placeholder = ejemplo.
- Multi-paso solo con más de 5-6 campos o ramas: indicador de progreso, guardar progreso, volver atrás, fácil primero.
- Errores: específicos, junto al campo, sin borrar lo escrito, foco en el primer error.
- Botón: "[acción] + [lo que obtienen]" ("Obtener mi presupuesto"); estados cargando/éxito/error; confirmación con siguiente paso claro.
- Confianza junto al formulario: aviso de privacidad, "sin spam", tiempo de respuesta esperado, "tarda 30 segundos", "sin tarjeta", alternativa (teléfono/chat).
- Móvil: objetivos táctiles 44 px+, teclado correcto (`email`, `tel`), autocompletado, botón visible/fijo.
- Por tipo: contacto (email/nombre + mensaje, tiempo de respuesta), demo (nombre, email, empresa; calendario embebido puede subir asistencia), presupuesto (multi-paso, técnico al final), captura de lead (a menudo solo email).
- Métricas: inicio, finalización, abandono por campo, errores por campo, tiempo, móvil vs escritorio.

## Registro / waitlist (si el objetivo es cuenta)
- Pedir lo mínimo (email); diferir empresa, rol, teléfono (perfilado progresivo). Mostrar valor antes de pedir registro cuando se pueda.
- Waitlist: solo email, pregunta opcional de uso, confirmación con expectativa.
- Trial B2B: email + password (o login social) > nombre/empresa opcional > onboarding. Ecommerce: invitado por defecto.
- Verificación de email: retrasarla si es posible, enlace mágico, reenvío fácil, aviso de spam, permitir cambiar email.

## Popups (decisión: no por defecto; guardarraíles)
No usar popup en una landing de objetivo único salvo recurso gratuito y tráfico suficiente.
- Preferir disparo por clic (cero molestia). Si no: scroll 25-50% o salida de página (en móvil no hay intención de salida; usar scroll arriba/atrás). Evitar disparo a los 5 s.
- Máx. una vez por sesión; recordar descarte 7-30 días; excluir convertidos.
- Cierre visible y grande, "No, gracias" educado (nada de "No quiero ahorrar"); clic fuera cierra; en móvil, panel inferior, no pantalla completa.
- Accesibilidad: teclado (Tab/Enter/Esc), trampa de foco mientras está abierto, lector de pantalla, contraste.
- SEO: Google penaliza interstitials intrusivos en móvil; permitidos avisos de cookies y verificación de edad.
- RGPD/privacidad: texto de consentimiento claro, enlace a privacidad, nunca casillas premarcadas. No solapar con el banner de cookies.
- Referencia de conversión: email popup 2-5%, salida 3-10%, por clic 10%+ (autoselección).
- Descartado: tipos de popup de ecommerce (descuentos, carrito), formatos de banner/slide-in, ideas de experimentos.

## Elegir la vía de captación (decisión antes de implementar)
Una por objetivo (01): formulario de contacto/presupuesto, reserva de cita (calendario embebido), registro/waitlist, lead magnet a cambio de email, o contacto directo (teléfono/WhatsApp/email) cuando el negocio es local o de ticket alto. Más de una compite con el CTA único (03): la secundaria va subordinada. El contacto directo se muestra como texto/enlace real, no solo en imagen.

## Lead magnet (solo si el objetivo es captar email)
- Resuelve **un problema concreto** ("cómo redactar emails fríos que se respondan" > "guía de marketing"), se consume en menos de 30 min (idealmente 10), una sola formato, funciona en móvil, lleva de forma natural al producto.
- Formatos baratos primero: checklist, plantilla, hoja de referencia (horas, no semanas); ebook largo solo si hay recursos. Ajustar a la etapa del comprador (consciencia: educar; consideración: comparar; decisión: implantar o prueba).
- Gating: completo para contenido de alto valor y fondo de embudo; parcial (vista previa + versión completa) para equilibrar; sin gate para contenido de cabecera. Pedir el mínimo (cada campo extra resta ~5-10%, orientativo).
- Página: titular con beneficio, vista previa/maqueta, 3-5 puntos de contenido, prueba social real, formulario mínimo, FAQ breve ("¿es gratis?", "¿qué formato?").
- Entrega: página de gracias + email con copia (acceso inmediato y verificación de email). La página de gracias tiene un siguiente paso (reservar, prueba, comunidad), no se desperdicia.
- Referencia de conversión del origen (sin verificar): 20-40% tráfico caliente, 5-15% frío. No usar como promesa.

## Implementación del envío (lo que una IA suele hacer mal)
1. **Validar siempre en servidor**; la validación del navegador es solo UX. Sanear y limitar longitudes; rechazar campos inesperados.
2. **Guardar antes de notificar**: persistir la solicitud válida (base de datos o servicio) y después enviar el aviso/ email/ integración. Si el email o el CRM falla, la solicitud no se pierde (reintento o cola). Un fallo de enriquecimiento o de CRM nunca borra ni rechaza un lead.
3. **Idempotencia**: ID de envío estable para que un reintento, un doble clic o un webhook repetido no cree otro contacto, tarea o aviso.
4. **Antispam en capas** (ninguna sola vale):
   - Campo trampa (honeypot) oculto, comprobado en servidor. Aviso: el autocompletado del navegador puede rellenarlo y bloquear a usuarios reales (nombre del campo no obvio, `autocomplete="off"`, sin ocultar con `display:none` solo si falla).
   - Control de tiempo mínimo desde la carga (rechazar envíos más rápidos que un humano).
   - **Cloudflare Turnstile** (o hCaptcha) **verificado en servidor** con el endpoint `siteverify` antes de guardar: el token del formulario no prueba nada por sí mismo, porque un bot que hace POST directo nunca pasa por el widget. Para tráfico UE, mejor Turnstile/hCaptcha que reCAPTCHA (sin perfilado entre sitios; confirmar en el aviso de privacidad).
   - **Límite de frecuencia** por IP (orden de 3-5 envíos por IP por hora/10 minutos; ajustar al caso), en servidor o con reglas del CDN/WAF.
   - Sospechosos a **cuarentena**, no a la papelera: los bloqueos por palabra clave dan falsos positivos y pierden leads. Si el spam sigue y es "gramatical", pregunta de contexto validada en servidor.
   - Las cifras de efectividad (95%, 99%) de los blogs son marketing: medir el propio spam.
5. **Secretos**: claves de API/Turnstile secretas solo en servidor (variables de entorno), nunca en el cliente ni en el repo. Endpoint de envío con CORS acotado y sin exponer destinatarios.
6. **Email de aviso y de confirmación**:
   - Autenticación del dominio emisor: SPF y DKIM como mínimo para cualquier remitente; DMARC (`p=none` basta de inicio) recomendado a cualquier volumen; alineación del dominio del `From` con SPF/DKIM; clave DKIM de 2048 bits (≥1024). Los correos transaccionales también cuentan. Comprobar en Gmail "Mostrar original": SPF, DKIM y DMARC en PASS. (Fuente oficial: guía de remitentes de Google; verificar vigencia.)
   - Remitente propio del dominio con proveedor transaccional (no `mail()` del servidor ni un Gmail personal como `From`).
   - Confirmación al usuario: qué pasa ahora y cuándo (tiempo de respuesta real), copia de lo enviado si procede. El aviso interno incluye origen/UTM y página.
7. **Doble opt-in** (boletín/marketing): confirmación por email; el RGPD no lo exige como tal pero sí poder **probar el consentimiento** (registro con fecha, texto y versión de la política). La mecánica y el texto legal dependen de la jurisdicción: ver 09. Casilla de comunicaciones comerciales **separada, opcional y nunca premarcada**.
8. **Estados**: cargando (botón deshabilitado), éxito (mensaje + siguiente paso o redirección a página de gracias), error recuperable (conserva lo escrito, enlaza alternativa: teléfono/email). Si el envío falla en servidor, mostrar la alternativa en lugar de perder al usuario.
9. **Página de gracias con URL propia** (o evento tras éxito confirmado por el servidor): es el punto fiable para medir la conversión en 08; no contar el clic del botón como conversión.
10. **Accesibilidad**: etiquetas asociadas, errores anunciados (`aria-live`/`aria-describedby`), foco al primer error, orden de tabulación lógico, contraste, no depender del color. Turnstile: comprobar que la alternativa accesible funciona.

## Enrutado y seguimiento (si hay equipo comercial/CRM)
- Aceptar y registrar el envío válido **antes** de depender de un tercero; no rechazar por que un proveedor de enriquecimiento no devuelva datos. Un correo personal no identifica empresa: pedir el mínimo que falte o enviar a cola humana.
- Reglas escritas antes de implementar, con ramas: cliente existente, encaja y hay responsable, encaja sin responsable (confirmación con expectativa honesta + cola con plazo), datos ausentes/ambiguos (cola "pendiente", confirmación genérica), descalificador explícito con evidencia fiable (recurso alternativo o mensaje respetuoso, registrar el motivo).
- Acotar el tiempo de espera interactivo; lo lento se completa en segundo plano y no debe robar un lead ya asignado ni duplicar reservas.
- Validar antes de lanzar con casos: cliente existente, lead nuevo que encaja, empresa desconocida, duplicado, timeout con éxito tardío, responsable no disponible. Comprobar la página visible y los registros resultantes, no solo que el flujo "dé OK".
- Medir tiempo hasta la primera respuesta humana (la latencia de la petición no es la respuesta comercial).

## Verificación
Envío de prueba real de extremo a extremo (llega a la base/CRM, llega el aviso, llega la confirmación a Gmail y a otro proveedor, no cae en spam); envío con honeypot rellenado y con token inválido (debe rechazarse); doble envío (un solo registro); fallo simulado del proveedor de email (la solicitud queda guardada); prueba con lector de pantalla/teclado; prueba en móvil real.

## Puerta
No se pasa a 08 sin: envío de prueba E2E correcto, antispam verificado en servidor, autenticación de email en PASS, página de gracias o evento de éxito definidos para medir, y consentimiento de marketing (si lo hay) resuelto con 09.
