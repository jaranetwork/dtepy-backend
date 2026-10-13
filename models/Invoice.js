const mongoose = require('mongoose');
const crypto = require('crypto');

const invoiceSchema = new mongoose.Schema({
  // ========================================
  // CAMPOS MULTI-EMPRESA (NUEVOS)
  // ========================================
  empresaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Empresa',
    required: false,  // false temporalmente para migración
    index: true
  },
  rucEmpresa: {
    type: String,
    required: false,  // false temporalmente para migración
    index: true
  },
  
  // ========================================
  // CAMPOS EXISTENTES
  // ========================================
  correlativo: {
    type: String,
    required: true
    // Quitamos unique: true - El correlativo puede repetirse si hay errores de carga
    // El hash es lo que realmente debe ser único
  },
  cliente: {
    type: Object,
    default: {}
  },
  total: {
    type: Number,
    default: 0
  },
  fechaCreacion: {
    type: Date,
    default: Date.now
  },
  estadoSifen: {
    type: String,
    enum: ['recibido', 'procesando', 'enviado', 'aceptado', 'rechazado', 'error', 'encolado', 'observado', 'cancelado'],
    default: 'recibido'
  },
  fechaEnvio: {
    type: Date
  },
  fechaProceso: {
    type: String  // Fecha de proceso devuelta por SIFEN (Manual Técnico v150)
  },
  qrCode: {
    type: String
  },
  xmlPath: {
    type: String
  },
  cdc: {
    type: String  // Código de Control del Documento (44 caracteres)
  },
  digestValue: {
    type: String  // DigestValue de la firma digital
  },
  codigoRetorno: {
    type: String  // Código de retorno de SIFEN (4 dígitos) - Legacy
  },
  mensajeRetorno: {
    type: String  // Mensaje de retorno de SIFEN - Legacy
  },
  // ========================================
  // CAMPOS PARA RESPUESTA SIFEN v150 (Síncrono)
  // ========================================
  respuestaSifen: {
    codigo: {
      type: String,  // dCodRes - Código de resultado del procesamiento
      index: true
    },
    estado: {
      type: String,  // dEstRes - Estado del resultado (Aprobado/Rechazado)
      index: true
    },
    mensaje: {
      type: String  // dMsgRes - Mensaje descriptivo del resultado
    },
    fechaProceso: {
      type: String  // dFecProc - Fecha y hora de procesamiento
    },
    digestValue: {
      type: String  // dDigVal - Digest Value de la respuesta
    },
    protocolo: {
      type: String  // dProtAut - Número de protocolo de autorización (comprobante de que SET aprobó el DTE)
    }
  },
  // Estado visual para el frontend (según código de retorno)
  estadoVisual: {
    type: String,
    enum: ['aceptado', 'observado', 'rechazado', 'error'],
    default: 'rechazado'
  },
  kudePath: {
    type: String  // Ruta del archivo PDF KUDE generado
  },
  datosFactura: {
    type: Object,
    default: {}
  },
  xmlContent: {
    type: String  // Contenido del XML firmado con QR antes de enviar a SET
  },
  facturaHash: {
    type: String,
    required: true,
    unique: true  // ← El hash SÍ debe ser único (combina todos los campos oficiales)
  },
  // Header Idempotency-Key con que la integración pidió la emisión. Una
  // repetición con la misma clave devuelve esta factura en vez de crear otra
  // (facturaService.crearFactura). No es único: tras un rechazo o una
  // cancelación la misma clave emite de nuevo y manda la más reciente vigente.
  claveIdempotencia: {
    type: String,
    index: true,
    sparse: true
  },
  // ========================================
  // CAMPO PARA CONTROL DE PROCESO
  // ========================================
  // Permite recrear factura cuando XML/PDF no se completó
  proceso: {
    type: String,
    enum: ['Completado', 'No completado', null],
    default: null,
    index: true
  },
  // ========================================
  // CAMPOS PARA CONTINGENCIA / LOTES
  // ========================================
  tipoEmision: {
    type: Number,
    enum: [1, 2],
    default: 1
  },
  grupoLoteId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LoteEnvio',
    index: true
  },
  // ========================================
  // CAMPO DE (DESCRIPCIÓN DEL TIPO DE DOCUMENTO)
  // ========================================
  de: {
    type: String,
    required: false,
    default: 'Factura electrónica'
  }
}, {
  timestamps: true
});

// Índice único en el hash de la factura (no en el correlativo)
invoiceSchema.index({ facturaHash: 1 }, { unique: true });

// Índice compuesto para búsquedas rápidas por empresa
invoiceSchema.index({ rucEmpresa: 1, fechaCreacion: -1 });

// ========================================
// PROPIEDADES VIRTUALES
// ========================================
// Virtual para 'estado' como alias de 'estadoSifen' (para consistencia con la API)
invoiceSchema.virtual('estado').get(function() {
  return this.estadoSifen;
});

// Asegurar que los virtuales se incluyan en las respuestas JSON
invoiceSchema.set('toJSON', { virtuals: true });
invoiceSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Invoice', invoiceSchema);
