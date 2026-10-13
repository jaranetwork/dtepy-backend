const crypto = require('crypto');
const Invoice = require('../models/Invoice');
const OperationLog = require('../models/OperationLog');
const SecuenciaFactura = require('../models/SecuenciaFactura');
const { facturaQueue, kudeQueue } = require('../queues/facturaQueue');
const { normalizarFechasEnObjeto } = require('../utils/fechaUtils');
const { buscarEmpresaPorRUC, validarEmpresaActiva, validarCertificadoValido } = require('./empresaService');
const { validarReceptor } = require('./receptorValidator');
const { evaluarPlazoEmision } = require('../utils/plazosSifen');
const { ESTADOS_NUNCA_EN_SET } = require('./numeracionService');

const tiposDocumentoMap = {
  1: 'Factura electrónica',
  2: 'Factura electrónica de exportación',
  3: 'Factura electrónica de importación',
  4: 'Autofactura electrónica',
  5: 'Nota de crédito electrónica',
  6: 'Nota de débito electrónica',
  7: 'Nota de remisión electrónica',
  8: 'Comprobante de retención electrónico'
};

function construirCorrelativo(datosFactura) {
  const data = datosFactura.data || datosFactura;
  const establecimiento = String(data.establecimiento || '001').padStart(3, '0');
  const punto = String(data.punto || '001').padStart(3, '0');
  const numero = String(data.numero || '0000001').padStart(7, '0');
  return `${establecimiento}-${punto}-${numero}`;
}

/**
 * Identidad fiscal del documento: emisor + tipo de DE + timbrado + correlativo
 * (establecimiento-punto-número). Es lo que hace único a un documento ante SET.
 *
 * Antes se hasheaba `ruc|codigoSeguridadAleatorio|numero`: el CSA recién se
 * genera en el worker, así que acá llegaba `undefined`, y dos documentos
 * distintos con el mismo número (la FE 001-002-0000001 y la NC 001-001-0000001)
 * daban el mismo hash. El segundo entraba por la rama de "reintento" y PISABA
 * el registro del primero (visto en producción el 2026-09-02).
 */
function generarFacturaHash(datosFactura, empresa) {
  const data = datosFactura.data || datosFactura;
  const ruc = datosFactura.param?.ruc || empresa?.ruc || datosFactura.ruc;
  const tipoDocumento = Number(data.tipoDocumento || datosFactura.tipoDocumento || 1);
  const timbrado = String(datosFactura.param?.timbradoNumero || data.timbrado || empresa?.configuracionSifen?.timbrado || '');
  const cadena = `${ruc}|${tipoDocumento}|${timbrado}|${construirCorrelativo(datosFactura)}`;
  return crypto.createHash('sha256').update(cadena).digest('hex');
}

// Estados en los que el documento EXISTE (o existió) en SET: nunca se reutiliza
// el registro ni el número. 'cancelado' incluido: una FE cancelada sigue siendo
// un documento emitido; lo que corresponde es emitir con otro número.
const ESTADOS_FINALES_EN_SET = ['aceptado', 'observado', 'cancelado'];

// ── Idempotency-Key ──────────────────────────────────────────────────
// Si la respuesta de /crear se pierde (timeout de red), el reintento de la
// integración creaba OTRA factura con otro número. Con el header estándar
// `Idempotency-Key`, una repetición devuelve la factura que ya existe.
const LARGO_MAXIMO_CLAVE_IDEMPOTENCIA = 200;
// Una factura en uno de estos estados ya no retiene su clave y se emite de
// nuevo: el documento no existe en SET o fue anulado (una venta cuya factura
// se canceló se vuelve a facturar con la misma clave).
const ESTADOS_CLAVE_LIBERADA = [...ESTADOS_NUNCA_EN_SET, 'cancelado'];

/**
 * Normaliza el valor del header Idempotency-Key: recorta espacios; vacío o
 * ausente → null (se ignora). Más de 200 caracteres → 400, sin recortar:
 * truncarla podría hacer coincidir dos claves distintas.
 */
function normalizarClaveIdempotencia(valor) {
  if (valor === undefined || valor === null) return null;
  const clave = String(valor).trim();
  if (!clave) return null;
  if (clave.length > LARGO_MAXIMO_CLAVE_IDEMPOTENCIA) {
    throw Object.assign(
      new Error(`El header Idempotency-Key admite hasta ${LARGO_MAXIMO_CLAVE_IDEMPOTENCIA} caracteres (llegaron ${clave.length})`),
      { statusCode: 400, errorCode: 'IDEMPOTENCY_KEY_INVALIDA' }
    );
  }
  return clave;
}

/**
 * La factura más reciente de la empresa con esa clave que todavía la retiene
 * (no rechazada, en error ni cancelada). Se filtra por estado en la consulta
 * y no mirando solo la última: si una vieja volvió a estar vigente (reintento
 * desde el panel) mientras la nueva se rechazaba, la clave sigue tomada y no
 * se emite un duplicado.
 */
function buscarVigentePorClave(empresaId, claveIdempotencia) {
  return Invoice.findOne({ empresaId, claveIdempotencia, estadoSifen: { $nin: ESTADOS_CLAVE_LIBERADA } })
    .sort({ createdAt: -1, _id: -1 })
    .select('correlativo estadoSifen proceso cdc');
}

function snapshotCliente(cliente, validacionReceptor) {
  return {
    // `ruc` conserva el fallback histórico porque la búsqueda del listado
    // (routes/invoices.js) filtra por este campo; los campos siguientes son
    // el snapshot fiel para auditoría.
    ruc: cliente.ruc || cliente.documentoNumero || 'N/A',
    nombre: cliente.razonSocial || cliente.nombreFantasia || cliente.nombre || 'N/A',
    razonSocial: cliente.razonSocial,
    nombreFantasia: cliente.nombreFantasia,
    contribuyente: cliente.contribuyente,
    tipoOperacion: cliente.tipoOperacion,
    pais: cliente.pais,
    tipoContribuyente: cliente.tipoContribuyente,
    direccion: cliente.direccion,
    telefono: cliente.telefono,
    email: cliente.email,
    documentoTipo: cliente.documentoTipo,
    documentoNumero: cliente.documentoNumero,
    // Resultado de la validación pre-SIFEN al momento de emitir (auditoría).
    validacionReceptor
  };
}

/**
 * El establecimiento y el punto de expedición tienen que ser de los que la
 * empresa tiene registrados: cada rango de numeración pertenece a un emisor
 * concreto y meterse en uno ajeno (por ejemplo el 001-001 que usa otro sistema
 * de la misma empresa) genera documentos con numeración pisada ante SET.
 *
 * El default de la empresa siempre pasa. Para habilitar puntos adicionales se
 * cargan en configuracionSifen.puntosExpedicion.
 */
function validarPuntoHabilitado(empresa, data) {
  const config = empresa.configuracionSifen || {};
  const establecimiento = String(data.establecimiento).padStart(3, '0');
  const punto = String(data.punto).padStart(3, '0');

  const establecimientosOk = new Set(
    [config.establecimiento, ...(empresa.establecimientos || []).map(e => e.codigo)]
      .filter(Boolean)
      .map(codigo => String(codigo).padStart(3, '0'))
  );
  if (establecimientosOk.size > 0 && !establecimientosOk.has(establecimiento)) {
    throw Object.assign(
      new Error(`Establecimiento ${establecimiento} no registrado para ${empresa.ruc}. Habilitados: ${[...establecimientosOk].join(', ')}`),
      { statusCode: 400, errorCode: 'ESTABLECIMIENTO_NO_HABILITADO', detalles: { establecimiento, habilitados: [...establecimientosOk] } }
    );
  }

  const puntosOk = new Set(
    [config.puntoExpedicion, ...(config.puntosExpedicion || [])]
      .filter(Boolean)
      .map(codigo => String(codigo).padStart(3, '0'))
  );
  if (puntosOk.size > 0 && !puntosOk.has(punto)) {
    throw Object.assign(
      new Error(`Punto de expedición ${punto} no habilitado para ${empresa.ruc}. Habilitados: ${[...puntosOk].join(', ')} (se configuran en configuracionSifen.puntoExpedicion / puntosExpedicion)`),
      { statusCode: 400, errorCode: 'PUNTO_NO_HABILITADO', detalles: { punto, habilitados: [...puntosOk] } }
    );
  }

  data.establecimiento = establecimiento;
  data.punto = punto;
}

/**
 * Asigna el siguiente número correlativo (7 dígitos) para la secuencia
 * timbrado + tipo de documento + establecimiento + punto de la empresa.
 *
 * El contador es atómico ($inc), así que emisiones concurrentes reciben
 * números distintos. Los números que una integración ya usó mandando
 * data.numero explícito se saltan (el contador avanza hasta uno libre).
 */
async function asignarNumeroCorrelativo(empresa, datosFactura) {
  const data = datosFactura.data || datosFactura;
  const clave = {
    empresaId: empresa._id,
    timbrado: String(datosFactura.param?.timbradoNumero || empresa.configuracionSifen?.timbrado || ''),
    tipoDocumento: Number(data.tipoDocumento || datosFactura.tipoDocumento || 1),
    establecimiento: String(data.establecimiento || '001').padStart(3, '0'),
    punto: String(data.punto || '001').padStart(3, '0')
  };
  const deDescripcion = tiposDocumentoMap[clave.tipoDocumento] || 'Factura electrónica';

  for (let intento = 0; intento < 200; intento++) {
    let secuencia;
    try {
      secuencia = await SecuenciaFactura.findOneAndUpdate(
        clave,
        { $inc: { ultimoNumero: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } catch (error) {
      // E11000: dos requests crearon la secuencia a la vez; reintentar toma
      // el documento ya insertado.
      if (error.code === 11000) continue;
      throw error;
    }

    if (secuencia.ultimoNumero > 9999999) {
      throw Object.assign(new Error(`Numeración agotada para ${clave.establecimiento}-${clave.punto} (timbrado ${clave.timbrado}): se llegó al 9999999`), {
        statusCode: 409, errorCode: 'NUMERACION_AGOTADA'
      });
    }

    const numero = String(secuencia.ultimoNumero).padStart(7, '0');
    const correlativo = `${clave.establecimiento}-${clave.punto}-${numero}`;
    // Un documento rechazado o con error no existe en SET: su número está
    // libre y el registro se reutiliza más abajo por hash.
    const ocupado = await Invoice.exists({
      empresaId: empresa._id,
      correlativo,
      de: deDescripcion,
      estadoSifen: { $nin: ESTADOS_NUNCA_EN_SET }
    });
    if (!ocupado) return numero;
  }

  throw Object.assign(new Error('No se pudo asignar un número correlativo libre'), {
    statusCode: 500, errorCode: 'NUMERACION_SIN_LIBRES'
  });
}

/**
 * Total provisorio del documento, para listados, estadísticas y el webhook
 * hasta que se genera el XML (procesarFacturaService lo reemplaza por el
 * dTotGralOpe real). Si el total sale de los ítems, el descuento y el
 * anticipo globales se restan: xmlgen los reparte entre los ítems y el
 * documento factura el neto.
 */
function calcularTotal(datosFactura) {
  const data = datosFactura.data || datosFactura;
  const totalInformado = data.totalPago || data.total || datosFactura.totalPago || datosFactura.total;
  if (totalInformado) return totalInformado;

  const totalItems = data.items?.reduce((sum, item) => sum + (item.precioTotal || item.precioUnitario * item.cantidad || 0), 0) || 0;
  return totalItems - (Number(data.descuentoGlobal) || 0) - (Number(data.anticipoGlobal) || 0);
}

async function encolarFactura(facturaId, datosFactura, empresaId) {
  return facturaQueue.add('generar-factura', {
    facturaId: facturaId.toString(),
    datosFactura,
    empresaId: empresaId.toString()
  }, {
    priority: 0,
    removeOnComplete: true,
    timeout: 300000
  });
}

async function encolarKUDE(facturaId, xmlPath, cdc, correlativo, fechaCreacion, datosFactura, empresaId) {
  return kudeQueue.add('generar-kude', {
    facturaId: facturaId.toString(),
    xmlPath,
    cdc,
    correlativo,
    fechaCreacion,
    datosFactura,
    empresaId: empresaId?.toString()
  }, { priority: 1 });
}

/**
 * Bitácora de la validación del receptor: qué se validó, con qué resultado y
 * en qué modo, ligado a la factura. Es la evidencia que se muestra si la DNIT
 * pregunta por qué un DTE salió con esos datos. Nunca bloquea la emisión.
 */
async function registrarValidacionReceptor(invoiceId, validacionReceptor) {
  if (!validacionReceptor) return;
  const { errores, advertencias, modo } = validacionReceptor;
  if (errores.length === 0 && advertencias.length === 0) return;
  try {
    await OperationLog.create({
      invoiceId,
      tipoOperacion: 'validacion_receptor',
      descripcion: errores.length > 0
        ? `Receptor con ${errores.length} error(es) SIFEN y ${advertencias.length} advertencia(s) [modo ${modo}]`
        : `Receptor normalizado con ${advertencias.length} advertencia(s) [modo ${modo}]`,
      detalle: { errores, advertencias, modo },
      estado: errores.length > 0 ? 'warning' : 'success'
    });
  } catch (logErr) {
    console.error('No se pudo registrar validacion_receptor:', logErr.message);
  }
}

/**
 * @param {object} datosFactura  payload de /api/facturar/crear ({ param, data })
 * @param {object} [opciones]
 * @param {string} [opciones.claveIdempotencia]  header Idempotency-Key
 */
async function crearFactura(datosFactura, opciones = {}) {
  const data = datosFactura.data || datosFactura;
  const claveIdempotencia = normalizarClaveIdempotencia(opciones.claveIdempotencia);

  normalizarFechasEnObjeto(data);

  const rucEmpresa = datosFactura.param?.ruc || datosFactura.ruc?.trim();
  if (!rucEmpresa) {
    throw Object.assign(new Error('El campo RUC es requerido para identificar la empresa emisora'), {
      statusCode: 400, errorCode: 'RUC_REQUIRED'
    });
  }

  const empresa = await buscarEmpresaPorRUC(rucEmpresa);
  validarEmpresaActiva(empresa);

  // Repetición de una emisión que ya existe: se devuelve esa factura sin
  // numerar ni encolar nada. Va antes de validar el certificado y el payload
  // para que la repetición conteste lo mismo aunque algo haya cambiado desde
  // el pedido original (p. ej. el certificado venció en el medio).
  if (claveIdempotencia) {
    const previa = await buscarVigentePorClave(empresa._id, claveIdempotencia);
    if (previa) {
      console.log(`🔁 Idempotency-Key repetida: se devuelve la factura ${previa.correlativo} (${previa.estadoSifen})`);
      return {
        tipo: 'idempotente',
        facturaId: previa._id,
        correlativo: previa.correlativo,
        estado: previa.estadoSifen,
        proceso: previa.proceso ?? null,
        cdc: previa.cdc || null
      };
    }
  }

  validarCertificadoValido(empresa);

  // Política de monedas: SIFEN acepta cualquier ISO 4217, pero la
  // contabilidad de la empresa define en cuáles emite (Kingston: PYG y USD).
  const monedaOperacion = String(data.moneda || 'PYG').toUpperCase();
  const monedasPermitidas = empresa.configuracionSifen?.monedasPermitidas?.length
    ? empresa.configuracionSifen.monedasPermitidas
    : ['PYG', 'USD'];
  if (!monedasPermitidas.includes(monedaOperacion)) {
    throw Object.assign(
      new Error(`Moneda ${monedaOperacion} no permitida por la política de la empresa. Monedas habilitadas: ${monedasPermitidas.join(', ')} (configurable en la empresa: configuracionSifen.monedasPermitidas)`),
      { statusCode: 400, errorCode: 'MONEDA_NO_PERMITIDA' }
    );
  }

  // ── Validación del receptor (pre-SIFEN) ──────────────────────────
  // Replica las reglas del receptor del MT v150 + NT vigentes ANTES de firmar
  // (docs/fiscal/02-reglas-receptor-sifen.md). Modos por empresa
  // (configuracionSifen.validacionReceptor):
  //   'estricto'    → los errores rechazan la emisión con 400 RECEPTOR_INVALIDO
  //   'advertencia' → (default) normaliza + registra, sin rechazar: permite
  //                   desplegar sin romper integraciones y ver qué corregir
  //   'off'         → escape hatch, sin validación
  // En ambos modos activos el cliente queda NORMALIZADO (DV recalculado,
  // documento limpio, país por defecto, campos prohibidos removidos): el bug
  // del `"undefined"` firmado muere acá.
  const modoValidacionReceptor = empresa.configuracionSifen?.validacionReceptor || 'advertencia';
  let validacionReceptor = null;
  if (modoValidacionReceptor !== 'off') {
    const resultado = validarReceptor(data);
    validacionReceptor = {
      modo: modoValidacionReceptor,
      errores: resultado.errores,
      advertencias: resultado.advertencias,
      fecha: new Date()
    };
    if (resultado.errores.length > 0 && modoValidacionReceptor === 'estricto') {
      throw Object.assign(
        new Error(`Receptor inválido: ${resultado.errores.map(e => e.mensaje).join(' | ')}`),
        {
          statusCode: 400,
          errorCode: 'RECEPTOR_INVALIDO',
          detalles: { errores: resultado.errores, advertencias: resultado.advertencias }
        }
      );
    }
    if (resultado.cliente) {
      data.cliente = resultado.cliente;
    }
    if (resultado.errores.length > 0) {
      console.warn(`⚠️ Receptor con ${resultado.errores.length} error(es) SIFEN (modo advertencia): ${resultado.errores.map(e => e.codigo).join(', ')}`);
    }
  }

  // Establecimiento y punto de expedición: si el payload no los trae, se usan
  // los configurados por defecto en la empresa. Debe resolverse ANTES de la
  // numeración (la secuencia es por establecimiento+punto).
  if (!data.establecimiento) data.establecimiento = empresa.configuracionSifen?.establecimiento || '001';
  if (!data.punto) data.punto = empresa.configuracionSifen?.puntoExpedicion || '001';
  validarPuntoHabilitado(empresa, data);

  // Rango de dFeEmiDE que acepta SET: hasta 720 h atrás (1150) y 120 h adelante
  // (1151). Emitir retroactivo es válido —una NC de tres días atrás entra de
  // sobra—; lo que se corta acá es la fecha fuera de rango, para no quemar un
  // correlativo en un rechazo cantado.
  const plazoEmision = evaluarPlazoEmision(data.fecha);
  if (!plazoEmision.dentro) {
    const desfase = Math.abs(plazoEmision.horasDesfase).toFixed(1);
    const sentido = plazoEmision.motivo === 'retroactiva' ? 'anterior' : 'posterior';
    throw Object.assign(
      new Error(`La fecha de emisión ${data.fecha} es ${desfase} h ${sentido} a la transmisión y SET acepta como máximo ${plazoEmision.horasLimite} h en ese sentido.`),
      {
        statusCode: 400,
        errorCode: 'FECHA_EMISION_FUERA_DE_RANGO',
        detalles: {
          fechaEmision: data.fecha,
          motivo: plazoEmision.motivo,
          horasDesfase: Number(plazoEmision.horasDesfase.toFixed(2)),
          horasLimite: plazoEmision.horasLimite
        }
      }
    );
  }

  // Numeración: si la integración no manda data.numero, el sistema asigna el
  // siguiente correlativo. Debe ocurrir ANTES de construir hash/correlativo
  // (y de encolar) porque el número forma parte del CDC del documento.
  if (!data.numero) {
    data.numero = await asignarNumeroCorrelativo(empresa, datosFactura);
    console.log(`🔢 Número correlativo asignado: ${data.numero}`);
  } else {
    data.numero = String(data.numero).padStart(7, '0');
  }

  const correlativo = construirCorrelativo(datosFactura);
  const totalFactura = calcularTotal(datosFactura);
  const facturaHash = generarFacturaHash(datosFactura, empresa);
  const tipoDocumentoCodigo = data.tipoDocumento || datosFactura.tipoDocumento;
  const deDescripcion = tiposDocumentoMap[tipoDocumentoCodigo] || 'Factura electrónica';
  const tipoEmisionVal = data.tipoEmision || datosFactura.tipoEmision || 1;
  const cliente = data.cliente || datosFactura.cliente || {};

  // Mismo documento (emisor + tipo + timbrado + correlativo) ya registrado:
  // por hash (registros nuevos) o por correlativo + tipo (registros anteriores
  // al cambio de fórmula del hash). Un documento que existe en SET nunca se
  // reutiliza: solo se reintenta uno que falló antes de llegar a SET.
  let facturaExistente = await Invoice.findOne({ facturaHash });
  if (!facturaExistente) {
    facturaExistente = await Invoice.findOne({
      empresaId: empresa._id,
      correlativo,
      de: deDescripcion,
      estadoSifen: { $in: ESTADOS_FINALES_EN_SET }
    });
  }

  if (facturaExistente) {
    const estaAprobada = ESTADOS_FINALES_EN_SET.includes(facturaExistente.estadoSifen) && facturaExistente.cdc;

    if (facturaExistente.estadoSifen === 'cancelado' && facturaExistente.cdc) {
      throw Object.assign(new Error(`El documento ${correlativo} (${deDescripcion}) ya fue emitido y cancelado en SET (CDC ${facturaExistente.cdc}). Emití con otro número.`), {
        statusCode: 409, errorCode: 'FACTURA_YA_CANCELADA',
        detalles: {
          facturaId: facturaExistente._id,
          fechaCreacion: facturaExistente.fechaCreacion,
          correlativo: facturaExistente.correlativo,
          estadoSifen: facturaExistente.estadoSifen,
          cdc: facturaExistente.cdc
        }
      });
    }

    if (estaAprobada && facturaExistente.proceso === 'No completado') {
      facturaExistente.proceso = null;
      facturaExistente.kudePath = null;
      await facturaExistente.save();

      const job = await encolarKUDE(
        facturaExistente._id,
        facturaExistente.xmlPath,
        facturaExistente.cdc,
        facturaExistente.correlativo,
        facturaExistente.fechaCreacion,
        facturaExistente.datosFactura,
        facturaExistente.empresaId
      );

      return {
        tipo: 'pdf_regeneracion',
        facturaId: facturaExistente._id,
        correlativo: facturaExistente.correlativo,
        estado: facturaExistente.estadoSifen,
        proceso: null,
        cdc: facturaExistente.cdc,
        kudeJobId: job.id
      };
    }

    if (estaAprobada && facturaExistente.proceso !== 'No completado') {
      throw Object.assign(new Error(`La factura ya tiene estado "${facturaExistente.estadoSifen}" en SET. Los archivos (XML/PDF) ya están generados.`), {
        statusCode: 409, errorCode: 'FACTURA_YA_APROBADA',
        detalles: {
          facturaId: facturaExistente._id,
          fechaCreacion: facturaExistente.fechaCreacion,
          correlativo: facturaExistente.correlativo,
          estadoSifen: facturaExistente.estadoSifen,
          cdc: facturaExistente.cdc,
          proceso: facturaExistente.proceso
        }
      });
    }

    // Reintento de un documento que nunca llegó a SET (error, rechazado, en
    // cola): se reutiliza el registro con los datos NUEVOS, incluido el
    // snapshot del cliente y el total (antes quedaban los del intento previo).
    const estadoAnteriorReintento = facturaExistente.estadoSifen;
    const mensajeAnteriorReintento = facturaExistente.mensajeRetorno;

    facturaExistente.datosFactura = datosFactura;
    facturaExistente.correlativo = correlativo;  // el reintento puede cambiar est/punto
    facturaExistente.facturaHash = facturaHash;
    facturaExistente.cliente = snapshotCliente(cliente, validacionReceptor);
    facturaExistente.total = totalFactura;
    facturaExistente.estadoSifen = 'encolado';
    facturaExistente.proceso = null;
    facturaExistente.fechaCreacion = new Date();
    facturaExistente.de = deDescripcion;
    facturaExistente.tipoEmision = tipoEmisionVal;
    facturaExistente.cdc = null;
    facturaExistente.xmlPath = null;
    facturaExistente.kudePath = null;
    facturaExistente.codigoRetorno = null;
    facturaExistente.mensajeRetorno = null;
    facturaExistente.digestValue = null;
    facturaExistente.fechaProceso = null;
    facturaExistente.respuestaSifen = {};
    // Sin clave (p. ej. el reintento desde el panel) se conserva la que tenía.
    if (claveIdempotencia) facturaExistente.claveIdempotencia = claveIdempotencia;

    const estadoAnterior = estadoAnteriorReintento;
    const mensajeAnterior = mensajeAnteriorReintento;

    await facturaExistente.save();

    await registrarValidacionReceptor(facturaExistente._id, validacionReceptor);

    const job = await encolarFactura(facturaExistente._id, datosFactura, empresa._id);

    return {
      tipo: 'reintento',
      facturaId: facturaExistente._id,
      correlativo,
      estado: 'encolado',
      proceso: null,
      jobId: job.id,
      reintentando: true,
      intentoAnterior: { estadoSifen: estadoAnterior, mensajeRetorno: mensajeAnterior },
      cdc: null
    };
  }

  const invoice = new Invoice({
    empresaId: empresa._id,
    rucEmpresa: empresa.ruc,
    correlativo,
    cliente: snapshotCliente(cliente, validacionReceptor),
    total: totalFactura,
    fechaCreacion: new Date(),
    estadoSifen: 'encolado',
    proceso: null,
    datosFactura,
    facturaHash,
    de: deDescripcion,
    tipoEmision: tipoEmisionVal,
    ...(claveIdempotencia ? { claveIdempotencia } : {})
  });

  await invoice.save();

  await registrarValidacionReceptor(invoice._id, validacionReceptor);

  const job = await encolarFactura(invoice._id, datosFactura, empresa._id);

  return {
    tipo: 'nueva',
    facturaId: invoice._id,
    correlativo,
    estado: 'encolado',
    proceso: null,
    jobId: job.id,
    cdc: null
  };
}

module.exports = {
  crearFactura,
  tiposDocumentoMap,
  generarFacturaHash,
  construirCorrelativo,
  validarPuntoHabilitado,
  calcularTotal,
  normalizarClaveIdempotencia
};
