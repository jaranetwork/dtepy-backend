/**
 * Catálogo HARDCODEADO de proveedores de cotización.
 *
 * Agregar un proveedor = agregar una entrada acá. No hay forma de cargar una
 * URL arbitraria desde la UI ni desde la API: la empresa solo elige un `id` de
 * esta lista. Es deliberado — una URL configurable por el usuario sería un
 * SSRF y una vía para inyectar cotizaciones falsas en documentos fiscales.
 *
 * Cada proveedor declara:
 *   urls           orden de intento (la primera que responda válida gana)
 *   hostsPermitidos hosts aceptados, incluso después de redirecciones
 *   monedas        códigos ISO (del catálogo SIFEN) que publica
 *   parsear(json)  normaliza a { fecha: 'YYYY-MM-DD', valores: { USD: {compra, venta} } }
 */

const TIMEOUT_MS = 10000;
const TAMANIO_MAXIMO_BYTES = 256 * 1024;   // el feed real pesa ~300 bytes

// Rango absoluto de cordura, en guaraníes por unidad. Nada fuera de esto puede
// ser una cotización legítima (el JPY ronda 37 Gs; la GBP, 8.000 Gs).
const VALOR_MINIMO = 0.0001;
const VALOR_MAXIMO = 1000000;

const PROVEEDORES = {
  sistemaaguila: {
    id: 'sistemaaguila',
    nombre: 'Sistema Águila (cotizaciones SET)',
    descripcion:
      'Publica la cotización oficial de la SET/DNIT. El valor del día D se publica ' +
      'la tarde del propio día D (~17:00 PY) y es el que rige para facturar el día D+1. ' +
      'No publica sábados, domingos ni feriados: en esos casos sigue vigente la última.',
    // raw.githubusercontent primero: TTL de caché 5 min, acompaña el reintento
    // de 5 min. jsDelivr es respaldo — su s-maxage es de 12 h, así que por sí
    // solo serviría datos viejos durante medio día.
    urls: [
      'https://raw.githubusercontent.com/sistemasaguila/cotizaciones-set/main/data/latest.json',
      'https://cdn.jsdelivr.net/gh/sistemasaguila/cotizaciones-set@main/data/latest.json'
    ],
    hostsPermitidos: ['raw.githubusercontent.com', 'cdn.jsdelivr.net'],
    monedas: ['USD', 'BRL', 'ARS', 'JPY', 'EUR', 'GBP'],

    /**
     * Formato: { "2026-08-31": { "usd": {"purchase": 5892.65, "sale": 5912.9}, ... } }
     * Ojo: el feed llama "arp" al peso argentino; en el catálogo SIFEN es ARS.
     */
    parsear(json) {
      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        throw new Error('respuesta que no es un objeto JSON');
      }
      const fechas = Object.keys(json).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k));
      if (fechas.length !== 1) {
        throw new Error(`se esperaba exactamente una fecha en la raíz, llegaron ${fechas.length}`);
      }
      const fecha = fechas[0];
      const crudo = json[fecha];
      if (!crudo || typeof crudo !== 'object') {
        throw new Error(`la fecha ${fecha} no trae un objeto de monedas`);
      }

      const claveISO = { usd: 'USD', brl: 'BRL', arp: 'ARS', jpy: 'JPY', eur: 'EUR', gbp: 'GBP' };
      const valores = {};
      for (const [clave, par] of Object.entries(crudo)) {
        const iso = claveISO[String(clave).toLowerCase()];
        if (!iso || !par || typeof par !== 'object') continue;
        const compra = Number(par.purchase);
        const venta = Number(par.sale);
        if (!esValorRazonable(compra) || !esValorRazonable(venta)) continue;
        valores[iso] = { compra, venta };
      }
      if (Object.keys(valores).length === 0) {
        throw new Error(`la fecha ${fecha} no trae ninguna moneda con valores válidos`);
      }
      return { fecha, valores };
    }
  }
};

function esValorRazonable(valor) {
  return Number.isFinite(valor) && valor >= VALOR_MINIMO && valor <= VALOR_MAXIMO;
}

function listar() {
  return Object.values(PROVEEDORES).map((p) => ({
    id: p.id,
    nombre: p.nombre,
    descripcion: p.descripcion,
    monedas: p.monedas,
    fuente: p.urls[0]
  }));
}

function obtener(id) {
  return PROVEEDORES[String(id || '').toLowerCase()] || null;
}

function idsValidos() {
  return Object.keys(PROVEEDORES);
}

/**
 * Descarga y normaliza la cotización del proveedor. Recorre sus URLs en orden
 * hasta que una responda algo válido.
 *
 * Controles (esto termina en documentos fiscales firmados):
 *   - solo https y solo hosts de la lista blanca, revalidados tras redirección
 *   - timeout duro y tope de tamaño de respuesta
 *   - la estructura tiene que parsear exactamente; nada de valores por defecto
 *
 * @returns {Promise<{fecha: string, valores: object, url: string}>}
 */
async function descargar(proveedor) {
  const fallos = [];

  for (const url of proveedor.urls) {
    try {
      const destino = new URL(url);
      if (destino.protocol !== 'https:' || !proveedor.hostsPermitidos.includes(destino.hostname)) {
        throw new Error('URL fuera de la lista blanca del proveedor');
      }

      const respuesta = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'dtepy-cotizaciones/1.0' },
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });

      // Una redirección pudo sacarnos del host permitido
      const hostFinal = new URL(respuesta.url).hostname;
      if (!proveedor.hostsPermitidos.includes(hostFinal)) {
        throw new Error(`redirección a un host no permitido: ${hostFinal}`);
      }
      if (!respuesta.ok) {
        throw new Error(`HTTP ${respuesta.status}`);
      }

      const texto = await respuesta.text();
      if (texto.length > TAMANIO_MAXIMO_BYTES) {
        throw new Error(`respuesta demasiado grande (${texto.length} bytes)`);
      }

      let json;
      try {
        json = JSON.parse(texto);
      } catch (err) {
        throw new Error('la respuesta no es JSON válido');
      }

      const { fecha, valores } = proveedor.parsear(json);
      return { fecha, valores, url };
    } catch (err) {
      fallos.push(`${new URL(url).hostname}: ${String(err.message).slice(0, 120)}`);
    }
  }

  const error = new Error(`No se pudo obtener la cotización de ${proveedor.nombre} — ${fallos.join(' | ')}`);
  error.errorCode = 'PROVEEDOR_NO_DISPONIBLE';
  throw error;
}

module.exports = {
  listar,
  obtener,
  idsValidos,
  descargar,
  esValorRazonable,
  VALOR_MINIMO,
  VALOR_MAXIMO
};
