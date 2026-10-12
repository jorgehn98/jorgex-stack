# Requisitos legales para una landing comercial: Reino Unido y EE. UU.

Fecha de la investigación: 2026-10-12. Descripción de lo que dicen las normas y guías; no es asesoramiento legal.

## Leyenda y limitaciones

- **[OFICIAL]** = hecho leído en una fuente oficial (legislation.gov.uk, ico.org.uk, ftc.gov, oag.ca.gov, cppa.ca.gov) durante esta investigación. Se indica URL y fecha de la fuente cuando la página la muestra.
- **[TERCEROS]** = interpretación o dato de despachos, blogs o proveedores de cumplimiento. Debe contrastarse.
- **[NO VERIFICADO]** = no pude comprobarlo en fuente oficial.
- Las páginas se leyeron con WebFetch, que devuelve un resumen del contenido hecho por un modelo, no el texto íntegro. Las citas literales son las que la herramienta marcó como tales; conviene releer el artículo exacto antes de redactar documentos definitivos.
- Bloqueos (HTTP 403) en leginfo.legislature.ca.gov, oag.ca.gov/privacy/privacy-laws y fcc.gov: los textos de Cal. B&P Code 22575, Civ. Code 1798.83 y 1798.130 NO se pudieron leer en origen oficial.
- Algunos datos recientes (SB 690, cambios de 2026) provienen solo de terceros porque son de las últimas semanas.

---

## 1. REINO UNIDO

### 1.1 UK GDPR y Data Protection Act 2018: aviso de privacidad y base legal

- **[OFICIAL]** UK GDPR art. 13 (https://www.legislation.gov.uk/eur/2016/679/article/13). Cuando se recogen datos del propio interesado hay que facilitar, en el momento de la recogida: identidad y contacto del responsable (13.1.a), contacto del DPO si existe (b), fines y base jurídica (c), intereses legítimos si es la base (d), destinatarios (e), transferencias internacionales y garantías (f); y además plazo de conservación (13.2.a), derechos de acceso/rectificación/supresión/limitación/oposición/portabilidad (b), derecho a retirar el consentimiento (c), derecho a reclamar ante el responsable (ca, introducido por la DUAA, s.164A DPA 2018), derecho a reclamar ante la autoridad (d), si el dato es obligatorio y consecuencias (e), decisiones automatizadas (f). Fecha de la fuente: la página indica versión "Latest available (Revised)"; la última modificación listada es de 30/09/2026 (cambio de una palabra en 13.2.d); otras de 05/02/2026 y 19/06/2026 (esta última añade 13.2.ca).
- **[OFICIAL]** Base legal: art. 6 UK GDPR (consentimiento, contrato, interés legítimo, etc.). No se verificó el texto del art. 6 en esta sesión; la guía ICO sobre marketing indica que si se usa consentimiento PECR la base será probablemente consentimiento, y si se usa soft opt-in, probablemente interés legítimo (https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-direct-marketing-using-electronic-mail/how-do-we-comply-with-the-pecr-electronic-mail-marketing-rules/ , vía resumen de búsqueda; fecha de la página no mostrada).
- **[OFICIAL]** Derecho absoluto a oponerse al marketing directo: la misma guía ICO indica que si se ejerce, hay que dejar de usar los datos para marketing (UK GDPR art. 21(2)-(3); el artículo no se leyó directamente).
- **[NO VERIFICADO]** La página ICO "What privacy information should we provide" devolvió 404 con la URL probada; la obligación se verificó por el texto del art. 13.

### 1.2 PECR (Privacy and Electronic Communications Regulations 2003) y la Data (Use and Access) Act 2025 (DUAA)

**Cookies y tecnologías similares (reg. 6 PECR, ahora con Schedule A1)**

- **[OFICIAL]** Regla general: consentimiento previo, con información clara y completa, para almacenar o acceder a información en el dispositivo (Schedule A1 par. 2, introducido por Schedule 12 DUAA). Fuente: https://www.legislation.gov.uk/ukpga/2025/18/schedule/12
- **[OFICIAL]** Estado de entrada en vigor: la Schedule 12 DUAA entró en vigor el **5 de febrero de 2026** (SI 2026/82, reg. 2(z13)); legislation.gov.uk indica "no known outstanding effects". Las multas PECR más altas (s.115 y Schedule 13 DUAA) entraron también el 5/02/2026 [TERCEROS: dato de multas proviene de resumen de búsqueda sobre SI 2026/1015, https://www.legislation.gov.uk/uksi/2026/1015/made].
- **[OFICIAL]** Excepciones nuevas, Schedule A1 PECR:
  - Par. 4: estrictamente necesario para prestar un servicio solicitado (incluye ejemplos de seguridad, fraude, autenticación).
  - **Par. 5, fines estadísticos**: permitida si el proveedor de un servicio de la sociedad de la información usa la tecnología con el **único** fin de recoger estadísticas sobre el uso del servicio para mejorarlo; la información no se comparte salvo para ayudar a esa mejora; el usuario recibe información clara y completa; y dispone de un medio **simple y gratuito de oponerse** y no se opone.
  - Par. 6: apariencia y funcionalidad del sitio (preferencias del usuario), con la misma información y derecho de oposición.
  - Par. 7: asistencia de emergencia.
- **[OFICIAL]** Guía ICO "What are the exceptions?" (https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/what-are-the-exceptions/): la analítica cae en la excepción si es agregada, no se usa para decisiones sobre personas concretas, hay información y oposición simple. **No** entran: grabaciones/logs de visitantes individuales (salvo seguridad), medición de rendimiento de anuncios o cualquier fin publicitario, perfilado. La guía admite analítica de terceros solo si el proveedor actúa como encargado, no cruza los datos con otros y se informa al usuario; **no dice si Google Analytics cumple**. Fecha de la página: no mostrada; la guía general se finalizó el **29 de abril de 2026** (https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/).
- **[OFICIAL]** La publicidad online siempre requiere consentimiento; no hay excepción (guía ICO, resumen de búsqueda sobre "How do we manage consent in practice").
- **[OFICIAL]** Banner de cookies, guía ICO "How do we manage consent in practice?" (https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/how-do-we-manage-consent-in-practice/): rechazar debe ser tan fácil como aceptar (un banner con "aceptar todo" y "más opciones" sin "rechazar todo" figura como mala práctica); sin casillas premarcadas ni consentimiento por seguir navegando; consentimiento por finalidad, separado de los términos; poder retirarlo con la misma facilidad; informar de los terceros; conservar prueba del consentimiento. Fecha de la página: no mostrada.
- **[TERCEROS]** Varios blogs afirman que ICO considera baja prioridad de enforcement la analítica de bajo riesgo; no verificado en fuente oficial y no se cita como hecho.

**Marketing electrónico (reg. 22 PECR)**

- **[OFICIAL]** Reg. 22(2): consentimiento previo para correo electrónico (incluye SMS, mensajes directos) de marketing no solicitado a suscriptores individuales. Reg. 22(3), **soft opt-in**: solo si (a) los datos se obtuvieron en una venta o negociación de venta, (b) el marketing es solo de productos/servicios similares del propio remitente, (c) se ofreció un medio simple y gratuito de rechazo al recoger los datos y en cada mensaje. Reg. 22(3A) añade soft opt-in para organizaciones benéficas desde 05/02/2026. Fuente: https://www.legislation.gov.uk/uksi/2003/2426/regulation/22 (versión revisada; "no known outstanding effects"; modificada el 05/02/2026 por DUAA y SI 2026/82).
- **[OFICIAL]** ICO: el soft opt-in no vale para prospectos que solo rellenaron un formulario sin compra; no se aplica a listas compradas; a suscriptores corporativos (sociedades, LLP) se les puede enviar sin consentimiento pero con identificación y baja válida; los empresarios individuales cuentan como individuos (https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/electronic-and-telephone-marketing/electronic-mail-marketing/ , vía resumen de búsqueda; fecha no mostrada).
- **Consecuencia práctica descrita por la norma**: para un formulario de newsletter de captación (sin compra previa) el soft opt-in no aplica; se necesita consentimiento específico con acción positiva.

### 1.3 Información de empresa y comercio electrónico

- **[OFICIAL]** Electronic Commerce (EC Directive) Regulations 2002, reg. 6 (https://www.legislation.gov.uk/uksi/2002/2013/regulation/6): quien presta un servicio de la sociedad de la información debe facilitar de forma "easily, directly and permanently accessible": nombre, dirección geográfica de establecimiento, datos de contacto incluyendo email, registro público y número de registro si existe, autoridad supervisora si requiere autorización, datos de profesión regulada, **número de IVA** si realiza actividad sujeta. Reg. 6(2): si se mencionan precios, claros y diciendo si incluyen impuestos y envío. Versión "latest available", sin efectos pendientes conocidos.
- **[OFICIAL]** Si el negocio es una sociedad (company): debe mostrar su **nombre registrado** en la web (Company, LLP and Business (Names and Trading Disclosures) Regulations 2015, reg. 24(2): "Every company shall disclose its registered name on its websites"; https://www.legislation.gov.uk/uksi/2015/17/regulation/24). Las Trading Disclosures Regulations 2008 (SI 2008/495), que exigían además país de registro, número de registro y domicilio social en la web (reg. 7), figuran como revocadas y reemplazadas por la Parte 6 del SI 2015/17. [TERCEROS/NO VERIFICADO]: el resumen de búsqueda atribuye a la norma de 2015 los mismos datos adicionales (número, domicilio social); no leí las reg. 25 ss.
- **[NO VERIFICADO]** Para empresarios individuales (sole trader) rige el nombre de negocio (Companies Act 2006, Part 41); no investigado.

### 1.4 Tasa de protección de datos ICO

- **[OFICIAL]** Fuente: https://ico.org.uk/for-organisations/data-protection-fee/data-protection-fee/ (fecha de la página no mostrada). Tier 1 (micro: facturación hasta 632.000 GBP o hasta 10 empleados): **52 GBP**; Tier 2 (hasta 36 M GBP o 250 empleados): 78 GBP; Tier 3: 3.763 GBP; 5 GBP menos por domiciliación. "Not all controllers must pay a fee"; hay una página de exenciones que no se leyó. Base: Data Protection (Charges and Information) Regulations 2018.
- **[TERCEROS]** Sanción fija por impago: 400 GBP (tier 1), 600 (tier 2), 4.000 (tier 3) según un resumen de búsqueda que cita la página de penalizaciones ICO (https://ico.org.uk/about-the-ico/our-information/fixed-penalties-for-failure-to-pay-the-data-protection-charge/); no se leyó la página. También un tercero indica que desde 30/09/2026 las funciones pasan a una "Information Commission"; NO VERIFICADO en fuente oficial en esta sesión (sí aparece "the Commission" en el art. 13(2)(d) UK GDPR revisado, lo que es coherente).

---

## 2. ESTADOS UNIDOS (federal)

No hay ley federal general de privacidad de datos de consumidores; aplican leyes sectoriales y la FTC Act s.5 (prácticas desleales o engañosas). **NO VERIFICADO** en esta sesión el texto de s.5 (afirmación de conocimiento general).

### 2.1 CAN-SPAM (email comercial)

- **[OFICIAL]** https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business (fecha en la página: agosto 2023, editada enero 2024). Requisitos: no usar cabeceras falsas o engañosas; no asuntos engañosos; identificar el mensaje como anuncio; incluir **dirección postal física válida**; explicar claramente cómo darse de baja; atender la baja en **10 días hábiles**; el proveedor externo no libera de responsabilidad. Se aplica también a B2B ("The law makes no exception for business-to-business email"). Sanción: hasta 53.088 USD por email infractor (cifra de la página).
- No exige consentimiento previo (modelo opt-out) **[OFICIAL por contraste con la guía; ni la guía ni yo verificamos la frase literal]**.

### 2.2 TCPA (SMS y llamadas)

- **[TERCEROS]** Marketing por SMS con autómata exige consentimiento escrito previo expreso (47 CFR 64.1200). El Eleventh Circuit anuló en enero de 2025 (Insurance Marketing Coalition v. FCC, No. 24-10277) la exigencia de consentimiento "uno a uno"; la FCC restauró el texto previo de 64.1200(f)(9) con efecto 29/08/2025. Fuentes: resúmenes de despachos (p. ej. https://www.womblebonddickinson.com/us/insights/tcpa-defense-force/102ndra/fcc-repeals-one-to-one-consent-rule-following-eleventh-circuit-decision). La página oficial de la FCC devolvió 403 y no se leyó el CFR.
- **[NO VERIFICADO]** Daños legales de 500-1.500 USD por mensaje (conocimiento general, no comprobado aquí).

### 2.3 COPPA (menores de 13)

- **[OFICIAL]** https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions (fecha no mostrada): aplica a sitios dirigidos a menores de 13 que recogen datos personales y a sitios generales con **conocimiento real** de que recogen datos de menores de 13; exige consentimiento parental verificable; no obliga a preguntar la edad en sitios generales. Sanción civil hasta 53.088 USD por infracción. La regla fue enmendada el 22/04/2025; fechas de vigencia/cumplimiento **NO VERIFICADAS**.

### 2.4 FTC: publicidad, testimonios y reseñas

- **[OFICIAL]** Endorsement Guides, FAQ (https://www.ftc.gov/business-guidance/resources/ftcs-endorsement-guides-what-people-are-asking ; guías revisadas en 2023): el testimonio debe reflejar la opinión y experiencia reales; hay que divulgar conexiones materiales (pago, productos gratis, comisiones de afiliado) de forma clara y visible; no basta un enlace "disclosure" o texto al pie; el anunciante debe supervisar. Son guías (no norma vinculante en sí), aunque la FTC las usa para valorar engaño [INTERPRETACIÓN: carácter no vinculante, conocimiento general].
- **[OFICIAL]** Regla sobre reseñas y testimonios de consumidores (16 CFR Part 465), vigente desde **21/10/2024** (https://www.ftc.gov/business-guidance/resources/consumer-reviews-testimonials-rule-questions-answers , página fechada noviembre 2024): prohíbe reseñas/testimonios falsos (465.2), comprar reseñas condicionadas a un sentido (465.4), reseñas internas sin divulgar (465.5), webs de "reseñas independientes" controladas por la empresa (465.6), supresión de reseñas (465.7) e indicadores falsos de influencia social (465.8). Penalidad por violación: no indicada en la página leída.
- **[OFICIAL]** Precios y "junk fees": Rule on Unfair or Deceptive Fees (16 CFR Part 464), vigente desde 12/05/2025, aplica solo a **entradas de eventos en vivo y alojamiento de corta estancia** (https://www.ftc.gov/business-guidance/resources/rule-unfair-or-deceptive-fees-frequently-asked-questions ; vía resumen de búsqueda, fecha de la página no mostrada). Para otros sectores no hay norma federal equivalente; rige s.5 FTC Act. Existen normas estatales más amplias [TERCEROS].
- **[NO VERIFICADO]** Claims de "gratis" (16 CFR Part 251, "Free" Guides): no se consultó.

---

## 3. CALIFORNIA (caso principal)

### 3.1 CCPA/CPRA

- **[OFICIAL]** https://oag.ca.gov/privacy/ccpa (página marcada "Updated on August 28, 2026"). Aplica a negocios con fines de lucro que operan en California y cumplen **uno** de: ingresos brutos anuales superiores al umbral (la página dice 25 M USD, desactualizado); comprar, vender o compartir datos de **100.000 o más** residentes u hogares; obtener **50 % o más** de ingresos de vender/compartir datos personales.
- **[OFICIAL]** El umbral de ingresos se actualizó a **26.625.000 USD** desde el 01/01/2025 (CPPA, https://www.cppa.ca.gov/regulations/cpi_adjustment.html , publicado 17/12/2024; leído vía resumen de búsqueda). La próxima actualización será en año impar (Civ. Code 1798.199.95(d)): 2027.
- **[OFICIAL]** Aviso en la recogida: en o antes del momento de recogida, con categorías de datos, fines y enlace a la política de privacidad; si se venden/comparten datos, enlace "Do Not Sell or Share My Personal Information" (oag.ca.gov/privacy/ccpa). Plazos: solicitudes de acceso/borrado/corrección 45 días (+45); opt-out en máx. 15 días hábiles. Derechos: saber, borrar, corregir, limitar uso de datos sensibles, optar por no vender/compartir, no discriminación. Menores: venta de datos de menores de 16 requiere opt-in (menores de 13, consentimiento parental).
- **[OFICIAL]** Global Privacy Control: la página dice que un negocio que recoge datos online debe tratarlo como solicitud válida de opt-out de venta/compartición.
- **[NO VERIFICADO en origen]** Política de privacidad con contenido mínimo y revisión al menos cada 12 meses (Civ. Code 1798.130(a)(5)): leginfo devolvió 403 y la página de la AG no menciona el ciclo de 12 meses (verificado por lectura de la página). Es conocimiento general, no confirmado aquí.
- **[TERCEROS]** Reglamentos CPPA nuevos (evaluaciones de riesgo, ADMT, auditoría de ciberseguridad) con umbrales propios; un resumen cita 250.000 consumidores o 50.000 datos sensibles para la auditoría; no verificado.
- Relevancia para una landing pequeña: si el negocio no alcanza ninguno de los tres umbrales, el CCPA no le aplica **[INTERPRETACIÓN a partir del texto oficial de los umbrales]**. Los umbrales usan ingresos globales según terceros (no verificado).

### 3.2 CalOPPA (Bus. & Prof. Code 22575-22579)

- **[TERCEROS, texto citado por FindLaw/california.public.law/Pillsbury; oficial no accesible]** 22575(a): el operador de un sitio comercial que recoge información personal identificable de residentes de California debe publicar de forma visible su política de privacidad; solo hay infracción si no la publica en 30 días desde el aviso. 22575(b): categorías de datos y terceros, proceso de revisión/cambio si existe, cómo se avisa de cambios, fecha de vigencia, **cómo responde a señales "Do Not Track"** (b)(5) y si otros terceros recogen datos de navegación (b)(6). Solo exige **divulgar**, no obedecer DNT. Fuente: https://codes.findlaw.com/ca/business-and-professions-code/bpc-sect-22575/ . Aplica con independencia de dónde esté el operador.

### 3.3 Shine the Light (Civ. Code 1798.83)

- **[NO VERIFICADO]** leginfo devolvió 403. Conocimiento general (no verificado): obliga a ciertas empresas a divulgar a clientes, bajo solicitud, qué datos compartieron con terceros para marketing directo, con exención para negocios de menos de 20 empleados; no confirmado en esta sesión.

### 3.4 CIPA, píxeles, chat y session replay (litigio)

- **[TERCEROS]** CIPA (Penal Code 631 wiretapping, 632 grabación, 638.51 pen register/trap and trace) se usa en demandas de clase contra analítica, píxeles, chat y session replay. Datos de resúmenes de despachos:
  - Javier v. Assurance IQ (9th Cir., 31/05/2022): el consentimiento bajo s.631(a) debe ser previo a la captura; la sentencia se describe en una fuente como no publicada. Fuente: https://www.dlapiper.com/en/insights/publications/2022/06/javier-v-assurance-iq-llc-et-al
  - Popa v. Microsoft (9th Cir., 26/08/2025): desestimado por falta de legitimación (no se probó información privada capturada por Microsoft Clarity).
  - **SB 690**: según Thompson Hine (https://www.thompsonhine.com/insights/california-enacts-sb-690-eliminating-private-pen-trap-claims-over-website-tracking/), firmado el **30/09/2026**, operativo desde el **01/01/2027**; elimina la acción privada bajo s.638.51 para conductas en webs y apps (solo la AG), con efecto sobre acciones iniciadas en los dos años previos; **sigue la exposición privada bajo ss.631 y 632**. El propio resumen de búsqueda y otras firmas coinciden. NO VERIFICADO en el texto oficial de la ley.
- **[NO VERIFICADO]** Ninguna fuente oficial consultada; el riesgo descrito es litigioso, no un requisito legal de contenido para la landing.

---

## 4. OTROS ESTADOS CON LEY INTEGRAL (lista breve, solo terceros)

**[TERCEROS]** Resumen de comparativas (clym.io, enzuzo, promise.legal, etc.; los recuentos varían entre 19 y 24 estados). Ejemplos y umbrales citados:

| Estado | Vigencia | Umbral (según terceros) |
|---|---|---|
| Virginia | 01/01/2023 | 100.000 consumidores, o 25.000 + 50 % ingresos por venta de datos |
| Colorado | 01/07/2023 | 100.000 consumidores, o 25.000 con ingresos/descuentos por venta de datos |
| Connecticut | 01/07/2023 | enmendado el 01/07/2026: 35.000 consumidores, o cualquier dato sensible o venta |
| Texas | 01/07/2024 | sin umbral numérico; exento si es pequeña empresa según la SBA (sigue habiendo obligaciones sobre venta de datos sensibles según algún tercero) |
| Rhode Island, Indiana, Kentucky | 01/01/2026 | RI: 35.000 consumidores o 10.000 + 20 % ingresos; otros no verificados |
| Oregon, Montana, Utah, Florida, Tennessee, Delaware, Iowa, Maryland, Minnesota, Nebraska, New Hampshire, New Jersey | varias | no verificados |

Doce estados exigen respetar GPC según una fuente (Colorado, Connecticut, Texas entre ellos); Virginia no. **NO VERIFICADO** en fuentes oficiales estatales; contrastar con cada AG.

---

## 5. ACCESIBILIDAD (ADA / WCAG)

- **[OFICIAL]** DOJ, "Guidance on Web Accessibility and the ADA", https://www.ada.gov/resources/web-guidance/ (fecha: **18 de marzo de 2022**): el Title III exige "full and equal enjoyment" a negocios abiertos al público y el DOJ considera que se aplica a ofertas web; **no existe reglamento con estándares técnicos detallados para webs privadas**; WCAG y Section 508 se citan como orientación útil, no como obligación.
- **[OFICIAL]** La regla de 2024 con WCAG como estándar (Title II) es para estados y gobiernos locales (publicada en el Federal Register el 24/04/2024), no para negocios privados (según la propia página del DOJ; el contenido de la regla no se leyó).
- **[TERCEROS/NO VERIFICADO]** El riesgo es de demandas privadas; no verifiqué estadísticas de litigios ni la Unruh Act de California.

---

## 6. TABLA FINAL

| Documento/mecanismo | ¿Obligatorio en landing? | Condición | Fuente |
|---|---|---|---|
| Aviso de privacidad (UK) | Sí | Si se recogen datos personales (formulario, analítica, newsletter) de personas en UK | UK GDPR art. 13, https://www.legislation.gov.uk/eur/2016/679/article/13 |
| Base legal declarada | Sí, dentro del aviso | Por cada finalidad | UK GDPR art. 13(1)(c) |
| Banner de cookies con rechazar equivalente a aceptar | Sí, si hay cookies no exentas (publicidad, píxeles) | Consentimiento previo; rechazar tan fácil como aceptar | PECR reg. 6 + Sch. A1, guía ICO (abr. 2026) |
| Analítica sin consentimiento | Opcional: solo bajo excepción estadística | Fin único de mejorar el servicio, información clara, oposición simple, sin fin publicitario ni perfilado | PECR Sch. A1 par. 5 (en vigor 05/02/2026); guía ICO |
| Consentimiento de newsletter (UK) | Sí | Particulares o empresario individual; soft opt-in solo si hubo venta previa y productos similares | PECR reg. 22(2)-(3) |
| Datos de empresa (nombre, dirección, email, registro, IVA) | Sí | Servicio de la sociedad de la información; IVA/registro si existen | SI 2002/2013 reg. 6 |
| Nombre registrado en la web | Sí | Si es una sociedad (company) | SI 2015/17 reg. 24(2) |
| Tasa de protección de datos ICO | Sí (no es un elemento de la web) | Controlador no exento; 52 GBP tier 1 | ICO fee page |
| Email comercial: identificación, dirección postal, baja en 10 días hábiles | Sí | Si se envía email comercial | CAN-SPAM, FTC guide (ago. 2023) |
| Consentimiento escrito para SMS | Sí | Si se envían SMS de marketing con autómata | TCPA 47 CFR 64.1200 [TERCEROS] |
| Medidas COPPA | Solo condicional | Sitio dirigido a menores de 13 o conocimiento real | FTC COPPA FAQ |
| Divulgación de conexiones en testimonios; no reseñas falsas | Sí, si hay testimonios/reseñas | Siempre que se usen | 16 CFR Part 465; FTC Endorsement Guides |
| Regla de junk fees | Condicional | Solo entradas de eventos y alojamiento corto | 16 CFR Part 464 |
| Política de privacidad CCPA, aviso en la recogida | Condicional | Negocio que supera algún umbral CCPA (26,625 M USD ingresos, 100.000 consumidores, 50 % ingresos por venta) | oag.ca.gov/privacy/ccpa; cppa.ca.gov |
| Enlace "Do Not Sell or Share" y respeto de GPC | Condicional | Solo si vende o comparte datos (incl. publicidad conductual) y está sujeto al CCPA | oag.ca.gov/privacy/ccpa |
| Política de privacidad CalOPPA con divulgación de DNT | Sí, si recoge datos personales de residentes de California | Sin umbral de tamaño en el texto citado | Cal. B&P 22575 [TERCEROS: texto oficial no accesible] |
| Shine the Light | NO VERIFICADO | Posible exención por tamaño | Civ. Code 1798.83 |
| Otras leyes estatales | Condicional | Umbrales por estado | Terceros |
| Consentimiento previo para píxeles, chat, session replay (CIPA) | No obligación formal; riesgo de litigio | Captura de comunicaciones sin consentimiento previo | Terceros (Javier, Popa, SB 690) |
| Accesibilidad (WCAG) | No hay norma explícita para web privada | Riesgo de litigio ADA Title III | ada.gov (18/03/2022) |

## 7. Incertidumbres principales

1. Texto oficial de CalOPPA, Shine the Light y 1798.130 (12 meses): no accesible (403).
2. Fecha de última actualización de varias páginas ICO no mostrada; solo se confirmó 29/04/2026 para la guía de storage and access y 05/02/2026 para la entrada en vigor.
3. Si Google Analytics encaja en la excepción estadística: la guía ICO no lo nombra.
4. SB 690 y la vigencia de leyes estatales 2026: solo fuentes de terceros.
5. Fechas de vigencia de la enmienda COPPA 2025 y de los reglamentos CPPA nuevos: no verificadas.
6. Datos de empresa adicionales en la web (número de registro, domicilio social) bajo la norma de 2015: no leí las reg. 25 ss.
