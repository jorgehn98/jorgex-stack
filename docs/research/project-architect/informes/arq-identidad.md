# Arquitectura: identidad y servicios. Tema A: autenticación y autorización

Fecha de verificación: 2026-10-12. Skill genérica, sin tecnología ni proveedor preferido.
Convención: **[V]** verificado en la fuente abierta hoy; **[P]** verificado parcialmente (página truncada o solo resumen de búsqueda); **[NV]** NO VERIFICADO (no se abrió o no se pudo confirmar). Ninguna página abierta contenía texto dirigido a asistentes de IA (comprobado en las cheat sheets de OWASP Authentication y JWT; el resto no mostró nada).

---

## 1. Criterios estables

### 1.1 Cuándo NO hace falta autenticación
Criterio: no hay datos ni acciones que dependan de "quién es esta persona" y nada que deba persistir por usuario.
- Landing, web de contenido, documentación pública, blog, catálogo sin cuenta: no hace falta. Formulario de contacto o waitlist: se resuelve con validación + antispam + límite de tasa, no con cuentas.
- Compra como invitado (checkout sin cuenta), pedidos consultables por enlace firmado de un solo uso: evita crear cuentas, pero el enlace es una credencial (caducidad, un uso, no adivinable).
- Panel de administración de un único operador: puede bastar autenticación delegada (acceso por proxy/VPN/IdP existente) en vez de un sistema de usuarios propio.
- API pública de solo lectura: normalmente clave de API o nada; la clave identifica un cliente, no un usuario.
- Cuándo SÍ: datos personales por usuario, estado persistente por usuario, pagos, contenido restringido, roles, auditoría de acciones, multiusuario.
- Señal de alarma: añadir cuentas "por si acaso". Cada cuenta crea superficie (recuperación, abuso, RGPD/cumplimiento, soporte). YAGNI aplica, pero ver sección 4: el identificador de usuario y el modelo de organización se deciden antes de que haya usuarios si el producto va a tenerlos.

### 1.2 Construir vs servicio gestionado vs IdP autoalojado
Criterios (sin proveedor):
| Criterio | Construir | Servicio gestionado | IdP autoalojado |
|---|---|---|---|
| Coste de equivocarse | Alto: cada fallo (recuperación, sesiones, MFA, enumeración) es tuyo | Medio: el proveedor absorbe la mayor parte del riesgo del protocolo; tú sigues siendo responsable de la integración y de la autorización | Medio-alto: operas parches, copias, alta disponibilidad |
| Seguridad | Depende totalmente del equipo | Delegada, pero con dependencia de su disponibilidad y de su incidente | Delegada en software maduro, pero operación a tu cargo |
| Cumplimiento (RGPD, sector) | Control total de datos y ubicación | Revisar ubicación de datos, encargado del tratamiento, subencargados, certificaciones | Control total de datos y ubicación |
| Bloqueo (lock-in) | Ninguno | Alto si no se pueden exportar hashes (ver abajo) | Bajo-medio (estándares abiertos, formato propio de export) |
| Exportación usuarios y hashes | Total | Varía mucho: confirmar ANTES de elegir | Normalmente posible; el formato del hash es el del IdP |
| SSO/empresa (SAML, OIDC enterprise, SCIM) | Mucho trabajo | Suele ser el factor de precio principal | Soportado; configuración y soporte propios |
| Límites de plan | n/a | Usuarios activos, conexiones SSO, MFA, retención, personalización; cambian (ver sección 5) | Solo recursos propios |
| Coste de operar | Tiempo de desarrollo y mantenimiento | Variable por usuario | Infraestructura + tiempo de guardia |

Reglas estables derivadas:
- No construir criptografía de autenticación ni el flujo de recuperación si hay una opción madura que cubra el caso; construir tiene sentido cuando el modelo de identidad es trivial (un solo método, sin SSO, sin MFA, pocos usuarios) o cuando hay restricción dura de datos/coste. Reconocer que "construir" también incluye usar una librería de autenticación del framework: sigue siendo tu responsabilidad.
- Pregunta de salida obligatoria antes de elegir un gestionado: ¿se pueden exportar usuarios Y hashes de contraseña? ¿en qué formato (bcrypt, scrypt, PBKDF2, Argon2) y con qué parámetros? ¿en qué plan? Sin hashes exportables, migrar obliga a reset masivo de contraseñas o a migración perezosa (verificar en el proveedor viejo en el primer login).
- Pregunta de entrada: ¿se pueden importar hashes existentes en el formato que ya tienes? (migración hacia dentro).
- Fiabilidad: el login es camino crítico; su caída es caída total. Evaluar SLA, estado histórico y modo degradado.
- Estándares abiertos (OIDC, OAuth) como interfaz reducen el bloqueo; extensiones propietarias (metadata de usuario, componentes de UI, reglas/hooks) lo aumentan.
- Evidencia de la variabilidad de export (ejemplos, no recomendaciones): ver sección 5.

### 1.3 Métodos de autenticación
| Método | Ventajas | Compromisos | Fuente |
|---|---|---|---|
| Contraseña | Universal, sin dependencias externas | Reutilización, phishing, credential stuffing; exige almacenamiento correcto, recuperación y límite de intentos | NIST 800-63B-4, OWASP Auth, OWASP Password Storage |
| Enlace mágico / código por correo | Sin contraseña que guardar ni robar; baja fricción | Seguridad = seguridad del buzón; no es resistente al phishing; entregabilidad del correo; riesgo de abuso (spam, bombing) y de enlaces reenviados/pre-fetch por escáneres de correo; NIST 800-63B-4 dice que el correo NO se puede usar como canal fuera de banda de autenticación (sí para verificar el correo y para recuperación) | NIST 800-63B-4 [V] |
| OAuth/OIDC con proveedores sociales | Sin contraseñas propias; verificación de correo "gratis" según el proveedor | Dependencia de terceros, posible bloqueo de cuenta del usuario en ese proveedor, no todos tienen cuenta; identificar por `iss`+`sub`, NUNCA por correo; vincular cuentas por correo exige confirmar que el correo está verificado | OWASP Auth, OIDC Core [V] |
| Passkeys / WebAuthn | Resistente al phishing (credencial ligada al origen); sin secreto compartido | Recuperación y portabilidad entre ecosistemas; credenciales sincronizadas (backup eligible) no son "no exportables"; hay que mantener un método de recuperación | W3C WebAuthn L3, NIST 800-63B-4 App. B, OWASP Auth/MFA [V] |
| MFA: TOTP | Estándar (RFC 6238), sin hardware | Phishable, semillas en copias de seguridad, app en el mismo dispositivo | OWASP MFA [V] |
| MFA: push | Cómodo | Fatiga de aprobaciones; exige number matching y límite de avisos | OWASP MFA [V] |
| MFA: clave de seguridad / passkey | Resistente al phishing | Coste y logística de hardware; exigir verificación de usuario (PIN/biometría), la mera presencia no es segundo factor | OWASP MFA, WebAuthn [V] |
| MFA: SMS/voz | Muy extendido | NIST lo marca como restringido (SIM swap, portabilidad, coste/abuso); ofrecer alternativa | NIST 800-63B-4, OWASP MFA [V] |

Reglas verificadas de contraseñas (NIST 800-63B-4 y OWASP Auth) [V]:
- Mínimo 15 caracteres si la contraseña es el único factor; 8 si solo se usa dentro de MFA. Aceptar al menos 64. Aceptar Unicode y espacios.
- Sin reglas de composición ni rotación periódica obligatoria (solo ante indicio de compromiso). Comprobar contra lista de contraseñas comunes/filtradas. Permitir pegar y gestores de contraseñas. Sin pistas ni preguntas de seguridad.
- Almacenamiento (OWASP Password Storage) [V]: Argon2id preferido (mínimo 19 MiB de memoria, 2 iteraciones, paralelismo 1), scrypt (N=2^17, r=8, p=1) si no hay Argon2id, bcrypt solo en sistemas heredados (factor >= 10 y límite de 72 bytes), PBKDF2-HMAC-SHA256 con >= 600.000 iteraciones si se exige FIPS. Guardar algoritmo y parámetros con el hash (formato PHC) para poder migrar; rehash en el siguiente login. Pepper opcional, fuera de la base de datos.
- Niveles de garantía NIST (AAL) [V]: AAL1 permite un factor; AAL2 exige dos factores, un autenticador resistente a repetición y ofrecer al menos una opción resistente al phishing; AAL3 exige criptografía resistente al phishing con clave no exportable (las credenciales sincronizadas no valen en AAL3). Las credenciales sincronizadas pueden servir en AAL2 si el tejido de sincronización está protegido con MFA equivalente a AAL2 y las claves van cifradas (Apéndice B).
- Apéndice B de NIST usa el término "syncable authenticators"; no usa la palabra "passkey" en el texto leído.
- Pedir MFA: en el login, y en acciones sensibles (cambio de contraseña, de correo, desactivar MFA, elevar a admin), y en TODAS las vías de acceso (API, móvil) [V OWASP MFA].
- Recuperación de MFA: códigos de recuperación de un solo uso, varios tipos de factor inscritos, y reautenticar con un factor ya inscrito antes de cambiarlo; notificar fuera de banda [V].

OAuth/OIDC (solo roles y flujos) [V]:
- OAuth 2.0 es autorización delegada; OIDC añade identidad (ID token con `iss`, `sub`, `aud`, `exp`, `iat` obligatorios). Validar firma, emisor, audiencia y caducidad.
- Flujo recomendado: Authorization Code con PKCE (S256). RFC 9700 (BCP 240, enero 2025): PKCE obligatorio para clientes públicos, S256, coincidencia exacta del redirect URI, no usar implicit, no usar el grant de contraseña, proteger `state`/`nonce`, verificar `iss` si hay varios servidores de autorización.
- Para SPAs: RFC 10017 / BCP 212 (OAuth for Browser-Based Applications) [P]: orden de preferencia BFF (tokens solo en servidor, el navegador tiene una cookie de sesión), luego backend mediador de tokens, y por último cliente solo-navegador, el más débil. Detalle de almacenamiento (sección 8 del RFC) no leído.

### 1.4 Sesión de servidor con cookie vs JWT
Sesión en servidor con cookie (opaca) [V OWASP Session Management, NIST 800-63B-4 §5]:
- ID aleatorio (CSPRNG, >= 64 bits de entropía según OWASP y NIST), sin datos personales; el estado vive en el servidor. Guardar en el servidor un verificador (hash) del token.
- Cookie: `Secure`, `HttpOnly`, `SameSite=Lax` o `Strict`, prefijo `__Host-`, sin `Domain`. Preferir no persistente. Regenerar el ID en login y en cambios de privilegio (anti fijación). Invalidar en el servidor en logout (borrar la cookie no basta). Caducidad inactiva y absoluta en el servidor.
- Con cookies hace falta defensa CSRF; SameSite es defensa en profundidad, no sustituto (OWASP CSRF Prevention) [V]. Token CSRF firmado ligado a la sesión recomendado; el double-submit simple está desaconsejado.
- Ventaja: revocación inmediata y control central. Coste: almacén de sesiones (base de datos o caché) y escalado.

JWT como credencial de sesión [V OWASP JWT Cheat Sheet]:
- Riesgos conocidos: algoritmo `none`, confusión de algoritmo/clave, secretos HMAC débiles, claves incrustadas en cabecera (`jwk`, `jku`, `x5u`), confusión de emisor/audiencia, confusión de tipo de token, divulgación (el payload solo está codificado, no cifrado), repetición.
- Revocación: un JWT firmado sigue valido hasta `exp`. Opciones: caducidad corta, denylist por `jti`+`iss` (hace la sesión con estado y anula el beneficio), Token Status List, tokens ligados al emisor del cliente (DPoP/mTLS). No indexar la denylist por el hash del token (maleabilidad).
- Almacenamiento en el navegador: no guardar IDs de sesión, JWT ni refresh tokens en `localStorage`/`sessionStorage` (cualquier XSS del origen los lee) [V OWASP Session Management]; NIST también lo desaconseja para secretos de sesión [V]. Alternativas: cookie `HttpOnly; Secure; SameSite` o patrón BFF [V].
- Nota de verificación: la URL antigua de la cheat sheet "JSON Web Token for Java" devolvió 404 y la versión actual (`JSON_Web_Token_Cheat_Sheet.html`) fue reorganizada; no cubre `localStorage` vs cookies. Las afirmaciones sobre almacenamiento salen de Session Management y de NIST/RFC 10017.
- Cuándo cada uno: cookie de sesión opaca por defecto para web con backend propio; JWT/tokens de acceso de corta vida cuando hay varios servicios o clientes no-navegador que deben validar sin consultar un almacén central, o cuando los emite un IdP y se consumen como credencial de API. JWT no es una sesión más escalable "gratis": o renuncias a revocar o vuelves a tener estado.

### 1.5 Autorización [V OWASP Authorization Cheat Sheet]
- Mínimo privilegio, denegar por defecto, validar en CADA petición, de forma central (middleware/filtro), nunca confiar en comprobaciones del cliente. Fallar de forma segura y probar la denegación.
- Modelos: RBAC (simple, mal con comprobaciones por objeto, explosión de roles, mal con multi-organización), ABAC (atributos de sujeto, objeto y entorno; más fino), ReBAC (según relaciones usuario-recurso; encaja en compartición y jerarquías).
- Comprobación por objeto (IDOR/BOLA): ocultar o aleatorizar IDs no basta; verificar acceso al objeto concreto en cada petición. Incluir ficheros estáticos y almacenamiento en la política.
- Multi-tenencia: el identificador de organización debe derivarse de la sesión/relación del servidor, no de un parámetro del cliente; filtrar TODA consulta por organización (o aislar por esquema/base de datos según el nivel de aislamiento exigido). RBAC puro por organización suele quedarse corto; usar roles por membresía. (Esta frase es criterio de ingeniería, no cita literal de OWASP; OWASP solo señala que RBAC es mal adecuado para multi-tenant.)
- Dónde aplicar: en el servidor, en la capa de acceso a datos o servicio de dominio, más una defensa adicional (filas por tenant en la base de datos si el motor lo ofrece). Un gateway o IdP puede autenticar y pasar claims; la decisión por objeto se toma donde están los datos.
- Reglas del IdP (roles en token) caducan con el token; para permisos que cambian rápido, consultar en servidor.
- Criterio de elección: empezar con RBAC si los permisos son por función; pasar a ABAC/ReBAC cuando aparezcan "solo sus propios objetos", compartición, jerarquías u organizaciones anidadas. Motores de políticas externos: solo si la complejidad lo justifica (YAGNI).

### 1.6 Recuperación de cuenta y abuso
- Enumeración de usuarios [V OWASP Auth, Forgot Password]: mismo mensaje, mismo código HTTP y tiempo de respuesta parecido en login, registro y recuperación, exista o no la cuenta. Ojo con registro: la respuesta genérica obliga a confirmar por correo.
- Limitación de intentos [V]: contador por cuenta (no solo por IP), umbral/ventana/duración o retroceso exponencial, y diseñar el bloqueo para que no permita denegar servicio a otro usuario (el bloqueado debe poder recuperar). CAPTCHA como defensa adicional, no como control único. NIST fija un tope máximo de 100 fallos consecutivos por autenticador. Registrar y revisar fallos.
- Recuperación de contraseña [V OWASP Forgot Password]: token de CSPRNG, único, de un solo uso, ligado al usuario, con caducidad; limitar por cuenta los envíos y los intentos de adivinar el token; no iniciar sesión automáticamente tras el cambio; notificar por correo el cambio; invalidar sesiones activas; sin preguntas de seguridad como único método. La página no dice explícitamente "guardar el token con hash"; remite a Password Storage.
- Recuperación = puerta trasera del MFA: reautenticar con un factor inscrito antes de cambiar factores; notificar fuera de banda; la política de recuperación debe ser tan fuerte como la del acceso normal (OWASP MFA) [V].
- Otros abusos: relleno de credenciales (limitar, MFA, lista de filtradas), spam de SMS/correo (coste y entregabilidad), registro masivo (límite de tasa, verificación de correo).

---

## 2. Tabla de decisión (necesidad -> enfoque -> motivo -> contraindicación)

| Necesidad | Enfoque | Motivo | Contraindicación |
|---|---|---|---|
| Sitio público, contenido, formulario | Sin cuentas; validación + antispam + límite de tasa | Menos superficie, sin recuperación ni datos personales de cuenta | Si luego habrá área privada: decidir ya el identificador y el modelo de organización |
| Compra/consulta ocasional | Invitado + enlace firmado de un solo uso | Evita cuentas | Si el usuario espera historial o hay fraude/cumplimiento que exija identidad |
| MVP con pocos usuarios, un método | Librería de autenticación del framework o servicio gestionado | Menos código propio de seguridad | Si se exige residencia de datos o ya hay IdP corporativo |
| Producto con SSO empresarial / SCIM / organizaciones | Servicio gestionado con soporte enterprise o IdP autoalojado | Es el trabajo más caro de construir; el límite de conexiones SSO por plan es el factor de coste | Presupuesto bajo con muchos clientes pequeños que no usan SSO |
| Control total de datos, residencia, coste fijo | IdP autoalojado (OIDC) | Datos y hashes bajo control propio | Sin equipo que opere parches, copias y disponibilidad |
| Bloqueo mínimo | Interfaz OIDC estándar, usuarios y hashes exportables, ID de usuario propio | Migrar sin resetear contraseñas | Funciones propietarias imprescindibles |
| Sin contraseñas y baja fricción | Passkeys como método principal + recuperación definida | Resistente al phishing; sin hashes que proteger | Usuarios con dispositivos sin soporte; sin plan de recuperación |
| Sin contraseñas, simple de implantar | Enlace/código por correo | Fricción baja | No es resistente al phishing; no sirve como segundo factor según NIST; riesgo si el correo es el eslabón débil; entregabilidad |
| Reducir contraseñas propias | OIDC con login social (Authorization Code + PKCE) | Delegación | Usuarios sin cuenta social; dependencia del tercero; usar `iss`+`sub`, no correo |
| Contraseña como método | Argon2id, sin reglas de composición, lista de filtradas, límite de intentos | NIST/OWASP | Si no puedes cumplir recuperación y limitación, delegar |
| MFA de base | TOTP + códigos de recuperación; passkeys/claves donde se pueda | Cobertura amplia y barata | SMS solo como último recurso; push sin number matching |
| Cuentas privilegiadas / admin | Autenticador resistente al phishing (passkey/clave de seguridad) | Mayor impacto del robo de cuenta | Equipo sin hardware ni plan de reposición |
| Web con backend propio | Sesión opaca en cookie `__Host-` HttpOnly Secure SameSite + CSRF | Revocación inmediata, nada sensible en JS | Varios servicios sin almacén común de sesiones |
| SPA con API | BFF con cookie de sesión; tokens solo en servidor | RFC 10017 prefiere BFF | Cliente público sin backend posible: asumir el riesgo y tokens cortos |
| API entre servicios / clientes no navegador | Tokens de acceso de corta vida (JWT o opaco con introspección), ligados al emisor si se puede | Validación sin estado central | JWT como sesión de usuario con revocación larga |
| Permisos por función | RBAC con deny by default | Simple | Acceso por objeto/organización: añadir comprobación por objeto |
| Compartición, jerarquías, equipos | ReBAC/ABAC según complejidad | Evita explosión de roles | Pocas reglas estables: un motor externo sería exceso |
| SaaS multiusuario | Organización como entidad de primera clase; el tenant sale de la membresía en servidor; toda consulta filtrada | Evita fugas entre clientes | Datos con aislamiento regulatorio fuerte: valorar aislamiento por esquema o base |

---

## 3. Decisiones caras de revertir (decidir pronto)

1. **Identificador de usuario interno.** Usar un ID propio opaco e inmutable (UUID/ULID), NO el correo, NO el `sub` de un proveedor como clave primaria. Guardar identidades externas aparte (tabla de identidades `iss`+`sub`->usuario). Cambiar de proveedor o fusionar cuentas sin esto obliga a reescribir referencias. OIDC define `sub` solo como único dentro del emisor [V OIDC Core]; OWASP indica vincular por `iss`+`sub` [V].
2. **Modelo de organización/equipo.** Decidir si habrá multi-tenencia antes del primer usuario: tabla de organizaciones, membresías (usuario <-> organización con rol), `organization_id` en cada entidad del dominio. Añadirlo después toca todas las tablas y consultas. Un usuario puede pertenecer a varias organizaciones: no modelar "usuario pertenece a una organización" salvo decisión de producto firme.
3. **Dónde viven contraseñas y hashes.** Determina exportabilidad y migración. Guardar algoritmo y parámetros con cada hash (PHC) para rehash progresivo [V OWASP Password Storage]. Si se delega, anotar el procedimiento y el plan necesario para exportar hashes antes de comprometerse.
4. **Verificación de correo y vinculación de cuentas.** Política de qué ocurre si el mismo correo llega por otro método (riesgo de toma de cuenta si se vincula sin verificar).
5. **Modelo de sesión (cookie vs token) y dominio de cookies.** Afecta a CSRF, a subdominios y a clientes móviles/API. Cambiarlo toca frontend, backend y APIs.
6. **Modelo de autorización y punto de aplicación.** Si las comprobaciones se dispersan por controladores, centralizarlas después es costoso y propenso a omisiones.
7. **Política de recuperación y soporte.** Define si el correo es la raíz de confianza; cambiarla requiere rediseñar el flujo y la atención al cliente.
8. **Datos personales de identidad y cumplimiento** (ubicación, retención, borrado): [NV] no se consultó normativa; validar con asesoría jurídica y con las condiciones del proveedor.
9. **Eliminación de cuentas / borrado:** si hay referencias por ID, borrar o anonimizar debe estar previsto.

---

## 4. Cuándo cambiar la recomendación (resumen operativo)
Ver resumen final.

---

## 5. Datos volátiles (verificados 2026-10-12)

Normas:
- NIST SP 800-63-4 (63, 63A, 63B, 63C): versión final publicada en julio 2025 [V]. La página de 63B-4 lleva fecha 26 agosto 2025 y dice que sustituye a la 63B anterior. https://pages.nist.gov/800-63-4/ (La página índice menciona a la vez "draft" y "final"; se toma "final" como más reciente, comprobar en csrc.nist.gov.) Ver sección de Fuentes.
- OAuth 2.1: sigue como Internet-Draft `draft-ietf-oauth-v2-1-16`, fecha 3 sep 2026 (datatracker: actualizado 2026-09-02), expira 7 mar 2027; NO es RFC [V]. https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/. Para la skill: citar RFC 9700 (BCP 240) como práctica vigente y no presentar OAuth 2.1 como norma.
- RFC 9700 (BCP 240), enero 2025 [V]. RFC 7636 (PKCE), 2015 [V]. OIDC Core 1.0 con errata set 2, 15 dic 2023 [V].
- W3C WebAuthn Level 3: Recommendation, 25 agosto 2026 (CR snapshot anterior 26 mayo 2026) [P: solo leídos los primeros 100.000 caracteres]. https://www.w3.org/TR/webauthn-3/
- RFC 10017 "OAuth 2.0 for Browser-Based Applications" (BCP 212), 2026; la página no da fecha de publicación y su numeración de BCP era inconsistente en el resumen de la herramienta [P]. https://www.rfc-editor.org/rfc/rfc10017 (el datatracker de `draft-ietf-oauth-browser-based-apps` muestra revisión 27, última actualización 2026-08-21).
- Parámetros de OWASP Password Storage (Argon2id 19 MiB/t=2/p=1, PBKDF2-SHA256 600.000, etc.) cambian con el tiempo: releer antes de fijar números.

Planes de proveedores (solo como EJEMPLO de volatilidad, sin recomendar; hay que reverificar en cada proyecto):
- Clerk (https://clerk.com/pricing, 2026-10-12) [V]: Hobby 50.000 usuarios retenidos mensuales (MRU) por app; Pro 25 USD/mes; Business 300 USD/mes; una conexión SSO/SAML incluida en planes de pago, adicionales 75 USD/mes (2-15); MFA no disponible en Hobby; export completo de datos desde el panel en todos los planes (el export de hashes de contraseña NO se verificó: [NV]). Aviso: "Directory Sync" empieza a facturarse el 1 ene 2027.
- Auth0 (https://auth0.com/pricing, 2026-10-12) [V, con incoherencias internas señaladas por la propia página]: gratis hasta 25.000 MAU; Essentials desde 35 USD (B2C) / 150 USD (B2B); Professional 240 / 800 USD; SSO enterprise: 1 conexión en el plan gratis, 3 incluidas en B2B Essentials, 5 en Professional, adicionales a 100 USD/mes; MFA "Pro" no disponible en gratis. La tabla de la página se contradice en MFA/SSO de Essentials: [NV] el detalle.
- Exportación de hashes en Auth0 [P: resumen de búsqueda, no página abierta; la URL de docs que intenté abrir devolvió 404]: la API y la exportación masiva no incluyen hashes; solo vía ticket de soporte, no disponible en el plan gratis, bcrypt. Fuentes listadas por la búsqueda: https://auth0.com/docs/troubleshoot/customer-support/manage-subscriptions/export-data y https://support.auth0.com/center/s/article/How-to-Use-the-Password-Hashes-Export-from-Auth0. Reverificar abriéndolas.
- Firebase Authentication (https://firebase.google.com/docs/auth/admin/import-users) [P: 100.000 de 124.962 caracteres]: importación de hashes soportada (HMAC_SHA256, SCRYPT modificado, STANDARD_SCRYPT, quizá más). Exportación de hashes: la página no la describe; [NV].
- Supabase: la página `auth-password-hash-migration` devolvió 404. [NV].
- Keycloak (autoalojado; Context7 `/keycloak/keycloak`, versiones listadas 22.0.2, 26.3.2, 26_4_0, 26.5.2) [P]: desde Keycloak 24 los valores por defecto de hash siguen a OWASP (pbkdf2-sha512 con 210.000 iteraciones; sha256 con 600.000); existe export/import de realm con ficheros de usuarios. Que el export incluya hashes y en qué condiciones: [NV].

Límites de plan que suelen cambiar: usuarios activos incluidos, definición de "usuario activo" (MAU vs MRU), número de conexiones SSO, MFA por plan, retención de logs, dominios personalizados, SCIM/Directory Sync, residencia de datos.

---

## 6. Fuentes con estado

| Fuente | URL | Estado |
|---|---|---|
| NIST SP 800-63B-4 (parte 1: §§ contraseñas, AAL, email/SMS, sincronizables) | https://pages.nist.gov/800-63-4/sp800-63b.html | V (leído en tres tramos hasta carácter 288.876 aprox.; tramo final 200.000+ cubrió Apéndice B) |
| NIST SP 800-63-4 índice | https://pages.nist.gov/800-63-4/ | V con ambigüedad draft/final |
| OWASP Authentication CS | https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html | V |
| OWASP Session Management CS | https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html | V |
| OWASP Password Storage CS | https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html | V |
| OWASP Forgot Password CS | https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html | V |
| OWASP Multifactor Authentication CS | https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html | V |
| OWASP Authorization CS | https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html | V |
| OWASP JSON Web Token CS | https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_Cheat_Sheet.html | V (las URL "..._for_Java" dieron 404) |
| OWASP CSRF Prevention CS | https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html | V |
| W3C WebAuthn Level 3 | https://www.w3.org/TR/webauthn-3/ | P (primer 20 % del texto) |
| draft-ietf-oauth-v2-1 | https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/ | P (primeros 100.000 de 244.900 caracteres), borrador |
| RFC 9700 | https://datatracker.ietf.org/doc/html/rfc9700 | P (primeros 100.000 de 154.309) |
| RFC 7636 | https://www.rfc-editor.org/rfc/rfc7636 | V |
| OIDC Core 1.0 | https://openid.net/specs/openid-connect-core-1_0.html | P (no se vio la sección de claims; afirmación "el correo no es único" no verificada aquí, la respalda OWASP Auth que dice vincular por iss+sub) |
| RFC 10017 / browser-based-apps | https://www.rfc-editor.org/rfc/rfc10017 y https://datatracker.ietf.org/doc/draft-ietf-oauth-browser-based-apps/ | P (sección 8 sin leer; numeración BCP inconsistente en el resumen) |
| Clerk pricing | https://clerk.com/pricing | V (volátil) |
| Auth0 pricing | https://auth0.com/pricing | V con incoherencias (volátil) |
| Auth0 export de hashes | enlaces de la sección 5 | P (solo resumen de búsqueda) |
| Firebase import users | https://firebase.google.com/docs/auth/admin/import-users | P |
| Keycloak (Context7) | /keycloak/keycloak | P |
| Supabase hash migration | https://supabase.com/docs/guides/auth/auth-password-hash-migration | NV (404) |
| Auth0 export-user-data (URL probada) | https://auth0.com/docs/troubleshoot/customer-support/manage-subscriptions/export-user-data | NV (404; la URL correcta parece ser `export-data`) |
| RGPD / normativa sectorial | n/a | NV (no consultada) |
| RFC 6238 (TOTP), RFC 8252, RFC 9207, RFC 8414, RFC 6749, OWASP ASVS | n/a | NV (no abiertos; solo citados vía otras fuentes) |
| Comprobación de que las cuentas de correo son prueba de identidad (NIST 800-63A) | n/a | NV |

---

## 7. Resumen final (qué cambiaría la recomendación de la skill)
1. Si no hay datos ni estado por usuario: sin autenticación; la skill no debe empujar a cuentas.
2. Si el producto tendrá organizaciones o SSO empresarial: modelar organización y membresía desde el día uno y elegir IdP gestionado/autoalojado por el límite de conexiones SSO y SCIM.
3. Si el proveedor no permite exportar hashes (o solo en planes altos): tratar como bloqueo real; exigir plan de salida antes de elegir.
4. Si hay requisito de residencia de datos o cumplimiento sectorial: inclinar a autoalojado o a proveedor con garantías contractuales (no verificado aquí).
5. Si el público es de alto riesgo (admin, finanzas): exigir autenticador resistente al phishing; correo/SMS/TOTP son insuficientes para AAL3 y el correo no es canal de autenticación según NIST 800-63B-4.
6. Si hay SPA sin backend propio: aceptar el riesgo de tokens en navegador o añadir BFF; no guardar tokens en localStorage.
7. Si varios servicios deben validar identidad sin almacén común: tokens de acceso cortos (JWT) sí; JWT como sesión de usuario con revocación inmediata exige denylist y pierde la ventaja sin estado.
8. Si aparece una nueva revisión de NIST 800-63, publicación de OAuth 2.1 como RFC, o cambios en parámetros de OWASP Password Storage: actualizar números y citas.
9. Los precios y límites de plan caducan: la skill debe pedir verificación en la web del proveedor en cada proyecto y no almacenar cifras.
10. Pendiente de verificar antes de dar por cerrada la skill: exportación de hashes de Auth0/Firebase/Keycloak/Supabase, sección 8 de RFC 10017, RFC 6238, y normativa de protección de datos.
