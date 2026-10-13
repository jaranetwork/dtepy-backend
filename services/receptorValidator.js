/**
 * Validación y normalización del receptor (data.cliente) ANTES de xmlgen.
 *
 * Replica las reglas del receptor de SIFEN (MT v150 + NT 2/10/20/21/23/24 —
 * ver docs/fiscal/02-reglas-receptor-sifen.md) para rechazar en el request lo
 * que SIFEN rechazaría después de firmar, y para que jamás se firme un XML
 * con `"undefined"`, un DV inventado o un país fuera de regla.
 *
 * Puro: sin I/O. Devuelve { errores, advertencias, cliente } donde `cliente`
 * es la versión normalizada (trims, mayúsculas en documentos, DV recalculado,
 * defaults seguros, campos prohibidos removidos). Cada error lleva el código
 * de validación SIFEN que lo habría rechazado, para que el integrador corrija
 * contra el manual y no contra un mensaje inventado.
 *
 * Lo que NO se valida acá (necesita el padrón): existencia del RUC en
 * Marangatú (1306), estado activo (1307/1308) y OEE→B2G (1332). Para eso está
 * GET /api/consulta/ruc/:ruc antes de emitir.
 */

const TIPOS_DOCUMENTO = new Set([1, 2, 3, 4, 5, 6, 9]);
const TIPOS_OPERACION = new Set([1, 2, 3, 4]);

// Umbral de innominado vigente (Decreto 872/2023 art. 6 + NT 24, desde
// 01/01/2025): operación ≥ 7.000.000 Gs debe identificar al receptor.
const INNOMINADO_MAX_PYG = 7000000;

/** Dígito verificador módulo 11 de la SET (mismo algoritmo del padrón). */
function calcularDv(base) {
  const digits = String(base || '').replace(/\D/g, '');
  if (!digits) return null;
  let k = 2;
  let sum = 0;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += Number(digits[i]) * k;
    k = k === 11 ? 2 : k + 1;
  }
  const mod = sum % 11;
  return mod > 1 ? 11 - mod : 0;
}

/** Limpieza de números de documento: SIFEN rechaza '.', '/' y espacios. */
function limpiarDocumento(raw) {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[.\s/\\-]/g, '')
    .trim();
}

/** Total de la operación en guaraníes (aproximado, para la regla 1321). */
function totalEnGuaranies(data) {
  const items = Array.isArray(data.items) ? data.items : [];
  let total = 0;
  for (const it of items) {
    const precio = Number(it?.precioUnitario ?? 0);
    const cantidad = Number(it?.cantidad ?? 0);
    if (Number.isFinite(precio) && Number.isFinite(cantidad)) {
      total += precio * cantidad;
    }
  }
  total -= Number(data.descuentoGlobal ?? 0) || 0;
  const moneda = String(data.moneda || 'PYG').toUpperCase();
  if (moneda === 'PYG') return total;
  const cambio = Number(data.cambio ?? 0);
  return cambio > 0 ? total * cambio : null; // null = no determinable
}

/**
 * @param {object} data - el `data` del payload de emisión (con cliente/items).
 * @returns {{ errores: Array<{codigo:string, regla:string|null, mensaje:string}>,
 *            advertencias: string[], cliente: object|null }}
 */
function validarReceptor(data) {
  const errores = [];
  const advertencias = [];
  const err = (codigo, regla, mensaje) => errores.push({ codigo, regla, mensaje });

  const original = data?.cliente;
  if (!original || typeof original !== 'object') {
    err('RECEPTOR_REQUERIDO', null, 'data.cliente es requerido');
    return { errores, advertencias, cliente: null };
  }

  const c = { ...original };

  // ── Naturaleza y tipo de operación ─────────────────────────────────
  if (typeof c.contribuyente !== 'boolean') {
    err('RECEPTOR_CONTRIBUYENTE_REQUERIDO', null,
      'cliente.contribuyente debe ser true (con RUC) o false (con documento de identidad)');
    return { errores, advertencias, cliente: c };
  }

  let tipoOperacion = Number(c.tipoOperacion);
  if (!TIPOS_OPERACION.has(tipoOperacion)) {
    tipoOperacion = c.contribuyente ? 1 : 2;
    advertencias.push(`tipoOperacion ausente o inválido: se asume ${tipoOperacion} (${c.contribuyente ? 'B2B' : 'B2C'})`);
  }
  // Regla 1300 (NT 10): no contribuyente → solo B2C o B2F.
  if (!c.contribuyente && tipoOperacion !== 2 && tipoOperacion !== 4) {
    err('RECEPTOR_OPERACION_INCOMPATIBLE', '1300',
      'Con receptor no contribuyente el tipo de operación debe ser B2C (2) o B2F (4)');
  }
  if (c.contribuyente && tipoOperacion === 4) {
    err('RECEPTOR_OPERACION_INCOMPATIBLE', '1300',
      'B2F (4) exige receptor no contribuyente');
  }
  c.tipoOperacion = tipoOperacion;
  const esB2F = tipoOperacion === 4;

  // ── País (regla 1320) ──────────────────────────────────────────────
  const pais = String(c.pais || '').toUpperCase().trim();
  if (esB2F) {
    if (!pais || pais === 'PRY') {
      err('RECEPTOR_PAIS_INVALIDO', '1320',
        'B2F exige el país real del receptor, distinto de PRY (ej: BRA, USA)');
    } else {
      c.pais = pais;
    }
  } else {
    if (!pais) {
      c.pais = 'PRY';
      advertencias.push('cliente.pais ausente: se asume PRY (obligatorio salvo B2F)');
    } else if (pais !== 'PRY') {
      err('RECEPTOR_PAIS_INVALIDO', '1320',
        `Para operaciones que no son B2F el país del receptor debe ser PRY (recibido: ${pais}). El país real del cliente va en data.observacion`);
    } else {
      c.pais = 'PRY';
    }
  }

  // ── Contribuyente: RUC + DV + tipoContribuyente ───────────────────
  if (c.contribuyente) {
    const rucRaw = String(c.ruc ?? '').trim();
    if (!rucRaw) {
      err('RECEPTOR_RUC_REQUERIDO', '1304', 'Receptor contribuyente sin cliente.ruc');
    } else {
      const [basePart, dvPart] = rucRaw.replace(/[^\dkK-]/g, '').split('-');
      const base = String(basePart || '').replace(/\D/g, '');
      const dvEsperado = calcularDv(base);
      if (base.length < 3 || base.length > 8 || dvEsperado === null) {
        err('RECEPTOR_RUC_INVALIDO', '1304', `RUC receptor inválido: "${rucRaw}" (base de 3 a 8 dígitos + guión + DV)`);
      } else if (dvPart !== undefined && dvPart !== '' && Number(dvPart) !== dvEsperado) {
        err('RECEPTOR_RUC_DV_INVALIDO', '1309',
          `Dígito verificador incorrecto para RUC ${base}: recibido ${dvPart}, módulo 11 = ${dvEsperado}`);
      } else {
        // DV siempre recalculado: nunca se firma el que mandó el integrador.
        c.ruc = `${base}-${dvEsperado}`;
      }
    }
    const tipoContribuyente = Number(c.tipoContribuyente);
    if (tipoContribuyente !== 1 && tipoContribuyente !== 2) {
      err('RECEPTOR_TIPO_CONTRIBUYENTE_REQUERIDO', '1302',
        'Receptor contribuyente exige tipoContribuyente: 1 (persona física) o 2 (jurídica)');
    }
    // Reglas 1311/1334: contribuyente jamás lleva documento de identidad.
    if (c.documentoTipo !== undefined || c.documentoNumero !== undefined) {
      delete c.documentoTipo;
      delete c.documentoNumero;
      delete c.documentoTipoDescripcion;
      advertencias.push('documentoTipo/documentoNumero removidos: un contribuyente se identifica solo por RUC (reglas 1311/1334)');
    }
  }

  // ── No contribuyente: documento de identidad ──────────────────────
  if (!c.contribuyente) {
    // Regla 1305: jamás RUC en no contribuyente.
    if (c.ruc !== undefined) {
      delete c.ruc;
      delete c.tipoContribuyente;
      advertencias.push('cliente.ruc removido: receptor no contribuyente no lleva RUC (regla 1305)');
    }
    const documentoTipo = Number(c.documentoTipo);
    const tieneTipo = TIPOS_DOCUMENTO.has(documentoTipo);
    if (!tieneTipo && !esB2F) {
      err('RECEPTOR_DOCUMENTO_TIPO_REQUERIDO', '1310',
        'Receptor no contribuyente exige documentoTipo: 1 CI py, 2 pasaporte, 3 cédula extranjera, 4 carnet residencia, 5 innominado, 6 tarjeta diplomática, 9 otro');
    }
    if (tieneTipo) {
      c.documentoTipo = documentoTipo;

      if (documentoTipo === 5) {
        // Innominado: forma fija + solo B2C + tope de monto (Decreto 872/23).
        c.documentoNumero = '0';
        c.razonSocial = 'Sin Nombre';
        if (tipoOperacion !== 2) {
          err('RECEPTOR_INNOMINADO_OPERACION', '1333', 'Innominado (documentoTipo 5) solo se permite en B2C');
        }
        const totalGs = totalEnGuaranies(data);
        if (totalGs === null) {
          advertencias.push('No se pudo verificar el tope de innominado (falta data.cambio para convertir a Gs)');
        } else if (totalGs >= INNOMINADO_MAX_PYG) {
          err('RECEPTOR_INNOMINADO_MONTO', '1321',
            `Operación de ${Math.round(totalGs).toLocaleString('es-PY')} Gs: desde el 01/01/2025 toda operación >= ${INNOMINADO_MAX_PYG.toLocaleString('es-PY')} Gs debe identificar al receptor (Decreto 872/2023)`);
        }
      } else {
        const numero = limpiarDocumento(c.documentoNumero);
        if (!numero) {
          err('RECEPTOR_DOCUMENTO_NUMERO_REQUERIDO', '1314',
            'Receptor no contribuyente exige documentoNumero');
        } else if (numero.length > 20) {
          err('RECEPTOR_DOCUMENTO_NUMERO_INVALIDO', null,
            'documentoNumero admite hasta 20 caracteres');
        } else {
          if (numero !== String(c.documentoNumero ?? '')) {
            advertencias.push(`documentoNumero normalizado a "${numero}" (mayúsculas, sin puntos/guiones/espacios)`);
          }
          c.documentoNumero = numero;
        }
        if (documentoTipo === 2 && numero && !/^[A-Z0-9]{5,15}$/.test(numero)) {
          err('RECEPTOR_PASAPORTE_FORMATO', null,
            `Pasaporte "${numero}" fuera de formato: solo letras y números, de 5 a 15 caracteres`);
        }
        if (documentoTipo === 9 && !String(c.documentoTipoDescripcion ?? '').trim()) {
          err('RECEPTOR_DOCUMENTO_DESCRIPCION_REQUERIDA', '1312',
            'documentoTipo 9 (otro) exige documentoTipoDescripcion (ej: "CNPJ", "Tax ID")');
        }
      }
    } else if (esB2F && c.documentoNumero !== undefined) {
      // NT 23: en B2F el documento es opcional pero, si viene, va limpio.
      c.documentoNumero = limpiarDocumento(c.documentoNumero);
    }
  }

  // ── Nombre / razón social (dNomRec 4-255, siempre) ────────────────
  const razonSocial = String(c.razonSocial ?? '').replace(/\s+/g, ' ').trim();
  if (razonSocial.length < 4 || razonSocial.length > 255) {
    err('RECEPTOR_RAZON_SOCIAL_INVALIDA', null,
      'cliente.razonSocial es obligatoria, de 4 a 255 caracteres');
  } else {
    c.razonSocial = razonSocial;
  }

  // ── Dirección ─────────────────────────────────────────────────────
  const direccion = String(c.direccion ?? '').trim();
  if (esB2F) {
    if (!direccion) {
      err('RECEPTOR_DIRECCION_REQUERIDA', '1318', 'B2F exige la dirección del receptor en el exterior');
    }
    // En B2F no se informan departamento/distrito/ciudad (campos D219/D221/D223).
    for (const campo of ['departamento', 'distrito', 'ciudad']) {
      if (c[campo] !== undefined) {
        delete c[campo];
        advertencias.push(`cliente.${campo} removido: no se informa en B2F`);
      }
    }
  }
  if (direccion && (c.numeroCasa === undefined || String(c.numeroCasa).trim() === '')) {
    err('RECEPTOR_NUMERO_CASA_REQUERIDO', '1330',
      'Si se informa la dirección del receptor, numeroCasa es obligatorio (usar "0" si no tiene)');
  }

  // ── Contacto (largos del manual; fuera de rango se omiten) ────────
  if (c.email !== undefined) {
    const email = String(c.email).trim();
    if (email.length < 3 || email.length > 80 || !email.includes('@')) {
      delete c.email;
      advertencias.push('cliente.email fuera de formato (3-80, con @): se omite del DTE');
    } else {
      c.email = email;
    }
  }
  if (c.celular !== undefined) {
    const cel = String(c.celular).replace(/[^\d+]/g, '');
    if (cel.length < 10 || cel.length > 20) {
      delete c.celular;
      advertencias.push('cliente.celular fuera de largo (10-20): se omite del DTE');
    } else {
      c.celular = cel;
    }
  }
  if (c.telefono !== undefined) {
    const tel = String(c.telefono).replace(/[^\d+]/g, '');
    if (tel.length < 6 || tel.length > 15) {
      delete c.telefono;
      advertencias.push('cliente.telefono fuera de largo (6-15): se omite del DTE');
    } else {
      c.telefono = tel;
    }
  }

  return { errores, advertencias, cliente: c };
}

module.exports = { validarReceptor, calcularDv, limpiarDocumento, INNOMINADO_MAX_PYG };
