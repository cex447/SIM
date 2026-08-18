SIM+ BETA 3 COMPLETA

Subir TODO el contenido de este ZIP a la raíz del repositorio GitHub, sustituyendo la versión anterior.

IMPORTANTE:
- Conservar en la raíz los 3 archivos de fuente ya existentes:
  Canal+BoldItalic-Regular.otf
  Canal+MediumItalic-Regular.otf
  Canal+LightItalic-Regular.otf
- No se incluyen en el ZIP porque son archivos de fuente del usuario.

Beta 3:
- Toda la interfaz usa SIM Futura.
- Escala = aproximadamente 2x respecto a la primera beta.
- Modo claro/oscuro automático.
- PUV normaliza tanto IDs/UD crudos como campos ya decodificados.
- LIT usa el trip_id activo exacto y descarga trips.txt + stop_times.txt + stops.txt del GTFS vigente.
- Red BV completa incluida en data/network.json.
- Todos los pares de estaciones generan interestación.
- Los datos técnicos de pendiente/longitud solo se rellenan donde estaban consolidados; no se inventan valores desconocidos.
- Recorridos parciales funcionan de forma natural al venir de stop_times del trip_id real.
- Diagnóstico oculto: pulsación larga ~1 s sobre la esquina superior izquierda.
