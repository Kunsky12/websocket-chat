# Use official Node.js LTS image
FROM node:20

# Set working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json first (for caching)
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of your code
COPY . .

# Expose port
EXPOSE 8080

# Start your server
CMD ["node", "ChatSystem.js"]
