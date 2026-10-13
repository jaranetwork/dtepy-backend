/**
 * Cotizaciones de moneda extranjera (guaraníes por unidad).
 *
 * La cotización la DECLARA el usuario: desde la UI (sesión JWT) o vía API
 * (API Key con permiso 'cotizaciones:editar' — pensado para un actualizador
 * automático externo). Cada declaración queda en el historial con quién y
 * cuándo. La vigente es la última declarada por empresa+moneda.
 */

const express = require('express');
const router = express.Router();
const { verificarToken, verificarPermiso, requerirSesionUsuario } = require('../middleware/auth');
const { cargarAlcance, filtroEmpresa, perteneceAlAlcance } = require('../middleware/alcance');
const cotizacionService = require('../services/cotizacionService');
const cotizacionProveedores = require('../services/cotizacionProveedores');
const cotizacionSync = require('../services/cotizacionSyncService');
const Empresa = require('../models/Empresa');

router.use(verificarToken, cargarAlcance);

/**
 * Resuelve sobre qué empresa opera el pedido:
 * body/query explícito (validado contra el alcance) o, si el alcance tiene
 * una sola empresa, esa.
 */
async function resolverEmpresa(req, valorExplicito) {
  if (valorExplicito) {
    const texto = String(valorExplicito).trim();
    const empresa = /^[0-9a-fA-F]{24}$/.test(texto)
      ? await Empresa.findById(texto)
      : await Empresa.findOne({ ruc: texto });
    if (!empresa || !perteneceAlAlcance(req, empresa._id)) {
      const error = new Error('La empresa indicada no existe o no corresponde a este usuario o API Key');
      error.statusCode = 404;
      error.errorCode = 'EMPRESA_FUERA_DE_ALCANCE';
      throw error;
    }
    return empresa;
  }

  if (req.alcance?.ids?.length === 1) {
    return Empresa.findById(req.alcance.ids[0]);
  }

  const error = new Error('Indicá la empresa: empresaId o ruc');
  error.statusCode = 400;
  error.errorCode = 'EMPRESA_REQUERIDA';
  throw error;
}

/**
 * @route GET /api/cotizaciones
 * @desc  Cotizaciones vigentes (última declarada por empresa y moneda)
 */
router.get('/', verificarPermiso('facturas:leer'), async (req, res) => {
  try {
    const ids = req.alcance.total ? null : req.alcance.ids;
    const lista = await cotizacionService.vigentes(ids);
    res.json({ success: true, data: lista, monedasSoportadas: cotizacionService.monedasValidas() });
  } catch (error) {
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: 'Error al listar cotizaciones' });
  }
});

/**
 * @route GET /api/cotizaciones/historial
 * @desc  Historial de declaraciones (?moneda=USD&limit=50)
 */
router.get('/historial', verificarPermiso('facturas:leer'), async (req, res) => {
  try {
    const filtro = filtroEmpresa(req);
    const lista = await cotizacionService.historial({
      empresaIds: filtro.empresaId ? filtro.empresaId.$in : null,
      moneda: req.query.moneda,
      limite: req.query.limit
    });
    res.json({ success: true, data: lista });
  } catch (error) {
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: 'Error al listar historial' });
  }
});

/**
 * @route GET /api/cotizaciones/proveedores
 * @desc  Catálogo (hardcodeado) de proveedores de cotización automática
 */
router.get('/proveedores', verificarPermiso('facturas:leer'), (req, res) => {
  res.json({ success: true, data: cotizacionProveedores.listar() });
});

/**
 * @route GET /api/cotizaciones/automatica
 * @desc  Configuración de actualización automática de una empresa
 */
router.get('/automatica', verificarPermiso('facturas:leer'), async (req, res) => {
  try {
    const empresa = await resolverEmpresa(req, req.query.empresaId || req.query.ruc);
    const config = empresa.cotizacionesAutomaticas || {};
    res.json({
      success: true,
      data: {
        empresaId: empresa._id,
        ruc: empresa.ruc,
        activo: config.activo || false,
        proveedor: config.proveedor || 'sistemaaguila',
        monedas: config.monedas || [],
        tipoValor: config.tipoValor || 'venta',
        variacionMaximaPct: config.variacionMaximaPct ?? 10,
        ultimaSincronizacion: config.ultimaSincronizacion || null,
        fechaObjetivo: cotizacionSync.fechaObjetivo()
      }
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.errorCode || 'INTERNAL_ERROR',
      message: error.message
    });
  }
});

/**
 * @route PUT /api/cotizaciones/automatica
 * @desc  Configurar la actualización automática (solo sesión JWT: define de
 *        dónde salen valores que terminan en documentos fiscales firmados)
 */
router.put('/automatica', requerirSesionUsuario, async (req, res) => {
  try {
    const { activo, proveedor, monedas, tipoValor, variacionMaximaPct } = req.body || {};
    const empresa = await resolverEmpresa(req, req.body?.empresaId || req.body?.ruc);
    const guardado = empresa.cotizacionesAutomaticas;
    const config = guardado?.toObject ? guardado.toObject() : { ...(guardado || {}) };
    // El lock lo maneja el sincronizador; guardar la configuración no lo hereda
    // (si no, un guardado podía revivir un lock ya liberado y dejar el botón
    // "Sincronizar ahora" contestando "hay una sincronización en curso").
    delete config.sincronizandoDesde;

    if (proveedor !== undefined) {
      const encontrado = cotizacionProveedores.obtener(proveedor);
      if (!encontrado) {
        return res.status(400).json({
          success: false,
          error: 'PROVEEDOR_INVALIDO',
          message: `Proveedor inválido. Valores: ${cotizacionProveedores.idsValidos().join(', ')}`
        });
      }
      config.proveedor = encontrado.id;
    }

    if (monedas !== undefined) {
      if (!Array.isArray(monedas)) {
        return res.status(400).json({ success: false, error: 'MONEDAS_INVALIDAS', message: 'monedas debe ser un array' });
      }
      const proveedorActual = cotizacionProveedores.obtener(config.proveedor || 'sistemaaguila');
      const normalizadas = monedas.map((m) => String(m).toUpperCase().trim());
      for (const moneda of normalizadas) {
        if (!proveedorActual.monedas.includes(moneda)) {
          return res.status(400).json({
            success: false,
            error: 'MONEDA_NO_PUBLICADA',
            message: `${proveedorActual.nombre} no publica ${moneda}. Monedas: ${proveedorActual.monedas.join(', ')}`
          });
        }
      }
      config.monedas = normalizadas;
    }

    if (tipoValor !== undefined) {
      if (!['compra', 'venta', 'promedio'].includes(tipoValor)) {
        return res.status(400).json({
          success: false,
          error: 'TIPO_VALOR_INVALIDO',
          message: 'tipoValor debe ser compra, venta o promedio'
        });
      }
      config.tipoValor = tipoValor;
    }

    if (variacionMaximaPct !== undefined) {
      const numero = Number(variacionMaximaPct);
      if (!Number.isFinite(numero) || numero < 0.1 || numero > 100) {
        return res.status(400).json({
          success: false,
          error: 'VARIACION_INVALIDA',
          message: 'variacionMaximaPct debe ser un número entre 0.1 y 100'
        });
      }
      config.variacionMaximaPct = numero;
    }

    if (activo !== undefined) {
      const encender = Boolean(activo);
      if (encender && (!config.monedas || config.monedas.length === 0)) {
        return res.status(400).json({
          success: false,
          error: 'SIN_MONEDAS',
          message: 'Elegí al menos una moneda antes de activar la actualización automática'
        });
      }
      config.activo = encender;
    }

    empresa.cotizacionesAutomaticas = config;
    empresa.markModified('cotizacionesAutomaticas');
    await empresa.save();

    res.json({
      success: true,
      message: config.activo
        ? `Actualización automática activada (${config.monedas.join(', ')}, valor de ${config.tipoValor}). ` +
          'La próxima sincronización recalcula con la última cotización publicada.'
        : 'Actualización automática desactivada',
      data: empresa.cotizacionesAutomaticas
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.errorCode || 'INTERNAL_ERROR',
      message: error.message
    });
  }
});

/**
 * @route POST /api/cotizaciones/sincronizar
 * @desc  Fuerza una sincronización ahora (ignora el atajo de "ya al día" y la
 *        caché). Las guardas de validación y variación siguen aplicando.
 */
router.post('/sincronizar', verificarPermiso('cotizaciones:editar'), async (req, res) => {
  try {
    const empresa = await resolverEmpresa(req, req.body?.empresaId || req.body?.ruc);
    const resumen = await cotizacionSync.sincronizarEmpresa(empresa, { forzado: true });
    const status = resumen.estado === 'error' ? 502 : 200;
    res.status(status).json({ success: resumen.estado !== 'error', data: resumen });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.errorCode || 'INTERNAL_ERROR',
      message: error.message
    });
  }
});

/**
 * @route POST /api/cotizaciones
 * @desc  Declarar una cotización { moneda, valor, empresaId? | ruc? }
 *        JWT: cualquier usuario sobre sus empresas.
 *        API Key: requiere permiso 'cotizaciones:editar'.
 */
router.post('/', verificarPermiso('cotizaciones:editar'), async (req, res) => {
  try {
    const { moneda, valor } = req.body || {};
    const empresa = await resolverEmpresa(req, req.body?.empresaId || req.body?.ruc);

    const declaradaPor = req.tipoAutenticacion === 'jwt'
      ? {
          tipo: 'usuario',
          nombre: [req.usuario?.nombre, req.usuario?.apellido].filter(Boolean).join(' '),
          email: req.usuario?.email || ''
        }
      : { tipo: 'api_key', nombre: req.apiKey?.nombre || 'API Key', email: '' };

    const cotizacion = await cotizacionService.declarar({
      empresaId: empresa._id,
      moneda,
      valor,
      declaradaPor
    });

    res.status(201).json({
      success: true,
      message: `Cotización ${cotizacion.moneda} declarada: ${cotizacion.valor} Gs`,
      data: {
        cotizacionId: cotizacion._id,
        empresaId: empresa._id,
        ruc: empresa.ruc,
        moneda: cotizacion.moneda,
        valor: cotizacion.valor,
        declaradaPor: cotizacion.declaradaPor,
        declaradaEn: cotizacion.createdAt
      }
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      success: false,
      error: error.errorCode || 'INTERNAL_ERROR',
      message: error.message
    });
  }
});

module.exports = router;
