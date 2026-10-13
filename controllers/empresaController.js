/**
 * Controller para gestión de empresas
 * CRUD completo para empresas con sus certificados digitales
 */

const Empresa = require('../models/Empresa');
const { filtroEmpresasVisibles, filtroEmpresasAdministrables, tipoAccesoEmpresa } = require('../middleware/alcance');
const certificadoService = require('../services/certificadoService');
const Invoice = require('../models/Invoice');
const LoteEnvio = require('../models/LoteEnvio');
const Evento = require('../models/Evento');
const ApiKey = require('../models/ApiKey');

/**
 * Normaliza los códigos de establecimiento a 3 dígitos ('1' -> '001').
 */
function normalizarEstablecimientos(establecimientos) {
  if (!Array.isArray(establecimientos)) return establecimientos;
  return establecimientos.map((est) => ({
    ...est,
    codigo: String(est.codigo || '').padStart(3, '0')
  }));
}

/**
 * Valida la configuración de notificaciones. Devuelve mensaje de error o
 * null; normaliza el objeto en el lugar (genera webhookSecret si falta).
 */
async function validarNotificaciones(notificaciones, usuarioId) {
  if (!notificaciones) return null;
  if (notificaciones.smtpProviderId !== undefined) {
    if (!notificaciones.smtpProviderId) {
      notificaciones.smtpProviderId = null;   // vacío = usar SMTP_* del entorno
    } else {
      const mongoose = require('mongoose');
      if (!mongoose.isValidObjectId(notificaciones.smtpProviderId)) {
        return 'smtpProviderId inválido';
      }
      const SmtpProvider = require('../models/SmtpProvider');
      const provider = await SmtpProvider.findOne({ _id: notificaciones.smtpProviderId, usuarioId });
      if (!provider) {
        return 'smtpProviderId no corresponde a un proveedor SMTP del usuario';
      }
    }
  }
  if (notificaciones.webhookUrl === '' || notificaciones.webhookUrl === null) {
    notificaciones.webhookUrl = undefined;   // vacío = desactivar webhook
  } else if (notificaciones.webhookUrl !== undefined) {
    if (!/^https?:\/\/.+/i.test(notificaciones.webhookUrl)) {
      return 'webhookUrl inválida: debe ser una URL http(s)';
    }
    // si activan webhook sin secreto, se genera uno (para la firma HMAC)
    if (notificaciones.webhookSecret === undefined || notificaciones.webhookSecret === '') {
      const crypto = require('crypto');
      notificaciones.webhookSecret = crypto.randomBytes(24).toString('hex');
    }
  }
  if (notificaciones.emailAutomatico !== undefined && typeof notificaciones.emailAutomatico !== 'boolean') {
    return 'emailAutomatico debe ser true o false';
  }
  return null;
}

/**
 * Valida los datos de emisor configurables de la empresa. Devuelve el
 * mensaje de error o null si todo está bien.
 */
function validarDatosEmisor({ configuracionSifen, actividadesEconomicas, establecimientos }) {
  if (configuracionSifen) {
    for (const campo of ['establecimiento', 'puntoExpedicion']) {
      if (configuracionSifen[campo] === '' || configuracionSifen[campo] === null) {
        delete configuracionSifen[campo];   // vacío = mantener el actual
      } else if (configuracionSifen[campo] !== undefined) {
        if (!/^\d{1,3}$/.test(String(configuracionSifen[campo]))) {
          return `${campo} inválido: debe ser numérico de 1 a 3 dígitos (ej. "001")`;
        }
        configuracionSifen[campo] = String(configuracionSifen[campo]).padStart(3, '0');
      }
    }
    if (configuracionSifen.timbradoFecha === '' || configuracionSifen.timbradoFecha === null) {
      delete configuracionSifen.timbradoFecha;  // el match de mongoose no acepta ''
    } else if (configuracionSifen.timbradoFecha && !/^\d{4}-\d{2}-\d{2}$/.test(configuracionSifen.timbradoFecha)) {
      return 'timbradoFecha inválida: formato YYYY-MM-DD (fecha de inicio de vigencia del timbrado)';
    }
    if (configuracionSifen.monedasPermitidas !== undefined) {
      if (!Array.isArray(configuracionSifen.monedasPermitidas) || configuracionSifen.monedasPermitidas.length === 0) {
        return 'monedasPermitidas debe ser un array con al menos una moneda (ej. ["PYG","USD"])';
      }
      configuracionSifen.monedasPermitidas = configuracionSifen.monedasPermitidas.map((m) => String(m).trim().toUpperCase());
      for (const m of configuracionSifen.monedasPermitidas) {
        if (!/^[A-Z]{3}$/.test(m)) {
          return `Moneda "${m}" inválida en monedasPermitidas: código ISO 4217 de 3 letras (ej. PYG, USD)`;
        }
      }
    }
  }
  if (actividadesEconomicas !== undefined && actividadesEconomicas !== null) {
    if (!Array.isArray(actividadesEconomicas)) {
      return 'actividadesEconomicas debe ser un array de { codigo, descripcion }';
    }
    for (const act of actividadesEconomicas) {
      if (!act?.codigo || !act?.descripcion) {
        return 'Cada actividad económica necesita codigo y descripcion';
      }
    }
  }
  if (establecimientos !== undefined && establecimientos !== null) {
    if (!Array.isArray(establecimientos)) {
      return 'establecimientos debe ser un array';
    }
    for (const est of establecimientos) {
      if (!est?.codigo || !/^\d{1,3}$/.test(String(est.codigo))) {
        return 'Cada establecimiento necesita un codigo numérico de 1 a 3 dígitos';
      }
      if (!est?.denominacion) {
        return `El establecimiento ${est.codigo} necesita denominacion (nombre de la sucursal)`;
      }
    }
  }
  return null;
}

/**
 * Empresa tal como la ve este token: agrega `acceso` (propietario |
 * administrador | compartida) y `puedeAdministrar`. Quien solo tiene acceso
 * compartido opera los documentos pero no ve los secretos de la empresa
 * (CSC, secreto del webhook) ni la lista de quiénes más tienen acceso.
 */
function vistaEmpresa(req, empresa) {
  const obj = empresa.toObject();
  obj.acceso = tipoAccesoEmpresa(req, empresa);
  obj.puedeAdministrar = obj.acceso !== 'compartida';
  if (!obj.puedeAdministrar) {
    if (obj.configuracionSifen) delete obj.configuracionSifen.csc;
    if (obj.notificaciones) delete obj.notificaciones.webhookSecret;
    delete obj.usuariosConAcceso;
  }
  return obj;
}

/**
 * Listar las empresas que ve el usuario autenticado: las propias, las
 * compartidas con él y, si es admin, todas.
 * GET /api/empresas
 */
exports.listar = async (req, res) => {
  try {
    const empresas = await Empresa.find(filtroEmpresasVisibles(req))
      .select('-certificado.contrasena')
      .sort({ nombreFantasia: 1 });
    
    // Agregar información adicional
    const empresasConInfo = empresas.map(empresa => {
      const infoCertificado = certificadoService.obtenerInfoCertificado(empresa.ruc);
      return {
        ...vistaEmpresa(req, empresa),
        certificadoEnFileSystem: infoCertificado?.existe || false
      };
    });
    
    res.json({
      success: true,
      data: empresasConInfo
    });
  } catch (error) {
    console.error('❌ Error listando empresas:', error);
    res.status(500).json({
      success: false,
      error: 'Error al listar empresas',
      message: error.message
    });
  }
};

/**
 * Obtener detalles de una empresa específica
 * GET /api/empresas/:id
 */
exports.obtener = async (req, res) => {
  try {
    const { id } = req.params;
    
    const empresa = await Empresa.findOne({
      _id: id,
      ...filtroEmpresasVisibles(req)
    }).select('-certificado.contrasena');
    
    if (!empresa) {
      return res.status(404).json({
        success: false,
        error: 'Empresa no encontrada'
      });
    }
    
    // Agregar información del certificado
    const infoCertificado = certificadoService.obtenerInfoCertificado(empresa.ruc);
    
    res.json({
      success: true,
      data: {
        ...vistaEmpresa(req, empresa),
        certificadoEnFileSystem: infoCertificado?.existe || false
      }
    });
  } catch (error) {
    console.error('❌ Error obteniendo empresa:', error);
    res.status(500).json({
      success: false,
      error: 'Error al obtener empresa',
      message: error.message
    });
  }
};

/**
 * Crear una nueva empresa
 * POST /api/empresas
 */
exports.crear = async (req, res) => {
  try {
    const {
      ruc,
      nombreFantasia,
      razonSocial,
      configuracionSifen,
      tipoContribuyente,
      tipoRegimen,
      actividadesEconomicas,
      establecimientos,
      notificaciones,
      direccion,
      telefono,
      email
    } = req.body;

    // Validar campos requeridos
    if (!ruc || !nombreFantasia || !razonSocial) {
      return res.status(400).json({
        success: false,
        error: 'RUC, nombre de fantasía y razón social son requeridos'
      });
    }

    const errorEmisor = validarDatosEmisor({ configuracionSifen, actividadesEconomicas, establecimientos });
    if (errorEmisor) {
      return res.status(400).json({ success: false, error: errorEmisor });
    }
    const errorNotif = await validarNotificaciones(notificaciones, req.usuario._id);
    if (errorNotif) {
      return res.status(400).json({ success: false, error: errorNotif });
    }

    // Limpiar RUC (eliminar guiones y otros caracteres no numéricos)
    const rucLimpio = ruc.replace(/[^0-9]/g, '');

    // Verificar RUC único
    const existe = await Empresa.findOne({ ruc: rucLimpio });
    if (existe) {
      return res.status(400).json({
        success: false,
        error: 'El RUC ya está registrado'
      });
    }

    // Crear empresa
    const empresa = new Empresa({
      ruc: rucLimpio,
      nombreFantasia,
      razonSocial,
      configuracionSifen,
      tipoContribuyente,
      tipoRegimen,
      actividadesEconomicas,
      establecimientos: normalizarEstablecimientos(establecimientos),
      notificaciones,
      direccion,
      telefono,
      email,
      usuarioId: req.usuario._id
    });

    await empresa.save();

    console.log(`✅ Empresa creada: ${nombreFantasia} (RUC: ${rucLimpio})`);

    res.status(201).json({
      success: true,
      message: 'Empresa creada exitosamente',
      data: empresa
    });
  } catch (error) {
    console.error('❌ Error creando empresa:', error);
    res.status(500).json({
      success: false,
      error: 'Error al crear empresa',
      message: error.message
    });
  }
};

/**
 * Actualizar empresa existente
 * PUT /api/empresas/:id
 */
exports.actualizar = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      ruc,
      nombreFantasia,
      razonSocial,
      configuracionSifen,
      tipoContribuyente,
      tipoRegimen,
      actividadesEconomicas,
      establecimientos,
      notificaciones,
      direccion,
      telefono,
      email,
      activo
    } = req.body;

    const errorEmisor = validarDatosEmisor({ configuracionSifen, actividadesEconomicas, establecimientos });
    if (errorEmisor) {
      return res.status(400).json({ success: false, error: errorEmisor });
    }
    const empresa = await Empresa.findOne({
      _id: id,
      ...filtroEmpresasAdministrables(req)
    });

    if (!empresa) {
      return res.status(404).json({
        success: false,
        error: 'Empresa no encontrada'
      });
    }

    // El proveedor SMTP tiene que ser del dueño de la empresa: quien edita
    // puede ser un administrador que no es el dueño.
    const errorNotif = await validarNotificaciones(notificaciones, empresa.usuarioId);
    if (errorNotif) {
      return res.status(400).json({ success: false, error: errorNotif });
    }

    // Actualizar RUC si se proporciona y es diferente
    if (ruc && ruc !== empresa.ruc) {
      // Limpiar RUC (eliminar guiones y otros caracteres no numéricos)
      const rucLimpio = ruc.replace(/[^0-9]/g, '');
      
      // Validar formato del RUC (6-12 dígitos)
      if (rucLimpio.length < 6 || rucLimpio.length > 12) {
        return res.status(400).json({
          success: false,
          error: 'RUC inválido. Debe tener entre 6-12 dígitos'
        });
      }
      
      // Verificar que el nuevo RUC no esté ya en uso por otra empresa
      const existeOtraEmpresa = await Empresa.findOne({
        ruc: rucLimpio,
        _id: { $ne: id }
      });
      
      if (existeOtraEmpresa) {
        return res.status(400).json({
          success: false,
          error: 'El RUC ya está registrado en otra empresa'
        });
      }
      
      empresa.ruc = rucLimpio;
      console.log('🔄 RUC actualizado:', empresa.ruc);
    }

    // Actualizar campos
    if (nombreFantasia) empresa.nombreFantasia = nombreFantasia;
    if (razonSocial) empresa.razonSocial = razonSocial;
    if (configuracionSifen) {
      // Validar CSC si se proporciona (debe ser 32 caracteres hexadecimales)
      if (configuracionSifen.csc) {
        const cscLimpio = configuracionSifen.csc.trim();
        if (!/^[0-9A-Fa-f]{32}$/.test(cscLimpio)) {
          return res.status(400).json({
            success: false,
            error: 'CSC inválido. Debe ser 32 caracteres hexadecimales'
          });
        }
        // OJO: el CSC es case-sensitive tal como lo entrega SET. Antes se
        // hacía toUpperCase() y el hash del QR (SHA-256 sobre el CSC) nunca
        // coincidía: SET rechazaba todo con "2501: hash del QR inválido".
        configuracionSifen.csc = cscLimpio;
      }
      // Validar timbrado si se proporciona (debe ser 8 dígitos)
      if (configuracionSifen.timbrado) {
        if (!/^\d{8}$/.test(configuracionSifen.timbrado)) {
          return res.status(400).json({
            success: false,
            error: 'Timbrado inválido. Debe ser 8 dígitos'
          });
        }
      }
      // Validar idCSC si se proporciona (1-4 dígitos)
      if (configuracionSifen.idCSC) {
        if (!/^\d{1,4}$/.test(configuracionSifen.idCSC)) {
          return res.status(400).json({
            success: false,
            error: 'ID CSC inválido. Debe ser 1-4 dígitos'
          });
        }
      }
      // Validar modo si se proporciona
      if (configuracionSifen.modo && !['test', 'produccion'].includes(configuracionSifen.modo)) {
        return res.status(400).json({
          success: false,
          error: 'Modo inválido. Debe ser "test" o "produccion"'
        });
      }
      // Actualizar configuración SIFEN manteniendo valores existentes
      empresa.configuracionSifen = {
        ...empresa.configuracionSifen,
        ...configuracionSifen
      };
    }
    if (notificaciones !== undefined) {
      empresa.notificaciones = {
        ...(empresa.notificaciones?.toObject ? empresa.notificaciones.toObject() : empresa.notificaciones),
        ...notificaciones
      };
    }
    if (tipoContribuyente !== undefined) empresa.tipoContribuyente = tipoContribuyente;
    if (tipoRegimen !== undefined) empresa.tipoRegimen = tipoRegimen || undefined;
    if (actividadesEconomicas !== undefined) empresa.actividadesEconomicas = actividadesEconomicas;
    if (establecimientos !== undefined) empresa.establecimientos = normalizarEstablecimientos(establecimientos);
    if (direccion !== undefined) empresa.direccion = direccion;
    if (telefono !== undefined) empresa.telefono = telefono;
    if (email !== undefined) empresa.email = email;
    if (activo !== undefined) empresa.activo = activo;

    await empresa.save();

    res.json({
      success: true,
      message: 'Empresa actualizada exitosamente',
      data: empresa
    });
  } catch (error) {
    console.error('❌ Error actualizando empresa:', error.message);
    res.status(500).json({
      success: false,
      error: 'Error al actualizar empresa',
      message: error.message
    });
  }
};

/**
 * Subir/actualizar certificado digital
 * POST /api/empresas/:id/certificado
 */
exports.subirCertificado = async (req, res) => {
  try {
    const { id } = req.params;
    const { contrasena } = req.body;
    
    // Validar contraseña
    if (!contrasena) {
      return res.status(400).json({
        success: false,
        error: 'La contraseña del certificado es requerida'
      });
    }
    
    // Validar archivo
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No se recibió el archivo del certificado'
      });
    }
    
    const empresa = await Empresa.findOne({
      _id: id,
      ...filtroEmpresasAdministrables(req)
    });
    
    if (!empresa) {
      return res.status(404).json({
        success: false,
        error: 'Empresa no encontrada'
      });
    }
    
    // Guardar archivo .p12
    certificadoService.guardarCertificado(empresa.ruc, req.file.buffer);
    
    // Actualizar metadatos del certificado
    empresa.certificado = {
      nombreArchivo: req.file.originalname,
      contrasena: certificadoService.cifrarContrasena(contrasena),
      fechaCarga: new Date(),
      activo: true
    };
    
    // Nota: fechaVencimiento debería extraerse del certificado
    // Por ahora se deja null, se puede implementar con openssl
    
    await empresa.save();
    
    console.log(`✅ Certificado cargado para empresa: ${empresa.nombreFantasia}`);
    
    res.json({
      success: true,
      message: 'Certificado cargado exitosamente',
      data: {
        nombreArchivo: req.file.originalname,
        fechaCarga: empresa.certificado.fechaCarga
      }
    });
  } catch (error) {
    console.error('❌ Error subiendo certificado:', error);
    res.status(500).json({
      success: false,
      error: 'Error al subir certificado',
      message: error.message
    });
  }
};

/**
 * Validar certificado de una empresa
 * GET /api/empresas/:id/validar-certificado
 */
exports.validarCertificado = async (req, res) => {
  try {
    const { id } = req.params;
    
    const empresa = await Empresa.findOne({
      _id: id,
      ...filtroEmpresasVisibles(req)
    });
    
    if (!empresa) {
      return res.status(404).json({
        success: false,
        error: 'Empresa no encontrada'
      });
    }
    
    // Verificar certificado
    const tieneCertificado = empresa.tieneCertificadoValido();
    const infoCertificado = certificadoService.obtenerInfoCertificado(empresa.ruc);
    
    res.json({
      success: true,
      data: {
        tieneCertificado,
        certificadoActivo: empresa.certificado?.activo || false,
        certificadoEnFileSystem: infoCertificado?.existe || false,
        fechaVencimiento: empresa.certificado?.fechaVencimiento,
        fechaCarga: empresa.certificado?.fechaCarga,
        nombreArchivo: empresa.certificado?.nombreArchivo,
        infoAdicional: infoCertificado
      }
    });
  } catch (error) {
    console.error('❌ Error validando certificado:', error);
    res.status(500).json({
      success: false,
      error: 'Error al validar certificado',
      message: error.message
    });
  }
};

/**
 * Eliminar empresa
 * DELETE /api/empresas/:id
 */
exports.eliminar = async (req, res) => {
  try {
    const { id } = req.params;
    
    const empresa = await Empresa.findOne({
      _id: id,
      ...filtroEmpresasAdministrables(req)
    });
    
    if (!empresa) {
      return res.status(404).json({
        success: false,
        error: 'Empresa no encontrada'
      });
    }
    
    // Verificar dependencias
    const [facturasCount, lotesCount, eventosCount, apiKeysCount] = await Promise.all([
      Invoice.countDocuments({ empresaId: empresa._id }),
      LoteEnvio.countDocuments({ empresaId: empresa._id }),
      Evento.countDocuments({ empresaId: empresa._id }),
      ApiKey.countDocuments({ empresaId: empresa._id })
    ]);

    const dependencias = [];
    if (facturasCount > 0) dependencias.push(`${facturasCount} factura(s)`);
    if (lotesCount > 0) dependencias.push(`${lotesCount} lote(s) de envío`);
    if (eventosCount > 0) dependencias.push(`${eventosCount} evento(s)`);
    if (apiKeysCount > 0) dependencias.push(`${apiKeysCount} clave(s) de API`);

    if (dependencias.length > 0) {
      return res.status(400).json({
        success: false,
        error: `No se puede eliminar: la empresa tiene ${dependencias.join(', ')} asociada(s)`,
        mensaje: 'Elimine o reasigne los registros dependientes antes de eliminar la empresa',
        dependencias: {
          facturas: facturasCount,
          lotes: lotesCount,
          eventos: eventosCount,
          apiKeys: apiKeysCount
        }
      });
    }
    
    // Eliminar certificado del filesystem
    certificadoService.eliminarCertificado(empresa.ruc);
    
    // Eliminar empresa
    await Empresa.deleteOne({ _id: id });
    
    console.log(`🗑️ Empresa eliminada: ${empresa.nombreFantasia} (RUC: ${empresa.ruc})`);
    
    res.json({
      success: true,
      message: 'Empresa eliminada correctamente'
    });
  } catch (error) {
    console.error('❌ Error eliminando empresa:', error);
    res.status(500).json({
      success: false,
      error: 'Error al eliminar empresa',
      message: error.message
    });
  }
};

/**
 * Obtener estadísticas de una empresa
 * GET /api/empresas/:id/stats
 */
exports.obtenerStats = async (req, res) => {
  try {
    const { id } = req.params;
    
    const empresa = await Empresa.findOne({
      _id: id,
      ...filtroEmpresasVisibles(req)
    });
    
    if (!empresa) {
      return res.status(404).json({
        success: false,
        error: 'Empresa no encontrada'
      });
    }
    
    // Obtener estadísticas de facturas
    const totalFacturas = await Invoice.countDocuments({ empresaId: empresa._id });
    
    const facturasPorEstado = await Invoice.aggregate([
      { $match: { empresaId: empresa._id } },
      { $group: { _id: '$estadoSifen', count: { $sum: 1 } } }
    ]);
    
    const ultimaFactura = await Invoice.findOne({ empresaId: empresa._id })
      .sort({ fechaCreacion: -1 })
      .select('fechaCreacion correlativo');
    
    res.json({
      success: true,
      data: {
        empresa: {
          nombreFantasia: empresa.nombreFantasia,
          ruc: empresa.ruc
        },
        totalFacturas,
        facturasPorEstado,
        ultimaFactura
      }
    });
  } catch (error) {
    console.error('❌ Error obteniendo estadísticas:', error);
    res.status(500).json({
      success: false,
      error: 'Error al obtener estadísticas',
      message: error.message
    });
  }
};
