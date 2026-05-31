FROM node:22-slim

WORKDIR /app

# Install dependencies first for better caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application source
COPY src/ ./src/

# Copy WASM binary if available (optional, BigInt fallback is used otherwise)
COPY sha3_wasm_bg.was[m] ./

# Create persistent data directory
RUN mkdir -p /app/data

ENV DATA_DIR=/app/data

EXPOSE 3000

# Use exec form so SIGTERM reaches Node.js for graceful shutdown
CMD ["node", "src/index.js"]
