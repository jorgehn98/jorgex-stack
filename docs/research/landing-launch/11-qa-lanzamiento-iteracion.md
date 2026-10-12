# 11-qa-lanzamiento-iteracion — extractos

Fuentes: Marketing Skills (Corey Haines, MIT), skill launch (site-launch-qa + puerta de preparación; descartado ORB, Product Hunt, fases alfa/beta, anuncios de producto: es estrategia de lanzamiento de producto, no de una landing), ab-testing, búsqueda web (cabeceras de seguridad, WCAG 2.2). Estado: borrador completo de la fase. Esta fase **verifica** todo lo anterior: cada casilla remite a la fase que la define.

## Puerta de preparación (antes de la QA)
Idea de "Simple, Lovable, Complete" (Jason Cohen) adaptada: ¿la página hace **una** cosa (objetivo único, 01), sería elegida y no solo tolerada (propuesta clara, 02-03) y es completa para esa cosa (sin huecos: pruebas, legal, formulario funcionando)? Si se sigue puliendo más allá de esa barra, publicar; si se sigue añadiendo alcance, recortar.

## Tres pasadas
Antes del cambio, en el cambio y las dos primeras semanas. Lanzar con un plan de vuelta atrás probado.

### 1. Antes de publicar (en staging o preproducción)
**Contenido y enlaces**
- [ ] Todo el copy es final: sin lorem ipsum, "TBD", precios de prueba ni `[NEED: …]`/`[COMPLETAR: …]` pendientes (04, 09).
- [ ] Rastreo de la preproducción: sin enlaces rotos ni imágenes ausentes; el enlace del CTA y de los datos de contacto reales.
- [ ] Páginas legales presentes, enlazadas desde el pie y desde el formulario, con los datos del titular completos (09).
- [ ] Precio, planes, plazos y datos de contacto coinciden con lo que dicen ventas y soporte.
**Formularios y conversión (07, 08)**
- [ ] Envío de prueba real de cada formulario llega a la base/CRM, al aviso interno y a la confirmación del usuario (Gmail y otro proveedor, sin caer en spam).
- [ ] Antispam verificado en servidor (honeypot relleno y token inválido se rechazan); un doble envío crea un solo registro.
- [ ] La conversión se dispara con el éxito confirmado (página de gracias o evento de servidor), no con el clic.
- [ ] Analítica instalada una vez, tráfico interno excluido, sin eventos duplicados; UTM y origen llegan al lead.
- [ ] Banner/CMP funciona y las etiquetas lo respetan: con el banner sin aceptar no se escribe ninguna cookie no esencial ni hay peticiones de seguimiento (09).
**SEO (05, 06)**
- [ ] Título único, meta description y un H1; canónica apunta al dominio de producción, no a preproducción.
- [ ] **La preproducción es `noindex` o está protegida con contraseña, y la producción NO lo es**: el fallo de SEO más común el día del lanzamiento es publicar con el `noindex` de preproducción. Comprobar la cabecera `X-Robots-Tag` y la etiqueta meta.
- [ ] `robots.txt` permite lo que debe indexarse y refleja la política de rastreadores de IA; el sitemap lista URLs de producción.
- [ ] Datos estructurados validados (Rich Results Test para funciones de Google; validador de Schema.org para el resto).
- [ ] Contenido principal en el HTML del servidor (ver con "ver código fuente", sin JS).
- [ ] Si es una migración o sustituye una página existente: mapa de redirecciones 301 cargado y probado con una muestra de URLs antiguas.
**Rendimiento y acceso**
- [ ] Core Web Vitals aceptables en móvil con los presupuestos de la fase 10; en producción, repetir la medición (los scripts y el CDN reales pueden cambiar el resultado).
- [ ] Funciona en móvil real, Safari y navegadores integrados de apps (LinkedIn, Instagram, Facebook).
- [ ] Open Graph: título e imagen se ven bien al compartir la URL (depurador de cada red).
- [ ] 404 propia y útil; favicon; `lang` correcto.
**Rendimiento y accesibilidad**: ya medidos y aprobados en la fase 10; aquí solo se **repite una comprobación rápida en producción** (LCP/CLS/INP de laboratorio, teclado y lector de pantalla del flujo principal) para detectar diferencias entre preproducción y producción (CDN, caché, scripts reales).
**Seguridad básica (sitio estático o ligero)**
- [ ] HTTPS en todos los hostnames (www y apex) con una redirigiendo a la otra; certificado válido y renovación automática.
- [ ] Cabeceras: HSTS (solo cuando todo sea HTTPS; empezar con `max-age` moderado), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` desactivando lo que no se usa, `frame-ancestors`/`X-Frame-Options`; CSP al final y primero en modo "solo informar"; quitar `Server`/`X-Powered-By` con versión. Con Nginx usar `always` para que las cabeceras salgan también en 404/500. Verificar con una herramienta de análisis de cabeceras. Orden de despliegue: HSTS y `nosniff` primero, CSP el último.
- [ ] Secretos solo en servidor, sin claves en el repositorio ni en el JS del cliente; dependencias sin vulnerabilidades graves conocidas.
**Vuelta atrás**
- [ ] Se sabe cómo revertir en la plataforma (promover el despliegue anterior, restaurar copia) y alguien lo ha probado una vez.
- [ ] Si se cambia DNS: reducir el TTL un día antes; anotar los registros actuales (incluidos los de correo: SPF/DKIM/DMARC, que no deben perderse en el cambio).

### 2. En el momento de publicar
- [ ] Desplegar las redirecciones a la vez que la página nueva.
- [ ] HTTPS correcto en todos los hostnames.
- [ ] Cargar las páginas clave y comprobar contenido, título, canónica y código 200.
- [ ] Enviar un formulario real y confirmar que llega a todos los destinos (base, aviso, confirmación) y que la conversión aparece en analítica.
- [ ] Enviar el sitemap en Search Console y en Bing Webmaster Tools; solicitar la indexación de la URL **una vez**.
- [ ] Repetir la comprobación de que producción no tiene `noindex`.
- [ ] Alerta de disponibilidad (monitorización de uptime) activada para la URL y para el endpoint del formulario.

### 3. Las dos primeras semanas
- [ ] Search Console: revisar cobertura/indexación y 404 a diario la primera semana, luego semanal; arreglar redirecciones que falten.
- [ ] Comparar tráfico y conversiones con el periodo anterior, página por página, no solo en total.
- [ ] Confirmar que las conversiones llegan a cada plataforma de anuncios al ritmo esperado (contrastar con el servidor, 08).
- [ ] Probar el flujo completo otra vez en producción a los 2-3 días y a la semana (formulario, email, consentimiento).
- [ ] Corregir enlaces internos que aún apuntan a URLs redirigidas.
- [ ] Recoger fallos que reporten el equipo y los usuarios y decidir qué es urgente.
- [ ] Auditoría ligera de visibilidad en IA (06) y comprobación de que la página aparece indexada con el título deseado.
- [ ] Revisión legal puntual si cambió alguna fuente volátil de 09 desde la verificación.

## Mantenimiento recurrente
Mensual: Core Web Vitals de campo, enlaces rotos, caducidad de certificados/dominio, errores del formulario, consentimiento y proveedores nuevos que cargan scripts. Trimestral: revisar fechas y cifras visibles (prueba social, precios, "actualizado el…"), la política de privacidad frente a los tratamientos reales y las fuentes volátiles de 09; refrescar contenido que compita por posiciones (05).

## Iteración: cuándo A/B-testear y cuándo simplemente publicar
- Una prueba A/B fiable exige muestra: depende de conversión base, mejora mínima detectable y 95 % de confianza / 80 % de potencia. Tabla de referencia del origen (visitantes por variante): base 1 %: 150k (10 % mejora), 39k (20 %), 6k (50 %); base 3 %: 47k, 12k, 2k; base 5 %: 27k, 7k, 1,2k; base 10 %: 12k, 3k, 550. Calculadoras: Evan Miller, Optimizely.
- Una landing típica no tiene ese tráfico. Regla de la skill: si no se alcanza la muestra en **4-6 semanas**, no testear; publicar el cambio con apoyo cualitativo (5-10 usuarios, grabaciones de sesión, encuesta corta "¿qué te frenó?") y medir antes/después con cautela. Las fuentes dan umbrales dispares (de ~1.000 visitas semanales a la página a decenas de miles por variante): orientativos.
- Si se testea: cambios grandes (un 50 % de mejora necesita ~1/10 de muestra que un 5 %), una hipótesis por prueba, pocas variantes (cada variante extra reparte el tráfico), duración fija con mínimo de dos semanas completas, **sin mirar y parar antes** (peeking), sin cambiar la página ni la mezcla de tráfico a mitad. Un resultado no significativo es **inconcluso**, no un empate.
- Hipótesis en formato: "Como [observación/dato], creemos que [cambio] provocará [efecto] en [métrica], porque [razón]"; métrica principal única + de guarda (p. ej. calidad del lead).
- Prioridad de ideas: puntuación ICE (impacto, confianza, facilidad). Primero lo que el diagnóstico de 03 marcó como mayor fricción (propuesta de valor, titular, CTA, formulario, prueba social), luego precio y orden.
- Errores típicos: cambio demasiado pequeño, demasiadas cosas a la vez, sin hipótesis, parar pronto, trocear segmentos hasta encontrar algo, sobreinterpretar un resultado inconcluso.
- Cifras sin contrastar: "solo 1 de cada 8 pruebas es significativa" (blog).
