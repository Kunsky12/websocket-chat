# Use official Node.js LTS slim image (smaller than full node image)
FROM node:20-slim

# Set working directory
WORKDIR /usr/src/app

# Install dependencies first (copy only package files for caching)
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy the rest of the application
COPY . .

# Expose the port
EXPOSE 8080

# Start the server
CMD ["node", "Websocket-Server.js"]