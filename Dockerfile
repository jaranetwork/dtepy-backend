# DTE-PY Backend
#
# Necesita Node y Java en la misma imagen: la API corre en Node, pero el KUDE
# (el PDF) lo genera un programa Java sobre JasperReports.
#
# El CreateKude.jar propio (assets/kude) está compilado para Java 21, así que
# un JRE más viejo falla con UnsupportedClassVersionError.
# Se usa trixie (Debian 13) porque es la primera con openjdk-21 en main:
# bookworm solo llega a 17, ni siquiera en backports.

FROM node:22-trixie-slim

# --- Java 21 + fuentes ---
# fontconfig y las DejaVu no son opcionales: JasperReports las necesita para
# rasterizar el texto del PDF y sin ellas la generación falla.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        openjdk-21-jre-headless \
        fontconfig \
        fonts-dejavu-core \
        libharfbuzz0b \
    && rm -rf /var/lib/apt/lists/*
# libharfbuzz0b: libfontmanager.so de la JRE la carga al rasterizar texto;
# sin ella JasperReports muere con UnsatisfiedLinkError (libharfbuzz.so.0)
# y el KUDE no se genera (visto en produccion).

# SIFEN valida las horas contra la hora paraguaya: con el contenedor en UTC
# la firma queda 3h "en el futuro" y SET rechaza con 1004 (fecha de firma
# adelantada). tzdata + TZ alinean el reloj del proceso.
RUN apt-get update     && apt-get install -y --no-install-recommends tzdata     && rm -rf /var/lib/apt/lists/*
ENV TZ=America/Asuncion

WORKDIR /app

# --- Dependencias (capa cacheada aparte del código) ---
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Código ---
COPY . .

# Deja armado el directorio de plantillas .jasper (las de la librería con las
# propias encima). Es idempotente; si no se hiciera acá, el servicio lo haría
# solo al generar el primer PDF.
RUN npm run kude:prepare

# Carpetas persistentes: montar volúmenes acá.
#   /app/certificados -> los .p12 de cada empresa
#   /app/de_output    -> XML y PDF generados (se leen al descargarlos)
RUN mkdir -p /app/certificados /app/de_output

ENV NODE_ENV=production
ENV PORT=8081
EXPOSE 8081

# API + los tres workers en un solo contenedor.
# Para escalarlos por separado, usar `npm start`, `npm run worker`,
# `npm run worker:lote` y `npm run worker:cotizacion` en servicios distintos.
# OJO con worker:cotizacion: una sola instancia alcanza (y el índice único de
# Cotizacion evita duplicados si igual corrieran dos).
CMD ["npm", "run", "start:all"]
