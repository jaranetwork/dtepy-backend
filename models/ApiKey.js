const mongoose = require('mongoose');
const crypto = require('crypto');

const apiKeySchema = new mongoose.Schema({
  // Texto plano de la key: SOLO transitorio (creación/renovación).
  // El hook pre-save deriva keyHash + keyParcial y lo descarta:
  // la key en claro nunca se persiste en la base de datos.
  key: {
    type: String
  },
  keyHash: {
    type: String,
    index: true
  },
  // Prefijo/sufijo para identificar la key en listados (ej: "a1b2c3d4...e5f6a7b8")
  keyParcial: {
    type: String
  },
  nombre: {
    type: String,
    required: true,
    trim: true
  },
  descripcion: {
    type: String,
    trim: true
  },
  usuario: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // NUEVO: Empresa asociada (opcional)
  // Si es null, la key funciona para todas las empresas del usuario
  empresaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Empresa',
    default: null,
    index: true
  },
  permisos: {
    type: [String],
    // 'cotizaciones:editar' NO va en los defaults: declarar cotizaciones vía
    // API es un permiso explícito (pensado para un actualizador automático).
    enum: ['facturas:crear', 'facturas:leer', 'facturas:eliminar', 'stats:leer', 'cotizaciones:editar', 'admin'],
    default: ['facturas:crear', 'facturas:leer', 'stats:leer']
  },
  activa: {
    type: Boolean,
    default: true
  },
  expiracion: {
    type: Date
  },
  ultimoUso: {
    type: Date
  },
  ipOrigen: {
    type: String
  },
  fechaCreacion: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Método para verificar si la API key es válida
apiKeySchema.methods.verificarKey = function(key) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return this.keyHash === hash;
};

// Método estático para encontrar una API key por el valor plano
apiKeySchema.statics.encontrarPorKey = async function(key) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return await this.findOne({ keyHash: hash, activa: true });
};

// Hook pre-save: deriva hash + parcial y descarta el texto plano
apiKeySchema.pre('save', function(next) {
  // Documento nuevo sin key explícita: generarla
  if (this.isNew && !this.key) {
    this.key = crypto.randomBytes(32).toString('hex');
  }

  // Hay una key en texto plano (creación, renovación, o documento viejo
  // todavía sin migrar): derivar lo necesario y no guardarla nunca.
  if (this.key) {
    this.keyHash = crypto.createHash('sha256').update(this.key).digest('hex');
    this.keyParcial = `${this.key.substring(0, 8)}...${this.key.substring(this.key.length - 8)}`;
    this._plainKey = this.key; // solo en memoria: para mostrarla una única vez
    this.key = undefined;      // nunca se persiste
  }

  next();
});

module.exports = mongoose.model('ApiKey', apiKeySchema);
