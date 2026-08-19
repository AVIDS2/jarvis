FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY agent-bridge/package*.json ./

# Install dependencies
RUN npm ci --production

# Copy application files
COPY . .

# Expose port
EXPOSE 3030

# Start the bridge
CMD ["node", "agent-bridge/bridge.mjs"]