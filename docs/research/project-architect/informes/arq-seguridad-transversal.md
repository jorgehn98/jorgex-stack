# Fase 7: repaso transversal de seguridad, privacidad (decisión técnica) y coste

Investigación del 2026-10-12. Todas las fechas de lectura son 2026-10-12. Sin análisis legal. Lo que no se pudo abrir en fuente oficial va marcado NO VERIFICADO.

## 1. Criterios estables (cambian poco)

1. Modelar antes de listar: cuatro preguntas (qué construimos, qué puede fallar, qué hacemos al respecto, ¿fue suficiente?). Todo lo demás cuelga de las respuestas.
2. El rigor se proporciona a dos cosas: sensibilidad de los datos y consecuencia de un fallo. No al tamaño del equipo.
3. Controles por defecto de la plataforma primero (HTTPS, cabeceras, gestor de secretos del proveedor). Escribir seguridad propia es el último recurso.
4. Lo más rentable en proyectos pequeños: control de acceso correcto, secretos fuera del código, dependencias al día, copias de seguridad probadas, logs mínimos útiles.
5. Privacidad como decisión de arquitectura: recoger menos, guardar menos tiempo, restringir quién accede, valores por defecto privados.
6. Coste: asignar (etiquetas/propietario) antes que optimizar; alertar antes que recortar.
7. Cadena de suministro: ya cubierta en otras fases; aquí solo se enlaza (ver sección 6, punto 7).

## 2. Tabla de rigor por tamaño de proyecto

| Tamaño / tipo | Rigor | Qué hacer | Qué se puede saltar |
|---|---|---|---|
| Landing / web estática sin cuentas ni formularios con datos personales | Mínimo | HTTPS + HSTS, cabeceras básicas, sin secretos en el repo, dependencias/hosting al día, presupuesto con alerta | Modelado formal, ASVS completo, security.txt (opcional), gestor de secretos dedicado |
| Landing/web con formulario, newsletter o analítica | Bajo | Lo anterior + decidir qué datos se recogen y cuánto se retienen, proveedor de formularios revisado, CSP razonable, protección anti-spam | ASVS L2 completo, pentest, SIEM |
| SaaS o app con cuentas, datos de usuarios | Estándar (ASVS nivel 2 como referencia) | Modelado de amenazas de 30 min, Top 10 como lista de revisión, control de acceso por defecto-denegar, gestión de secretos, logs de seguridad, backups con restauración probada, security.txt, etiquetado y alertas de coste | Nivel 3, programas de bug bounty, HSM propios |
| API pública o con integraciones de terceros | Estándar + | Lo anterior + autenticación/autorización por recurso, límites de uso, validación de entrada en el borde, CORS con orígenes explícitos | Nivel 3 salvo datos críticos |
| Datos muy sensibles (salud, financieros) o fallo con impacto grave | Alto (ASVS nivel 3 como referencia) | Modelado formal revisado, verificación independiente, gestión de secretos con rotación automática, auditoría | Nada de lo anterior; aquí no hay atajos |

Regla de elección de nivel ASVS: L1 mínimo para todo; L2 para datos sensibles (recomendado para la mayoría); L3 para lo crítico. Ver sección 4.

## 3. Lista "antes de lanzar" (13 líneas)

1. Hay un diagrama simple del sistema y una lista de amenazas con respuesta (mitigar/aceptar) hecha con las cuatro preguntas.
2. Revisadas las diez categorías del OWASP Top 10:2025 contra el diseño, con foco en control de acceso y configuración.
3. Control de acceso: denegar por defecto y comprobado en el servidor para cada recurso, no solo en la interfaz.
4. Ningún secreto en el repositorio ni en la imagen; escaneo de secretos activo; plan de revocación y rotación si uno se filtra.
5. Credenciales con mínimo privilegio y separadas por entorno (producción distinta de desarrollo); CI/CD tratado como producción.
6. Todo por HTTPS con HSTS; cabeceras: nosniff, Referrer-Policy, Permissions-Policy, CSP o frame-ancestors; sin cabeceras de versión (Server, X-Powered-By).
7. Dependencias y cadena de suministro revisadas según la fase correspondiente (bloqueo de versiones, actualizaciones, escaneo).
8. Errores controlados: sin trazas ni datos internos al usuario; fallo cerrado (denegar) ante excepción.
9. Logs de eventos de seguridad (acceso, fallos de autenticación, cambios de permisos) con alerta mínima y sin datos personales innecesarios.
10. Inventario de datos personales: cada dato tiene finalidad, plazo de retención y borrado/anonimizado definido; lo no necesario no se recoge.
11. Copias de seguridad cifradas y restauración probada al menos una vez.
12. Canal para reportes de vulnerabilidades (security.txt con Contact y Expires, o dirección de correo documentada) si hay usuarios externos; fecha de caducidad en el calendario.
13. Coste: etiquetas/propietario, presupuesto con alertas (por ejemplo 80% y 100%), revisión mensual agendada, límite o cuota en servicios de pago por uso.

## 4. Datos por fuente

### 4.1 OWASP Top 10:2025
- Fuente: https://top10.owasp.org/2025 (redirige desde https://owasp.org/Top10/2025/). Leída 2026-10-12.
- Lista oficial (nombres exactos):
  1. A01:2025 Broken Access Control
  2. A02:2025 Security Misconfiguration
  3. A03:2025 Software Supply Chain Failures
  4. A04:2025 Cryptographic Failures
  5. A05:2025 Injection
  6. A06:2025 Insecure Design
  7. A07:2025 Authentication Failures
  8. A08:2025 Software or Data Integrity Failures
  9. A09:2025 Security Logging and Alerting Failures
  10. A10:2025 Mishandling of Exceptional Conditions
- Fecha de publicación: la página oficial NO indica fecha (solo "2025", copyright 2021-2025). NO VERIFICADO en fuente oficial. Fuentes secundarias (búsqueda web, no oficiales) dicen: candidata anunciada el 2025-11-06 en Global AppSec, versión final en enero de 2026 sin día exacto. Tratar como indicativo.
- Las páginas de introducción (top10.owasp.org/2025/en/0x00_2025-Introduction/) solo devolvieron una redirección; no se pudo leer.

### 4.2 OWASP ASVS
- Versión vigente: 5.0.0, "fechada en mayo de 2025" según https://github.com/OWASP/ASVS (leída 2026-10-12). La página https://owasp.org/www-project-application-security-verification-standard/ es ambigua (llama a 5.0.0 estable y también "bleeding edge").
- Niveles: el capítulo "Using the ASVS" de la 5.0 NO se pudo abrir (404/503). NO VERIFICADO para 5.0 literal. Descripción verificada en la guía oficial OWASP Developer Guide, https://devguide.owasp.org/en/03-requirements/05-asvs/ (leída 2026-10-12; cita ASVS 4.0.3):
  - L1: baja garantía; completamente probable por pruebas de intrusión; primeros pasos o visión de cartera.
  - L2: aplicaciones con datos sensibles; recomendado para la mayoría.
  - L3: aplicaciones más críticas, máxima confianza (transacciones de alto valor, datos médicos sensibles).
- Cómo elegir (resumen de lo anterior): empezar en L1 para todo, apuntar a L2 si hay cuentas o datos sensibles, L3 solo si el fallo es grave. Texto 4.0 de apoyo (vía búsqueda, no abierto directamente): github.com/OWASP/ASVS/blob/master/4.0/en/0x03-Using-ASVS.md.
- Recuento de requisitos de la 5.0 (70 en L1, 253 acumulado hasta L2, 345 hasta L3) proviene de un issue de GitHub de terceros: NO VERIFICADO.

### 4.3 Modelado de amenazas ligero
- OWASP Threat Modeling Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html (leída 2026-10-12). Pasos: modelar el sistema (DFD con fronteras de confianza o lluvia de ideas), identificar y ordenar amenazas (STRIDE como punto de partida), elegir respuesta (mitigar, eliminar, transferir, aceptar), revisar y validar. Debe mantenerse actualizado, no hacerse una sola vez; ideal en la fase de diseño.
- Threat Modeling Manifesto: https://www.threatmodelingmanifesto.org/ (leída 2026-10-12). Las cuatro preguntas: "What are we working on?", "What can go wrong?", "What are we going to do about it?", "Did we do a good enough job?". Sin texto dirigido a asistentes de IA.
- Media hora (adaptación mía, no figura así en las fuentes, que no definen un método "ligero" con nombre): 10 min dibujar flujo de datos y fronteras (pizarra); 10 min recorrer STRIDE sobre cada flujo/almacén; 10 min decidir respuesta por amenaza y anotar las 3-5 principales como tareas. Repetir al cambiar el diseño.

### 4.4 RFC 9116 (security.txt)
- Fuente: https://www.rfc-editor.org/rfc/rfc9116 (leída 2026-10-12). Estado: Informational (no es estándar de Internet Standards Track), 2022; mes exacto no extraído.
- Campos obligatorios: Contact (mailto:, tel: o HTTPS; puede repetirse) y Expires (RFC 3339, una sola vez; recomendado menos de un año en el futuro). Opcionales: Acknowledgments, Canonical, Encryption, Hiring, Policy, Preferred-Languages.
- Ubicación: /.well-known/security.txt por HTTPS, text/plain UTF-8. Firma OpenPGP recomendada, no obligatoria.
- Cuándo vale la pena (inferencia): solo si hay usuarios externos o datos de terceros y alguien lee el buzón. El propio RFC avisa de que un archivo caducado es peor que no tenerlo y de que aumenta el volumen de reportes (incluido spam). No concede permiso de pruebas; eso va en una política aparte. Para una landing sin datos, saltable.

### 4.5 Gestión de secretos
- Fuente: https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html (leída 2026-10-12). Esenciales: centralizar y documentar dónde está cada secreto; mínimo privilegio; automatizar rotación, preferir secretos dinámicos de vida corta; auditar accesos; ciclo de vida con caducidad y revocación; TLS siempre; copias cifradas; en CI/CD tratar el pipeline como producción y no pasar secretos por la salida; usar el gestor del proveedor cloud; en contenedores no hornear secretos en imágenes (variables de entorno solo como último recurso); escaneo de secretos en pre-commit y CI; plan de respuesta: revocar, rotar, limpiar código y logs.

### 4.6 Cabeceras seguras
- Fuente: https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html (leída 2026-10-12). Resumen: Strict-Transport-Security (max-age=63072000; includeSubDomains; preload, con cuidado por el preload), CSP (complejo; usar frame-ancestors), X-Content-Type-Options: nosniff, Referrer-Policy: strict-origin-when-cross-origin, Permissions-Policy desactivando lo no usado, COOP/COEP/CORP según necesidad, Cache-Control no-store en respuestas sensibles, CORS con orígenes concretos, retirar Server y X-Powered-By. Obsoletas: X-XSS-Protection (no usar o 0), Expect-CT, HPKP, Feature-Policy.
- OWASP Secure Headers Project: https://owasp.org/www-project-secure-headers/ (leída 2026-10-12): proyecto de producción, remite a su repositorio como fuente de verdad; la página no lista valores.

### 4.7 Cadena de suministro
- Cubierta en otras fases; solo enlazar. Dato de esta investigación: el Top 10:2025 la eleva a A03 "Software Supply Chain Failures".

### 4.8 Coste (FinOps)
- Marco: https://www.finops.org/framework/ y https://www.finops.org/framework/phases/ (leídas 2026-10-12). Una línea: el ciclo FinOps recorre Inform (medir y asignar costes), Optimize (reducir uso y mejorar tarifas) y Operate (aplicar los cambios de forma continua). La página del marco no muestra versión ni fecha propias (menciona "2026 Framework Updates"; último elemento fechado 2026-04-03).
- Prácticas a escala pequeña (la FinOps Foundation no tiene guía específica para equipos pequeños; el orden es síntesis de sus páginas, vía búsqueda): etiquetas obligatorias (p. ej. environment, owner, workload) definidas antes del primer recurso de producción, https://www.finops.org/wg/cloud-cost-allocation/; presupuestos con alertas, https://www.finops.org/wg/token-economics-saas/ (ejemplo para costes de IA: medir 30-60 días, presupuesto al 110-120% de la base, alertas al 80% y 100%); alertas de anomalías diarias, https://www.finops.org/wg/managing-cloud-cost-anomalies/. Revisión mensual: es práctica común, pero no la encontré expresada como regla de la Foundation: NO VERIFICADO como cita.

### 4.9 Privacidad desde el diseño
- Fuente primaria: Information and Privacy Commissioner of Ontario (Ann Cavoukian), "Privacy by Design: The 7 Foundational Principles", publicado en agosto de 2009, revisado en enero de 2011. URL oficial https://www.ipc.on.ca/wp-content/uploads/Resources/7foundationalprinciples.pdf devolvió 404 el 2026-10-12; texto leído en la copia alojada en https://www.sfu.ca/~palys/Cavoukian-2011-PrivacyByDesign-7FoundationalPrinciples.pdf (misma publicación; copia, no el sitio del emisor).
- Los siete: 1) Proactive not Reactive; Preventative not Remedial. 2) Privacy as the Default Setting. 3) Privacy Embedded into Design. 4) Full Functionality: Positive-Sum, not Zero-Sum. 5) End-to-End Security: Full Lifecycle Protection. 6) Visibility and Transparency: Keep it Open. 7) Respect for User Privacy: Keep it User-Centric.
- Decisión técnica: minimización (no recoger lo que no se usa; menos tipos y menos detalle), retención (plazo por dato según su finalidad, borrado o anonimización al vencer), acceso (por roles, mínimo), valores por defecto privados, y cifrado/seudonimización cuando aplique. Apoyo del EDPB, Guidelines 4/2019 v2.0 (adoptadas octubre 2020): https://www.edpb.europa.eu/sites/default/files/files/file1/edpb_guidelines_201904_dataprotection_by_design_and_by_default_v2.0_en.pdf. Solo vista en resumen de búsqueda; el PDF no se abrió: NO VERIFICADO directamente. AEPD: no consultada. No se analiza ninguna ley.

## 5. Datos volátiles (con fecha)

| Dato | Valor | Fuente | Leído |
|---|---|---|---|
| Edición vigente OWASP Top 10 | 2025 (sin 2026 anunciado según fuentes secundarias; siguiente ~2028-29, no oficial) | top10.owasp.org/2025 | 2026-10-12 |
| Versión ASVS | 5.0.0 (mayo 2025) | github.com/OWASP/ASVS | 2026-10-12 |
| Estado RFC 9116 | Informational, 2022 | rfc-editor.org/rfc/rfc9116 | 2026-10-12 |
| HSTS recomendado | max-age=63072000; includeSubDomains; preload | OWASP HTTP Headers CS | 2026-10-12 |
| Alertas de presupuesto de ejemplo | 80% y 100% (ejemplo de FinOps para costes de IA, no norma) | finops.org/wg/token-economics-saas | 2026-10-12 |
| Privacy by Design | revisión enero 2011 | IPC Ontario (copia SFU) | 2026-10-12 |

## 6. Estado de las fuentes

| Fuente | Estado |
|---|---|
| top10.owasp.org/2025 (lista) | Verificado |
| Fecha de publicación Top 10:2025 | NO VERIFICADO oficialmente (solo secundarias) |
| ASVS versión 5.0.0, mayo 2025 | Verificado (GitHub OWASP) |
| ASVS niveles texto 5.0 | NO VERIFICADO (404/503); niveles verificados en Developer Guide (basada en 4.0.3) |
| Threat Modeling Cheat Sheet y Manifesto | Verificado |
| RFC 9116 | Verificado (mes de publicación no extraído) |
| Secrets Management CS | Verificado |
| HTTP Headers CS | Verificado |
| Secure Headers Project | Verificado (sin lista de valores en la página) |
| FinOps Framework y fases | Verificado |
| Prácticas FinOps de etiquetado, presupuesto y anomalías | Verificado vía resumen de búsqueda de páginas finops.org; páginas no abiertas una a una |
| Revisión mensual como práctica FinOps | NO VERIFICADO |
| Privacy by Design (7 principios) | Verificado en copia SFU del PDF del IPC; URL oficial 404 |
| EDPB 4/2019 | NO VERIFICADO directamente (solo búsqueda) |
| AEPD | No consultada |
| Texto dirigido a IA en páginas | Ninguno detectado en las páginas leídas |

## 7. Resumen final (qué cambiaría la recomendación de la skill)

1. Citar Top 10 como edición 2025 con A03 Software Supply Chain Failures y A10 Mishandling of Exceptional Conditions; SSRF ya no es categoría propia (según fuentes secundarias).
2. Referenciar ASVS 5.0.0 (mayo 2025), no 4.0.x; la regla de niveles (L1 todos, L2 datos sensibles, L3 crítico) viene de documentación 4.0, revisar al verificar el texto 5.0.
3. Para web/landing sin datos, la fase puede reducirse a HTTPS, cabeceras, secretos fuera del repo y alerta de coste.
4. security.txt solo con usuarios externos y buzón atendido; un Expires vencido es peor que no tenerlo.
5. Modelado de amenazas: las cuatro preguntas bastan; la media hora es adaptación, no método oficial.
6. Privacidad: tratar minimización y retención como campos obligatorios del registro de decisiones.
7. Coste: etiquetado antes que optimización; presupuesto con alertas; revisión mensual es práctica sin cita oficial.
8. Pendiente de verificar si se quiere cerrar: fecha oficial Top 10, texto ASVS 5.0 de niveles, EDPB/AEPD en PDF.
