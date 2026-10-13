const mongoose = require('mongoose');

/**
 * Contador atómico de numeración correlativa de documentos electrónicos.
 *
 * La numeración es por timbrado + tipo de documento + establecimiento +
 * punto de expedición (cada tipo de comprobante lleva su propia secuencia,
 * y al renovar el timbrado la secuencia arranca de nuevo en 0000001).
 * Se incrementa con findOneAndUpdate + $inc: dos emisiones concurrentes
 * jamás reciben el mismo número.
 */
const secuenciaFacturaSchema = new mongoose.Schema({
  empresaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Empresa',
    required: true
  },
  timbrado: {
    type: String,
    required: true
  },
  tipoDocumento: {
    type: Number,
    required: true
  },
  establecimiento: {
    type: String,
    required: true
  },
  punto: {
    type: String,
    required: true
  },
  ultimoNumero: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

secuenciaFacturaSchema.index(
  { empresaId: 1, timbrado: 1, tipoDocumento: 1, establecimiento: 1, punto: 1 },
  { unique: true }
);

module.exports = mongoose.model('SecuenciaFactura', secuenciaFacturaSchema);
