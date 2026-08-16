SIM+ Beta 1

Objetivo
- Beta funcional para iPhone/desktop.
- PUV en vivo desde posicionament-dels-trens.
- LIT intenta construir el viaje real desde viajes-de-hoy, sin inventar itinerarios si el esquema no coincide.
- EMA deja preparada la interfaz.
- Diagnóstico oculto: pulsación larga (~1,2 s) sobre la esquina superior izquierda / SIM+.

Publicación
1. Sube el contenido de esta carpeta conservando las rutas.
2. En GitHub Pages, usa index.html como raíz.
3. No abras index.html directamente con file://: los módulos ES y fetch necesitan servidor web.

Diseño
- Futura/Futura PT si está instalada; fallback Century Gothic/Arial.
- Cabecera fija, hora HH:MM:SS.
- LIT/PUV/EMA fijos.
- Responsive vertical/horizontal.
- LIT: Futura Bold Italic estaciones; interestaciones en peso normal italic.
- PUV: ASCENDENTS/DESCENDENTS Helvetica Bold 16.

Limitaciones de esta beta
- No incluye audio EMA.
- No intenta deducir circuito de vía.
- La tabla técnica de interestaciones incluida es la parte recuperada con certeza; se ampliará con el inventario completo.
- La vía de estacionamiento no es requisito de Beta 1.
