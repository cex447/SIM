/** Referencia de integración TORNS. No importa ni escribe datos de ciclos. */
export function normalizarServicio(valor) {
  if (!/^\d{1,3}$/.test(String(valor))) throw new Error('Código de servicio inválido');
  return Math.floor(Number(valor) / 100) * 100;
}

const copiar = valor => JSON.parse(JSON.stringify(valor));
const hoyMadrid = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date());

function vigenciaGeneral(circular, fecha) {
  if (!circular.aplicacion.usar_vigencia_documental) return true;
  const { desde, hasta } = circular.vigencia_documental;
  return (!desde || fecha >= desde) && (!hasta || fecha < hasta);
}

function correspondeServicio(indicado, calendario, familia) {
  return indicado % 100 === 0 ? indicado === familia : indicado === calendario;
}

function aplicaOperacion(circular, operacion, calendario, familia, fecha) {
  if (!correspondeServicio(operacion.servicio, calendario, familia)) return false;
  const condiciones = operacion.condiciones || {};
  if (condiciones.fechas?.length) {
    if (!condiciones.fechas.includes(fecha)) return false;
    if (condiciones.fechas_explicitas_prevalecen_sobre_inicio_general) return true;
  }
  return vigenciaGeneral(circular, fecha);
}

/** Reconstruye desde el máster en cada consulta; retirar una circular revierte su efecto. */
export function resolverTurnos(master, circulares = [], opciones = {}) {
  if (master.formato !== 'simplus.torns' || master.tipo !== 'master') throw new Error('Máster incompatible');
  const calendario = Number(opciones.servicio ?? 0);
  const familia = normalizarServicio(opciones.servicio ?? 0);
  const fecha = opciones.fecha ?? hoyMadrid();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error('La fecha debe usar AAAA-MM-DD');
  const bloque = master.servicios[String(familia).padStart(3, '0')];
  if (!bloque) throw new Error(`Servicio ${familia} no disponible en el máster`);
  const turnos = new Map(bloque.turnos.map(t => [t.codigo, copiar(t)]));
  const ordenadas = [...circulares].sort((a, b) => a.prioridad - b.prioridad || a.documento.localeCompare(b.documento));
  const aplicadas = [], personal = new Map(), sustituciones = [];
  const prioridades = new Map();
  for (const circular of ordenadas) {
    if (circular.formato !== master.formato || circular.tipo !== 'modificaciones' || circular.master_documento !== master.documento) throw new Error('Circular incompatible con el máster');
    let usada = false;
    for (const operacion of circular.operaciones) {
      if (!aplicaOperacion(circular, operacion, calendario, familia, fecha)) continue;
      const anterior = prioridades.get(operacion.codigo);
      if (anterior && anterior.prioridad === circular.prioridad && anterior.documento !== circular.documento) {
        throw new Error(`Prioridad ambigua para ${operacion.codigo}: ${anterior.documento} / ${circular.documento}`);
      }
      if (operacion.accion === 'suprimir') turnos.delete(operacion.codigo);
      else if (operacion.accion === 'crear_o_sustituir') {
        const turno = copiar(operacion.turno);
        if (turno.codigo !== operacion.codigo || turno.servicio !== familia) throw new Error('Clave de turno incoherente');
        turno.circular_aplicada = circular.documento;
        turno.operacion_aplicada = operacion.id;
        turnos.set(turno.codigo, turno);
      } else throw new Error(`Acción desconocida: ${operacion.accion}`);
      if (anterior) sustituciones.push({ codigo: operacion.codigo, anterior: anterior.documento, vigente: circular.documento });
      prioridades.set(operacion.codigo, { prioridad: circular.prioridad, documento: circular.documento });
      usada = true;
    }
    if (vigenciaGeneral(circular, fecha)) {
      for (const t of circular.turnos_otro_personal || []) {
        if (correspondeServicio(t.servicio, calendario, familia)) {
          personal.set(t.codigo, { ...copiar(t), circular_aplicada: circular.documento });
          usada = true;
        }
      }
    }
    if (usada) aplicadas.push(circular.documento);
  }
  return {
    servicio_calendario: calendario, servicio_base: familia, fecha,
    turnos: [...turnos.values()].sort((a, b) => a.minuto_inicio - b.minuto_inicio || a.codigo.localeCompare(b.codigo)),
    turnos_otro_personal: [...personal.values()], circulares_aplicadas: aplicadas, sustituciones
  };
}

/** Distingue conducción, acompañamiento y viaje como pasajero. */
export function buscarCirculacion(estado, codigo) {
  return estado.turnos.flatMap(t => t.contenido.filter(a => a.circulacion === codigo).map(a => ({ turno: t.codigo, base: t.base, ...copiar(a) })));
}

/** Solo señala conducción simultánea; los relevos contiguos son válidos. */
export function detectarConflictosConduccion(estado) {
  const porCodigo = new Map(), conflictos = [];
  for (const t of estado.turnos) for (const a of t.contenido) {
    if (!a.circulacion || a.rol !== 'conductor') continue;
    if (!porCodigo.has(a.circulacion)) porCodigo.set(a.circulacion, []);
    porCodigo.get(a.circulacion).push({ turno: t.codigo, actividad: a });
  }
  for (const [circulacion, filas] of porCodigo) {
    for (let i = 0; i < filas.length; i++) for (let j = i + 1; j < filas.length; j++) {
      const a = filas[i], b = filas[j];
      if (a.turno === b.turno) continue;
      const inicio = Math.max(a.actividad.minuto_salida, b.actividad.minuto_salida);
      const fin = Math.min(a.actividad.minuto_llegada, b.actividad.minuto_llegada);
      if (fin > inicio) conflictos.push({ circulacion, turnos: [a.turno, b.turno], minuto_inicio: inicio, minuto_fin: fin });
    }
  }
  return conflictos;
}

/** Los nombres pueden proceder del índice suministrado o de un listado del servidor. */
export async function cargarTurnos({ baseUrl = '', indice = 'indice-turnos.json', servicio = 0, fecha, fetchImpl = globalThis.fetch } = {}) {
  const url = archivo => `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(archivo)}`;
  const respuestaIndice = await fetchImpl(url(indice), { cache: 'no-store' });
  if (!respuestaIndice.ok) throw new Error('No se puede leer el índice de turnos');
  const lista = await respuestaIndice.json();
  const respuestaMaster = await fetchImpl(url(lista.master), { cache: 'no-store' });
  if (!respuestaMaster.ok) throw new Error('No se puede leer el máster');
  const master = await respuestaMaster.json(), circulares = [];
  for (const archivo of lista.modificaciones) {
    const respuesta = await fetchImpl(url(archivo), { cache: 'no-store' });
    if (respuesta.status === 404) continue; // Circular retirada: se omite al reconstruir.
    if (!respuesta.ok) throw new Error(`No se puede leer la circular ${archivo}`);
    circulares.push(await respuesta.json());
  }
  return resolverTurnos(master, circulares, { servicio, fecha });
}
