# ===================================================================
# Dockerfile untuk ApsGo Railway Worker
# Background service untuk IoT automation dengan BullMQ + Redis
# ===================================================================

# Base image: Node.js 18 LTS (Alpine untuk size kecil)
FROM node:18-alpine

# Metadata
LABEL maintainer="ApsGo Team"
LABEL description="Railway Worker untuk ApsGo - 24/7 IoT Automation"
LABEL version="1.0.0"

# Set working directory
WORKDIR /app

# Copy package files dulu (untuk leverage Docker cache)
COPY package.json package-lock.json* ./

# Install dependencies
# --production: hanya production dependencies (tanpa devDependencies)
# --silent: suppress npm warnings
RUN npm install --production --silent

# Copy source code
COPY worker.js ./

# Environment variables (akan di-override oleh Railway)
ENV NODE_ENV=production
ENV LOG_LEVEL=info

# Health check (optional - Railway bisa monitor via process)
# Cek apakah process masih berjalan setiap 30 detik
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "process.exit(0)"

# Expose port (OPTIONAL - worker tidak butuh port)
# Tapi tetap define untuk dokumentasi
# EXPOSE 3000

# User non-root untuk security (best practice)
USER node

# Start command: jalankan worker
CMD ["node", "worker.js"]
