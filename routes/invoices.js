const express = require('express');
const { generarIdSifen } = require('../utils/idSifen');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const OperationLog = require('../models/OperationLog');
const { verificarToken, verificarPermiso, requerirSesionAdmin } = require('../middleware/auth');
const { cargarAlcance, filtroEmpresa, perteneceAlAlcance, empresaParaConsultas } = require('../middleware/alcance');
const { resolverCertificadoEmpresa } = require('../services/certificadoService');
const {
  extraerCodigoRetorno,
  extraerMensajeRetorno,
  extraerEstadoResultado,
  extraerEstadoDocumento
} = require('../utils/estadoSifen');
const acciones = require('../services/facturaAccionesService');

// Todas las rutas requieren autenticación
// Autenticación + permiso base: una API Key necesita al menos
// 'facturas:leer' para tocar cualquier ruta de facturas (las sesiones
// JWT pasan siempre). Las rutas de abajo suman permisos puntuales.
router.use(verificarToken, verificarPermiso('facturas:leer'), cargarAlcance);

// Obtener todas las facturas
/**
 * Arma el filtro de Mongo del listado a partir de la query. Lo comparten el
 * listado paginado y la exportación CSV, así ambos ven exactamente lo mismo.
 */
function construirFiltroListado(req) {
  const { estado, rucEmpresa, search, searchType, de, desde, hasta, tipoEmision, moneda, ids } = req.query;
  const query = {};

  if (estado) {
    const estados = String(estado).split(',').map(e => e.trim()).filter(Boolean);
    query.estadoSifen = estados.length > 1 ? { $in: estados } : estados[0];
  }
  if (rucEmpresa) query.rucEmpresa = rucEmpresa;
  if (de) {
    const tipos = String(de).split(',').map(e => e.trim()).filter(Boolean);
    query.de = tipos.length > 1 ? { $in: tipos } : tipos[0];
  }
  if (tipoEmision) query.tipoEmision = Number(tipoEmision);
  if (moneda) query['datosFactura.data.moneda'] = String(moneda).toUpperCase();

  if (desde || hasta) {
    query.fechaCreacion = {};
    if (desde) query.fechaCreacion.$gte = new Date(`${desde}T00:00:00-03:00`);
    if (hasta) query.fechaCreacion.$lte = new Date(`${hasta}T23:59:59.999-03:00`);
  }

  if (ids) {
    const lista = String(ids).split(',').filter(id => mongoose.Types.ObjectId.isValid(id));
    query._id = { $in: lista };
  }

  if (search) {
    // Escapar metacaracteres: el texto del usuario se busca literal
    // (sin esto, un patrón hostil permite ReDoS)
    const searchRegex = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    switch (searchType) {
      case 'ruc': query['cliente.ruc'] = searchRegex; break;
      case 'nombre': query['cliente.nombre'] = searchRegex; break;
      case 'cdc': query.cdc = searchRegex; break;
      case 'tipo': query.de = searchRegex; break;
      case 'correlativo': query.correlativo = searchRegex; break;
      case 'id':
        query._id = mongoose.Types.ObjectId.isValid(search) ? search : null;
        break;
      default:
        // Búsqueda libre: número, CDC, RUC o nombre del cliente
        query.$or = [
          { correlativo: searchRegex },
          { cdc: searchRegex },
          { 'cliente.ruc': searchRegex },
          { 'cliente.nombre': searchRegex }
        ];
    }
  }

  // Restringir a las empresas del alcance (admin ve todo)
  Object.assign(query, filtroEmpresa(req));
  return query;
}

const ORDENES = {
  fecha: 'fechaCreacion',
  correlativo: 'correlativo',
  total: 'total',
  estado: 'estadoSifen',
  cliente: 'cliente.nombre',
  tipo: 'de'
};

function construirOrden(req) {
  const campo = ORDENES[req.query.sort] || 'fechaCreacion';
  const dir = String(req.query.dir || 'desc').toLowerCase() === 'asc' ? 1 : -1;
  const orden = { [campo]: dir };
  if (campo !== 'fechaCreacion') orden.fechaCreacion = -1;
  orden.createdAt = -1;
  return orden;
}

/** Fila del listado: lo que necesita la tabla, sin XML ni payload completo. */
function transformarParaListado(invoice) {
  const obj = invoice.toObject();
  const data = obj.datosFactura?.data || {};
  delete obj.xmlContent;
  delete obj.datosFactura;
  delete obj.respuestaSifen;
  const empresaPopulada = obj.empresaId && typeof obj.empresaId === 'object' && obj.empresaId.ruc !== undefined;
  return {
    ...obj,
    estado: invoice.estadoSifen,
    estadoVisual: invoice.estadoVisual || 'rechazado',
    codigoRetorno: invoice.codigoRetorno || null,
    de: invoice.de || 'Factura electrónica',
    moneda: data.moneda || 'PYG',
    tipoCambio: data.cambio ?? null,
    fechaEmision: data.fecha || null,
    empresa: empresaPopulada
      ? { _id: obj.empresaId._id, ruc: obj.empresaId.ruc, nombre: obj.empresaId.nombreFantasia || obj.empresaId.razonSocial }
      : null,
    empresaId: empresaPopulada ? obj.empresaId._id : obj.empresaId,
    tieneXml: Boolean(invoice.xmlPath),
    tienePdf: Boolean(invoice.kudePath),
    elegibilidad: acciones.elegibilidad(invoice)
  };
}

// Obtener todas las facturas (paginado, con filtros y orden)
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 10));
    const query = construirFiltroListado(req);

    const [invoices, total] = await Promise.all([
      Invoice.find(query)
        .sort(construirOrden(req))
        .limit(limit)
        .skip((page - 1) * limit)
        .populate('empresaId', 'ruc nombreFantasia razonSocial')
        .exec(),
      Invoice.countDocuments(query)
    ]);

    res.json({
      success: true,
      message: 'Facturas obtenidas exitosamente',
      invoices: invoices.map(transformarParaListado),
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total,
      limit
    });
  } catch (error) {
    console.error('Error listando facturas:', error);
    res.status(500).json({ success: false, error: 'INVOICES_LIST_ERROR', message: error.message });
  }
});

// Exportar el listado (mismos filtros) a CSV para Excel
router.get('/export.csv', async (req, res) => {
  try {
    const query = construirFiltroListado(req);
    const invoices = await Invoice.find(query).sort(construirOrden(req)).limit(5000).select('-xmlContent').exec();
    const csv = acciones.aCsv(invoices.map(acciones.filaCsv));
    const fecha = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="documentos_${fecha}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('Error exportando CSV:', error);
    res.status(500).json({ success: false, error: 'INVOICES_EXPORT_ERROR', message: error.message });
  }
});

// -------------------------------------------------------------------
// Operaciones masivas (bulk). Reciben { ids: [...] } y devuelven un
// resultado por documento; nunca cortan por un error individual.
// -------------------------------------------------------------------

const MAX_BULK = 200;

/** Carga los documentos pedidos que estén dentro del alcance, en el orden pedido. */
async function cargarSeleccion(req, extra = {}) {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  const validos = [...new Set(ids)].filter(id => mongoose.Types.ObjectId.isValid(id));
  if (validos.length === 0) {
    const error = new Error('Indicá al menos un documento (ids)');
    error.statusCode = 400; error.errorCode = 'BULK_SIN_IDS';
    throw error;
  }
  if (validos.length > MAX_BULK) {
    const error = new Error(`Máximo ${MAX_BULK} documentos por operación (pediste ${validos.length})`);
    error.statusCode = 400; error.errorCode = 'BULK_DEMASIADOS';
    throw error;
  }
  const docs = await Invoice.find({ _id: { $in: validos }, ...filtroEmpresa(req) }, extra.select || undefined);
  const porId = new Map(docs.map(d => [String(d._id), d]));
  return validos.map(id => ({ id, invoice: porId.get(id) || null }));
}

function responderBulk(res, resultados, mensaje) {
  const ok = resultados.filter(r => r.ok).length;
  res.json({ success: true, message: mensaje, total: resultados.length, ok, fallidos: resultados.length - ok, resultados });
}

function errorBulk(res, error) {
  res.status(error.statusCode || 500).json({ success: false, error: error.errorCode || 'BULK_ERROR', message: error.message });
}

// ZIP con XML y/o PDF de la selección
router.post('/bulk/zip', async (req, res) => {
  try {
    const incluir = Array.isArray(req.body?.incluir) && req.body.incluir.length ? req.body.incluir : ['xml', 'pdf'];
    const seleccion = await cargarSeleccion(req, { select: 'correlativo de xmlPath kudePath estadoSifen cdc' });

    const JSZip = require('jszip');
    const zip = new JSZip();
    const faltantes = [];
    let agregados = 0;

    for (const { id, invoice } of seleccion) {
      if (!invoice) { faltantes.push(`${id}: no encontrado`); continue; }
      if (incluir.includes('xml')) {
        const ruta = acciones.rutaXml(invoice);
        if (ruta) { zip.file(acciones.nombreArchivo(invoice, 'xml'), fs.readFileSync(ruta)); agregados++; }
        else faltantes.push(`${invoice.correlativo}: sin XML`);
      }
      if (incluir.includes('pdf')) {
        const ruta = acciones.rutaPdf(invoice);
        if (ruta) { zip.file(acciones.nombreArchivo(invoice, 'pdf'), fs.readFileSync(ruta)); agregados++; }
        else faltantes.push(`${invoice.correlativo}: sin PDF`);
      }
    }

    if (agregados === 0) {
      return res.status(404).json({ success: false, error: 'BULK_ZIP_VACIO', message: 'Ninguno de los documentos seleccionados tiene archivos disponibles', faltantes });
    }
    if (faltantes.length) {
      zip.file('FALTANTES.txt', `Documentos sin archivo:\r\n${faltantes.join('\r\n')}\r\n`);
    }

    const fecha = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="documentos_${fecha}_${seleccion.length}.zip"`);
    res.setHeader('X-Archivos-Agregados', String(agregados));
    res.setHeader('X-Archivos-Faltantes', String(faltantes.length));
    zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE' })
      .on('error', (error) => { console.error('Error generando ZIP:', error); if (!res.headersSent) res.status(500).end(); })
      .pipe(res);
  } catch (error) {
    errorBulk(res, error);
  }
});

// Consultar estado en SET de la selección (secuencial: SET limita el ritmo)
router.post('/bulk/refresh-status', verificarPermiso('facturas:crear'), async (req, res) => {
  try {
    const seleccion = await cargarSeleccion(req);
    const resultados = [];
    for (const { id, invoice } of seleccion) {
      if (!invoice) { resultados.push({ id, ok: false, mensaje: 'No encontrado' }); continue; }
      const r = await acciones.consultarEstadoEnSet(invoice);
      resultados.push({
        id, correlativo: invoice.correlativo, ok: r.status === 200,
        estadoAnterior: r.body.estadoAnterior, estadoActual: r.body.estadoActual || invoice.estadoSifen,
        cambio: Boolean(r.body.estadoCambio), consultoSET: Boolean(r.body.consultoSET),
        mensaje: r.body.message || r.body.error
      });
    }
    responderBulk(res, resultados, 'Consulta de estado terminada');
  } catch (error) {
    errorBulk(res, error);
  }
});

// Reintentar emisión de la selección
router.post('/bulk/retry', verificarPermiso('facturas:crear'), async (req, res) => {
  try {
    const seleccion = await cargarSeleccion(req);
    const resultados = [];
    for (const { id, invoice } of seleccion) {
      if (!invoice) { resultados.push({ id, ok: false, mensaje: 'No encontrado' }); continue; }
      const r = await acciones.reintentarEnvio(invoice);
      resultados.push({ id, correlativo: invoice.correlativo, ok: r.status === 200, mensaje: r.body.message, nuevoCorrelativo: r.body.data?.correlativo });
    }
    responderBulk(res, resultados, 'Reintentos encolados');
  } catch (error) {
    errorBulk(res, error);
  }
});

// Eliminar de la selección lo que nunca existió en SET
router.post('/bulk/delete', verificarPermiso('facturas:eliminar'), async (req, res) => {
  try {
    const seleccion = await cargarSeleccion(req);
    const resultados = [];
    for (const { id, invoice } of seleccion) {
      if (!invoice) { resultados.push({ id, ok: false, mensaje: 'No encontrado' }); continue; }
      const r = await acciones.eliminarFactura(invoice);
      resultados.push({ id, correlativo: invoice.correlativo, ok: r.status === 200, mensaje: r.body.message });
    }
    responderBulk(res, resultados, 'Eliminación terminada');
  } catch (error) {
    errorBulk(res, error);
  }
});

// -------------------------------------------------------------------
// Rutas específicas (deben ir ANTES de /:id para evitar conflictos)
// -------------------------------------------------------------------

// Buscar factura por CDC (local + SET)
router.get('/cdc/:cdc', async (req, res) => {
  try {
    const cdc = req.params.cdc;

    if (!cdc) {
      res.status(400).json({ success: false, error: 'CDC_REQUIRED', message: 'CDC requerido' });
      return;
    }

    const invoiceRecord = await Invoice.findOne({ cdc, ...filtroEmpresa(req) });

    if (invoiceRecord) {
      res.status(200).json({
        success: true,
        message: 'Factura encontrada localmente',
        encontrado: true,
        fuente: 'local',
        data: {
          _id: invoiceRecord._id,
          correlativo: invoiceRecord.correlativo,
          cdc: invoiceRecord.cdc,
          estadoSifen: invoiceRecord.estadoSifen,
          proceso: invoiceRecord.proceso,
          fechaCreacion: invoiceRecord.fechaCreacion,
          fechaEnvio: invoiceRecord.fechaEnvio,
          fechaProceso: invoiceRecord.fechaProceso,
          digestValue: invoiceRecord.digestValue,
          total: invoiceRecord.total,
          cliente: invoiceRecord.cliente,
          xmlPath: invoiceRecord.xmlPath
        }
      });
      return;
    }

    try {
      const setApi = require('../services/setapi-wrapper');
      const idConsulta = generarIdSifen();

      // Consultar a SET requiere firmar con un certificado real
      const empresa = await empresaParaConsultas(req);
      if (!empresa) {
        return res.status(400).json({
          success: false,
          error: 'CERTIFICADO_NO_DISPONIBLE',
          message: 'Para consultar a SIFEN se necesita una empresa con certificado digital activo'
        });
      }
      const ambiente = empresa.configuracionSifen?.modo || 'test';
      const cert = resolverCertificadoEmpresa(empresa);

      const respuesta = await setApi.consulta(idConsulta, cdc, ambiente, cert.ruta, cert.contrasena);

      res.status(200).json({
        success: true,
        message: 'Factura encontrada en SIFEN',
        encontrado: true,
        fuente: 'sifen',
        data: { respuesta }
      });
    } catch (error) {
      res.status(404).json({
        success: false,
        error: 'CDC_NOT_FOUND_SIFEN',
        message: 'CDC no encontrado en SIFEN',
        encontrado: false,
        cdc: cdc
      });
    }
  } catch (error) {
    console.error('Error al consultar por CDC:', error);
    res.status(500).json({ success: false, error: 'CDC_CONSULTA_ERROR', message: 'Error al consultar por CDC' });
  }
});

// Consultar estado con SET (incluye actualización)
router.get('/estado/:cdc', async (req, res) => {
  try {
    const cdc = req.params.cdc;

    if (!cdc) {
      res.status(400).json({ success: false, error: 'CDC_REQUIRED', message: 'CDC requerido' });
      return;
    }

    const invoiceRecord = await Invoice.findOne({ cdc, ...filtroEmpresa(req) });

    if (!invoiceRecord) {
      res.status(404).json({
        success: false,
        error: 'FACTURA_NOT_FOUND_LOCAL',
        message: 'Factura no encontrada en la base de datos local',
        encontrado: false,
        cdc: cdc
      });
      return;
    }

    let estadoSET = null;

    try {
      const Empresa = require('../models/Empresa');
      const setApi = require('../services/setapi-wrapper');
      const empresa = await Empresa.findById(invoiceRecord.empresaId);

      if (!empresa) {
        console.log('⚠️ No se encontró la empresa, usando configuración por defecto');
      }

      const idConsulta = generarIdSifen();
      const ambiente = empresa?.configuracionSifen?.modo || 'test';

      if (!empresa) {
        return res.status(400).json({
          success: false,
          error: 'EMPRESA_NOT_FOUND',
          message: 'La factura no tiene una empresa asociada con la cual consultar a SET'
        });
      }
      const cert = resolverCertificadoEmpresa(empresa);

      const respuesta = await setApi.consulta(idConsulta, cdc, ambiente, cert.ruta, cert.contrasena);

      const codigoRetorno = extraerCodigoRetorno(respuesta);

      estadoSET = extraerEstadoDocumento(respuesta);

      console.log(`📥 Consulta SET - CDC: ${cdc}, dCodRes: ${codigoRetorno}, estado: ${estadoSET}`);

      if (codigoRetorno && estadoSET) {
        let nuevoEstadoSifen = invoiceRecord.estadoSifen;
        let nuevoEstadoVisual = invoiceRecord.estadoVisual;

        if (codigoRetorno === '0421') {
          if (estadoSET === 'Aprobado' || estadoSET === 'aprobado') {
            nuevoEstadoSifen = 'aceptado';
            nuevoEstadoVisual = 'aceptado';
          } else if (estadoSET === 'Rechazado' || estadoSET === 'rechazado') {
            nuevoEstadoSifen = 'rechazado';
            nuevoEstadoVisual = 'rechazado';
          } else if (estadoSET === 'Aprobado con observación' || estadoSET === 'observado') {
            nuevoEstadoSifen = 'observado';
            nuevoEstadoVisual = 'observado';
          } else {
            nuevoEstadoSifen = 'procesando';
            nuevoEstadoVisual = 'observado';
          }
        } else if (codigoRetorno === '0420') {
          nuevoEstadoSifen = 'rechazado';
          nuevoEstadoVisual = 'rechazado';
        } else if (codigoRetorno === '1005') {
          nuevoEstadoSifen = 'observado';
          nuevoEstadoVisual = 'observado';
        }

        if (nuevoEstadoSifen !== invoiceRecord.estadoSifen || nuevoEstadoVisual !== invoiceRecord.estadoVisual) {
          invoiceRecord.estadoSifen = nuevoEstadoSifen;
          invoiceRecord.estadoVisual = nuevoEstadoVisual;
          invoiceRecord.codigoRetorno = codigoRetorno;
          await invoiceRecord.save();
          console.log(`🔄 Estado actualizado para CDC ${cdc}: ${nuevoEstadoSifen} / ${nuevoEstadoVisual}`);
        }
      }
    } catch (error) {
      console.log('⚠️ No se pudo consultar el estado a la SET, usando estado local');
    }

    res.status(200).json({
      success: true,
      message: 'Estado consultado exitosamente',
      encontrado: true,
      cdc: cdc,
      estadoLocal: invoiceRecord.estadoSifen,
      proceso: invoiceRecord.proceso,
      estadoSET: estadoSET,
      estadoActualizado: estadoSET !== invoiceRecord.estadoSifen,
      data: {
        correlativo: invoiceRecord.correlativo,
        codigoRetorno: invoiceRecord.codigoRetorno,
        mensajeRetorno: invoiceRecord.mensajeRetorno,
        fechaCreacion: invoiceRecord.fechaCreacion,
        fechaEnvio: invoiceRecord.fechaEnvio,
        fechaProceso: invoiceRecord.fechaProceso,
        total: invoiceRecord.total,
        cliente: invoiceRecord.cliente
      }
    });
  } catch (error) {
    console.error('Error al verificar estado:', error);
    res.status(500).json({ success: false, error: 'ESTADO_CONSULTA_ERROR', message: 'Error al verificar estado' });
  }
});

// Obtener todos los logs del sistema
router.get('/logs', async (req, res) => {
  try {
    const { page = 1, limit = 10, tipo, estado } = req.query;

    const query = {};
    if (tipo) {
      query.tipoOperacion = tipo;
    }
    if (estado) {
      query.estado = estado;
    }

    const logs = await OperationLog.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit) * 1)
      .skip((parseInt(page) - 1) * parseInt(limit))
      .exec();

    const total = await OperationLog.countDocuments(query);

    res.json({
      success: true,
      message: 'Logs obtenidos exitosamente',
      logs,
      totalPages: Math.ceil(total / limit),
      currentPage: parseInt(page),
      total
    });
  } catch (error) {
    console.error('Error listando logs:', error);
    res.status(500).json({ success: false, error: 'LOGS_LIST_ERROR', message: error.message });
  }
});

// Limpiar todas las facturas (requiere contraseña)
router.delete('/clear', requerirSesionAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ success: false, error: 'PASSWORD_REQUIRED', message: 'Contraseña requerida' });
    }

    const User = require('../models/User');
    const usuario = await User.findById(req.usuario._id).select('+password');
    if (!usuario) {
      return res.status(401).json({ success: false, error: 'USER_NOT_FOUND', message: 'Usuario no encontrado' });
    }

    const passwordValido = await usuario.compararPassword(password);
    if (!passwordValido) {
      return res.status(401).json({ success: false, error: 'PASSWORD_INCORRECT', message: 'Contraseña incorrecta' });
    }

    // Un documento que existe en SET (aprobado, observado o cancelado, con
    // CDC) es un comprobante fiscal: se conserva 5 años y NUNCA se borra
    // desde acá, ni sus registros de operación. Solo se limpia lo que nunca
    // llegó a SET (pruebas, rechazados, errores, encolados).
    const protegidos = await Invoice.find(acciones.FILTRO_EXISTE_EN_SET).select('_id correlativo').lean();
    const idsProtegidos = protegidos.map((p) => p._id);

    const result = await Invoice.deleteMany({ _id: { $nin: idsProtegidos } });
    const logsResult = await OperationLog.deleteMany({ invoiceId: { $nin: idsProtegidos } });

    console.log(`🗑️ Base de datos limpiada: ${result.deletedCount} facturas, ${logsResult.deletedCount} registros eliminados; ${idsProtegidos.length} documento(s) fiscales conservados`);

    res.status(200).json({
      success: true,
      message: idsProtegidos.length
        ? `Base de datos limpiada. Se conservaron ${idsProtegidos.length} documento(s) que existen en SET: ${protegidos.map((p) => p.correlativo).join(', ')}`
        : 'Base de datos limpiada exitosamente',
      deletedCount: result.deletedCount,
      deletedLogs: logsResult.deletedCount,
      conservados: protegidos.map((p) => ({ id: p._id, correlativo: p.correlativo }))
    });
  } catch (error) {
    console.error('Error al limpiar base de datos:', error);
    res.status(500).json({
      success: false,
      error: 'CLEAR_DB_ERROR',
      message: error.message
    });
  }
});

// -------------------------------------------------------------------
// Rutas con parámetro :id (ordenadas de más específicas a genéricas)
// -------------------------------------------------------------------

// Obtener una factura específica
router.get('/:id', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id).populate('empresaId', 'ruc nombreFantasia razonSocial');

    if (!invoice || !perteneceAlAlcance(req, invoice.empresaId?._id || invoice.empresaId)) {
      return res.status(404).json({ success: false, error: 'FACTURA_NOT_FOUND', message: 'Factura no encontrada' });
    }
    const empresa = invoice.empresaId && invoice.empresaId.ruc
      ? { _id: invoice.empresaId._id, ruc: invoice.empresaId.ruc, nombre: invoice.empresaId.nombreFantasia || invoice.empresaId.razonSocial }
      : null;

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const xmlLink = invoice.xmlPath ? `${baseUrl}/api/invoices/${invoice._id}/download-xml` : null;
    const kudeLink = invoice.kudePath ? `${baseUrl}/api/invoices/${invoice._id}/download-pdf` : null;

    const estadosFinales = ['aceptado', 'rechazado', 'error', 'observado', 'cancelado'];
    const esEstadoFinal = estadosFinales.includes(invoice.estadoSifen);

    const recomendarRefresh = !esEstadoFinal && invoice.cdc;

    res.json({
      success: true,
      data: {
        facturaId: invoice._id,
        correlativo: invoice.correlativo,
        cdc: invoice.cdc || null,
        estado: invoice.estadoSifen,
        proceso: invoice.proceso || null,
        estadoVisual: invoice.estadoVisual || 'rechazado',
        esEstadoFinal: esEstadoFinal,
        recomendarRefresh: recomendarRefresh,
        xmlPath: invoice.xmlPath,
        kudePath: invoice.kudePath,
        xmlLink: xmlLink,
        kudeLink: kudeLink,
        cliente: invoice.cliente,
        total: invoice.total,
        fechaCreacion: invoice.fechaCreacion,
        fechaEnvio: invoice.fechaEnvio,
        fechaProceso: invoice.fechaProceso,
        codigoRetorno: invoice.codigoRetorno,
        mensajeRetorno: invoice.mensajeRetorno,
        digestValue: invoice.digestValue,
        qrCode: invoice.qrCode,
        datosFactura: invoice.datosFactura || null,
        xmlContent: invoice.xmlContent || null,
        de: invoice.de || 'Factura electrónica',
        tipoEmision: invoice.tipoEmision || 1,
        grupoLoteId: invoice.grupoLoteId || null,
        rucEmpresa: invoice.rucEmpresa || empresa?.ruc || null,
        empresa,
        protocolo: invoice.respuestaSifen?.protocolo || null,
        updatedAt: invoice.updatedAt,
        elegibilidad: acciones.elegibilidad(invoice)
      }
    });
  } catch (error) {
    console.error('Error obteniendo factura:', error);
    res.status(500).json({
      success: false,
      error: 'FACTURA_GET_ERROR',
      message: error.message
    });
  }
});

// Obtener logs de una factura
router.get('/:id/logs', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id).select('empresaId');
    if (!invoice || !perteneceAlAlcance(req, invoice.empresaId)) {
      return res.status(404).json({ success: false, error: 'FACTURA_NOT_FOUND', message: 'Factura no encontrada' });
    }

    const logs = await OperationLog.find({ invoiceId: req.params.id })
      .sort({ createdAt: -1 });

    res.json(logs);
  } catch (error) {
    console.error('Error obteniendo logs de factura:', error);
    res.status(500).json({ success: false, error: 'LOGS_GET_ERROR', message: error.message });
  }
});

// Obtener eventos de una factura
router.get('/:id/eventos', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id).select('empresaId');
    if (!invoice || !perteneceAlAlcance(req, invoice.empresaId)) {
      return res.status(404).json({ success: false, error: 'FACTURA_NOT_FOUND', message: 'Factura no encontrada' });
    }

    const Evento = require('../models/Evento');
    const eventos = await Evento.find({ invoiceId: req.params.id })
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      message: 'Eventos obtenidos',
      total: eventos.length,
      eventos
    });
  } catch (error) {
    console.error('Error obteniendo eventos de factura:', error);
    res.status(500).json({
      success: false,
      error: 'EVENTOS_GET_ERROR',
      message: error.message
    });
  }
});

// Reintentar envío de factura
router.post('/:id/retry', verificarPermiso('facturas:crear'), async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice || !perteneceAlAlcance(req, invoice.empresaId)) {
      return res.status(404).json({ success: false, error: 'FACTURA_NOT_FOUND', message: 'Factura no encontrada' });
    }
    const r = await acciones.reintentarEnvio(invoice);
    res.status(r.status).json(r.body);
  } catch (error) {
    console.error('Error en retry:', error);
    res.status(500).json({ success: false, error: 'RETRY_ERROR', message: error.message });
  }
});

// Refrescar estado desde SET
router.post('/:id/refresh-status', verificarPermiso('facturas:crear'), async (req, res) => {
  try {
    const invoiceRecord = await Invoice.findById(req.params.id);
    if (!invoiceRecord || !perteneceAlAlcance(req, invoiceRecord.empresaId)) {
      return res.status(404).json({ success: false, error: 'FACTURA_NOT_FOUND', message: 'Factura no encontrada' });
    }
    const r = await acciones.consultarEstadoEnSet(invoiceRecord);
    res.status(r.status).json(r.body);
  } catch (error) {
    console.error('❌ Error al actualizar estado:', error);
    res.status(500).json({ success: false, error: 'REFRESH_STATUS_ERROR', message: error.message });
  }
});

// Descargar XML de una factura
router.get('/:id/download-xml', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);

    if (!invoice || !perteneceAlAlcance(req, invoice.empresaId)) {
      return res.status(404).json({ success: false, error: 'FACTURA_NOT_FOUND', message: 'Factura no encontrada' });
    }

    if (!invoice.xmlPath) {
      return res.status(404).json({
        success: false,
        error: 'XML_NOT_AVAILABLE',
        message: 'XML no disponible',
        detalle: 'Esta factura no tiene un archivo XML asociado. Puede que haya sido creada antes de implementar el guardado de XMLs o que el envío a SET haya fallado.'
      });
    }

    const xmlPath = path.join(__dirname, '../de_output', invoice.xmlPath);
    console.log(`📂 Buscando documento XML en: ${xmlPath}`);

    if (!fs.existsSync(xmlPath)) {
      console.error(`❌ Archivo no encontrado: ${xmlPath}`);
      return res.status(404).json({
        success: false,
        error: 'XML_FILE_NOT_FOUND',
        message: 'Archivo XML no encontrado en el servidor',
        ruta: xmlPath,
        correlativo: invoice.correlativo,
        detalle: 'El archivo XML no existe en el servidor. Puede que se haya eliminado manualmente o que haya un error en la ruta.'
      });
    }

    const fileName = `factura_${invoice.correlativo}.xml`;
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    const fileStream = fs.createReadStream(xmlPath);
    fileStream.pipe(res);

    fileStream.on('error', (error) => {
      console.error('Error en stream:', error);
      res.status(500).json({ success: false, error: 'XML_STREAM_ERROR', message: 'Error al leer el archivo XML' });
    });
  } catch (error) {
    console.error('Error descargando XML:', error);
    res.status(500).json({ success: false, error: 'XML_DOWNLOAD_ERROR', message: 'Error al descargar XML' });
  }
});

// Descargar PDF de una factura (KUDE)
router.get('/:id/download-pdf', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);

    if (!invoice || !perteneceAlAlcance(req, invoice.empresaId)) {
      return res.status(404).json({ success: false, error: 'FACTURA_NOT_FOUND', message: 'Factura no encontrada' });
    }

    if (!invoice.kudePath) {
      return res.status(404).json({
        success: false,
        error: 'PDF_NOT_AVAILABLE',
        message: 'PDF no disponible',
        detalle: 'Esta factura no tiene un archivo PDF KUDE asociado. Puede que el PDF no haya sido generado correctamente.'
      });
    }

    let pdfPath = invoice.kudePath;

    if (!path.isAbsolute(pdfPath)) {
      pdfPath = path.join(__dirname, '../de_output', pdfPath);
    }

    console.log(`📂 Buscando documento PDF en: ${pdfPath}`);

    if (!fs.existsSync(pdfPath)) {
      console.error(`❌ Archivo PDF no encontrado: ${pdfPath}`);
      return res.status(404).json({
        success: false,
        error: 'PDF_FILE_NOT_FOUND',
        message: 'Archivo PDF no encontrado en el servidor',
        ruta: pdfPath,
        correlativo: invoice.correlativo,
        detalle: 'El archivo PDF no existe en el servidor. Puede que se haya eliminado manualmente o que haya un error en la ruta.'
      });
    }

    const fileName = pdfPath.split('/').pop();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);

    const fileStream = fs.createReadStream(pdfPath);
    fileStream.pipe(res);

    fileStream.on('error', (error) => {
      console.error('Error en stream PDF:', error);
      res.status(500).json({ success: false, error: 'PDF_STREAM_ERROR', message: 'Error al leer el archivo PDF' });
    });
  } catch (error) {
    console.error('Error descargando PDF:', error);
    res.status(500).json({ success: false, error: 'PDF_DOWNLOAD_ERROR', message: 'Error al descargar PDF' });
  }
});

// Eliminar una factura específica por ID (solo si nunca existió en SET)
router.delete('/:id', verificarPermiso('facturas:eliminar'), async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice || !perteneceAlAlcance(req, invoice.empresaId)) {
      return res.status(404).json({ success: false, error: 'FACTURA_NOT_FOUND', message: 'Factura no encontrada' });
    }
    const r = await acciones.eliminarFactura(invoice);
    if (r.status === 200) console.log(`🗑️ Factura eliminada: ${invoice.correlativo} (${invoice._id})`);
    res.status(r.status).json(r.body);
  } catch (error) {
    console.error('Error al eliminar factura:', error);
    res.status(500).json({ success: false, error: 'INVOICE_DELETE_ERROR', message: error.message });
  }
});

module.exports = router;
