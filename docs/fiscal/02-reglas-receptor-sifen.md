# Reglas del receptor SIFEN (vigentes a 09/2026)

Consolidado del Manual Técnico v150 con las Notas Técnicas que tocan al receptor: NT 2, 3, 5, 10, 17, 20, 21, 23, 24, 27. Cada regla lleva su **código de rechazo real** de SIFEN. Nuestra validación debe replicar esto ANTES de firmar.

## Campos (grupo D200) → nombres en dte-api

| SIFEN | dte-api | Regla | Rechazo |
|---|---|---|---|
| `iNatRec` | `contribuyente` | 1 = contribuyente, 2 = no contribuyente. Nat. 2 → solo B2C o B2F | 1300 |
| `iTiOpe` | `tipoOperacion` | 1 B2B · 2 B2C · 3 B2G · 4 B2F (solo servicios al exterior). RUC estatal → B2G obligatorio | 1332 |
| `cPaisRec` | `pais` | **B2F → ≠ PRY. Todo lo demás → = PRY obligatorio** (aunque el cliente sea extranjero) | 1320 |
| `iTiContRec` | `tipoContribuyente` | Obligatorio si nat. 1 (1 PF, 2 PJ); prohibido si nat. 2 | 1302 / 1303 |
| `dRucRec`+`dDVRec` | `ruc` (con guión) | Obligatorio si nat. 1; prohibido si nat. 2; debe **existir en Marangatú**; PJ y B2B/B2G: estado activo; **DV módulo 11** | 1304 / 1305 / 1306 / 1307 / 1308 / 1309 |
| `iTipIDRec` | `documentoTipo` | Obligatorio si nat. 2; prohibido si nat. 1. Catálogo: 1 CI py · 2 pasaporte · 3 cédula extranjera · 4 carnet residencia · 5 innominado · 6 tarjeta diplomática · 9 otro. Desde NT 23 también permitido en B2F | 1310 / 1335 / 1311 |
| `dNumIDRec` | `documentoNumero` | Obligatorio si nat. 2; prohibido si nat. 1; innominado → `"0"`; 1–20 chars; xmlgen rechaza `.` y `/` | 1314 / 1334 |
| `dNomRec` | `razonSocial` | Siempre obligatorio, 4–255; innominado → `"Sin Nombre"` | — |
| `dDirRec`+`dNumCasRec` | `direccion`/`numeroCasa` | Dirección obligatoria en B2F y nota de remisión; con dirección → número de casa obligatorio. Depto/distrito/ciudad ya NO obligatorios (NT 3 eliminó 1324/1327); en B2F NO informarlos | 1318 / 1330 |
| `dTelRec`/`dCelRec`/`dEmailRec` | `telefono`/`celular`/`email` | 6–15 (tel, con prefijo si PRY) / 10–20 / 3–80. El email habilita envío automático del KUDE | — |
| — | `documentoTipoDescripcion` | Obligatorio si `documentoTipo 9` (texto libre del tipo de documento) | 1312 |

## Innominado — umbrales (Decreto 872/2023 art. 6)

| Vigencia | Regla |
|---|---|
| hasta 2023 | ≥ 60.000.000 ₲ → nominada |
| 2024 | ≥ 35.000.000 ₲ → nominada (NT 21) |
| **desde 01/01/2025 (vigente)** | **≥ 7.000.000 ₲ → nominada** (NT 24, rechazo **1321**) |

- Se evalúa sobre el total en ₲ (`F014`) o su equivalente si la moneda es extranjera (`F023`) → con USD, convertir antes de decidir.
- Innominado **solo en B2C** (1319/1333). **B2B, B2G y B2F: nominadas siempre**, a cualquier monto.
- NC / ND / Nota de remisión: receptor **nunca** innominado (1331, NT 10 + NT 23).
- Bajo el umbral, el cliente igual puede exigir factura nominada (Decreto 872/23 art. 6).

## Evento de nominación (NT 14 + NT 27; Decreto 872/23 art. 33)

Permite ponerle receptor a una **factura ya aprobada que salió innominada**. Obligatorio antes de emitirle NC/ND.
- Solo sobre facturas emitidas innominadas (rechazo 4469), solo **una vez** por CDC (4453), solo facturas (4454).
- Payload = mismos campos del receptor, mismas validaciones (Marangatú 4461, DV 4463, país 4476: PRY salvo B2F).
- **dte-api aún no soporta este evento** (gap conocido).

## Otras reglas cruzadas

- Autofactura: receptor contribuyente, B2C, RUC receptor = RUC emisor (1315/1316/1317).
- Ente estatal (OEE) como receptor → B2G obligatorio (1332, NT 20).
- Innominado permitido a cualquier monto solo para muestras médicas (transacción 13).

## Fuentes

- Manual Técnico v150 (campos D200–D299 pág. 70–73; validaciones receptor pág. 165–167): https://www.dnit.gov.py/documents/20123/420592/Manual+T%C3%A9cnico+Versi%C3%B3n+150.pdf
- Notas Técnicas (índice oficial DNIT): https://www.dnit.gov.py/en/web/e-kuatia/documentacion-tecnica
  - NT 23 (rehace reglas de documento de identidad, 1331/1333/1334/1335): https://www.dnit.gov.py/documents/20123/420595/NT_E_KUATIA_023_MT_V150.pdf
  - NT 24 (umbral 7M vigente): https://www.dnit.gov.py/documents/20123/420595/NT_E_KUATIA_024_MT_V150.pdf
  - NT 14 (evento de nominación) y NT 27 (ajuste doc types del evento): mismo índice.
- Decreto 872/2023 arts. 6, 33, 47: https://lexparaguaya.com/docs/decreto-n-872-2023
