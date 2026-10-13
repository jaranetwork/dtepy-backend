/**
 * Utilidades para manejo de fechas de emisión.
 *
 * SIFEN trabaja en hora local paraguaya (dFeEmiDE = yyyy-MM-ddTHH:mm:ss, sin
 * zona). Regla de esta utilidad:
 *
 *  - Un datetime SIN zona ("2026-08-31T09:00:00", con o sin fracción de
 *    segundos, como manda ERPNext o la tienda) se toma como hora local
 *    literal: sale al XML exactamente como llegó.
 *  - Un datetime CON zona ("...Z" o "...-03:00"), un Date o un timestamp se
 *    convierten a la hora de America/Asuncion.
 *  - Una fecha sola ("2026-08-31") se preserva.
 *
 * Nunca se pasa por `toISOString()`: eso devolvía la hora en UTC y, con el
 * contenedor en TZ=America/Asuncion, el XML salía con 3 horas de más (y una
 * emisión retroactiva de última hora caía al día siguiente).
 */

const ZONA_HORARIA_SIFEN = process.env.SIFEN_TIMEZONE || 'America/Asuncion';

const RE_FECHA_SOLA = /^\d{4}-\d{2}-\d{2}$/;
// yyyy-MM-dd[T ]HH:mm[:ss][.fracción] sin indicador de zona
const RE_DATETIME_SIN_ZONA = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?(?:\.(\d{1,9}))?$/;

/**
 * Hora de pared de `date` en la zona indicada, como "yyyy-MM-ddTHH:mm:ss".
 */
function horaLocal(date, zona = ZONA_HORARIA_SIFEN) {
  const partes = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: zona,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date).forEach(({ type, value }) => { partes[type] = value; });
  const hora = partes.hour === '24' ? '00' : partes.hour;
  return `${partes.year}-${partes.month}-${partes.day}T${hora}:${partes.minute}:${partes.second}`;
}

function armar(base, milisegundos, formatoSIFEN) {
  return formatoSIFEN ? base : `${base}.${milisegundos}`;
}

function desdeDate(date, formatoSIFEN, zona) {
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return armar(horaLocal(date, zona), ms, formatoSIFEN);
}

/**
 * Normaliza un datetime al formato que espera el resto del sistema.
 *
 * @param {string|number|Date} valor
 * @param {boolean} [formatoSIFEN=false]  true → "yyyy-MM-ddTHH:mm:ss" (xmlgen);
 *                                        false → "yyyy-MM-ddTHH:mm:ss.SSS" (hora local, sin Z)
 * @param {string} [zona]                 zona IANA para valores con zona/Date/timestamp
 * @returns {string}
 */
function normalizarDatetime(valor, formatoSIFEN = false, zona = ZONA_HORARIA_SIFEN) {
  if (valor === null || valor === undefined || valor === '') {
    return desdeDate(new Date(), formatoSIFEN, zona);
  }

  if (valor instanceof Date) {
    if (!Number.isNaN(valor.getTime())) return desdeDate(valor, formatoSIFEN, zona);
  } else if (typeof valor === 'number') {
    const date = new Date(valor);
    if (!Number.isNaN(date.getTime())) return desdeDate(date, formatoSIFEN, zona);
  } else if (typeof valor === 'string') {
    const texto = valor.trim();

    if (RE_FECHA_SOLA.test(texto)) return texto;

    const m = texto.match(RE_DATETIME_SIN_ZONA);
    if (m) {
      const base = `${m[1]}T${m[2]}${m[3] || ':00'}`;
      const ms = (m[4] || '').padEnd(3, '0').slice(0, 3);
      return armar(base, ms, formatoSIFEN);
    }

    const date = new Date(texto);
    if (!Number.isNaN(date.getTime())) return desdeDate(date, formatoSIFEN, zona);
  }

  console.warn(`⚠️ Fecha inválida: ${valor}`);
  return desdeDate(new Date(), formatoSIFEN, zona);
}

const CAMPOS_FECHA = ['fecha', 'fecha_nacimiento', 'fecha_emision', 'fecha_vencimiento', 'created', 'modified', 'fechaEnvio'];

function esValorFecha(value) {
  return typeof value === 'string' || typeof value === 'number' || value instanceof Date;
}

function recorrerFechas(obj, transformar) {
  if (!obj || typeof obj !== 'object') return obj;

  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (CAMPOS_FECHA.includes(key) && esValorFecha(value)) {
      obj[key] = transformar(value);
    } else if (value && typeof value === 'object') {
      recorrerFechas(value, transformar);
    }
  }

  return obj;
}

/**
 * Normaliza (en el lugar) todos los campos de fecha conocidos de un payload.
 * Preserva las fechas solas (yyyy-MM-dd).
 */
function normalizarFechasEnObjeto(obj) {
  return recorrerFechas(obj, (value) => normalizarDatetime(value));
}

/**
 * Fecha en formato SIFEN v150: yyyy-MM-dd se preserva; con hora devuelve
 * yyyy-MM-ddTHH:mm:ss (sin milisegundos ni zona).
 */
function formatoFechaSIFEN(fecha) {
  return normalizarDatetime(fecha, true);
}

/**
 * Convierte (en el lugar) todas las fechas conocidas de un objeto al formato
 * que acepta facturacionelectronicapy-xmlgen.
 */
function convertirFechasASIFEN(obj) {
  return recorrerFechas(obj, formatoFechaSIFEN);
}

function esFechaValida(fecha) {
  if (!fecha) return false;
  const date = new Date(fecha);
  return !Number.isNaN(date.getTime());
}

module.exports = {
  ZONA_HORARIA_SIFEN,
  horaLocal,
  normalizarDatetime,
  normalizarFechasEnObjeto,
  formatoFechaSIFEN,
  convertirFechasASIFEN,
  esFechaValida
};
