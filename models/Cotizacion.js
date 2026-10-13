const mongoose = require('mongoose');

/**
 * Cotización de moneda extranjera declarada por el usuario.
 *
 * Cada declaración crea un documento nuevo (historial completo, con quién y
 * cuándo — respaldo contable). La cotización "vigente" de una moneda es la
 * última declarada para esa empresa. El valor es en guaraníes por unidad de
 * la moneda (ej.: USD 7300 = 7.300 Gs por dólar).
 */
const cotizacionSchema = new mongoose.Schema({
  empresaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Empresa',
    required: true,
    index: true
  },
  moneda: {
    type: String,
    required: true,
    uppercase: true,
    trim: true,
    minlength: 3,
    maxlength: 3
  },
  valor: {
    type: Number,
    required: true,
    min: [0.000001, 'La cotización debe ser mayor a 0']
  },
  // Quién la declaró (sesión de usuario, API Key o el sincronizador automático)
  declaradaPor: {
    tipo: { type: String, enum: ['usuario', 'api_key', 'automatica'], required: true },
    nombre: { type: String, default: '' },
    email: { type: String, default: '' }
  },
  // Solo en las automáticas: de dónde salió el valor. `fechaCotizacion` es la
  // fecha que publicó la fuente (en Paraguay rige al día siguiente), y es la
  // que hace idempotente la sincronización.
  fuente: {
    proveedor: { type: String },
    fechaCotizacion: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    tipoValor: { type: String, enum: ['compra', 'venta', 'promedio'] },
    url: { type: String }
  }
}, {
  timestamps: true
});

// La vigente se busca por empresa+moneda ordenando por fecha de creación
cotizacionSchema.index({ empresaId: 1, moneda: 1, createdAt: -1 });

// Acá había un índice ÚNICO por empresa+moneda+fecha de la fuente. Servía para
// que dos ticks simultáneos no duplicaran la declaración, pero también impedía
// volver a declarar la misma fecha con otras reglas: cambiar "venta" por
// "compra" chocaba contra el índice y la sincronización no aplicaba nada.
// Una redeclaración es una declaración nueva y tiene que quedar en el historial
// con su propio valor, quién y cuándo. La exclusión entre corridas ahora la da
// el lock por empresa de cotizacionSyncService (`sincronizandoDesde`).
// El índice viejo se elimina con migrations/003-cotizaciones-sin-indice-unico.js.

module.exports = mongoose.model('Cotizacion', cotizacionSchema);
