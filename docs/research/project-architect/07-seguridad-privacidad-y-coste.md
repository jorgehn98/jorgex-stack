# 07-seguridad-privacidad-y-coste — borrador

Fuente: informes/arq-seguridad-transversal.md (investigación propia con documentación oficial; sin material de terceros adaptado). Estado: borrador pendiente de revisión.
Naturaleza de la fase: **repaso transversal corto**, no una fase larga. La seguridad, los datos personales y el coste ya se decidieron dentro de las fases 02-06; aquí se revisa lo decidido, se cubren los huecos y se proporciona el rigor al proyecto. Sin análisis legal: cualquier cuestión normativa se marca `[NEED: revisión legal]` y se resuelve al construir las páginas públicas (ver la relación con lo legal de 04).
Se reduce a una línea en landings y webs estáticas sin datos (HTTPS, cabeceras básicas, secretos fuera del repositorio, alerta de coste).

## Entrada
Registro de decisiones parcial (01-06): tipo de proyecto, sensibilidad de los datos, servicios, despliegue, observabilidad, mapa de datos.

## Principios (estables)
1. **Modelar antes de listar:** cuatro preguntas (qué construimos, qué puede fallar, qué hacemos al respecto, ¿fue suficiente?); todo lo demás cuelga de las respuestas.
2. **El rigor se proporciona a la sensibilidad de los datos y a la consecuencia de un fallo, no al tamaño del equipo.**
3. **Primero los controles por defecto de la plataforma** (HTTPS, cabeceras, gestor de secretos del proveedor); escribir seguridad propia es el último recurso.
4. **Lo más rentable en proyectos pequeños:** control de acceso correcto, secretos fuera del código, dependencias al día, copias probadas, registros mínimos útiles.
5. **Privacidad como decisión de arquitectura:** recoger menos, guardar menos tiempo, restringir quién accede, valores por defecto privados. La minimización y la retención son campos obligatorios del registro de decisiones.
6. **Coste:** asignar (etiquetas y propietario) antes que optimizar; alertar antes que recortar.

## Rigor por tipo de proyecto
| Proyecto | Rigor | Qué hacer | Qué se puede saltar |
|---|---|---|---|
| Landing o web estática sin cuentas ni datos personales | Mínimo | HTTPS con HSTS, cabeceras básicas, sin secretos en el repositorio, dependencias y hosting al día, presupuesto con alerta | Modelado formal, ASVS completo, `security.txt`, gestor de secretos dedicado |
| Web con formulario, boletín o analítica | Bajo | Lo anterior + decidir qué datos se recogen y cuánto se retienen, proveedor de formularios revisado, CSP razonable, antispam | ASVS nivel 2 completo, pruebas de intrusión |
| SaaS o aplicación con cuentas | Estándar (ASVS nivel 2 como referencia) | Modelado de amenazas de unos 30 minutos, Top 10 como lista de revisión, control de acceso con denegar por defecto, gestión de secretos, registros de seguridad, copias con restauración probada, `security.txt`, etiquetado y alertas de coste | Nivel 3, programas de recompensas, módulos de seguridad dedicados |
| API pública o con integraciones | Estándar + | Lo anterior + autenticación y autorización por recurso, límites de uso, validación de entrada en el borde, CORS con orígenes explícitos | Nivel 3 salvo datos críticos |
| Datos muy sensibles (salud, finanzas) o impacto grave | Alto (ASVS nivel 3) | Modelado formal revisado, verificación independiente, rotación automática de secretos, auditoría; revisión legal previa | Ningún atajo |
Niveles de ASVS: nivel 1 para todo; nivel 2 para datos sensibles (recomendado para la mayoría); nivel 3 para lo crítico. Versión vigente 5.0.0 (mayo de 2025); la descripción de niveles verificada es de la Developer Guide de OWASP, basada en 4.0.3, así que se comprueba al consultar el texto 5.0.

## Modelado de amenazas ligero
Las cuatro preguntas del Threat Modeling Manifesto bastan. Adaptación propia en media hora (no es método oficial): 10 minutos para dibujar flujo de datos y fronteras de confianza, 10 para recorrer STRIDE sobre cada flujo y almacén, 10 para decidir respuesta (mitigar, eliminar, transferir o aceptar) y anotar las 3 a 5 principales como tareas. Se repite cuando cambia el diseño; no se hace una sola vez.

## Lista "antes de lanzar" (resumen; el detalle se reparte por las fases)
1. Diagrama simple del sistema y lista de amenazas con respuesta.
2. Las diez categorías del OWASP Top 10:2025 revisadas contra el diseño, con foco en control de acceso y configuración (la edición 2025 incluye cadena de suministro y manejo de condiciones excepcionales como categorías).
3. Control de acceso: denegar por defecto, comprobado en el servidor por recurso, no solo en la interfaz.
4. Ningún secreto en el repositorio ni en la imagen; escaneo de secretos activo; plan de revocación y rotación si uno se filtra.
5. Credenciales con mínimo privilegio y separadas por entorno; el pipeline de CI/CD se trata como producción.
6. Todo por HTTPS con HSTS; cabeceras `nosniff`, `Referrer-Policy`, `Permissions-Policy`, CSP o `frame-ancestors`; sin cabeceras de versión; las cabeceras obsoletas (`X-XSS-Protection`, `Expect-CT`, HPKP) no se usan.
7. Dependencias y cadena de suministro según 03 y 05 (versiones fijadas, actualizaciones, escaneo).
8. Errores controlados: sin trazas ni datos internos al usuario; fallo cerrado ante una excepción.
9. Registros de eventos de seguridad (acceso, fallos de autenticación, cambios de permisos) con alerta mínima y sin datos personales innecesarios.
10. Inventario de datos personales con retención y borrado definidos (mapa de datos de 04); lo que no se necesita no se recoge.
11. Copias cifradas y restauración probada al menos una vez (04).
12. Canal de reporte de vulnerabilidades si hay usuarios externos y alguien atiende el buzón: `security.txt` con `Contact` y `Expires` (RFC 9116, informativo, 2022) o una dirección documentada. Un archivo caducado es peor que no tenerlo y aumenta el volumen de reportes, incluido spam; no concede permiso de pruebas.
13. Coste: etiquetas y propietario, presupuesto con alertas (por ejemplo al 80 % y al 100 %, ejemplo de FinOps y no norma), límite o cuota en servicios de pago por uso, revisión mensual agendada (práctica común sin cita oficial).

## Coste
Marco de la FinOps Foundation en una línea: medir y asignar (Inform), reducir y mejorar tarifas (Optimize), aplicar de forma continua (Operate). A escala pequeña: etiquetas definidas antes del primer recurso de producción, presupuesto con alertas, alertas de anomalías diarias, y revisión mensual de costes (los pasos concretos son síntesis de varias páginas de FinOps; la Fundación no tiene guía para equipos pequeños).

## Entregable
Sección final del registro de decisiones, "Seguridad, privacidad y coste": nivel de rigor elegido y por qué, amenazas principales con su respuesta, estado de la lista "antes de lanzar" (hecho, pendiente, no aplica con motivo), canal de reporte, política de minimización y retención, presupuesto y alertas, y `[NEED: revisión legal]`.

## Verificación
- La lista "antes de lanzar" está marcada línea a línea con evidencia (dónde se ve cada punto) o con el motivo de no aplicar.
- Las amenazas principales tienen respuesta decidida y una tarea asociada.
- Las cabeceras se comprueban en la respuesta real y no solo en la configuración.
- Datos volátiles (edición de OWASP Top 10, versión de ASVS) con fecha de lectura.

## Auditoría (modo revisar)
Comprobar: secretos en el repositorio o en la imagen (bloqueante); control de acceso solo en la interfaz (bloqueante); cabeceras de versión visibles o cabeceras obsoletas; sin HTTPS o sin HSTS en producción (alta); datos personales sin retención definida; copias sin restauración probada (04); `security.txt` caducado o buzón sin atender; sin alertas de coste; modelo de amenazas inexistente en un SaaS o API; rigor muy por encima del necesario (por ejemplo, ASVS nivel 3 en una landing); lista "antes de lanzar" sin evidencia.

## Puerta
No se pasa a 08 sin: nivel de rigor elegido y justificado, modelado de amenazas hecho o saltado con motivo, lista "antes de lanzar" con estado por línea, política de minimización y retención escrita, presupuesto con alertas, canal de reporte decidido (o motivo para no tenerlo) y datos volátiles verificados con fecha o marcados como no verificados.

## No verificado / pendiente
- Fecha oficial de publicación del OWASP Top 10:2025: la página oficial no la indica; fuentes secundarias hablan de noviembre de 2025 (candidata) y enero de 2026 (final). Lista de categorías verificada.
- Texto de niveles de ASVS 5.0 (capítulo "Using the ASVS" dio 404 y 503); el recuento de requisitos por nivel viene de un issue de terceros.
- Privacy by Design: los siete principios se leyeron en una copia universitaria del documento del comisionado de Ontario (publicado en 2009, revisado en 2011); la URL oficial dio 404. Guidelines 4/2019 del EDPB solo vistas en resumen de búsqueda; AEPD no consultada. No se analiza ninguna ley.
- FinOps: el etiquetado, los presupuestos y las anomalías se verificaron por resumen de búsqueda de páginas de la Fundación; la revisión mensual no figura como regla suya. Mes de publicación del RFC 9116 no extraído.
- La media hora de modelado y el criterio de rigor por tamaño son adaptaciones propias. Ninguna página contenía texto dirigido a asistentes de IA.

## Enlaces oficiales a incluir (verificar al redactar)
top10.owasp.org/2025; OWASP ASVS (GitHub) y Developer Guide; Threat Modeling Manifesto y Cheat Sheet; RFC 9116; OWASP Secrets Management y HTTP Headers Cheat Sheets; finops.org (framework y fases); Privacy by Design (siete principios) del comisionado de Ontario.
