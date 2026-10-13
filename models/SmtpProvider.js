const mongoose = require('mongoose');

/**
 * Proveedor SMTP configurable desde la UI. Cada empresa puede seleccionar
 * uno (empresa.notificaciones.smtpProviderId) para el envío automático del
 * KUDE por email. Si la empresa no tiene proveedor asignado, se usan las
 * variables de entorno SMTP_* como fallback.
 *
 * La contraseña se guarda cifrada (AES-256-GCM) con la misma master key
 * que la contraseña del certificado: certificadoService.cifrarContrasena().
 */
const smtpProviderSchema = new mongoose.Schema({
  nombre: {
    type: String,
    required: true,
    trim: true
  },
  host: {
    type: String,
    required: true,
    trim: true
  },
  puerto: {
    type: Number,
    default: 587,
    min: 1,
    max: 65535
  },
  // true = TLS directo (puerto 465); false = STARTTLS (587/25)
  seguro: {
    type: Boolean,
    default: false
  },
  usuario: {
    type: String,
    required: true,
    trim: true
  },
  // Cifrada con certificadoService.cifrarContrasena(): nunca se guarda ni
  // se devuelve en texto plano.
  contrasena: {
    type: String,
    required: true
  },
  // Dirección "From" de los emails. Si falta, se usa el usuario SMTP.
  remitente: {
    type: String,
    trim: true
  },
  // false = aceptar certificados autofirmados/inválidos (rejectUnauthorized
  // false), necesario para servidores propios como poste.io sin cert firmado.
  validarCertificado: {
    type: Boolean,
    default: true
  },
  usuarioId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  activo: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Configuración de nodemailer para este proveedor. requireTLS en los puertos
// STARTTLS garantiza que las credenciales nunca viajen en texto plano.
smtpProviderSchema.methods.opcionesTransporte = function(contrasenaPlana) {
  return {
    host: this.host,
    port: this.puerto,
    secure: this.seguro,
    requireTLS: !this.seguro,
    auth: { user: this.usuario, pass: contrasenaPlana },
    ...(this.validarCertificado === false ? { tls: { rejectUnauthorized: false } } : {})
  };
};

module.exports = mongoose.model('SmtpProvider', smtpProviderSchema);
