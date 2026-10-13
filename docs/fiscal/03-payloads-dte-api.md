# Payloads por caso — `POST /api/facturar/crear` (data.cliente)

Verificados contra el spec de dte-api y el código de `facturacionelectronicapy-xmlgen` (que es quien mapea a los campos SIFEN). Regla general: `contribuyente: true` → solo `ruc` + `tipoContribuyente`; `contribuyente: false` → solo `documentoTipo` + `documentoNumero`. Nunca mezclar (rechazos 1305/1311/1334).

## 1. Paraguayo sin RUC (B2C, IVA normal)

```json
"cliente": {
  "contribuyente": false,
  "tipoOperacion": 2,
  "pais": "PRY",
  "documentoTipo": 1,
  "documentoNumero": "4123456",
  "razonSocial": "JUAN PEREZ GONZALEZ",
  "email": "juan@example.com"
}
```

## 2. Extranjero no residente con pasaporte (B2C, IVA normal — fuera de RTC)

```json
"cliente": {
  "contribuyente": false,
  "tipoOperacion": 2,
  "pais": "PRY",
  "documentoTipo": 2,
  "documentoNumero": "FP123456",
  "razonSocial": "JOAO PEREIRA DA SILVA",
  "email": "joao@example.com"
},
"observacion": "Cliente extranjero no residente. Pasaporte emitido por: Brasil. País de residencia: Brasil."
```

- `pais` es `PRY` obligatorio (regla 1320) — la extranjería la registra `documentoTipo` 2/3.
- Pasaporte normalizado: mayúsculas, sin puntos, barras ni espacios.
- `observacion` va a `dInfoEmi` (info de interés del emisor) — soportado por xmlgen aunque el spec no lo documente.
- Cédula MERCOSUR en vez de pasaporte → `documentoTipo: 3`. Carnet de residencia → `4`.

## 3. Turista RTC (B2C, EXENTO — solo empresa inscripta + bien del anexo)

```json
"cliente": {
  "contribuyente": false,
  "tipoOperacion": 2,
  "pais": "PRY",
  "documentoTipo": 2,
  "documentoNumero": "FP123456",
  "razonSocial": "JOAO PEREIRA DA SILVA",
  "email": "joao@example.com"
},
"observacion": "Régimen de Turismo de Compras - Decreto N° 2063/2024. País de residencia: Brasil.",
"items": [
  { "...": "...", "ivaTipo": 3, "ivaBase": 0, "iva": 0 }
]
```

- Ítems RTC exentos: `ivaTipo 3, ivaBase 0` (xmlgen exige base 0 con tipo 2 o 3).
- Empresa emisora con `tipoRegimen: 1` (Régimen de Turismo).
- Nunca innominada; si el comprador es residente PY → caso 1/4 con IVA 10%.

## 4. Contribuyente con RUC (B2B, IVA normal)

```json
"cliente": {
  "contribuyente": true,
  "tipoOperacion": 1,
  "pais": "PRY",
  "ruc": "80012345-6",
  "tipoContribuyente": 2,
  "razonSocial": "EMPRESA EJEMPLO S.A.",
  "email": "facturas@empresa.com.py"
}
```

- RUC **con guión** (xmlgen hace split por `-`; sin guión firma `dDVRec="undefined"`).
- Antes de emitir: `GET /api/consulta/ruc/80012345` → debe existir y estar activo (SIFEN valida contra Marangatú, rechazos 1306–1308). Usar la razón social del padrón.
- Ente estatal → `tipoOperacion: 3` (B2G, rechazo 1332 si no).

## 5. Servicio al exterior (B2F, no gravado)

```json
"cliente": {
  "contribuyente": false,
  "tipoOperacion": 4,
  "pais": "BRA",
  "documentoTipo": 2,
  "documentoNumero": "FP123456",
  "razonSocial": "ACME DIGITAL LTDA",
  "direccion": "Av. Paulista 1000, Sao Paulo",
  "numeroCasa": "1000"
}
```

- País **real** ≠ PRY (1320). Dirección + número de casa obligatorios (1318/1330). **Sin** departamento/distrito/ciudad.
- Tax ID en vez de pasaporte → `documentoTipo: 9` + `documentoTipoDescripcion: "CNPJ"`.

## 6. Consumidor final sin identificar (B2C < 7.000.000 ₲)

```json
"cliente": {
  "contribuyente": false,
  "tipoOperacion": 2,
  "pais": "PRY",
  "documentoTipo": 5,
  "documentoNumero": "0",
  "razonSocial": "Sin Nombre"
}
```

- Solo B2C y solo si el total < 7.000.000 ₲ (equivalente en ₲ si es USD) — rechazo 1321.
- Corregible después una única vez con el evento de nominación (dte-api aún no lo soporta).

## Trampas conocidas del backend actual

- Ningún campo se valida antes de xmlgen: documento faltante → `dNumIDRec: "undefined"` firmado; país fuera de catálogo → TypeError.
- El DV del RUC no se recalcula: se confía en lo que llega tras el guión.
- La descripción vieja del spec ("tipoOperacion 4 = turista RTC") es incorrecta: el turista es B2C (caso 2/3), B2F es solo servicios.
