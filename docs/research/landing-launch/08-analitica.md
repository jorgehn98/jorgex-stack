# 08-analitica — extractos

Fuentes: Marketing Skills (Corey Haines, MIT), skill analytics (SKILL + event-library + ga4-implementation), attribution (by-business-type, filtrado), búsqueda web (Consent Mode v2, analítica sin cookies). Estado: borrador completo de la fase. Descartado: GTM en detalle (396 líneas), Mixpanel/Amplitude/Segment (analítica de producto), MMM e incrementalidad, runbook de atribución propia en primera parte (253 líneas), eventos de app/monetización/ecommerce avanzados. Quedan en el repositorio original de Marketing Skills si un proyecto los pide.

## Orden dentro de la fase (importa)
1. **Qué decisiones informará** la medición (si no cambia una decisión, no se mide). 2. **Herramienta y consentimiento** (condiciona el resto y la fase 9). 3. **Plan de eventos**. 4. **Implementación**. 5. **Validación**. 6. **Vista de seguimiento** (qué mirar y cada cuánto).

## 1. Decisión de herramienta (depende de jurisdicción y de si hay anuncios)
Preguntar: ¿anuncios de Google/Meta con remarketing o optimización de conversiones?, ¿jurisdicción (01)?, ¿quién lo mirará?
- **Analítica sin cookies** (Plausible, Fathom, Umami y similares, o alternativas autoalojadas): menos datos, sin banner si la ley local lo permite y la herramienta no almacena nada en el dispositivo. Las afirmaciones de "no necesita consentimiento" proceden de los propios proveedores o de blogs, **no de un regulador**; ningún regulador de la UE las ha certificado en general (la CNIL aprobó Matomo en concreto con ciertas condiciones). Aun así hay que informar de la herramienta en la política de privacidad. Verificar con la guía oficial de la autoridad del país (CNIL, AEPD, ICO...) antes de afirmarlo. Pendiente: no encontré fuente oficial de la AEPD ni de Cloudflare Web Analytics.
- **GA4**: potente, gratis, imprescindible si se importan conversiones a Google Ads. Requiere consentimiento en UE/UK y gestión de Consent Mode.
- **Decisión por defecto sugerida** (hipótesis de la skill): sin anuncios de pago y objetivo simple (contacto/registro) → analítica sin cookies y sin banner si la jurisdicción lo permite; con anuncios de Google en el EEE → GA4 + Consent Mode v2 + CMP.
- Nada de "instalar ambas por si acaso": cada herramienta añade peso, consentimiento y mantenimiento.

## 2. Consentimiento y analítica (puente con la fase 9)
- Ninguna etiqueta de analítica o publicidad que escriba o lea almacenamiento del dispositivo se carga antes del consentimiento donde la ley lo exija. Comprobar en la pestaña Red/Aplicación de las herramientas del navegador, con el banner sin aceptar.
- **Consent Mode v2** (Google): obligatorio para sitios que sirven anuncios a usuarios del EEE/UK o los miden con productos de Google (según fuentes de proveedores; fecha de exigencia citada: marzo 2024, aplicación reforzada en 2025; verificar en la documentación de Google). Cuatro señales: `ad_storage`, `analytics_storage`, `ad_user_data`, `ad_personalization`. **Consent Mode no recoge el consentimiento**: lo hace el banner (CMP); el modo solo transmite la respuesta.
  - Estado por defecto **denegado** en las cuatro, para visitantes EEE/UK, **antes** de que cargue cualquier etiqueta de Google.
  - **Básico**: las etiquetas de Google no cargan hasta que hay consentimiento; no se modela nada. **Avanzado**: las etiquetas cargan con señales denegadas y envían pings sin cookies; permite modelado de conversiones. Su base legal es discutida: decidir con asesoría y reflejarlo en privacidad.
  - Un CMP certificado por Google emite las señales correctamente; se recomienda para anuncios en el EEE (la exigencia estricta varía según fuente).
  - Dato de una sola fuente (no verificado): cambios en junio de 2026 sobre Google Signals/`ad_storage`. Verificar antes de implementar.
- No poner datos personales (email, nombre, teléfono) en propiedades de eventos ni en URLs. Ajustes de retención de datos y capacidad de borrar usuarios cuando la herramienta lo permita.

## 3. Plan de eventos (una landing necesita pocos)
Formato del plan: `evento | descripción | propiedades | disparador | notas`. Nombres en minúsculas con guion bajo, objeto_acción, específicos ("cta_hero_clicked" mejor que "button_clicked"); el contexto va en propiedades, no en el nombre. Mantener los nombres que define el proveedor para eventos automáticos o recomendados (p. ej. `purchase`, `generate_lead`). Documentar.
Conjunto mínimo para una landing:
| Evento | Cuándo | Propiedades |
|---|---|---|
| `page_view` | carga (automático) | page_location, page_referrer |
| `cta_clicked` | clic en CTA principal/secundario | cta_location (hero/medio/final/sticky), button_text |
| `form_started` | primer foco en el formulario | form_name |
| `form_error` | validación fallida (opcional) | form_name, field/error_type |
| **`form_submitted` / `contact_submitted` / `signup_completed` / `demo_requested`** | **éxito confirmado por el servidor o carga de la página de gracias (fase 7)** | form_name, source |
| `scroll_depth` (opcional) | 50/90 % | depth |
| `outbound_link_clicked` (opcional) | WhatsApp/teléfono/email/calendario | link_type |
- **La conversión se define por éxito confirmado, no por el clic en el botón.** Un clic que falla validación o antispam no es conversión.
- Contacto directo (teléfono, WhatsApp, `mailto`): medir como evento propio de clic; es una conversión aproximada (el clic no garantiza la llamada).
- Valor de conversión: asignar un valor estimado por lead si se quiere optimizar anuncios o comparar fuentes; si no, no inventarlo.
- Descartado para una landing: eventos de onboarding, uso de producto, suscripción, carrito.

## 4. Atribución mínima y útil para una landing
- **Persistir el origen del visitante hasta la conversión**: capturar `utm_source/medium/campaign/content/term`, `gclid`/`fbclid` si hay anuncios, el `referrer` y la página de entrada en la primera visita (almacenamiento propio sujeto a consentimiento si procede) y **enviarlos como campos ocultos con el formulario** para que el lead llegue al CRM/base con su origen. Sin esto, el origen se pierde entre la visita y el envío.
- Convención UTM: minúsculas, guiones o guiones bajos consistentes, nombres específicos (`blog_footer_cta`, no `cta1`), hoja documentada de todos los UTM usados. Nunca poner UTM en enlaces internos del propio sitio (reinician la sesión).
- **Atribución declarada**: campo opcional "¿Cómo nos conociste?" en el formulario (texto libre o lista con "otro"). Es la señal más fuerte para boca a boca, podcasts, comunidades y redes oscuras, que el seguimiento no ve. Pesarla.
- No sumar las conversiones que declara cada plataforma de anuncios: la fuente de verdad es el número real de envíos/ventas del servidor (base de datos/CRM); las plataformas se contrastan con ese total.
- "Directo" y búsqueda de marca no son canales: son donde se cobra la demanda creada en otro sitio.
- Volumen bajo: la atribución multitoque y el MMM no son fiables; bastan UTM + atribución declarada + CRM como verdad.

## 5. Implementación (puntos que una IA suele fallar)
- Cargar el script **después** del consentimiento cuando proceda, y de forma que no bloquee el render (afecta a LCP: ver 05). Un solo contenedor/etiqueta; evitar GTM si solo hay 3-5 eventos (más peso y superficie); usarlo si hay varios píxeles y equipo de marketing no técnico.
- **Eventos duplicados**: típicos al disparar con navegación cliente (SPA), re-render o dos contenedores. Verificar que cada envío cuenta una vez.
- **GA4**: los parámetros personalizados no aparecen en informes hasta crear la dimensión personalizada (los datos tardan 24-48 h); marcar el evento como conversión (clave) y elegir el método de conteo (una por sesión para leads); activar "medición mejorada" con criterio (puede disparar eventos que no se desean); excluir tráfico interno y de desarrollo (definir IP interna / filtro); no medir entornos de preproducción en la misma propiedad.
- **Bloqueadores de anuncios y navegadores con protección** pueden ocultar 10-30 % del tráfico (rango orientativo, depende de la audiencia): por eso la fuente de verdad de leads es el servidor. Etiquetado en servidor solo si compensa; no por defecto.
- Vincular GA4 con Search Console (para consultas orgánicas) y con Google Ads si hay anuncios (activar etiquetado automático e importar conversiones).

## 6. Validación
Casillas: cada evento dispara en su disparador; propiedades con valores correctos; sin duplicados; funciona en móvil real y varios navegadores; la conversión se registra tras un envío real; sin datos personales en propiedades; con el banner sin aceptar no se escribe ninguna cookie de analítica/publicidad (donde sea exigible); con consentimiento denegado, Consent Mode envía lo esperado.
Herramientas: DebugView de GA4 (`?debug_mode=true`), Tag Assistant / vista previa de GTM, pestañas Red/Aplicación del navegador, informe en tiempo real (hasta ~30 min de retraso), Search Console.

## 7. Qué mirar tras el lanzamiento (entregable)
Panel mínimo: visitas por fuente/medio/campaña, tasa de conversión (envíos confirmados / visitas) por fuente y dispositivo, abandono del formulario (inicio vs envío), clics por CTA y ubicación, rendimiento de página móvil (CWV de campo), consultas orgánicas (Search Console) y calidad del lead en el CRM. Revisión semanal el primer mes, luego mensual. **No cambiar la página por cifras de pocos días**: con tráfico bajo las tasas son ruido (ver 10).

## Puerta
No se pasa a 09 sin: herramienta elegida y su impacto en consentimiento documentado para 09, plan de eventos aprobado, conversión definida por éxito confirmado, UTM/origen viajando hasta el lead, validación completada (incluida la prueba con banner sin aceptar).
