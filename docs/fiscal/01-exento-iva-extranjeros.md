# Exento de IVA a extranjeros: RTC y B2F

## 1. RTC — Régimen de Turismo de Compras

**Qué es**: régimen especial donde el importador paga el IVA en aduana sobre base imponible reducida del **12,5%** (efectivo 1,25%) como **pago único y definitivo**, y la **venta al turista sale exenta de IVA**.

**Marco vigente**:
- Decreto **2063/2024** — crea el RTC, deroga el 1931/2019.
- Decreto **3237/2025** — modifica y amplía el 2063/2024.
- **RG DNIT 26/2025** — reglamenta la inscripción en el Registro RTC.
- **RG DNIT 27/2025** — medidas administrativas (transición: operaciones con beneficio hasta 30/04/2025 bajo régimen viejo; desde 01/05/2025 solo inscriptos según RG 26/25).

**Requisitos para que UNA venta califique (todos a la vez)**:
1. Vendedor **inscripto en el Registro RTC** (vigencia 2 años, renovable a pedido).
2. Local en ciudad habilitada: **Asunción, Ciudad del Este, Encarnación, Pedro Juan Caballero, Pilar, Salto del Guairá**.
3. Bien incluido en el **anexo del Decreto 2063/2024** (485 códigos NCM — el Decreto 3237/2025 NO modificó la lista, solo los requisitos del importador). Lista completa y exclusiones: [04-anexo-rtc.md](04-anexo-rtc.md) + [anexo-rtc-ncm.csv](anexo-rtc-ncm.csv).
4. Comprador **turista**: persona física + extranjera (sin nacionalidad paraguaya) + **sin domicilio ni residencia en Paraguay**. Se acredita con pasaporte o documento de identidad de su país.

**Cómo se factura (en SIFEN no hay campo "RTC")**:
- Factura electrónica **B2C** (`tipoOperacion 2`), naturaleza no contribuyente.
- Documento: `2` pasaporte o `3` cédula extranjera. **Nunca innominada.**
- País del receptor: `PRY` (regla 1320 — ver 02).
- Ítems RTC: **`ivaTipo 3` (exento), `ivaBase 0`**.
- En `observacion`: leyenda del régimen + país de residencia. Ej.: `"Régimen de Turismo de Compras – Decreto N° 2063/2024. País de residencia: Brasil."`
- Empresa emisora con `tipoRegimen 1` (Régimen de Turismo) en su configuración.

**Prohibido**: vender bajo RTC a residentes en Paraguay o con factura innominada → la DNIT **reliquida el IVA al régimen general y sanciona**. A un residente se le vende con IVA 10% base completa.

**Fuentes**:
- Normativas del Régimen de Turismo (DNIT, lista oficial): https://www.dnit.gov.py/en/web/portal-institucional/normativas1
- Decreto 2063/2024 (texto): https://cdap.org.py/wp-content/uploads/2024/09/DECRETO2063_24.pdf
- Análisis Vouga Abogados: https://www.vouga.com.py/el-poder-ejecutivo-establece-el-regimen-de-turismo-de-compras/
- Gosocket (resumen 2063/24): https://gosocket.net/centro-de-recursos/se-emite-el-decreto-no-2063-que-crea-y-reglamenta-el-regimen-de-turismo-y-compras-rtc/
- RG 27/25 (transición): https://www.dnit.gov.py/en/web/portal-institucional/w/resolucion-general-dnit-n.-27/25

## 2. B2F — exportación de servicios

**Qué es**: servicio prestado desde Paraguay a una persona o empresa del exterior (desarrollo, SaaS, consultoría, etc.), utilizado/aprovechado en el exterior. No gravado por IVA.

**Cómo se factura**:
- `tipoOperacion 4` (B2F), naturaleza **no contribuyente** (regla 1300).
- País del receptor: **el real** (`BRA`, `USA`, …) — B2F es el ÚNICO caso con país ≠ PRY (regla 1320).
- **Dirección del exterior obligatoria** (regla 1318) + número de casa (regla 1330). **Sin** departamento/distrito/ciudad.
- Documento: desde NT 23 se puede (y conviene) informar — `2` pasaporte o `9` otro + `documentoTipoDescripcion` (ej. "CNPJ", "Tax ID").
- **Nunca innominada** (Decreto 872/2023 art. 6).
- Ítems: no gravados (exento).

**NO usar B2F para**: venta de bienes a turistas (eso es B2C, y si no es RTC lleva IVA 10%). B2F solo servicios — lo dice el propio campo D202 del manual: "esta última opción debe utilizarse solo en caso de servicios para empresas o personas físicas del exterior".

**Fuentes**:
- Manual Técnico v150, campo D202 (pág. 71) y validación 1320 (pág. 165): https://www.dnit.gov.py/documents/20123/420592/Manual+T%C3%A9cnico+Versi%C3%B3n+150.pdf
- NT 23 (documento en B2F): https://www.dnit.gov.py/documents/20123/420595/NT_E_KUATIA_023_MT_V150.pdf

## 3. Lo que NO existe: "tax free" con devolución

Paraguay **no tiene** devolución de IVA a turistas en frontera/aeropuerto (a diferencia de AR/UY/CO). Si un cliente pide "tax free": factura nominada con pasaporte, y si el comercio + bien + comprador califican, RTC (exención en origen). Nada más.

## 4. Acción pendiente en el e-commerce

`next-compras-aqui/lib/tax.ts` → `ivaApplies()` exime de IVA a todo cliente no-PY. **Incorrecto**: un extranjero comprando en Paraguay paga IVA salvo RTC. Corregir antes de conectar el checkout a la emisión.
