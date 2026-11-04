# 23 — Impeccable v4.8.0: extracción conductual

> Investigación del 2026-11-04, por lectura directa del repositorio; nada se instaló ni se ejecutó. Fuente: [fuentes.md](fuentes.md) (CR06). Amplía la lectura de octubre de [19](19-direccion-creativa-prototipos-y-critica.md) §1 (CR01), que solo cubrió el manifiesto y la referencia de crítica.

## 1. Qué se leyó

`pbakaus/impeccable`, `main` en `5af4319` (2026-11-04): skill v4.8.0, engine 0.1.18, Apache 2.0 (Copyright 2025 Paul Bakaus). En la fuente `skill/` se leyeron `SKILL.src.md`, `reference/new-work.md`, `reference/craft-floor.md`, `reference/routing.md`, `reference/mode-persuade.md`, `reference/critique.md` (apertura), `reference/shape.md` y `reference/component-review.md`; fuera de `skill/`, `README.md`, `AGENTS.md`, `LICENSE` y el registro de reglas `crates/foundation/src/registry.rs` (62 reglas).

No se leyeron las 41 referencias completas ni se ejecutó el engine: el detector, el hook, el modo *live*, las páginas de decisión y los subagentes no se probaron. Todo lo que sigue es lectura de texto, no evidencia de runtime.

## 2. El diagnóstico que se adopta

Impeccable y taste-skill v2 llegan al mismo sitio por caminos distintos: cuando se pide un aspecto sin más, el modelo devuelve el promedio de lo que ha visto. Las dos lo combaten con un mazo de direcciones; Impeccable añade, antes del mazo, tres frenos conductuales que no dependen de una librería:

1. **Derivar del mundo del público**: seis a ocho mundos concretos con diversidad de familia material, y la trampa de los instrumentos del oficio.
2. **Prohibirse la rut**: la pieza que la categoría siempre entrega y su opuesto predecible, las dos fuera; y el test de adivinación del aspecto (categoría, o categoría más su antídoto).
3. **Comprometerse sin diluir**: el primer build va entero; las pasadas siguientes aclaran y no rebajan.

Se adoptan los tres, más el primer fotograma como tesis con test de memoria, los tells de superficie y tipografía que faltaban, y la pasada con ojos frescos. El destino exacto está en el README de la skill (`2.1.1-draft`, con el ajuste posterior en `2.1.2-draft`) y en su changelog.

## 3. Qué se rechaza

- **Panel de dos subagentes obligatorio y puntuación heurística** (Nielsen 0-4, P0-P3): ya rechazado en [19](19-direccion-creativa-prototipos-y-critica.md) §1. La revisión con ojos frescos queda como opción, no como cadena.
- **Prohibiciones duras y cuotas** (sin eyebrow, sin mono, sin reglas finas, mínimo de imágenes): incompatible con la política de que un tell se justifica y la marca manda.
- **Motor, scripts, hook, telemetría y modo live**: la skill no debe exigir binario, instalar nada ni lanzar CLIs con aprobaciones desactivadas. El detector se usó solo como inventario de tells; no juzga si la idea pertenece al sujeto.
- **Símbolos cargados fuera de la decoración**: se consideró y se descartó por decisión del titular; los modelos ya lo rechazan y no es específico de dirección visual.
- **El mazo con script de taste-skill (`draw.mjs`) y su inspector**: resuelven el mismo problema, pero atan la skill a ejecutables y a una librería ajena. Se mantiene la derivación sin herramientas.

## 4. Límites de la evidencia

La lectura de octubre cubrió dos archivos; esta cubre diez, y sigue sin ejecución: versiones, comportamiento del detector y calidad del resultado no se verifican aquí. La ronda 5 del README de la skill evalúa un caso de propuesta con dos pases por versión y puntuación del propio agente; no certifica calidad artística ni sustituye la revisión humana.

## 5. Consecuencia para la skill

`visual-direction.md` gana la derivación, la rut y el compromiso; `good-design.md` gana el test de adivinación y los tells nuevos; `quality-bar.md` gana la pasada con ojos frescos. La primera evaluación mostró que dos de esas instrucciones se quedaban implícitas en la propuesta, así que `2.1.2-draft` pide nombrar la rut y su opuesto, y el coste de la dirección elegida.
