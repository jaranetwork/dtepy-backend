const mongoose = require('mongoose');

const operationLogSchema = new mongoose.Schema({
  invoiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice',
    required: true
  },
  tipoOperacion: {
    type: String,
    required: true,
    enum: ['inicio_proceso', 'validacion_receptor', 'generacion_xml', 'firma_xml', 'envio_sifen', 'respuesta_sifen', 'error', 'envio_exitoso', 'reintento', 'reintento_respuesta', 'actualizacion_estado', 'consulta_estado', 'error_consulta_estado', 'error_respuesta_set', 'encolado_lote', 'envio_lote']
  },
  descripcion: {
    type: String,
    required: true
  },
  detalle: {
    type: Object,
    default: {}
  },
  fecha: {
    type: Date,
    default: Date.now
  },
  estado: {
    type: String,
    enum: ['success', 'error', 'warning'],
    default: 'success'
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('OperationLog', operationLogSchema);