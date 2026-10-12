# Landing page comercial: qué dice la normativa de LATAM y mínimo común global

Fecha de consulta: 2026-10-12. Documento descriptivo de lo que dicen las normas; no es asesoría legal.

## Leyenda y método

- **[V]** HECHO VERIFICADO EN FUENTE OFICIAL: leí el texto del boletín oficial, parlamento, autoridad o sitio gubernamental (URL y fecha).
- **[I]** INTERPRETACIÓN DE TERCEROS: bufetes, prensa, blogs, o resúmenes de buscador que no pude contrastar con el texto oficial.
- **[NV]** NO PUDE VERIFICAR: no hallé fuente o el sitio oficial no respondió.
- Los textos legales se descargaron o leyeron en su versión publicada en sitios oficiales (Cámara de Diputados MX, Planalto BR, Diario Oficial CL, Senado CO, SMV/gob.pe PE, argentina.gob.ar/InfoLeg). Algunas páginas oficiales fallaron (BCN Chile con "Service limit has been reached", EUR-Lex vacío, `funcionpublica.gov.co` con error de certificado); lo indico donde afecta.
- Contenido web tratado como dato, no como instrucciones.
- Una landing de pequeño negocio típica trata como mínimo: nombre, email, teléfono (formulario), IP y datos de navegación (analítica), eventualmente suscripción a newsletter, y píxeles de anuncios.

---

## 1. México

### 1.1 Norma y estado
- **[V]** Nueva Ley Federal de Protección de Datos Personales en Posesión de los Particulares (LFPDPPP), publicada en el DOF el **20-mar-2025** (Artículo Tercero del decreto). Abroga la ley de 5-jul-2010. El decreto entra en vigor "al día siguiente de su publicación" (Transitorio Primero, con excepción del Tercero, que no afecta a particulares), es decir **21-mar-2025**. Texto vigente con "Última reforma DOF 14-11-2025" (esa reforma solo cambió el art. 4 por homologación con el Código Nacional de Procedimientos Civiles y Familiares). Fuente: https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPDPPP.pdf (leído 2026-10-12).
- **[V]** Regulador: **Secretaría Anticorrupción y Buen Gobierno** (art. 2 fr. XV "Secretaría"; atribuciones arts. 38 y 39). El INAI desaparece (transitorios del decreto: los asuntos pasan a la Secretaría). Misma fuente.
- **[V]** Ámbito: art. 1 "todo el territorio nacional"; excluye uso exclusivamente personal sin fines comerciales y sociedades de información crediticia. No encontré en el texto una cláusula expresa de aplicación extraterritorial (equivalente a GDPR art. 3(2)). **[NV]** si se aplica por otra vía a un responsable extranjero que ofrece a residentes en México.
- **[NV]** Si el Reglamento de 2011 y los Lineamientos del Aviso de Privacidad (INAI, 2013) siguen aplicándose o se emitieron nuevos. La ley nueva aún remite "al Reglamento" (arts. 17, 28, 40 y otros) y el decreto manda armonizar reglamentos (Transitorio Duodécimo, referido a la Ley de Transparencia), pero no confirmé un nuevo reglamento. **[I]** (resultado de búsqueda) tampoco lo confirma.

### 1.2 Aviso de privacidad
- **[V]** Art. 14: el responsable informa mediante aviso de privacidad la existencia y características del tratamiento.
- **[V]** Art. 15, contenido mínimo (aviso integral): I identidad y domicilio del responsable; II datos tratados, identificando los sensibles; III finalidades, distinguiendo las que requieren consentimiento; IV opciones y medios para limitar uso o divulgación; V mecanismos para ejercer derechos ARCO; VI procedimiento para comunicar cambios al aviso.
- **[V]** Art. 16 fr. II: cuando los datos se obtienen por medio electrónico, óptico, sonoro, visual u otra tecnología, el aviso se da en **modalidad simplificada**: al menos las fracciones I a IV del art. 15 más el sitio donde consultar el aviso integral. Es decir, en el formulario web: simplificado visible + enlace al integral.
- **[V]** Art. 17: si los datos no se obtienen directamente del titular, debe informarse el aviso; art. 35: al transferir a terceros se les comunica el aviso y las finalidades.
- **[I]** Un despacho señala que se eliminó la obligación de listar transferencias en el aviso; el texto de art. 15 no las menciona entre los mínimos. (Verificado que art. 15 no las lista; la valoración de "eliminación" es de terceros.)

### 1.3 Consentimiento, formularios y marketing
- **[V]** Art. 7: todo tratamiento requiere consentimiento salvo excepciones; puede ser **expreso o tácito**; tácito cuando se puso a disposición el aviso y el titular no manifiesta lo contrario; "por regla general será válido el consentimiento tácito"; datos financieros o patrimoniales requieren expreso; revocable en cualquier momento, y el aviso debe indicar mecanismos para revocar.
- **[V]** Art. 8: datos sensibles requieren consentimiento **expreso y por escrito** (firma autógrafa, firma electrónica o mecanismo de autenticación).
- **[V]** Art. 9: excepciones al consentimiento (disposición legal, fuentes de acceso público, disociación, relación jurídica, emergencia, etc.).
- **[V]** Art. 26 oposición con causa legítima; arts. 22 a 27 derechos ARCO; art. 31: respuesta en máximo **20 días** desde la solicitud, y cumplimiento en 15 días siguientes; art. 34: ejercicio gratuito (cobros solo de reproducción/envío).
- **[V]** Art. 19: vulneraciones de seguridad que afecten significativamente derechos patrimoniales o morales se informan de inmediato al titular.
- **[V]** Marketing (Ley Federal de Protección al Consumidor, LFPC, texto con "Última Reforma DOF 12-12-2025", https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPC.pdf): art. 17 la publicidad enviada a consumidores debe indicar nombre, domicilio, teléfono y, en su defecto, dirección electrónica del proveedor y de Profeco; el consumidor puede exigir no recibir publicidad ni que su información se ceda a terceros; art. 18 Profeco "podrá llevar" un registro público de consumidores que no desean publicidad (REPEP); art. 76 Bis fr. VI el proveedor respeta la decisión del consumidor de no recibir avisos comerciales.

### 1.4 Cookies y analítica
- **[NV]** No encontré regla específica sobre cookies en la LFPDPPP 2025 (grep del texto sin menciones de "cookies"). La ley cubre cualquier medio electrónico/tecnología (arts. 7 y 16), por lo que si la analítica trata datos personales aplica el régimen general (aviso + consentimiento, que puede ser tácito, art. 7). Guía específica de la Secretaría: **[NV]**.

### 1.5 Obligaciones de datos de empresa en sitio comercial
- **[V]** LFPC art. 76 Bis (comercio electrónico): I confidencialidad de los datos del consumidor y no difundirlos a otros proveedores sin autorización expresa; II usar elementos técnicos de seguridad e informar de ellos antes de la transacción; III dar antes de la transacción domicilio físico, teléfonos y medios para reclamos; V informar términos, condiciones, costos, cargos adicionales y formas de pago; VIII (adicionada DOF 12-12-2025) informar de forma clara si hay cobros automáticos recurrentes, con consentimiento expreso, y notificar renovaciones con 5 días naturales; IX (adicionada DOF 12-12-2025) mecanismo para cancelar suscripciones de inmediato.
- **[V]** Art. 76 Bis 1: el proveedor se guía por la Norma Mexicana de la Secretaría de Economía (comercio electrónico); su contenido (especificaciones, verificación, soporte de prueba, seguridad, quejas, identidad, pago, entrega). El texto de la NMX **[NV]**.

### 1.6 Comercio electrónico / consumo
- **[V]** LFPC art. 56 (capítulo de ventas a domicilio, mediante correo, teléfono u otros medios sin trato directo; art. 53 menciona telefono, televisión, mensajería "u otros en que no exista trato directo con el comprador"): el contrato se perfecciona a los **5 días hábiles** desde la entrega del bien o la firma; durante ese lapso el consumidor puede revocar sin responsabilidad; fletes y seguro a cargo del consumidor; en servicios no aplica si la prestación está a 10 días hábiles o menos de la orden. **[I]** Si este art. 56 abarca en la práctica compras online hechas desde una landing: el art. 76 Bis aplica al comercio electrónico, pero la remisión directa al art. 56 no la verifiqué.
- **[V]** Art. 32: información y publicidad veraz y comprobable (texto leído parcialmente; contenido exacto no reproducido aquí).

---

## 2. Brasil

### 2.1 Norma y estado
- **[V]** Lei nº 13.709/2018 (LGPD), texto compilado con modificaciones de las Leis 13.853/2019 y otras. Fuente: https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm (leído 2026-10-12). Fecha de última alteración visible: no la determiné; el texto compilado muestra redacciones de la Lei 13.853/2019 (mantenido en vigor).
- **[V]** Alcance extraterritorial, art. 3: aplica a cualquier tratamiento "independentemente do meio, do país de sua sede ou do país onde estejam localizados os dados" cuando: I se realiza en territorio nacional; II tenga por objeto la **oferta o suministro de bienes o servicios o el tratamiento de datos de individuos localizados en el territorio nacional**; III los datos se recolectaron en el territorio nacional (§ 1º: se consideran recolectados donde el titular se encuentra al momento de la recolección).
- **[V]** Autoridad: Autoridade Nacional de Proteção de Dados (ANPD), arts. 55-A y ss.; sanciones art. 52.

### 2.2 Aviso/política de privacidad
- **[V]** Art. 9: derecho de acceso facilitado a información "de forma clara, adequada e ostensiva" sobre: I finalidad específica; II forma y duración; III identificación del controlador; IV contacto del controlador; V uso compartido y finalidad; VI responsabilidades de los agentes; VII derechos del titular (art. 18). § 3º: si el tratamiento es condición para suministrar un producto o servicio, informarlo con destaque.
- **[V]** Art. 41 y § 1º: el controlador indica un **encarregado** (DPO); su identidad y contacto deben divulgarse públicamente, "preferencialmente no sítio eletrônico do controlador".
- **[V]** Resolução CD/ANPD nº 2/2022, arts. 2-3 y 11 (https://www.gov.br/anpd/pt-br/acesso-a-informacao/institucional/atos-normativos/regulamentacoes_anpd/resolucao-cd-anpd-no-2-de-27-de-janeiro-de-2022): los **agentes de pequeño porte** (microempresas, EPP, startups, personas naturales, sin fines de lucro, que no hagan tratamiento de alto riesgo ni excedan el límite de ingresos) **no están obligados a indicar encarregado**, pero deben mantener un **canal de comunicación con el titular** (art. 11, § 1º). Art. 13 permite política de seguridad simplificada; art. 14 plazos en doble para atender solicitudes. Alto riesgo (art. 4) = criterio general (gran escala o afectación significativa) + uno específico (tecnologías emergentes, vigilancia, decisiones automatizadas, datos sensibles, de niños, adolescentes o ancianos).
- **[I]** La Resolução CD/ANPD nº 18/2024 (16-jul-2024, actuación del encarregado) reitera la dispensa y el canal (resumen de búsqueda; no leí el texto oficial).

### 2.3 Bases legales y consentimiento
- **[V]** Art. 7: bases legales: I consentimiento; II obligación legal; III administración pública; IV investigación; V ejecución de contrato o procedimientos preliminares **a pedido del titular**; VI ejercicio de derechos en proceso; VII protección de la vida; VIII salud; IX **interés legítimo**; X protección del crédito. Art. 10: interés legítimo para "apoio e promoção de atividades do controlador", con transparencia y solo datos estrictamente necesarios.
- **[V]** Art. 8: consentimiento por escrito u otro medio que demuestre la voluntad; si es escrito, cláusula destacada (§ 1º); la carga de la prueba es del controlador (§ 2º); autorizaciones genéricas nulas (§ 4º); finalidades determinadas; revocable en cualquier momento por procedimiento **gratuito y facilitado** (§ 5º). Art. 7 § 5º: para compartir con otros controladores se necesita consentimiento específico.
- **[V]** Art. 14: datos de niños requieren consentimiento específico y destacado de uno de los padres (§ 1º) y no condicionar la participación a más datos que los necesarios (§ 4º). Art. 11: datos sensibles, consentimiento específico y destacado para finalidades específicas.
- **[V]** Art. 18: derechos del titular: confirmación, acceso, corrección, anonimización/bloqueo/eliminación, portabilidad, eliminación de datos tratados con consentimiento, información sobre uso compartido, información sobre posibilidad de no consentir, revocación (I-IX). § 5º: atención sin costo.
- **[V]** Art. 33: transferencia internacional solo a países con grado adecuado o con garantías (cláusulas específicas, estándar, normas corporativas globales, sellos/códigos), entre otras hipótesis.
- **[NV]** Regla específica brasileña sobre emails de marketing/opt-out (no hay ley de spam equivalente que haya leído). El CDC y la LGPD (art. 18 IX, art. 8 § 5º) sirven de base general.

### 2.4 Cookies y analítica
- **[V]** ANPD, *Guia Orientativo Cookies e Proteção de Dados Pessoais* (publicado 18-oct-2022; la página gob.br indica "modificado 23/01/2025"). Fuente: https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia-orientativo-cookies-e-protecao-de-dados-pessoais.pdf (PDF leído). Es una **guía orientativa, no una norma vinculante**. Contenido: distingue cookies "necessários" (estrictamente necesarios para el servicio solicitado) y "não necessários" (rastreo de comportamiento, **medir desempeño de la página**, anuncios). Para necesarios, el **legítimo interés** puede ser base apropiada; para publicidad "dificilmente" lo será (especialmente de terceros y perfilado) y suele requerirse consentimiento. No recomienda banners con opciones preseleccionadas ni consentimiento tácito por seguir navegando. Buenas prácticas de banner de primer nivel: botón para **rechazar todos los cookies no necesarios** visible y link para ejercer derechos; segundo nivel: categorías, descripción, consentimiento por finalidad y cookies basados en consentimiento desactivados por defecto. Distingue política de cookies (documento) de banner.

### 2.5 Obligaciones de datos de empresa en sitio comercial / comercio electrónico
- **[V]** Decreto 7.962/2013 (regula comercio electrónico del CDC): https://www.planalto.gov.br/ccivil_03/_ato2011-2014/2013/decreto/d7962.htm. Art. 2: los sitios usados para oferta o conclusión de contratos deben mostrar "em local de destaque e de fácil visualização": nombre empresarial y CNPJ/CPF; dirección física y electrónica y datos de contacto; características esenciales del producto o servicio; discriminar en el precio gastos adicionales (entrega, seguros); condiciones integrales de la oferta; restricciones. Art. 4: resumen del contrato, herramientas para corregir errores, confirmar inmediatamente la aceptación, contrato conservable, **servicio de atención electrónica** (respuesta en hasta 5 días), seguridad de pago y datos. Art. 5: informar "de forma clara e ostensiva" los medios para ejercer el **derecho de arrepentimiento**.
- **[V]** CDC (Lei 8.078/1990) art. 49: desistimiento en **7 días** desde la firma o recepción cuando la contratación ocurre **fuera del establecimiento comercial** (especialmente por teléfono o a domicilio); valores pagados se devuelven de inmediato con actualización monetaria. Art. 31: información "corretas, claras, precisas, ostensivas e em língua portuguesa". Fuente: https://www.planalto.gov.br/ccivil_03/leis/l8078compilado.htm. **[I]** Que el art. 49 abarca la compra por internet es la lectura corriente (Decreto 7.962 art. 5 presupone el derecho de arrepentimiento en e-commerce); el texto del art. 49 no dice "internet" explícitamente.

---

## 3. Argentina

### 3.1 Norma y estado
- **[V]** Ley 25.326 (2000), texto oficial en https://www.argentina.gob.ar/normativa/nacional/ley-25326-64790/texto (leído 2026-10-12). Autoridad: art. 29 "órgano de control" (hoy la **Agencia de Acceso a la Información Pública, AAIP**, según su sitio oficial). Decreto reglamentario 1558/2001.
- **[V]** Proyectos de reforma: **[I]** (resumen de búsqueda con referencia a IAPP/medios, expedientes 644-S-2025, 1948-D-2025, 3397-D-2026) ninguno votado; la ley sigue vigente. Los textos de proyectos están en sitios de la Cámara de Diputados pero no los abrí. Estado a 2026-10-12: **[NV]** más allá de lo anterior.
- Alcance extraterritorial claro de la Ley 25.326: **[NV]** (la ley no tiene cláusula como GDPR art. 3(2); el art. 12 regula transferencias internacionales).

### 3.2 Aviso, información y consentimiento
- **[V]** Art. 5: consentimiento "libre, expreso e informado", por escrito o medio equiparable; excepciones (fuentes públicas, listados básicos, relación contractual, etc.).
- **[V]** Art. 6: antes de recabar datos informar de modo expreso y claro: finalidad y destinatarios; existencia del archivo y identidad y domicilio del responsable; carácter obligatorio o facultativo de las respuestas; consecuencias de dar, negarse o dar datos inexactos; derechos de acceso, rectificación y supresión.
- **[V]** AAIP, "Obligaciones de los responsables" (https://www.argentina.gob.ar/aaip/datospersonales/responsables/obligaciones): la información debe exhibirse en lugar visible según **Resolución AAIP 14/2018**; inscripción en Registro; seguridad. Fecha de actualización de la página: no indicada.
- **[V]** Art. 14: acceso, respuesta en **10 días corridos**, gratuito cada 6 meses; art. 16: rectificación/supresión en **5 días hábiles**.

### 3.3 Marketing / emails
- **[V]** Art. 27 (Ley): datos para publicidad/perfiles comerciales; el titular puede en cualquier momento pedir retiro o bloqueo. Decreto 1558/2001 art. 27 (https://www.argentina.gob.ar/normativa/nacional/decreto-1558-2001-70368/texto): en **toda comunicación publicitaria** por correo, teléfono, email, Internet u otro medio a distancia debe indicarse **"en forma expresa y destacada"** la posibilidad de pedir el retiro o bloqueo; a pedido, informar quién proveyó los datos; los responsables de bases con fines de publicidad que no adhieran a un Código de Conducta cumplen el deber de información **inscribiéndose en el Registro (art. 21)**.

### 3.4 Registro de bases de datos
- **[V]** Art. 21 (Ley): registro obligatorio para archivos públicos y privados "destinados a dar informes". AAIP: inscripción, modificación y baja por TAD/GDE (Res. 132/2018 **[I]**). Que una base de leads de una landing deba inscribirse: depende de si encaja como base con fines de publicidad (Decreto 1558 art. 27 la lleva al registro art. 21) **[V para esa regla]**; la práctica de la AAIP sobre bases pequeñas **[NV]**.

### 3.5 Cookies/analítica
- **[NV]** Sin regla específica sobre cookies hallada.

### 3.6 Consumo y e-commerce
- **[V]** Ley 24.240 texto actualizado (InfoLeg: https://servicios.infoleg.gob.ar/infolegInternet/anexos/0-4999/638/texact.htm; la copia en argentina.gob.ar es "texto original" de 1993, que dice 5 días, no usar). Art. 34 (sustituido por Ley 26.361, B.O. 7-4-2008): en venta por correspondencia y otras modalidades a distancia (art. 33, incluye electrónico) el consumidor puede revocar la aceptación en **10 días corridos** desde la entrega o la celebración del contrato (lo último); el vendedor debe informarlo por escrito, "clara y notoria"; irrenunciable; gastos de devolución a cargo del vendedor. Art. 4 (texto Ley 27.250): información "cierta, clara y detallada". Art. 10 ter: rescisión por el mismo medio de contratación, constancia en 72 horas. Última modificación citada en la página: Ley 27.701 (B.O. 1-12-2022).
- **[V]** **Botón de arrepentimiento**: Resolución 424/2020 de la Secretaría de Comercio Interior, B.O. 5-10-2020 (https://www.boletinoficial.gob.ar/detalleAviso/primera/235729/20201005): art. 1 los proveedores que venden bienes o servicios por páginas o apps web deben publicar el "BOTÓN DE ARREPENTIMIENTO"; el proveedor informa un código de revocación en **24 horas** por el mismo medio; art. 2 link de acceso fácil y directo **desde la página de inicio**, destacado, sin registración previa; art. 3 adecuación en 60 días corridos. **[I]** Contexto "botón de baja" (Res. 270/2020, Mercosur 37/2019): fuente secundaria.

---

## 4. Colombia

### 4.1 Norma y estado
- **[V]** Ley 1581 de 2012 (Senado: http://www.secretariasenado.gov.co/senado/basedoc/ley_1581_2012.html, leída 2026-10-12). Autoridad: **Superintendencia de Industria y Comercio (SIC)**, Delegatura de Protección de Datos (art. 19).
- **[V]** Art. 2: aplica al tratamiento "efectuado en territorio colombiano" y, a responsables/encargados no establecidos, cuando les sea aplicable la ley colombiana "en virtud de normas y tratados internacionales" (cláusula más estrecha que GDPR art. 3(2)); **[NV]** cómo la SIC aplica a sitios extranjeros dirigidos a colombianos.
- **[V]** Reglamentación: Decreto 1377 de 2013 (leído en https://www.funcionpublica.gov.co/eva/gestornormativo/norma_pdf.php?i=53646 con verificación de certificado desactivada, solo lectura de texto público). **[I]** (guía SIC) está incorporado al Decreto 1074 de 2015; **[NV]** estado vigente de cada artículo citado tras la compilación.

### 4.2 Autorización, aviso y política
- **[V]** Ley 1581 art. 9: autorización previa e informada, obtenida por cualquier medio que permita consulta posterior; art. 12 (deber de informar al solicitar autorización): tratamiento y finalidad; carácter facultativo de respuestas sobre datos sensibles o de niños; derechos del titular; identificación, dirección física o electrónica y teléfono del responsable; parágrafo: conservar **prueba** del cumplimiento.
- **[V]** Decreto 1377/2013: art. 5 pedir autorización a más tardar al recolectar e informar los datos y **todas las finalidades específicas**; art. 7 la autorización puede ser por escrito, oral o **conductas inequívocas**, y "en ningún caso el silencio podrá asimilarse a una conducta inequívoca"; art. 8 prueba; art. 9 revocatoria/supresión; art. 13 **política de tratamiento** (contenido mínimo: razón social, domicilio, dirección, email y teléfono del responsable; tratamiento y finalidad; derechos; persona o área de atención de peticiones; procedimiento para ejercer derechos; fecha de entrada en vigencia y periodo de vigencia de la base de datos); art. 14 **aviso de privacidad** cuando no sea posible poner la política a disposición; art. 15 contenido mínimo del aviso: responsable y contacto, tratamiento y finalidad, derechos, cómo acceder a la política (y carácter facultativo si hay datos sensibles); art. 12 menores (requisitos especiales).
- **[V]** Ley 1581 art. 17 k): manual interno de políticas y procedimientos; art. 14: consultas en máximo **10 días hábiles**; art. 15: reclamos en **15 días hábiles** (prorrogables 8).
- **[V]** Art. 26 de la Ley: prohíbe transferir datos a países sin nivel adecuado según la SIC (matices y excepciones: **[NV]**, no leí el art. 26 completo ni las excepciones).

### 4.3 RNBD (registro)
- **[V]** Ley 1581 art. 25: el Registro Nacional de Bases de Datos es el directorio público de bases sujetas a tratamiento.
- **[I]** Decreto 090 de 2018 (según resumen de búsqueda y la página FAQ de la SIC no leída en detalle): solo deben inscribirse sociedades y entidades sin ánimo de lucro con **activos totales superiores a 100.000 UVT** y personas jurídicas públicas; quedan fuera personas naturales y entidades menores (que igual deben cumplir la Ley 1581). El texto del decreto: https://www.funcionpublica.gov.co/eva/gestornormativo/norma_pdf.php?i=85039 (no lo abrí). Bases creadas luego se inscriben dentro de 2 meses. **[NV]** el valor de la UVT vigente.

### 4.4 Marketing y cookies
- **[V]** Ley 2300 de 2023 ("Dejen de fastidiar"), art. 5 (http://www.secretariasenado.gov.co/senado/basedoc/ley_2300_2023.html): aplica a proveedores/productores frente al envío de **mensajes publicitarios por SMS, mensajería por aplicaciones o web, correos electrónicos y llamadas** comerciales; par. 2: no se puede obligar al consumidor a aceptar mensajes comerciales al comprar; "cuando se trate de promociones para alimentar bases de datos, el consumidor deberá saberlo y aceptarlo de manera explícita"; el emisor debe habilitar un mecanismo "ágil, sencillo y eficiente" para cancelar en cualquier momento; par. 3: solo dentro de los horarios del art. 3 (lunes a viernes 7:00 a 19:00; sábados 8:00 a 15:00; sin domingos ni festivos); registro de números excluidos adaptado por MinTIC/CRC.
- **[NV]** Regla específica de cookies por la SIC (búsqueda sin resultados; guía SIC de comercio electrónico 2019 centrada en datos, no cookies: https://www.sic.gov.co/content/gu%C3%ADa-sobre-el-tratamiento-de-datos-personales-para-fines-de-comercio-electr%C3%B3nico **[I]**).

### 4.5 Consumo y e-commerce
- **[V]** Ley 1480 de 2011 (Estatuto del Consumidor), http://www.secretariasenado.gov.co/senado/basedoc/ley_1480_2011_pr001.html: art. 47 **derecho de retracto**: en ventas con financiación del productor/proveedor, tiempos compartidos o ventas con métodos no tradicionales o **a distancia** (bienes que por su naturaleza no deban consumirse o no hayan comenzado a ejecutarse antes de 5 días): **5 días hábiles** desde la entrega del bien o celebración del contrato (servicios); reintegro del dinero; costos de devolución a cargo del consumidor; excepciones enumeradas (contenido de la lista: no la reproduje). Art. 50 (modificado en lo pertinente por Ley 2439 de 2024): proveedores en territorio nacional que ofrezcan productos por medios electrónicos deben informar identidad (nombre/razón social, **NIT**, dirección de notificación judicial, teléfono, correo), información cierta y suficiente de los productos, medios de pago, tiempo de entrega, **derecho de retracto y procedimiento**, precio total con impuestos y gastos de envío por separado, y publicar las condiciones generales del contrato descargables; resumen del pedido antes de finalizar. Art. 51 reversión del pago (5 días hábiles).

---

## 5. Chile

### 5.1 Norma y estado de entrada en vigor
- **[V]** Ley 21.719 (regula la protección y el tratamiento de los datos personales y crea la Agencia de Protección de Datos Personales), publicada en el Diario Oficial el **13-dic-2024**. Texto: https://www.diariooficial.interior.gob.cl/publicaciones/2024/12/13/44023/01/2583630.pdf (leído 2026-10-12). Disposición transitoria primera: las modificaciones a las leyes 19.628, 20.285 y 19.496 entran en vigencia "el día primero del mes vigésimo cuarto posterior a la publicación" = **1-dic-2026**. Transitoria segunda: reglamentos dentro de 6 meses.
- **[V]** Hay un proyecto del Ejecutivo (**Boletín 18.623-07**, mensaje del 31-ago-2026, ingresado al Senado el 1-sep-2026, primer trámite) que cambiaría la fecha a **1-dic-2027**, pasaría el Consejo de la Agencia de 3 a 5 consejeros y eliminaría la limitación del art. sexto transitorio sobre amonestación a empresas de menor tamaño. Fuentes: resumen de búsqueda de https://tramitacion.senado.cl (mensaje) y nota del Ministerio de Economía https://www.economia.gob.cl/2026/09/01/gobierno-propone-ampliar-plazo-para-implementar-nueva-ley-de-proteccion-de-datos-y-institucionalidad.htm (leída; sin fecha visible en el contenido recibido). **Estado de tramitación posterior: [NV]** (el portal legislativo no cargó).
- **[I]** Fuentes de terceros indican que el Consejo Directivo de la Agencia aún no está nombrado (Senado rechazó la propuesta presidencial el 19-may-2026), y que mientras el proyecto no se publique la fecha legal es 1-dic-2026. **No verificado en fuente oficial.**
- **Conclusión de estado a 2026-10-12:** la ley está publicada; sus reglas sustantivas aún no rigen (rige la Ley 19.628 antigua); la entrada en vigor legal es 1-dic-2026 salvo que el Congreso apruebe el aplazo (a 1-dic-2027).

### 5.2 Contenido de la ley (cuando rija)
- **[V]** Art. 1 bis letra c) (ámbito territorial): aplica aunque el responsable no esté establecido en Chile cuando el tratamiento esté destinado a **ofrecer bienes o servicios a titulares que se encuentren en Chile** (con o sin pago) o a **monitorear su comportamiento** (análisis, rastreo, perfilamiento, predicción).
- **[V]** Art. 12: consentimiento libre, informado y **específico** en cuanto a su finalidad; previo e inequívoco, por declaración verbal, escrita, medio electrónico equivalente o **acto afirmativo**; revocable en cualquier momento con medios similares; medios "expeditos, fidedignos, gratuitos y permanentemente disponibles"; se presume no libre si se exige sin ser necesario para el contrato o servicio; el responsable prueba que lo obtuvo.
- **[V]** Art. 13: otras bases: obligaciones económicas, ley, contrato o medidas precontractuales a solicitud del titular, **interés legítimo**, defensa de derechos.
- **[V]** Art. 14 inciso final: responsable sin domicilio en Chile que trate datos de residentes debe señalar y mantener un correo u otro medio de contacto idóneo para titulares y Agencia.
- **[V]** Art. 14 ter, información que el responsable debe mantener permanentemente en su **sitio web**: política de tratamiento con fecha y versión; identificación del responsable y representante; medio de contacto para solicitudes (domicilio postal, email o formulario); categorías de datos, universo de personas, destinatarios, finalidades, base de legitimidad e intereses legítimos; medidas de seguridad; derechos de acceso, rectificación, supresión, oposición y portabilidad; derecho a reclamar ante la Agencia; transferencias a terceros países; plazo de conservación; fuente de los datos; derecho a retirar el consentimiento; decisiones automatizadas/perfiles.
- **[V]** Art. 8 letra b): derecho de oposición cuando el tratamiento es exclusivamente para marketing directo, incluida la elaboración de perfiles. Art. 14 quáter: protección desde el diseño y por defecto. Art. 16 quáter: datos de niños.
- **[V]** Art. 14 septies y art. sexto transitorio: estándares diferenciados para empresas de menor tamaño y amonestación por escrito durante 12 meses tras la vigencia (el proyecto 18.623-07 elimina esa limitación, ver 5.1). Detalle del art. 14 septies: **[NV]** (no lo leí completo).
- Cookies: **[NV]** no hay regla específica leída; aplican consentimiento general y, para perfilamiento, art. 8 bis y 1 bis.

### 5.3 Consumo y e-commerce
- **[V]** SERNAC (portal oficial, https://www.sernac.cl/portal/617/w3-propertyvalue-64530.html; sin fecha de actualización): en compras por internet, teléfono o catálogo, retracto en **10 días** desde la contratación o recepción del producto, con el producto sin usar; el proveedor debe enviar confirmación escrita del contrato y si no la envía el plazo se extiende a **90 días**; aplica "siempre que la empresa no informe lo contrario" (la empresa puede excluirlo en los casos legales y debe informarlo antes de contratar). La página no cita el artículo de la Ley 19.496 (**[NV]** art. exacto, habitualmente art. 3 bis; no verificado en BCN por falla del servicio).
- **[I]** Resumen de búsqueda de SERNAC: Reglamento de Comercio Electrónico vigente desde 24-mar-2022, que obliga a informar si hay derecho a retracto; Ley Pro Consumidor.
- Nota: la Ley 21.719 art. tercero permanente suprime el art. 15 bis de la Ley 19.496 (consumo), con vigencia 1-dic-2026 (texto leído en la ley).

---

## 6. Perú

### 6.1 Norma y estado
- **[V]** Ley 29733 (Ley de Protección de Datos Personales), versión vigente publicada por la SMV (https://www.smv.gob.pe/Uploads/Ley_29733_vigente_2025.pdf; concordancias muestran D.S. 016-2024-JUS como reglamento vigente y D.S. 003-2013-JUS derogado). Art. 3: aplica a datos en bancos de datos "cuyo tratamiento se realiza en el territorio nacional".
- **[V]** Nuevo Reglamento, **D.S. 016-2024-JUS**, publicado en El Peruano el **30-nov-2024** (copia del diario en https://img.lpderecho.pe/wp-content/uploads/2024/11/Decreto-Supremo-016-2024-JUS-LPDerecho.pdf, reproduce la edición oficial; no es sitio estatal): Disposición Complementaria Final Primera: vigencia a los **120 días calendario** de su publicación. **[I]** fuentes secundarias dan el 30 o 31-mar-2025 (la página de la ANPD en gob.pe dice 31-mar-2025 según resumen de búsqueda); hay disposiciones con plazos escalonados (p. ej. oficial de datos personales).
- **[V]** Reglamento art. VI (ámbito en y para territorio peruano): aplica también cuando el responsable no está establecido en Perú pero **ofrece bienes o servicios a titulares ubicados en Perú** (3.1) o **analiza su comportamiento / elabora perfiles** (3.2), o utiliza medios situados en Perú. Esto es el equivalente peruano de GDPR art. 3(2).
- Autoridad: Autoridad Nacional de Protección de Datos Personales (Dirección General de Transparencia, Acceso a la Información Pública y Protección de Datos Personales del Minjusdh); registro: Registro Nacional de Protección de Datos Personales (Ley art. 34).

### 6.2 Información, consentimiento y marketing
- **[V]** Ley art. 5: consentimiento previo; art. 28 inc. 1: consentimiento "informado, expreso e inequívoco"; art. 18: información previa, "detallada, sencilla, expresa, inequívoca": finalidad, destinatarios, existencia del banco de datos y **identidad y domicilio del titular del banco**, carácter obligatorio o facultativo, transferencia, consecuencias, **tiempo de conservación**, derechos y medios; si los datos se recogen en línea, "pueden satisfacerse mediante la publicación de políticas de privacidad, fácilmente accesibles e identificables".
- **[V]** Reglamento art. 26 (publicidad y prospección comercial): lícito cuando se obtiene el consentimiento **de forma directa** del titular (26.1); se puede obtener mediante un primer contacto, tras el cual si no se logró no hay nuevo contacto (26.2); el titular puede negarse, revocar u oponerse con un medio sencillo y gratuito, atendido dentro de **10 días** (26.5).
- **[V]** Reglamento arts. 42 y 45: obligación de inscribir bancos de datos de administración privada; procedimiento de **aprobación automática** por formulario (la gratuidad: **[I]**). Art. 46: medidas de seguridad en plataformas, sitios web y aplicaciones que traten datos.
- **[I]** Brecha de seguridad: notificar en 48 horas (resumen de terceros; no localicé el artículo).
- Cookies: **[NV]** sin regla específica leída.
- Email comercial: **[V]** Ley 28493 (spam) existe y prevé opt-out con aviso "PUBLICIDAD"; **[I]** un comentario del Congreso sostiene que está desplazada por el Código de Consumo (D.Leg. 1390, ley 32323); no pude confirmarlo. Código de Consumo art. 58.1 d): prohíbe propuestas no solicitadas por teléfono, fax, correo electrónico "de manera persistente e impertinente", o ignorando la petición de cesar (**[V]**, texto en https://cdn.www.gob.pe/uploads/document/file/4265044/Co%CC%81digo%20de%20Proteccio%CC%81n%20y%20Defensa%20del%20Consumidor%20-%202023%20(1).pdf.pdf).

### 6.3 Consumo y e-commerce
- **[V]** Código de Protección y Defensa del Consumidor, Ley 29571, 2ª edición Indecopi marzo 2023: art. 2 información relevante, veraz, suficiente, en castellano; art. 58.2 los métodos comerciales agresivos o engañosos aplican a contratos a distancia y comercio electrónico; art. 59 derecho a la restitución (7 días calendario) **solo** cuando hubo prácticas del art. 58; art. 150 Libro de Reclamaciones (físico o virtual). No encontré en el texto un derecho general de retracto/arrepentimiento (búsqueda de "arrepent", "retracto", "desistim" sin resultados relevantes). 
- **[I]** El Libro de Reclamaciones virtual debe estar en la página de inicio para proveedores solo virtuales (resumen de Indecopi vía búsqueda; texto del D.S. 011-2011-PCM no abierto) y una ley reciente extiende la obligación a plataformas (sin fecha de vigencia confirmada).

---

## 7. Otros países (breve)

- **Uruguay**: Ley 18.331 (2008). **[I]** resumen de búsqueda de la URCDP/IMPO: ley 19.670 art. 37 y Decreto 64/020 extienden la ley a responsables no establecidos cuando ofrecen bienes o servicios a habitantes de Uruguay o analizan su comportamiento (idioma, moneda nacional, etc.), con obligación de **registrar bases** ante la URCDP (Dictamen 15/021). No leí los textos.
- **Ecuador**: Ley Orgánica de Protección de Datos Personales (R.O. Suplemento 459, 26-may-2021); régimen sancionatorio aplicable desde 26-may-2023; Reglamento publicado 13-nov-2023; art. 3 alcance extraterritorial (oferta de bienes/servicios o control de comportamiento de residentes); autoridad: Superintendencia de Protección de Datos Personales. **[I]** (resultados de búsqueda sobre sitios oficiales; no leí el texto).
- **Panamá**: Ley 81 de 2019, vigente desde 29-mar-2021, Decreto Ejecutivo 285 de 2021 (Gaceta 29296-A); autoridad: ANTAI. Consentimiento previo, informado e inequívoco; revocable. **[I]** (resumen de búsqueda sobre antai.gob.pa).
- **Otros**: Costa Rica (Ley 8968), Paraguay, Bolivia, Venezuela etc.: **[NV]**; no investigados. México, Brasil, Argentina, Colombia, Chile, Perú, Uruguay, Ecuador y Panamá tienen ley omnibus con consentimiento + derechos + autoridad; los patrones coinciden con la sección 8.

---

## 8. Marco global de referencia (GDPR, ePrivacy, CCPA)

- **[V]** GDPR (Reglamento UE 2016/679), texto en español del DOUE L 119, 4.5.2016 (copia local descargada de EUR-Lex en este repositorio de trabajo; fuente oficial https://eur-lex.europa.eu/eli/reg/2016/679/oj). **Art. 3(2)**: aplica a datos de interesados **que residan en la Unión** tratados por un responsable no establecido en la Unión cuando se relacionen con (a) la **oferta de bienes o servicios** a esos interesados, sea o no de pago, o (b) el **control de su comportamiento** en la UE. **Art. 27**: representante en la UE por escrito, salvo tratamiento ocasional sin categorías especiales a gran escala y con riesgo improbable. **Art. 13**: información en el momento de obtener los datos: identidad/contacto del responsable (y representante), contacto del DPO si existe, fines y base jurídica, intereses legítimos, destinatarios, transferencias internacionales, plazo de conservación, derechos (acceso, rectificación, supresión, limitación, oposición, portabilidad), retirada del consentimiento, derecho a reclamar ante autoridad, si la comunicación es requisito legal o contractual y consecuencias de no darla. **Art. 7**: consentimiento demostrable, distinguible, retirable tan fácil como darlo.
- **[NV]** Directiva ePrivacy 2002/58/CE art. 5(3) (cookies: consentimiento previo salvo estrictamente necesarias) y art. 13 (comunicaciones comerciales no solicitadas): EUR-Lex no devolvió contenido en esta sesión; conocidos por la guía oficial AEPD/CNIL (otros documentos de la investigación). Citar solo con verificación.
- **[V]** CCPA/CPRA (California Civil Code 1798.100 y ss.), texto "effective 7/15/2024 – AB 3286 update", publicado por la CPPA (https://cppa.ca.gov/regulations/pdf/cppa_act.pdf, leído 2026-10-12): 1798.140(d) "business" = entidad con fines de lucro que **hace negocios en California** y cumple al menos un umbral: ingresos brutos anuales **>25.000.000 USD** (ajustados), **compra, vende o comparte** datos de **100.000 o más** consumidores u hogares, o **50%** o más de ingresos por vender/compartir datos. La página de la Fiscalía de California (https://oag.ca.gov/privacy/ccpa, "Updated on August 28, 2026") lista derechos (conocer, eliminar, corregir, oponerse a venta/compartir, limitar uso de datos sensibles, no discriminación), reconoce el **Global Privacy Control**, y obligaciones: política de privacidad, aviso en el momento de recolección, enlace "Do Not Sell or Share" si se vende/comparte. El valor ajustado del umbral de 25M para 2026: **[NV]**.
- **[V]** LGPD art. 3 y Chile 1 bis y Perú art. VI del Reglamento: ver secciones 2, 5 y 6 (criterios de "oferta de bienes o servicios" y "monitoreo/análisis de comportamiento" similares al GDPR).

---

## 9. MÍNIMO COMÚN PARA UNA LANDING GLOBAL

La regla práctica de aplicar la norma del lugar donde residen los usuarios **está respaldada por texto oficial** donde hay cláusula expresa:
- GDPR art. 3(2) **[V]**; LGPD art. 3 II y III **[V]**; Chile Ley 21.719 art. 1 bis c) (cuando rija) **[V]**; Perú Reglamento art. VI 3.1 y 3.2 **[V]**; CCPA: depende de que el negocio "haga negocios" en California y supere umbrales **[V]**; Ecuador y Uruguay **[I]**.
- **Matices**: México (art. 1: territorio nacional), Argentina (sin cláusula expresa leída) y Colombia (art. 2 con remisión a tratados o normas internacionales) no tienen una cláusula equivalente a GDPR 3(2) en lo que leí. Eso no equivale a "no aplica" a un negocio establecido en ese país: aplica por establecimiento. Para un negocio fuera de ellos que capta residentes: **[NV]** cómo lo tratan sus autoridades.

### 9.1 Conjunto reducido que cubre razonablemente la mayoría de las jurisdicciones

1. **Política de privacidad** única, en la web, accesible desde cada formulario y desde el pie, con: identidad y domicilio del responsable (MX art. 15 I; AR art. 6; CO art. 12 y Dec. 1377 art. 13; CL art. 14 ter b/c; PE art. 18; BR art. 9 III-IV; GDPR 13(1)(a)); contacto para ejercer derechos (todas); datos tratados y finalidades específicas, con base legal (GDPR 13; BR art. 9 I y art. 7; CL art. 14 ter d); destinatarios y transferencias internacionales (BR art. 9 V y 33; GDPR; CL; AR art. 12); plazo de conservación (PE art. 18; CL art. 14 ter i; GDPR 13(2)(a); BR art. 9 II); **derechos** (acceso, rectificación, supresión/cancelación, oposición, portabilidad, revocación; BR art. 18; CL art. 14 ter f; MX arts. 22-27; CO art. 8; GDPR 13(2)(b)); cómo reclamar ante la autoridad (CL; GDPR); cambios y fecha de versión (MX art. 15 VI; CL art. 14 ter a; CO Dec. 1377 art. 13).
2. **Aviso breve en el formulario** (aviso simplificado) con enlace a la política integral: es literalmente el modelo mexicano (art. 16 II) y encaja con GDPR art. 13 en el momento de recolección.
3. **Consentimiento afirmativo, específico y por finalidad** para el marketing y la newsletter: casilla **no premarcada**, separada de los términos, con constancia (fecha, texto, IP) y revocación tan fácil como el alta. Soportes: GDPR art. 7; LGPD art. 8 §§ 1-5; Chile art. 12; Perú art. 28.1 y Reglamento art. 26; Colombia Dec. 1377 art. 7 (el silencio no vale) y Ley 2300/2023 art. 5 par. 2 ("alimentar bases de datos" requiere aceptación explícita); Argentina art. 5 (expreso). **Excepción**: México permite consentimiento tácito por regla general (art. 7) y para datos sensibles exige expreso y por escrito (art. 8).
4. **Gestión de baja** en cada email: enlace de baja de un clic, gratuito, + identificación del anunciante y su dirección (MX LFPC art. 17; AR Decreto 1558 art. 27; CO Ley 2300 art. 5 par. 2; PE Reglamento art. 26.5, atender en 10 días; CL art. 8 b; BR art. 8 § 5 y 18 IX; CAN-SPAM y GDPR/ePrivacy como referencia).
5. **Cookies/analítica**: banner solo si hay cookies o tecnologías no necesarias (analítica, píxeles de anuncios). Brasil lo define con guía ANPD (rechazar visible, sin preseleccionados, categorías); GDPR/ePrivacy lo exige para no esenciales (**[NV]** texto ePrivacy). En LATAM no hallé norma específica vinculante de cookies en MX, AR, CO, CL, PE **[NV]**. Si la analítica es solo de primera parte, agregada y sin identificadores, la necesidad de banner depende de la jurisdicción: ANPD la clasifica como "não necessário" (BR) y la CNIL/AEPD tienen exenciones condicionadas (**[NV]** aquí; ver las guías de la investigación). Alternativa mínima: analítica sin cookies + aviso informativo.
6. **Datos de contacto del proveedor** visibles (razón social, número fiscal, dirección física y electrónica, teléfono): BR Decreto 7.962 art. 2 I-II; CO Ley 1480 art. 50 a; MX LFPC art. 76 Bis III; PE Código art. 2 (información relevante) y Libro de Reclamaciones; AR Ley 24.240 art. 4. Aplica en cuanto haya oferta comercial.
7. **Términos y condiciones de venta** solo si la landing vende o toma pagos: precio total con impuestos y envío por separado (CO art. 50 c; BR Dec. 7.962 art. 2 IV), características, plazos, medios de pago, soporte y reclamaciones (MX LFPC 76 Bis; BR art. 4), y **información clara sobre arrepentimiento/retracto**.
8. **Mecanismo de arrepentimiento/retracto**, con plazo por país: AR **10 días corridos** + botón en home (Ley 24.240 art. 34; Res. 424/2020); BR **7 días** (CDC art. 49; Dec. 7.962 art. 5); CL **10 días** (SERNAC; texto legal **[NV]**); CO **5 días hábiles** (Ley 1480 art. 47); MX **5 días hábiles** en ventas a distancia (LFPC art. 56, ver caveat 1.6); PE: sin retracto general en el Código (**[V]** ausencia en texto leído). Si la landing no vende, no aplica.
9. **Canal para ejercer derechos** (email o formulario) con plazos que respeten el más corto razonable: AR 10 días corridos/5 hábiles; CO 10-15 hábiles; MX 20 días; PE 10 días para marketing; BR "nos prazos de regulamento" (Res. 2/2022 art. 14 duplica plazo para pequeño porte); GDPR 1 mes (**[NV]** texto del art. 12 no leído).
10. **Seguridad básica y registro de actividades**: HTTPS, acceso mínimo, prueba del consentimiento (todas); LGPD art. 37 (registro de operaciones); CO Dec. 1377 art. 8 (prueba). 
11. **Encarregado / representante / registro** solo si corresponde: BR dispensa a pequeño porte (canal obligatorio); AR registro bases si "destinados a informes" o publicidad sin código de conducta; PE inscripción de banco de datos (aprobación automática); CO RNBD solo si activos >100.000 UVT **[I]**; UE representante art. 27; CL contacto para residentes (art. 14).
12. **Menores**: si el público puede incluir menores, no recolectar sin consentimiento parental (BR art. 14; CO Dec. 1377 art. 12; CL 16 quáter; GDPR art. 8).

### 9.2 Decisiones según el público objetivo principal
- **Un solo país** (p. ej. México): usar su régimen como base. En MX alcanza con aviso simplificado + integral, consentimiento tácito válido para datos no sensibles, y no pedir datos sensibles. Si cobra online: LFPC art. 76 Bis y revisar art. 56.
- **Argentina**: añadir leyenda de baja en cada publicidad (Decreto 1558 art. 27), botón de arrepentimiento en home si vende, 10 días de revocación; valorar inscripción en el registro de la AAIP si arma base de marketing.
- **Brasil**: portugués, base legal explícita (consentimiento o interés legítimo con justificación), canal del titular, banner con "rechazar", CNPJ y datos de contacto visibles si vende, 7 días de arrepentimiento.
- **Colombia**: política de tratamiento + aviso + autorización con finalidades; no tratar el silencio como consentimiento; Ley 2300 (horarios de mensajes, opción de baja); NIT y retracto en 5 días hábiles si vende.
- **Chile**: preparar ya la política (art. 14 ter) con base en 1-dic-2026, **sujeto al aplazo a 1-dic-2027 si el Senado lo aprueba**. Hasta entonces rige la Ley 19.628 antigua (**[I]**, no verificada su exigencia concreta).
- **Perú**: política en línea (art. 18), consentimiento directo para marketing (Reglamento art. 26), inscripción del banco de datos, y Libro de Reclamaciones virtual si vende.
- **UE/California incluidas**: añadir base legal por finalidad, banner con rechazo, representante UE (art. 27) si apunta a la UE sin establecimiento, enlace "Do Not Sell or Share" solo si vende/comparte datos y supera umbrales CCPA.
- **Varios países a la vez**: la política y el banner estrictos (opt-in granular) cubren a la mayoría; las divergencias reales están en (a) consentimiento tácito en MX, (b) botón de arrepentimiento solo AR, (c) plazos de retracto, (d) registro de bases (AR, PE, UY, CO condicionado), (e) UE/CCPA representantes y enlaces especiales.

---

## 10. Tabla final

| Documento/mecanismo | ¿Obligatorio en landing? | Condición | Fuente |
|---|---|---|---|
| Política de privacidad (integral) con derechos y contacto | Sí, en la práctica en todas las jurisdicciones | Si se capta cualquier dato personal (formulario, IP en analítica) | MX LFPDPPP arts. 14-16; BR LGPD art. 9; AR Ley 25.326 art. 6; CO Ley 1581 art. 12 y Dec. 1377 art. 13; CL Ley 21.719 art. 14 ter (desde su vigencia); PE Ley 29733 art. 18; GDPR art. 13 |
| Aviso de privacidad simplificado junto al formulario | Obligatorio en MX; recomendable en el resto | Datos recabados por medio electrónico | MX LFPDPPP art. 16 fr. II; CO Dec. 1377 arts. 14-15 |
| Consentimiento explícito para marketing/newsletter (casilla no premarcada) | Sí en BR (si base es consentimiento), CL (futuro), PE, CO, AR, UE; MX permite tácito | Si hay envíos comerciales o cesión a terceros | BR art. 8; CL art. 12; PE art. 28.1 y Reglamento art. 26; CO Ley 2300 art. 5 par. 2 y Dec. 1377 art. 7; AR art. 5; MX art. 7; GDPR art. 7 |
| Enlace de baja en cada email y mecanismo gratuito de revocación | Sí | Si se envía publicidad | MX LFPC arts. 17 y 76 Bis VI; AR Dec. 1558 art. 27; CO Ley 2300 art. 5; PE Reglamento art. 26.5; BR art. 8 § 5; CL art. 8 b |
| Banner de cookies con rechazo | Exigido de forma vinculante en UE; en LATAM solo guía (BR ANPD); sin regla específica hallada en MX/AR/CO/PE/CL | Si hay cookies no necesarias (analítica, píxeles de anuncios) | BR Guía ANPD (orientativa) [V]; ePrivacy 5(3) [NV]; resto [NV] |
| Política de cookies | Recomendable; guía ANPD la distingue del banner | Si se usan cookies no necesarias | BR Guía ANPD [V]; resto [NV] |
| Identificación del proveedor (razón social, ID fiscal, domicilio, teléfono, email) en el sitio | Sí en BR, CO, MX en e-commerce; AR/PE información veraz | Si hay oferta/venta | BR Dec. 7.962 art. 2; CO Ley 1480 art. 50; MX LFPC art. 76 Bis III; AR Ley 24.240 art. 4; PE Código art. 2 |
| Términos y condiciones de venta | Sí si hay venta | Venta o cobro online | CO Ley 1480 art. 50 d; BR Dec. 7.962 arts. 2-4; MX LFPC art. 76 Bis V |
| Derecho de retracto / arrepentimiento informado | Sí: AR 10 días, BR 7 días, CO 5 días hábiles, CL 10 días, MX 5 días hábiles (ver caveat); PE sin derecho general | Venta a distancia de bienes/servicios | AR Ley 24.240 art. 34; BR CDC art. 49 y Dec. 7.962 art. 5; CO Ley 1480 arts. 47 y 50 c; CL SERNAC (texto legal [NV]); MX LFPC art. 56 |
| Botón de arrepentimiento en la página de inicio | Sí solo en Argentina | Si vende bienes/servicios en web o app | AR Res. SCI 424/2020 arts. 1-3 |
| Canal para ejercer derechos (email o formulario) y plazo de respuesta | Sí | Si se tratan datos personales | MX arts. 27-31; BR art. 18 y Res. 2/2022 art. 11; AR arts. 14 y 16; CO arts. 14-15; PE; CL art. 14 ter c |
| Encargado/DPO | No para agentes de pequeño porte en BR (pero sí canal); CL tiene "delegado" opcional; PE oficial según cronograma [I] | Según tamaño y riesgo | BR LGPD art. 41 y Res. CD/ANPD 2/2022 art. 11; CL Ley 21.719 art. 50; PE [I] |
| Registro de bases de datos | AR: si base con fines de publicidad sin código de conducta o dedicada a informes; PE: inscribir bancos privados (aprobación automática); CO: solo >100.000 UVT [I]; BR: no; MX: no hallado | Según país y tamaño | AR Ley 25.326 art. 21 y Dec. 1558 art. 27; PE Reglamento arts. 42-45; CO Ley 1581 art. 25 y Dec. 090/2018 [I] |
| Representante local/contacto para residentes | UE art. 27; CL art. 14 (correo de contacto); otros [NV] | Si se dirige a residentes sin establecimiento | GDPR art. 27; CL Ley 21.719 art. 14 |
| Libro de Reclamaciones virtual | Sí en Perú | Si vende en línea | PE Código de Consumo art. 150 y D.S. 011-2011-PCM [I]; extensión a plataformas [I] |
| Enlace "Do Not Sell or Share" | Solo si vende o comparte datos | Negocio que supera umbrales CCPA | CCPA 1798.140(d); Fiscalía de California |
| Consentimiento de menores/restricciones | Sí si hay menores | Si el público incluye menores | BR art. 14; CO Dec. 1377 art. 12; CL art. 16 quáter; GDPR art. 8 |

---

## 11. Incertidumbres principales

1. Chile: la Ley 21.719 sigue fijada para 1-dic-2026 en el texto publicado; hay un proyecto (Boletín 18.623-07) para pasarla a 1-dic-2027 cuyo estado actual no pude confirmar en fuente oficial.
2. México: no confirmé si el Reglamento de 2011 y los Lineamientos del aviso de privacidad se mantienen o hay uno nuevo; tampoco hallé cláusula extraterritorial ni regla específica de cookies. LFPC art. 56 (5 días hábiles) se aplica a ventas "sin trato directo"; su alcance exacto para una compra en landing queda a interpretación.
3. Colombia: RNBD y estado vigente del Decreto 1377 tras compilación en el 1074/2015 los cito vía fuentes secundarias.
4. Perú: fecha exacta de vigencia del nuevo Reglamento (30 o 31-mar-2025) y el estado de la Ley 28493 frente al Código de Consumo.
5. Cookies: sin norma vinculante específica verificada en MX, AR, CO, CL, PE; ePrivacy no verificada en esta sesión.
6. Argentina: no hay cláusula extraterritorial expresa leída; los proyectos de ley nueva no están votados **[I]**.
7. Otros países (UY, EC, PA): solo resúmenes de búsqueda sobre sitios oficiales, sin lectura del texto.
