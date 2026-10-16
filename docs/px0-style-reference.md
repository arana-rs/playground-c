# Referencia visual de px0

**Inspección:** 12 de octubre de 2026 · **px0:** 0.1.9 · **tema:** GitHub Dark (`data-theme="github-dark"`) · **viewport:** 1280 × 800.

Esta ficha registra el estilo observado en px0 para reutilizarlo más adelante en el editor y el visualizador de memoria. La inspección fue de solo lectura: `GET /static/style.css`, `GET /static/themes.css`, estilos computados y la vista en navegador. No es una hoja conectada al runtime.

## Rasgos observados

La interfaz es oscura y compacta. Mantiene superficies casi planas, separadores finos y radios pequeños; reserva el azul para selección, foco y acciones. El explorador lateral medía 340 px; su cabecera 36 px, cada fila del árbol 22 px y el pie 24 px.

| Elemento | Medida observada |
| --- | --- |
| Texto general | 13 px, line-height 19.5 px |
| Fila del árbol | alto 22 px; texto 12.5 px; gap 5 px; padding derecho 8 px |
| Cabecera de panel | alto 36 px; texto 11 px/600, mayúsculas, `letter-spacing: .07em`; padding `9px 12px 7px`; gap 6 px |
| Pestaña de archivo | alto 28 px; texto 11.5 px; padding `0 8px 0 10px`; separador derecho de 1 px |
| Pie/status | alto 24 px; padding horizontal 8 px; borde superior de 1 px |
| Botón mini | caja 20 × 20 px; SVG de 13 × 13 px |
| Iconos del selector de vista | SVG de 12 × 12 px; chevrón del árbol 12 × 12 px; marca de archivo 7 × 7 px |
| Radios | `--r: 2px`; `--r-lg: 4px` |
| Líneas | 1 px, `--line`; filas del árbol sin marco propio |

La UI declara una pila sans de sistema. El código usa la pila mono de JetBrains Mono, Fira Code, Cascadia Code, SF Mono, Menlo, Consolas y fuentes `ui-monospace`; el estilo computado expone la pila declarada, y la fuente disponible depende del sistema. Las filas de código usan `--fs: 13.5px`, `--lh: 21px` y tabulación de 4 espacios.

Hover de fila: `--bg3`; selección del árbol: `--sel`; línea actual del editor: `--cur`. Los iconos de acción son discretos. El foco visible de controles mini usa contorno de 1 px `--accent` con offset de 1 px. Las pestañas separan con una línea `--line`; la activa usa `--bg` y la inactiva pasa a `--bg3` al hover.

## Paleta y tokens observados

Las variables siguientes se leyeron de GitHub Dark. Se conserva la sintaxis hexadecimal y `rgba()` de px0.

```css
:root[data-theme="github-dark"] {
  color-scheme: dark;
  --theme-name: "GitHub Dark";

  /* Superficies y texto */
  --bg: #0d1117;
  --bg2: #010409;
  --bg3: #161b22;
  --bg4: #21262d;
  --fg: #e6edf3;
  --dim: #8b949e;
  --faint: #6e7681;
  --line: #30363d;

  /* Acento, selección y elevación */
  --accent: #1f6feb;
  --accent-fg: #58a6ff;
  --on-accent: #fff;
  --sel: rgba(56, 139, 253, 0.25);
  --cur: #161b22;
  --mark: rgba(187, 128, 9, 0.4);
  --mark-active: #d29922;
  --on-mark-active: #0d1117;
  --on-badge: #0d1117;
  --scrim: rgba(0, 0, 0, 0.45);
  --shadow: 0 4px 16px rgba(1, 4, 9, 0.85);
  --shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.28);

  /* Sintaxis */
  --k: #ff7b72;
  --kt: #ff7b72;
  --o: #ff7b72;
  --cp: #ff7b72;
  --nf: #d2a8ff;
  --nd: #d2a8ff;
  --nc: #ffa657;
  --nv: #ffa657;
  --nb: #79c0ff;
  --no: #79c0ff;
  --na: #79c0ff;
  --np: #79c0ff;
  --m: #79c0ff;
  --nt: #7ee787;
  --s: #a5d6ff;
  --p: #c9d1d9;
  --c: #8b949e;
  --err: #f85149;

  /* Estado Git */
  --gi: #3fb950;
  --gd: #f85149;
  --gi-bg: rgba(46, 160, 67, 0.15);
  --gd-bg: rgba(248, 81, 73, 0.15);
}

:root {
  --ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica,
    Arial, sans-serif;
  --mono: "JetBrains Mono", "Fira Code", "Cascadia Code", "SF Mono", Menlo,
    Consolas, ui-monospace, monospace;
  --r: 2px;
  --r-lg: 4px;
  --fs: 13.5px;
  --lh: 21px;
  --tab-size: 4;
}

/* Patrones visuales observados; los selectores son ilustrativos. */
.px0-row:hover { background: var(--bg3); }
.px0-row[aria-selected="true"] { background: var(--sel); }
.px0-control:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
}
```

## Aplicación futura al editor y a la memoria C

Lo siguiente es una **propuesta de adaptación**, no una descripción de widgets de px0 ni un cambio implementado. px0 aporta el lenguaje visual; no se observó en él un visualizador de regiones static, stack y heap.

- En el editor, usar `--ui` para chrome y `--mono` para código, direcciones y valores. Mantener la línea de código en 13.5/21 px, con pestañas de 28 px y cabeceras de panel de 36 px como referencias de densidad.
- En el viewer, conservar las regiones simultáneas y el orden STATIC → STACK → HEAP, con STATIC plegable y carriles independientes. Darles cabeceras discretas de 11 px en mayúsculas; presentar metadatos en texto atenuado y valores en mono; separar con `--line`, resaltar hover con `--bg3` y selección con `--sel`. Mantener foco visible y señales de estado además del color.
- Evitar marcos repetidos, sombras fuertes en cada objeto, fondos cuadriculados dominantes y áreas fijas grandes para cada valor. En el viewer actual las tarjetas miden 180 px de ancho, las celdas de valor 180 × 100 px y los carriles al menos 164 px de alto; esas medidas son del proyecto actual, no de px0, y son candidatas a compactar al aplicar esta dirección.

Contexto del proyecto revisado: editor y shell en `memory-viewer-vite/src/main.tsx:516+`; diálogo del viewer en `src/viewer/ValidatedSourceDialog.tsx:263-373`; regiones en `src/viewer/MemoryStackPanel.tsx:891-1033`; reglas visuales en `src/style.css`. La propuesta conserva sus controles, datos de memoria, orden y comportamiento existentes.
